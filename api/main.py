"""OwO.FM API — 127.0.0.1:8787 (proxied by Caddy at /api/*).

Talks to MPD only through `mpc` (see install_stack.md — variant A: MPD httpd
output, no Icecast/ffmpeg source). ADMIN_TOKEN lives in /etc/owo/owo.env
(EnvironmentFile for the owo-api systemd unit) and is NEVER shipped to the
browser — the public player only ever calls GET /api/now.

Endpoints (see OWO_FM_PROD_TZ.md §4):
  GET  /api/now?channel=owo|citypop        public
  GET  /api/mode?channel=owo               public
  POST /api/mode      {channel, mode}      Bearer ADMIN_TOKEN
  POST /api/skip       {channel}           Bearer ADMIN_TOKEN
  POST /api/play|pause {channel}           Bearer ADMIN_TOKEN
  POST /api/update-db  {channel}           Bearer ADMIN_TOKEN
"""

import os
import subprocess
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
MUSIC_ROOT = Path(os.environ.get("MUSIC_ROOT", "/var/lib/mpd/music"))
WWW_ROOT = Path(os.environ.get("WWW_ROOT", "/var/www/owo"))
SITE_URL = os.environ.get("SITE_URL", "https://owofm.space").rstrip("/")
MODE_FILE = Path(os.environ.get("MODE_FILE", "/var/lib/owo/mode"))

CHANNELS = {
    "owo": {
        "host": os.environ.get("MPD_OWO_HOST", "127.0.0.1"),
        "port": int(os.environ.get("MPD_OWO_PORT", "6600")),
        "has_mode": True,
    },
    "citypop": {
        "host": os.environ.get("MPD_CITY_HOST", "127.0.0.1"),
        "port": int(os.environ.get("MPD_CITY_PORT", "6601")),
        "has_mode": False,
    },
}
VALID_MODES = ("all", "party", "chill")

app = FastAPI(title="OwO.FM API")
# Same-origin in production (Caddy proxies /api/* on owofm.space); CORS kept
# permissive so the Telegram Mini App WebView / local dev fetches don't 404
# on a preflight. No credentials, no token ever crosses this boundary.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class ModeBody(BaseModel):
    channel: str
    mode: str


class ChannelBody(BaseModel):
    channel: str


def channel_conf(channel: str) -> dict:
    conf = CHANNELS.get(channel)
    if not conf:
        raise HTTPException(status_code=404, detail="unknown channel")
    return conf


def mpc(channel: str, *args: str) -> str:
    conf = channel_conf(channel)
    cmd = ["mpc", "-h", conf["host"], "-p", str(conf["port"]), *args]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(status_code=502, detail=f"mpd unreachable: {exc}") from exc
    if out.returncode != 0:
        raise HTTPException(status_code=502, detail=out.stderr.strip() or "mpc failed")
    return out.stdout


def require_admin(authorization: Optional[str], x_admin_token: Optional[str]) -> None:
    if not ADMIN_TOKEN:
        # Refuse everything rather than silently accept when misconfigured.
        raise HTTPException(status_code=503, detail="ADMIN_TOKEN not configured")
    token = x_admin_token or ""
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if token != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="invalid or missing admin token")


def read_mode() -> str:
    try:
        val = MODE_FILE.read_text(encoding="utf-8").strip().lower()
        if val in VALID_MODES:
            return val
    except OSError:
        pass
    return "all"


def write_mode(mode: str) -> None:
    MODE_FILE.parent.mkdir(parents=True, exist_ok=True)
    MODE_FILE.write_text(mode + "\n", encoding="utf-8")


def find_cover(relpath: str) -> str:
    """Best-effort cover lookup: bot/main.py saves extracted art next to the
    upload as img/covers/<stem>.jpg — same-stem convention, nothing fancier."""
    if not relpath:
        return ""
    stem = Path(relpath).stem
    covers_dir = WWW_ROOT / "img" / "covers"
    for ext in (".jpg", ".jpeg", ".png", ".webp"):
        candidate = covers_dir / (stem + ext)
        if candidate.is_file():
            return f"{SITE_URL}/img/covers/{candidate.name}"
    return ""


def current_track(channel: str) -> dict:
    raw = mpc(channel, "-f", "%artist%\t%title%\t%file%", "current")
    line = raw.strip("\n")
    artist = title = relfile = ""
    if line:
        parts = line.split("\t")
        artist = parts[0] if len(parts) > 0 else ""
        title = parts[1] if len(parts) > 1 else ""
        relfile = parts[2] if len(parts) > 2 else ""
    if not title and relfile:
        title = Path(relfile).stem
    status = mpc(channel, "status")
    is_playing = "[playing]" in status
    return {
        "title": title,
        "artist": artist,
        "art_url": find_cover(relfile),
        "is_playing": is_playing,
    }


@app.get("/api/now")
def api_now(channel: str = Query(...)):
    conf = channel_conf(channel)
    track = current_track(channel)
    mode = read_mode() if conf["has_mode"] else None
    return {
        "channel": channel,
        "title": track["title"],
        "artist": track["artist"],
        "mode": mode,
        "art_url": track["art_url"],
        "listeners": None,
        "is_playing": track["is_playing"],
    }


@app.get("/api/mode")
def api_mode_get(channel: str = Query("owo")):
    conf = channel_conf(channel)
    if not conf["has_mode"]:
        return {"mode": None}
    return {"mode": read_mode()}


@app.post("/api/mode")
def api_mode_post(
    body: ModeBody,
    authorization: Optional[str] = Header(None),
    x_admin_token: Optional[str] = Header(None),
):
    require_admin(authorization, x_admin_token)
    conf = channel_conf(body.channel)
    if not conf["has_mode"]:
        raise HTTPException(status_code=400, detail="channel has no VIBE modes")
    mode = body.mode.strip().lower()
    if mode not in VALID_MODES:
        raise HTTPException(status_code=400, detail="mode must be all|party|chill")

    mpc(body.channel, "clear")
    if mode in ("all", "party"):
        mpc(body.channel, "add", "owo/party")
    if mode in ("all", "chill"):
        mpc(body.channel, "add", "owo/chill")
    mpc(body.channel, "random", "on")
    mpc(body.channel, "play")
    write_mode(mode)
    return {"ok": True, "mode": mode}


@app.post("/api/skip")
def api_skip(
    body: ChannelBody,
    authorization: Optional[str] = Header(None),
    x_admin_token: Optional[str] = Header(None),
):
    require_admin(authorization, x_admin_token)
    channel_conf(body.channel)
    mpc(body.channel, "next")
    return {"ok": True}


@app.post("/api/play")
def api_play(
    body: ChannelBody,
    authorization: Optional[str] = Header(None),
    x_admin_token: Optional[str] = Header(None),
):
    require_admin(authorization, x_admin_token)
    channel_conf(body.channel)
    mpc(body.channel, "play")
    return {"ok": True}


@app.post("/api/pause")
def api_pause(
    body: ChannelBody,
    authorization: Optional[str] = Header(None),
    x_admin_token: Optional[str] = Header(None),
):
    require_admin(authorization, x_admin_token)
    channel_conf(body.channel)
    mpc(body.channel, "pause")
    return {"ok": True}


@app.post("/api/update-db")
def api_update_db(
    body: ChannelBody,
    authorization: Optional[str] = Header(None),
    x_admin_token: Optional[str] = Header(None),
):
    require_admin(authorization, x_admin_token)
    channels = CHANNELS.keys() if body.channel == "all" else [body.channel]
    for ch in channels:
        channel_conf(ch)
        mpc(ch, "update")
    return {"ok": True}

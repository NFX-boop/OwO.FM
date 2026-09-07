"""OwO.FM Telegram bot (aiogram 3).

Admin actions that touch the shared "mode" state go through the local HTTP
API with ADMIN_TOKEN (so /api/now stays in sync — see api/main.py). Skip,
db-update and the upload/library flow talk to MPD/ffmpeg directly with
`mpc`/subprocess, since none of that needs the API's shared-state file.

Everyone (admin or not) gets the Telegram Mini App button to the public
player. Nobody gets ADMIN_TOKEN, skip, mode or upload through the Mini App —
those are bot buttons only, exactly like OWO_FM_PROD_TZ.md §5.1 spells out.
"""

import asyncio
import logging
import os
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path

import aiohttp
from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    WebAppInfo,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("owo-bot")

BOT_TOKEN = os.environ["BOT_TOKEN"]
SITE_URL = os.environ.get("SITE_URL", "https://owofm.space").rstrip("/")
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
API_BASE = f"http://127.0.0.1:{os.environ.get('API_PORT', '8787')}"
ADMIN_IDS = {
    int(x) for x in re.split(r"[,\s]+", os.environ.get("ADMIN_IDS", "")) if x.strip().isdigit()
}
MUSIC_ROOT = Path(os.environ.get("MUSIC_ROOT", "/var/lib/mpd/music"))
WWW_ROOT = Path(os.environ.get("WWW_ROOT", "/var/www/owo"))
TMP_DIR = Path("/tmp/owo-bot-uploads")
TMP_DIR.mkdir(parents=True, exist_ok=True)

MPD_PORTS = {
    "owo": int(os.environ.get("MPD_OWO_PORT", "6600")),
    "citypop": int(os.environ.get("MPD_CITY_PORT", "6601")),
}
FOLDER_CHANNEL = {"owo/party": "owo", "owo/chill": "owo", "citypop": "citypop"}
NOW_CACHE_TTL = 20  # seconds — "cache ответа 15-30s" per OWO_FM_PROD_TZ.md §5

_now_cache: dict[str, tuple[float, str]] = {}

router = Router()


def is_admin(user_id: int) -> bool:
    return user_id in ADMIN_IDS


def listen_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="🎧 Слушать OwO.FM", web_app=WebAppInfo(url=f"{SITE_URL}/"))
    ]])


def admin_panel_kb(channel: str) -> InlineKeyboardMarkup:
    other = "citypop" if channel == "owo" else "owo"
    rows = [
        [
            InlineKeyboardButton(text="▶️ Сейчас играет", callback_data=f"now:{channel}"),
            InlineKeyboardButton(text="📃 Очередь", callback_data=f"queue:{channel}"),
        ],
        [
            InlineKeyboardButton(text="⏭ Skip", callback_data=f"skip:{channel}"),
            InlineKeyboardButton(text="🔄 Update DB", callback_data=f"updatedb:{channel}"),
        ],
    ]
    if channel == "owo":
        rows.append([InlineKeyboardButton(text="🎛 VIBE", callback_data="vibe:menu")])
    rows.append([InlineKeyboardButton(
        text=f"↔️ Канал: {'City Pop' if other == 'citypop' else 'OwO'}",
        callback_data=f"chan:{other}",
    )])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def vibe_menu_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="ALL", callback_data="vibe:all"),
        InlineKeyboardButton(text="PARTY", callback_data="vibe:party"),
        InlineKeyboardButton(text="CHILL", callback_data="vibe:chill"),
    ], [
        InlineKeyboardButton(text="« Назад", callback_data="chan:owo"),
    ]])


def folder_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="OwO — Party", callback_data="folder:owo/party")],
        [InlineKeyboardButton(text="OwO — Chill", callback_data="folder:owo/chill")],
        [InlineKeyboardButton(text="City Pop", callback_data="folder:citypop")],
    ])


def action_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="▶️ Играть сразу", callback_data="action:now")],
        [InlineKeyboardButton(text="➕ В очередь", callback_data="action:queue")],
        [InlineKeyboardButton(text="📚 Только в библиотеку", callback_data="action:library")],
    ])


class UploadFlow(StatesGroup):
    choosing_folder = State()
    choosing_action = State()


def run_mpc(channel: str, *args: str) -> str:
    port = MPD_PORTS[channel]
    out = subprocess.run(
        ["mpc", "-p", str(port), *args], capture_output=True, text=True, timeout=10
    )
    if out.returncode != 0:
        log.warning("mpc %s failed: %s", args, out.stderr.strip())
    return out.stdout


def safe_slug(name: str) -> str:
    base = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", name)
    base = re.sub(r"[^A-Za-z0-9_-]+", "_", base).strip("_").lower()
    return (base or "track")[:60] + "_" + uuid.uuid4().hex[:8]


async def call_admin_api(path: str, payload: dict) -> tuple[int, str]:
    headers = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
    async with aiohttp.ClientSession() as session:
        async with session.post(f"{API_BASE}{path}", json=payload, headers=headers, timeout=10) as resp:
            return resp.status, await resp.text()


def now_text(channel: str) -> str:
    cached = _now_cache.get(channel)
    if cached and time.time() - cached[0] < NOW_CACHE_TTL:
        return cached[1]
    label = "OwO" if channel == "owo" else "City Pop"
    raw = run_mpc(channel, "-f", "%artist% - %title%", "current").strip()
    status = run_mpc(channel, "status")
    playing = "▶️ playing" if "[playing]" in status else "⏸ paused"
    text = f"<b>{label}</b>\n{raw or '(нет данных)'}\n{playing}"
    _now_cache[channel] = (time.time(), text)
    return text


def queue_text(channel: str) -> str:
    label = "OwO" if channel == "owo" else "City Pop"
    playlist = run_mpc(channel, "playlist").strip().splitlines()
    current = run_mpc(channel, "-f", "%title%", "current").strip()
    return (
        f"<b>{label} — очередь</b>\n"
        f"Сейчас: {current or '—'}\n"
        f"Треков в плейлисте: {len(playlist)}\n"
        f"<i>random on — порядок не фиксирован</i>"
    )


@router.message(CommandStart())
async def cmd_start(message: Message) -> None:
    admin = is_admin(message.from_user.id)
    text = "OwO.FM — непрерывный радиоэфир.\nOwO / City Pop, жми кнопку ниже."
    kb = listen_kb()
    if admin:
        kb.inline_keyboard.append([InlineKeyboardButton(text="⚙️ Админ-панель", callback_data="chan:owo")])
    await message.answer(text, reply_markup=kb)


@router.message(Command("now"))
async def cmd_now(message: Message) -> None:
    await message.answer(now_text("owo"), reply_markup=listen_kb())


@router.message(Command("queue"))
async def cmd_queue(message: Message) -> None:
    await message.answer(queue_text("owo"))


@router.callback_query(F.data.startswith("chan:"))
async def cb_channel(callback: CallbackQuery) -> None:
    if not is_admin(callback.from_user.id):
        return await callback.answer("Только для админов", show_alert=True)
    channel = callback.data.split(":", 1)[1]
    await callback.message.edit_text(f"Панель управления — <b>{channel}</b>", reply_markup=admin_panel_kb(channel))
    await callback.answer()


@router.callback_query(F.data.startswith("now:"))
async def cb_now(callback: CallbackQuery) -> None:
    channel = callback.data.split(":", 1)[1]
    await callback.answer()
    await callback.message.answer(now_text(channel))


@router.callback_query(F.data.startswith("queue:"))
async def cb_queue(callback: CallbackQuery) -> None:
    channel = callback.data.split(":", 1)[1]
    await callback.answer()
    await callback.message.answer(queue_text(channel))


@router.callback_query(F.data.startswith("skip:"))
async def cb_skip(callback: CallbackQuery) -> None:
    if not is_admin(callback.from_user.id):
        return await callback.answer("Только для админов", show_alert=True)
    channel = callback.data.split(":", 1)[1]
    run_mpc(channel, "next")
    _now_cache.pop(channel, None)
    await callback.answer("Skipped")


@router.callback_query(F.data.startswith("updatedb:"))
async def cb_update_db(callback: CallbackQuery) -> None:
    if not is_admin(callback.from_user.id):
        return await callback.answer("Только для админов", show_alert=True)
    channel = callback.data.split(":", 1)[1]
    run_mpc(channel, "update")
    await callback.answer("DB updated")


@router.callback_query(F.data == "vibe:menu")
async def cb_vibe_menu(callback: CallbackQuery) -> None:
    if not is_admin(callback.from_user.id):
        return await callback.answer("Только для админов", show_alert=True)
    await callback.message.edit_text("VIBE (OwO):", reply_markup=vibe_menu_kb())
    await callback.answer()


@router.callback_query(F.data.startswith("vibe:"))
async def cb_vibe_set(callback: CallbackQuery) -> None:
    # "vibe:menu" is caught by cb_vibe_menu above (registered first, exact
    # match) — anything else reaching here is an actual mode value.
    if not is_admin(callback.from_user.id):
        return await callback.answer("Только для админов", show_alert=True)
    mode = callback.data.split(":", 1)[1]
    status, body = await call_admin_api("/api/mode", {"channel": "owo", "mode": mode})
    _now_cache.pop("owo", None)
    if status == 200:
        await callback.answer(f"VIBE → {mode.upper()}")
    else:
        await callback.answer(f"Ошибка API ({status})", show_alert=True)
        log.warning("mode set failed: %s %s", status, body)


@router.message(F.audio | F.voice | F.document, F.from_user.id.in_(ADMIN_IDS))
async def handle_upload(message: Message, state: FSMContext, bot: Bot) -> None:
    src = message.audio or message.voice or message.document
    orig_name = getattr(src, "file_name", None) or f"upload_{src.file_unique_id}"
    status_msg = await message.answer("⬇️ Скачиваю…")

    stamp = TMP_DIR / f"{uuid.uuid4().hex}_{re.sub(r'[^A-Za-z0-9_.-]', '_', orig_name)}"
    tg_file = await bot.get_file(src.file_id)
    await bot.download_file(tg_file.file_path, destination=stamp)

    slug = safe_slug(Path(orig_name).stem or "track")
    aac_path = TMP_DIR / f"{slug}.aac"
    cover_path = TMP_DIR / f"{slug}.jpg"

    await status_msg.edit_text("🎛 Конвертирую в AAC 128k…")
    conv = subprocess.run(
        ["ffmpeg", "-y", "-i", str(stamp), "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-vn", str(aac_path)],
        capture_output=True, text=True, timeout=180,
    )
    if conv.returncode != 0 or not aac_path.is_file():
        stamp.unlink(missing_ok=True)
        return await status_msg.edit_text(f"❌ ffmpeg не смог сконвертировать файл:\n<code>{conv.stderr[-500:]}</code>")

    # Best-effort cover art extract — most uploads won't have one, that's fine.
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(stamp), "-an", "-vcodec", "copy", str(cover_path)],
        capture_output=True, text=True, timeout=30,
    )
    if not cover_path.is_file() or cover_path.stat().st_size == 0:
        cover_path.unlink(missing_ok=True)
        cover_path = None

    stamp.unlink(missing_ok=True)

    await state.update_data(aac_path=str(aac_path), cover_path=str(cover_path) if cover_path else None, slug=slug)
    await state.set_state(UploadFlow.choosing_folder)
    await status_msg.edit_text("✅ Готово. Куда положить трек?", reply_markup=folder_kb())


@router.callback_query(F.data.startswith("folder:"), UploadFlow.choosing_folder)
async def cb_choose_folder(callback: CallbackQuery, state: FSMContext) -> None:
    folder = callback.data.split(":", 1)[1]
    await state.update_data(folder=folder)
    await state.set_state(UploadFlow.choosing_action)
    await callback.message.edit_text(f"Папка: <b>{folder}</b>. Что делаем?", reply_markup=action_kb())
    await callback.answer()


@router.callback_query(F.data.startswith("action:"), UploadFlow.choosing_action)
async def cb_choose_action(callback: CallbackQuery, state: FSMContext) -> None:
    action = callback.data.split(":", 1)[1]
    data = await state.get_data()
    folder = data["folder"]
    slug = data["slug"]
    channel = FOLDER_CHANNEL[folder]

    dest_dir = MUSIC_ROOT / folder
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_aac = dest_dir / f"{slug}.aac"
    # shutil.move (not Path.rename) — /tmp and MUSIC_ROOT are commonly
    # different filesystems, and rename() can't cross that boundary.
    shutil.move(data["aac_path"], str(dest_aac))

    if data.get("cover_path"):
        covers_dir = WWW_ROOT / "img" / "covers"
        covers_dir.mkdir(parents=True, exist_ok=True)
        cover_src = Path(data["cover_path"])
        if cover_src.is_file():
            shutil.move(str(cover_src), str(covers_dir / f"{slug}.jpg"))

    relpath = f"{folder}/{slug}.aac"
    run_mpc(channel, "update")

    if action == "now":
        run_mpc(channel, "insert", relpath)
        run_mpc(channel, "next")
        verdict = "▶️ играет прямо сейчас"
    elif action == "queue":
        run_mpc(channel, "add", relpath)
        verdict = "➕ добавлен в очередь"
    else:
        verdict = "📚 сохранён в библиотеке"

    _now_cache.pop(channel, None)
    await state.clear()
    await callback.message.edit_text(f"Готово: <code>{relpath}</code>\n{verdict}")
    await callback.answer()


async def main() -> None:
    bot = Bot(token=BOT_TOKEN, default=DefaultBotProperties(parse_mode="HTML"))
    dp = Dispatcher(storage=MemoryStorage())
    dp.include_router(router)
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())

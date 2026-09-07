/* OwO.FM player — player.html (core: audio, meta, VIBE, canvases)
   Loaded before js/drive.js — both are plain classic scripts sharing one
   top-level scope on purpose (same trick the original single-file build
   used), so drive.js can call back into the functions/state declared here
   and vice versa. Nothing here ever touches ADMIN_TOKEN — skip/mode calls
   go out unauthenticated and the server decides (see install_stack.md). */

/* ===== Telegram Mini App (safe no-op outside TG) ===== */
(function initTelegramWebApp() {
    try {
        const tg = window.Telegram && window.Telegram.WebApp;
        if (!tg) return;
        tg.ready();
        if (typeof tg.expand === 'function') tg.expand();
        if (typeof tg.setHeaderColor === 'function') tg.setHeaderColor('#050308');
        if (typeof tg.setBackgroundColor === 'function') tg.setBackgroundColor('#050308');
        document.documentElement.classList.add('tg-webapp');
    } catch (_) {}
})();

const STORAGE_KEY = 'owofm_state_v1';
const VIBE_UNLOCK_KEY = 'owofm_vibe_unlock_v1'; /* same key as boot.js — IDDQD is unlocked on index.html */
const AUTOPLAY_FLAG_KEY = 'owofm_autoplay'; /* set by boot.js right before navigating here */
const DEFAULT_COVER = '/img/default-cover.webp';
const VOLUME_FADE_MS = 1500;

const stations = [
    {
        name: 'OwO Music',
        id: 'owo',
        url: 'https://owofm.space/stream/owo',
        metaUrl: '/api/now?channel=owo',
        cover: DEFAULT_COVER
    },
    {
        name: 'City Pop',
        id: 'citypop',
        url: 'https://owofm.space/stream/citypop',
        metaUrl: '/api/now?channel=citypop',
        cover: DEFAULT_COVER
    }
];

function resolveCover(url) {
    return (url && String(url).trim()) ? url : DEFAULT_COVER;
}

/* IDDQD — read-only here: the fox-pat unlock ritual lives on index.html.
   This page only reflects the flag (Next button, VIBE picker button). */
let vibeUnlocked = false;
try { vibeUnlocked = localStorage.getItem(VIBE_UNLOCK_KEY) === '1'; } catch (_) {}
document.body.classList.toggle('iddqd-unlocked', vibeUnlocked);

let volumeFadeToken = 0;
function fadeVolume(to, ms, onDone) {
    const token = ++volumeFadeToken;
    const from = typeof audio.volume === 'number' ? audio.volume : 1;
    const dur = Math.max(50, ms || VOLUME_FADE_MS);
    const t0 = performance.now();
    function step(now) {
        if (token !== volumeFadeToken) return;
        const p = Math.min(1, (now - t0) / dur);
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        try { audio.volume = from + (to - from) * e; } catch (_) {}
        if (p < 1) requestAnimationFrame(step);
        else {
            try { audio.volume = to; } catch (_) {}
            if (onDone) onDone();
        }
    }
    requestAnimationFrame(step);
}

/* State */
let activeStationIdx = 0;
let isPlaying = false;
let isBuffering = false;
let bufferPercent = 0;
let streamError = false;
let currentTrack = '';
let stationAnnounceUntil = 0;
let metaTimer = null;
let lastPointerTs = 0;
let viewMode = 'VFD';
let displayMode = 'classic';
let currentPalette = 'default';
let tempNotice = null;
let tempNoticeTimer = null;
let lastFrame = 0;
let animActive = false;
let pageVisible = true;

/* DPR / FPS budget: phones ok at 1.5; desktop/old GPU stay light */
const SAVE_GPU = (() => {
    try {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
        if (navigator.connection && (navigator.connection.saveData || /2g/i.test(navigator.connection.effectiveType || ''))) return true;
    } catch (_) {}
    return false;
})();
function getDpr() {
    const raw = devicePixelRatio || 1;
    const desktop = window.matchMedia && window.matchMedia('(min-width: 900px)').matches;
    if (SAVE_GPU) return 1;
    if (desktop) return Math.min(raw, 1.1);
    return Math.min(raw, 1.5);
}

/* Desktop / TV shell: no spectrum, ambient from cover, Media Session */
function isDesktopUi() {
    try {
        return !!(window.matchMedia && window.matchMedia('(min-width: 900px)').matches);
    } catch (_) {
        return (window.innerWidth || 0) >= 900;
    }
}
function syncDesktopUiClass() {
    const on = isDesktopUi();
    document.body.classList.toggle('desktop-ui', on);
    return on;
}
syncDesktopUiClass();
if (window.matchMedia) {
    try {
        const mq = window.matchMedia('(min-width: 900px)');
        const fn = function () { syncDesktopUiClass(); };
        if (mq.addEventListener) mq.addEventListener('change', fn);
        else if (mq.addListener) mq.addListener(fn);
    } catch (_) {}
}

/* Safe ambient from cover — dark, muted, never neon nightmare */
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            default: h = ((r - g) / d + 4) / 6; break;
        }
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
}
function hslToRgb(h, s, l) {
    h /= 360; s /= 100; l /= 100;
    if (s === 0) {
        const v = Math.round(l * 255);
        return { r: v, g: v, b: v };
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2 = function (t) {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return {
        r: Math.round(hue2(h + 1 / 3) * 255),
        g: Math.round(hue2(h) * 255),
        b: Math.round(hue2(h - 1 / 3) * 255)
    };
}
function applyAmbientFromImage(img) {
    if (!isDesktopUi() || !img) return;
    try {
        const w = 24, h = 24;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        let rSum = 0, gSum = 0, bSum = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
            if (a < 128) continue;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (max < 28 || min > 245) continue;
            if (max - min < 12 && max > 40 && max < 220) continue;
            rSum += r; gSum += g; bSum += b; n++;
        }
        if (n < 4) {
            document.body.style.removeProperty('--ambient');
            document.body.style.removeProperty('--ambient-deep');
            document.body.style.removeProperty('--ambient-glow');
            return;
        }
        const hsl = rgbToHsl(rSum / n, gSum / n, bSum / n);
        const s = clamp(hsl.s * 0.55, 18, 42);
        const base = hslToRgb(hsl.h, s, clamp(hsl.l * 0.22, 7, 14));
        const deep = hslToRgb(hsl.h, s * 0.8, 5);
        const glow = hslToRgb(hsl.h, clamp(s + 8, 20, 48), 22);
        document.body.style.setProperty('--ambient', base.r + ',' + base.g + ',' + base.b);
        document.body.style.setProperty('--ambient-deep', deep.r + ',' + deep.g + ',' + deep.b);
        document.body.style.setProperty('--ambient-glow', glow.r + ',' + glow.g + ',' + glow.b);
    } catch (_) {}
}
function applyAmbientFromUrl(url) {
    if (!isDesktopUi() || !url) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () { applyAmbientFromImage(img); };
    img.onerror = function () {
        document.body.style.setProperty('--ambient', '18,12,28');
        document.body.style.setProperty('--ambient-deep', '8,6,14');
        document.body.style.setProperty('--ambient-glow', '40,28,60');
    };
    img.src = url;
}

/* Audio */
const audio = new Audio();
try {
    audio.playsInline = true;
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    audio.preload = 'none';
} catch (_) {}
let audioCtx, analyser, freqData;
let audioGraphOk = false;

const vfdDisplay = document.getElementById('vfdDisplay');
const coverContainer = document.getElementById('coverContainer');
const coverImg = document.getElementById('coverImg');
const driveCover = document.getElementById('driveCover'); /* lives in drive-mode markup, read by loadStation() */
const onAirIndicator = document.getElementById('onAirIndicator');
const onAirText = document.getElementById('onAirText');
const playBtn = document.getElementById('playBtn');
const iconPlay = document.getElementById('iconPlay');
const iconStop = document.getElementById('iconStop');
const nextBtn = document.getElementById('nextBtn');
const stationsList = document.getElementById('stationsList');

const vCanvas = document.getElementById('visualizerCanvas');
const vCtx = vCanvas.getContext('2d', { alpha: true });
const tCanvas = document.getElementById('tickerCanvas');
const tCtx = tCanvas.getContext('2d', { alpha: true });
const bgCanvas = document.getElementById('bgVisualizer');
const bgCtx = bgCanvas.getContext('2d', { alpha: true });

const NUM_COLS = 28;
let peaks = new Array(NUM_COLS).fill(0);
let tickerScrollX = 0;

const FONT_5X7 = {
    'A':[0x0e,0x11,0x11,0x1f,0x11,0x11,0x11],'B':[0x1e,0x11,0x11,0x1e,0x11,0x11,0x1e],
    'C':[0x0e,0x11,0x10,0x10,0x10,0x11,0x0e],'D':[0x1c,0x12,0x11,0x11,0x11,0x12,0x1c],
    'E':[0x1f,0x10,0x10,0x1e,0x10,0x10,0x1f],'F':[0x1f,0x10,0x10,0x1e,0x10,0x10,0x10],
    'G':[0x0e,0x11,0x10,0x17,0x11,0x11,0x0e],'H':[0x11,0x11,0x11,0x1f,0x11,0x11,0x11],
    'I':[0x0e,0x04,0x04,0x04,0x04,0x04,0x0e],'J':[0x07,0x02,0x02,0x02,0x02,0x12,0x0c],
    'K':[0x11,0x12,0x14,0x18,0x14,0x12,0x11],'L':[0x10,0x10,0x10,0x10,0x10,0x10,0x1f],
    'M':[0x11,0x1b,0x15,0x15,0x11,0x11,0x11],'N':[0x11,0x19,0x15,0x13,0x11,0x11,0x11],
    'O':[0x0e,0x11,0x11,0x11,0x11,0x11,0x0e],'P':[0x1e,0x11,0x11,0x1e,0x10,0x10,0x10],
    'Q':[0x0e,0x11,0x11,0x11,0x15,0x12,0x0d],'R':[0x1e,0x11,0x11,0x1e,0x14,0x12,0x11],
    'S':[0x0e,0x11,0x10,0x0e,0x01,0x11,0x0e],'T':[0x1f,0x04,0x04,0x04,0x04,0x04,0x04],
    'U':[0x11,0x11,0x11,0x11,0x11,0x11,0x0e],'V':[0x11,0x11,0x11,0x11,0x11,0x0a,0x04],
    'W':[0x11,0x11,0x11,0x15,0x15,0x1b,0x11],'X':[0x11,0x11,0x0a,0x04,0x0a,0x11,0x11],
    'Y':[0x11,0x11,0x11,0x0a,0x04,0x04,0x04],'Z':[0x1f,0x01,0x02,0x04,0x08,0x10,0x1f],
    '0':[0x0e,0x13,0x15,0x19,0x15,0x13,0x0e],'1':[0x04,0x0c,0x04,0x04,0x04,0x04,0x0e],
    '2':[0x0e,0x11,0x01,0x02,0x04,0x08,0x1f],'3':[0x1f,0x01,0x02,0x0e,0x01,0x11,0x0e],
    '4':[0x02,0x06,0x0a,0x12,0x1f,0x02,0x02],'5':[0x1f,0x10,0x1e,0x01,0x01,0x11,0x0e],
    '6':[0x0e,0x10,0x10,0x1e,0x11,0x11,0x0e],'7':[0x1f,0x01,0x02,0x04,0x08,0x08,0x08],
    '8':[0x0e,0x11,0x11,0x0e,0x11,0x11,0x0e],'9':[0x0e,0x11,0x11,0x0f,0x01,0x01,0x0e],
    '-':[0x00,0x00,0x00,0x1f,0x00,0x00,0x00],'.':[0x00,0x00,0x00,0x00,0x00,0x06,0x06],
    ':':[0x00,0x06,0x06,0x00,0x06,0x06,0x00],'/':[0x01,0x02,0x04,0x08,0x10,0x00,0x00],
    ' ': [0x00,0x00,0x00,0x00,0x00,0x00,0x00],'%':[0x19,0x1a,0x02,0x04,0x08,0x13,0x13],
    '>':[0x04,0x02,0x01,0x02,0x04,0x00,0x00],
    '[':[0x0e,0x08,0x08,0x08,0x08,0x08,0x0e],
    ']':[0x0e,0x02,0x02,0x02,0x02,0x02,0x0e],
    '#':[0x0a,0x1f,0x0a,0x0a,0x1f,0x0a,0x00],
    '!':[0x04,0x04,0x04,0x04,0x04,0x00,0x04],
    '|':[0x04,0x04,0x04,0x04,0x04,0x04,0x04],
    '_':[0x00,0x00,0x00,0x00,0x00,0x00,0x1f],
    '~':[0x00,0x08,0x15,0x02,0x00,0x00,0x00],
    '+':[0x00,0x04,0x04,0x1f,0x04,0x04,0x00]
};

/* localStorage — display/session preferences only, never a token */
function saveState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            palette: currentPalette,
            station: activeStationIdx,
            displayMode: displayMode,
            nightDrive: document.body.classList.contains('night-drive')
        }));
    } catch (_) {}
}
function loadState() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch (_) { return {}; }
}

/* Canvas palette colors */
let cachedColors = { low: '#7b1fa2', mid: '#ff4500', high: '#ffc107', peak: '#ffffff' };
function updateCachedColors() {
    if (document.body.classList.contains('palette-vista')) {
        cachedColors = { low: '#0d4a5c', mid: '#00a8a8', high: '#5eead4', peak: '#c8fff6' };
    } else if (document.body.classList.contains('palette-dark')) {
        cachedColors = { low: '#2a1520', mid: '#c45a2e', high: '#a07850', peak: '#e8c4a0' };
    } else {
        cachedColors = { low: '#7b1fa2', mid: '#ff4500', high: '#ffc107', peak: '#ffffff' };
    }
}
function getAccentColors() { return cachedColors; }

/* Palette */
const paletteBtn = document.getElementById('paletteBtn');
const paletteMenu = document.getElementById('paletteMenu');
paletteBtn.addEventListener('click', e => {
    e.stopPropagation();
    paletteMenu.classList.toggle('open');
});
document.addEventListener('click', () => paletteMenu.classList.remove('open'));
paletteMenu.querySelectorAll('.palette-option').forEach(opt => {
    opt.addEventListener('click', () => setPalette(opt.dataset.palette));
});

function setPalette(p, save = true) {
    currentPalette = p;
    document.body.classList.remove('palette-vista', 'palette-dark');
    if (p === 'vista') document.body.classList.add('palette-vista');
    if (p === 'dark') document.body.classList.add('palette-dark');
    if (paletteMenu) {
        paletteMenu.querySelectorAll('.palette-option').forEach(o => {
            o.classList.toggle('active', o.dataset.palette === p);
        });
        paletteMenu.classList.remove('open');
    }
    updateCachedColors();
    if (save) saveState();
}

function applySavedState() {
    const s = loadState();
    if (s.palette) setPalette(s.palette, false);
    if (typeof s.station === 'number' && s.station < stations.length) {
        activeStationIdx = s.station;
    }
    displayMode = 'classic';
}
applySavedState();
updateCachedColors();

/* Display mode: VFD spectrum <-> cover art */
function setDisplayMode() {
    displayMode = 'classic';
    if (viewMode === 'VFD') {
        coverContainer.classList.remove('visible');
        coverContainer.style.display = 'none';
        vCanvas.style.display = 'block';
        document.body.classList.remove('mode-cover');
    } else {
        document.body.classList.add('mode-cover');
        setupBgCanvas();
    }
    setupCanvases();
    saveState();
}
function toggleViewMode() {
    if (viewMode === 'VFD') {
        viewMode = 'COVER';
        vCanvas.style.display = 'none';
        coverContainer.classList.add('visible');
        coverContainer.style.display = 'flex';
        coverContainer.style.opacity = '1';
        document.body.classList.add('mode-cover');
        setupBgCanvas();
    } else {
        viewMode = 'VFD';
        document.body.classList.remove('mode-cover');
        coverContainer.style.opacity = '0';
        setTimeout(() => {
            coverContainer.classList.remove('visible');
            coverContainer.style.display = 'none';
            vCanvas.style.display = 'block';
        }, 250);
    }
}

/* ===== VIBE / mood ===== */
const moodOpenBtn = document.getElementById('moodOpenBtn');
const vibeStatus = document.getElementById('vibeStatus');
const moodModal = document.getElementById('moodModal');
let currentVibeMode = 'all';

function vibeLabel(mode) {
    const m = String(mode || 'all').toLowerCase();
    if (m === 'party') return 'PARTY';
    if (m === 'chill') return 'CHILL';
    return 'VIBE';
}
function setVibeModeDisplay(mode) {
    if (mode) currentVibeMode = String(mode).toLowerCase();
    const label = vibeLabel(currentVibeMode);
    if (vibeStatus) vibeStatus.textContent = label;
    if (moodOpenBtn) moodOpenBtn.textContent = label;
}
const moodClose = document.getElementById('moodClose');
const moodSeg = document.getElementById('moodSeg');
const moodThumb = document.getElementById('moodThumb');
const moodLock = document.getElementById('moodLock');
let currentMood = 'all';
let moodBusy = false;

function openMoodModal() {
    if (!moodModal) return;
    moodModal.classList.add('open');
    moodModal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => positionMoodThumb(currentMood, false));
}
function closeMoodModal() {
    if (!moodModal) return;
    moodModal.classList.remove('open');
    moodModal.setAttribute('aria-hidden', 'true');
    if (moodLock) moodLock.textContent = '';
    if (moodSeg) moodSeg.classList.remove('is-locked', 'is-shake');
}
/* Guest: inert #vibeStatus pill (all→VIBE, party→PARTY, chill→CHILL), no click.
   IDDQD: pill replaced by a working #moodOpenBtn. Both hidden on City Pop. */
function updateMoodBtnVisibility() {
    const st = stations[activeStationIdx];
    const onOwo = !!(st && st.id === 'owo');
    if (vibeStatus) {
        const showBadge = onOwo && !vibeUnlocked;
        vibeStatus.classList.toggle('is-visible', showBadge);
        vibeStatus.setAttribute('aria-hidden', showBadge ? 'false' : 'true');
        if (showBadge) setVibeModeDisplay(currentVibeMode);
    }
    if (moodOpenBtn) {
        const showBtn = onOwo && vibeUnlocked;
        moodOpenBtn.classList.toggle('is-hidden-mood', !showBtn);
        moodOpenBtn.setAttribute('aria-hidden', showBtn ? 'false' : 'true');
        if (showBtn) setVibeModeDisplay(currentVibeMode);
    }
}
function positionMoodThumb(mode, animate) {
    if (!moodSeg || !moodThumb) return;
    const btn = moodSeg.querySelector('.mood-opt[data-mode="' + mode + '"]');
    if (!btn) return;
    const sr = moodSeg.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    if (!animate) moodThumb.style.transition = 'none';
    moodThumb.style.width = br.width + 'px';
    moodThumb.style.transform = 'translateX(' + (br.left - sr.left) + 'px)';
    if (!animate) {
        void moodThumb.offsetWidth;
        moodThumb.style.transition = '';
    }
    moodSeg.querySelectorAll('.mood-opt').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
    });
    moodSeg.dataset.mode = mode;
}
/* VIBE change: OwO channel only. No ADMIN_TOKEN here — the server decides
   whether this request is allowed (see install_stack.md §5 / owo.env). */
async function setMoodMode(mode) {
    if (moodBusy || !moodSeg) return;
    if (mode === currentMood) {
        positionMoodThumb(mode, true);
        return;
    }
    const prev = currentMood;
    currentMood = mode;
    positionMoodThumb(mode, true);
    moodBusy = true;
    try {
        const res = await fetch('/api/mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel: 'owo', mode: mode }),
            credentials: 'same-origin'
        });
        if (res.status === 401 || res.status === 403) {
            currentMood = prev;
            positionMoodThumb(prev, true);
            moodSeg.classList.add('is-locked', 'is-shake');
            if (moodLock) moodLock.textContent = 'ACCESS LOCKED';
            setTimeout(() => { moodSeg.classList.remove('is-shake'); }, 450);
            setTimeout(() => {
                moodSeg.classList.remove('is-locked');
                if (moodLock) moodLock.textContent = '';
            }, 2000);
        }
    } catch (_) {
        /* offline / API down — keep optimistic UI selection, non-fatal */
    } finally {
        moodBusy = false;
    }
}
if (moodOpenBtn) moodOpenBtn.addEventListener('click', e => {
    e.stopPropagation();
    openMoodModal();
});
if (moodClose) moodClose.addEventListener('click', closeMoodModal);
if (moodModal) {
    moodModal.addEventListener('click', e => {
        if (e.target === moodModal) closeMoodModal();
    });
}
if (moodSeg) {
    moodSeg.querySelectorAll('.mood-opt').forEach(btn => {
        btn.addEventListener('click', () => setMoodMode(btn.dataset.mode));
    });
    window.addEventListener('resize', () => positionMoodThumb(currentMood, false));
}
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && moodModal && moodModal.classList.contains('open')) {
        closeMoodModal();
    }
});

/* Buffering */
audio.addEventListener('waiting', () => setBuffering(true));
audio.addEventListener('stalled', () => setBuffering(true));
audio.addEventListener('playing', () => setBuffering(false));
audio.addEventListener('canplay', () => { if (isPlaying) setBuffering(false); });
audio.addEventListener('progress', updateBufferPercent);
audio.addEventListener('error', () => {
    streamError = true;
    setBuffering(false);
    isPlaying = false;
    updatePlayBtn();
    updatePlayingState();
    updateDriveSpin();
    onAirText.textContent = 'ERROR';
});

function updateBufferPercent() {
    try {
        if (audio.buffered.length) {
            const end = audio.buffered.end(audio.buffered.length - 1);
            bufferPercent = Math.min(99, Math.round((end - (audio.currentTime || 0)) * 12));
            if (bufferPercent < 0) bufferPercent = 0;
        }
    } catch (_) {}
}

function setBuffering(state) {
    isBuffering = state;
    onAirIndicator.classList.toggle('is-buffering', state && isPlaying);
    if (state && isPlaying) onAirText.textContent = 'BUFFER';
    else if (isPlaying) onAirText.textContent = 'ON AIR';
    else onAirText.textContent = 'STANDBY';
    updateDriveVfdStatus();
}

function startMetaPolling() {
    stopMetaPolling();
    fetchNowPlaying();
    metaTimer = setInterval(fetchNowPlaying, 15000);
}
function stopMetaPolling() {
    if (metaTimer) { clearInterval(metaTimer); metaTimer = null; }
}
/* GET /api/now?channel=owo|citypop — track + mode; see OWO_FM_PROD_TZ.md §4.1 */
async function fetchNowPlaying() {
    const st = stations[activeStationIdx];
    if (!st.metaUrl) return;
    try {
        const res = await fetch(st.metaUrl, { cache: 'no-store' });
        if (!res.ok) return;
        let data;
        try { data = await res.json(); } catch (_) { return; }
        if (!data || typeof data !== 'object') return;

        let title = '';
        if (data.artist && data.title) title = data.artist + ' - ' + data.title;
        else title = data.title || data.artist || '';

        if (data.mode && st.id === 'owo') {
            setVibeModeDisplay(data.mode);
            updateMoodBtnVisibility();
        }

        if (title && title !== currentTrack) {
            currentTrack = String(title).trim();
            updateMediaSession();
        }
        const art = data.art_url || data.cover || '';
        if (art) {
            const cov = resolveCover(art);
            if (coverImg && coverImg.src.indexOf(cov) < 0) {
                coverImg.src = cov;
                if (driveCover) driveCover.src = cov;
            }
        }
    } catch (_) {}
}

function initPlayer() {
    renderStationButtons();
    setupCanvases();
    setupBgCanvas();
    setupDriveCanvases();
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            setupCanvases();
            setupBgCanvas();
            setupDriveCanvases();
        }, 120);
    });

    vfdDisplay.addEventListener('click', () => toggleViewMode());
    playBtn.addEventListener('click', () => togglePlay());
    nextBtn.addEventListener('click', () => nextTrack());

    startAnimLoop();
    setupVisibility();
    setupKeyboard();
    setupMediaSession();
    updateMoodBtnVisibility();
    positionMoodThumb(currentMood, false);
}

function setupVisibility() {
    document.addEventListener('visibilitychange', () => {
        pageVisible = document.visibilityState === 'visible';
        document.body.classList.toggle('is-background', !pageVisible);
        if (pageVisible) {
            setupCanvases();
            setupBgCanvas();
            setupDriveCanvases();
            lastFrame = 0;
        }
    });
}

/* Space = play/pause (guest ok). N / -> = skip, only if IDDQD-unlocked.
   D = Night Drive toggle (display mode, no auth needed). */
function setupKeyboard() {
    document.addEventListener('keydown', e => {
        if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
        if (e.code === 'Space') {
            e.preventDefault();
            togglePlay();
        } else if (e.code === 'ArrowRight' || e.key === 'n' || e.key === 'N') {
            if (vibeUnlocked) nextTrack();
        } else if (e.key === 'd' || e.key === 'D') {
            setNightDrive(!document.body.classList.contains('night-drive'));
        }
    });
}

function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const bind = function (action, fn) {
        try { navigator.mediaSession.setActionHandler(action, fn); } catch (_) {}
    };
    bind('play', function () { togglePlay(true); });
    bind('pause', function () { togglePlay(false); });
    bind('stop', function () { togglePlay(false); });
    if (vibeUnlocked) bind('nexttrack', function () { nextTrack(); });
}

function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const st = stations[activeStationIdx];
    if (!st) return;
    const title = currentTrack || st.name || 'OwO.FM';
    try {
        const artSrc = resolveCover(st.cover);
        const art = [
            { src: artSrc, sizes: '96x96', type: 'image/webp' },
            { src: artSrc, sizes: '256x256', type: 'image/webp' },
            { src: artSrc, sizes: '512x512', type: 'image/webp' }
        ];
        if (typeof MediaMetadata !== 'undefined') {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: title,
                artist: 'OwO.FM',
                album: st.name || 'OwO.FM',
                artwork: art
            });
        }
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    } catch (_) {}
}

function renderStationButtons() {
    stationsList.innerHTML = '';
    stations.forEach((s, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `station-card-btn ${i === activeStationIdx ? 'active' : ''}`;
        btn.textContent = s.name;
        btn.onclick = () => loadStation(i, true);
        stationsList.appendChild(btn);
    });
}

function loadStation(idx, autoPlay = false) {
    activeStationIdx = idx;
    const st = stations[idx];
    const wasPlaying = isPlaying || autoPlay;
    const sameSrc = !!(audio.src && audio.src.indexOf(st.url.split('/').pop()) !== -1);

    if (!sameSrc || wasPlaying) {
        isPlaying = false;
        try { audio.pause(); } catch (_) {}
        if (!sameSrc) audio.src = st.url;
    }

    const cov = resolveCover(st.cover);
    coverImg.src = cov;
    coverImg.alt = st.name ? ('Cover: ' + st.name) : 'Artwork';
    driveCover.src = cov;
    driveCover.alt = st.name ? ('Cover: ' + st.name) : 'Cover';
    coverImg.onerror = function () {
        coverImg.src = DEFAULT_COVER;
        applyAmbientFromUrl(DEFAULT_COVER);
    };
    driveCover.onerror = function () { driveCover.src = DEFAULT_COVER; };
    coverImg.onload = function () {
        applyAmbientFromImage(coverImg);
        updateMediaSession();
    };
    applyAmbientFromUrl(cov);
    currentTrack = '';
    stationAnnounceUntil = performance.now() + 3000;
    Array.from(stationsList.children).forEach((b, i) => b.classList.toggle('active', i === idx));
    updateMoodBtnVisibility();
    updateMediaSession();
    saveState();
    if (wasPlaying) {
        togglePlay(true);
    } else {
        updatePlayBtn();
        updatePlayingState();
        setBuffering(false);
        updateDriveSpin();
    }
}

function triggerNotice(msg) {
    tempNotice = msg;
    if (tempNoticeTimer) clearTimeout(tempNoticeTimer);
    tempNoticeTimer = setTimeout(() => { tempNotice = null; }, 1800);
}

function initAudioContext() {
    if (audioCtx) return audioGraphOk;
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        audioCtx = new AC();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;
        freqData = new Uint8Array(analyser.frequencyBinCount);
        const source = audioCtx.createMediaElementSource(audio);
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        audioGraphOk = true;
    } catch (e) {
        console.warn('Web Audio unavailable, playback without visualizer', e);
        audioCtx = null;
        analyser = null;
        freqData = null;
        audioGraphOk = false;
    }
    return audioGraphOk;
}

function enableCorsAudio(on) {
    try {
        if (on) audio.crossOrigin = 'anonymous';
        else audio.removeAttribute('crossorigin');
    } catch (_) {}
}

function togglePlay(force) {
    const next = force !== undefined ? force : !isPlaying;
    if (next) {
        isPlaying = true;
        streamError = false;
        const st = stations[activeStationIdx];
        const needSrc = !audio.src || audio.src.indexOf(st.url.split('/').pop()) === -1;
        if (needSrc) audio.src = st.url;

        enableCorsAudio(true);
        initAudioContext();
        if (audioCtx && audioCtx.state === 'suspended') {
            try { audioCtx.resume(); } catch (_) {}
        }

        try { audio.volume = 0; } catch (_) {}
        setBuffering(true);
        updatePlayBtn();
        updatePlayingState();
        updateDriveSpin();

        const onOk = () => {
            isPlaying = true;
            streamError = false;
            fadeVolume(1, VOLUME_FADE_MS);
            updatePlayBtn();
            updatePlayingState();
            updateDriveSpin();
            updateMediaSession();
        };
        const onFail = () => {
            try {
                enableCorsAudio(false);
                audio.src = st.url;
                try { audio.volume = 0; } catch (_) {}
                const p2 = audio.play();
                if (p2 && p2.then) {
                    p2.then(onOk).catch(() => {
                        isPlaying = false;
                        streamError = true;
                        setBuffering(false);
                        updatePlayBtn();
                        updatePlayingState();
                        updateDriveSpin();
                        updateMediaSession();
                    });
                } else {
                    onOk();
                }
            } catch (_) {
                isPlaying = false;
                streamError = true;
                setBuffering(false);
                updatePlayBtn();
                updatePlayingState();
                updateDriveSpin();
                updateMediaSession();
            }
        };

        try {
            const p = audio.play();
            if (p && p.then) p.then(onOk).catch(onFail);
            else onOk();
        } catch (_) {
            onFail();
        }
        startMetaPolling();
    } else {
        isPlaying = false;
        setBuffering(false);
        stopMetaPolling();
        updatePlayBtn();
        updatePlayingState();
        updateDriveSpin();
        updateMediaSession();
        fadeVolume(0, VOLUME_FADE_MS, () => {
            if (isPlaying) return;
            try { audio.pause(); } catch (_) {}
            const keepUrl = stations[activeStationIdx].url;
            try { audio.removeAttribute('src'); audio.load(); } catch (_) {}
            try { audio.src = keepUrl; } catch (_) {}
            try { audio.volume = 1; } catch (_) {}
        });
    }
    updatePlayBtn();
    updatePlayingState();
    updateDriveSpin();
    updateMediaSession();
}

function updatePlayBtn() {
    iconPlay.style.display = isPlaying ? 'none' : 'block';
    iconStop.style.display = isPlaying ? 'block' : 'none';
}

function updatePlayingState() {
    vfdDisplay.classList.toggle('is-playing', isPlaying);
    if (!isPlaying) onAirText.textContent = 'STANDBY';
    else if (!isBuffering) onAirText.textContent = 'ON AIR';
}

/* Track skip — real effect only happens server-side with admin auth.
   IDDQD only unlocks this button locally; the browser never carries
   ADMIN_TOKEN, so a guest who somehow fires this just gets 401/403. */
function nextTrack() {
    if (!vibeUnlocked) return;
    const st = stations[activeStationIdx];
    triggerNotice('>> SKIP');
    fetch('/api/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: st.id }),
        credentials: 'same-origin'
    }).then(res => {
        if (res.status === 401 || res.status === 403) triggerNotice('SKIP: ADMIN ONLY');
    }).catch(() => {
        triggerNotice('SKIP: OFFLINE');
    });
}

function setupCanvases() {
    const dpr = getDpr();
    [vCanvas, tCanvas].forEach(c => {
        const r = c.parentElement.getBoundingClientRect();
        if (r.width > 0) {
            c.width = (r.width * dpr) | 0;
            c.height = (r.height * dpr) | 0;
        }
    });
}

function setupBgCanvas() {
    const dpr = getDpr();
    bgCanvas.width = (innerWidth * dpr) | 0;
    bgCanvas.height = (innerHeight * 0.42 * dpr) | 0;
}

function startAnimLoop() {
    if (animActive) return;
    animActive = true;
    requestAnimationFrame(loop);
}

function loop(ts) {
    requestAnimationFrame(loop);
    if (!pageVisible) return;
    let minDelta = 120;
    if (isPlaying) {
        const drive = document.body.classList.contains('night-drive');
        const desk = window.matchMedia && window.matchMedia('(min-width: 900px)').matches;
        if (SAVE_GPU) minDelta = drive ? 66 : 80;
        else if (drive) minDelta = desk ? 50 : 33;
        else minDelta = desk ? 66 : 50;
    } else if (document.body.classList.contains('night-drive')) {
        minDelta = 120;
    }
    if (ts - lastFrame < minDelta) return;
    lastFrame = ts;

    const inDrive = document.body.classList.contains('night-drive');

    if (isDesktopUi()) {
        if (inDrive) drawDriveTicker();
        else drawTicker(tCtx, tCanvas);
        return;
    }

    if (inDrive) {
        drawDriveTicker();
        drawDriveViz();
        return;
    }

    if (viewMode === 'VFD' && isPlaying) {
        drawVfdSpectrum();
    }
    if (isPlaying && viewMode === 'COVER') {
        drawBgSpectrum();
    }
    drawTicker(tCtx, tCanvas);
}

function drawVfdSpectrum() {
    const dpr = getDpr();
    const w = vCanvas.width / dpr, h = vCanvas.height / dpr;
    if (w < 2) return;
    const c = getAccentColors();
    vCtx.save();
    vCtx.scale(dpr, dpr);
    vCtx.fillStyle = '#030206';
    vCtx.fillRect(0, 0, w, h);
    if (analyser) analyser.getByteFrequencyData(freqData);
    const colW = w / NUM_COLS, barW = colW * 0.6;
    const g = vCtx.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, c.low); g.addColorStop(0.55, c.mid); g.addColorStop(1, c.high);
    for (let i = 0; i < NUM_COLS; i++) {
        const val = freqData ? freqData[Math.min(i, freqData.length - 1)] : 0;
        peaks[i] = Math.max(val, peaks[i] - 1.5);
        const bh = (val / 255) * h * 0.82;
        const ph = (peaks[i] / 255) * h * 0.82;
        const x = i * colW + (colW - barW) / 2;
        if (bh > 1) { vCtx.fillStyle = g; vCtx.globalAlpha = 0.8; vCtx.fillRect(x, h - bh, barW, bh); }
        if (ph > 1) {
            vCtx.fillStyle = c.peak; vCtx.globalAlpha = 0.85;
            vCtx.beginPath();
            vCtx.arc(x + barW / 2, h - ph - 3, Math.max(1.2, barW / 2.4), 0, Math.PI * 2);
            vCtx.fill();
        }
    }
    vCtx.restore();
}

function drawBgSpectrum() {
    const dpr = getDpr();
    const w = bgCanvas.width / dpr, h = bgCanvas.height / dpr;
    if (w < 2) return;
    const c = getAccentColors();
    bgCtx.save();
    bgCtx.scale(dpr, dpr);
    bgCtx.clearRect(0, 0, w, h);
    if (analyser && freqData) analyser.getByteFrequencyData(freqData);

    const cols = 48;
    const colW = w / cols;
    const barW = Math.max(2, colW * 0.62);
    const n = freqData ? freqData.length : 0;

    for (let i = 0; i < cols; i++) {
        let val = 0;
        if (n) {
            const t0 = i / cols;
            const t1 = (i + 1) / cols;
            const b0 = Math.floor(Math.pow(t0, 0.75) * (n - 1));
            const b1 = Math.max(b0 + 1, Math.floor(Math.pow(t1, 0.75) * (n - 1)));
            let max = 0, sum = 0, cnt = 0;
            for (let b = b0; b <= b1 && b < n; b++) {
                const v = freqData[b];
                if (v > max) max = v;
                sum += v;
                cnt++;
            }
            const avg = cnt ? sum / cnt : 0;
            val = max * 0.65 + avg * 0.35;
            val = Math.min(255, val * (1 + t0 * 0.7));
        }
        const bh = (val / 255) * h * 0.92;
        if (bh > 1.5) {
            bgCtx.globalAlpha = 0.34;
            bgCtx.fillStyle = c.mid;
            bgCtx.fillRect(i * colW + (colW - barW) / 2, h - bh, barW, bh);
        }
    }
    bgCtx.restore();
}

function drawDotText(ctx, text, w, h, color, scroll, staticCenter) {
    const dot = 2.0, gap = 1, cw = 6 * (dot + gap);
    const textW = text.length * cw;
    const y = (h - 7 * (dot + gap)) / 2;
    let x = staticCenter ? Math.max(4, (w - textW) / 2) : scroll;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i].toUpperCase();
        const m = FONT_5X7[ch] || FONT_5X7[' '];
        if (x > -cw && x < w) {
            for (let row = 0; row < 7; row++) {
                const bits = m[row] || 0;
                for (let col = 0; col < 5; col++) {
                    const bit = (bits >> (4 - col)) & 1;
                    ctx.fillStyle = color;
                    ctx.globalAlpha = bit ? 0.88 : 0.03;
                    ctx.fillRect(x + col * (dot + gap), y + row * (dot + gap), dot, dot);
                }
            }
        }
        x += cw;
    }
    return textW;
}

function drawTicker(ctx, canvas) {
    const dpr = getDpr();
    const w = canvas.width / dpr, h = canvas.height / dpr;
    if (w < 2) return;
    const c = getAccentColors();
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const st = stations[activeStationIdx];
    const now = performance.now();
    const announcing = now < stationAnnounceUntil;
    let text;
    let staticCenter = false;

    if (streamError) {
        text = 'STREAM ERROR';
        staticCenter = true;
    } else if (tempNotice) {
        text = tempNotice;
        staticCenter = true;
    } else if (announcing) {
        text = st.name;
        staticCenter = true;
    } else if (isPlaying && currentTrack) {
        text = currentTrack;
        staticCenter = false;
    } else if (isPlaying) {
        text = st.name;
        staticCenter = true;
    } else {
        text = 'PRESS PLAY';
        staticCenter = true;
    }

    const cw = 6 * (2 + 1);
    if (!staticCenter) {
        tickerScrollX -= 2.4;
        if (tickerScrollX < -(text.length * cw + 24)) tickerScrollX = w + 8;
    } else {
        tickerScrollX = 0;
    }

    drawDotText(ctx, text, w, h, c.mid, tickerScrollX, staticCenter);
    ctx.restore();
}

/* ===== Bootstrap =====
   Waits for js/drive.js (next <script> tag) to finish defining its
   functions before calling anything cross-file — see the end of drive.js. */

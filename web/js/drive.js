/* OwO.FM Night Drive — player.html (full-screen VFD dash)
   Loaded after js/player.js and shares its top-level scope on purpose:
   reads/calls player.js state (audio, isPlaying, stations, togglePlay,
   nextTrack, triggerNotice, resolveCover, getDpr, FONT_5X7, ...) and in
   turn player.js's loop()/togglePlay()/setBuffering()/loadStation() call
   back into the functions defined here (setupDriveCanvases,
   updateDriveSpin, updateDriveVfdStatus, drawDriveTicker, drawDriveViz).
   That's safe because every cross-file call happens from inside an event
   handler or rAF callback — by the time any of them actually run, both
   <script> tags have finished executing top to bottom. */

/* Drive VFD spectrum (single mode: bar + peak hold) */
const VFD_COLS = 46;
const VFD_ROWS = 28;
let vfdValues = new Array(VFD_COLS).fill(0);
let vfdPeaks = new Array(VFD_COLS).fill(0);
let vfdPeakTimers = new Array(VFD_COLS).fill(0);
let driveTickerScrollX = 0;

const driveVfdInds = document.getElementById('driveVfdInds');
const driveVfdMeta = document.getElementById('driveVfdMeta');
const driveTickerCanvas = document.getElementById('driveTickerCanvas');
const driveTickerCtx = driveTickerCanvas.getContext('2d', { alpha: true });
const driveVizCanvas = document.getElementById('driveVizCanvas');
const driveVizCtx = driveVizCanvas.getContext('2d', { alpha: true });
const driveCoverZone = document.getElementById('driveCoverZone');
const driveExit = document.getElementById('driveExit');
const nightDriveBtn = document.getElementById('nightDriveBtn');

let paletteBeforeDrive = 'default';

if (nightDriveBtn) {
    nightDriveBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        setNightDrive(!document.body.classList.contains('night-drive'));
    });
}
if (driveExit) {
    driveExit.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        setNightDrive(false);
    });
}

function setNightDrive(on) {
    try {
        if (on) {
            document.body.classList.add('night-drive');
            if (nightDriveBtn) nightDriveBtn.classList.add('active');
            paletteBeforeDrive = currentPalette;
            setPalette('dark', false);
            if (driveCover) driveCover.src = resolveCover(stations[activeStationIdx].cover);
            stationAnnounceUntil = performance.now() + 3000;
            requestAnimationFrame(() => {
                try {
                    setupDriveCanvases();
                    updateDriveSpin();
                    updateDriveVfdStatus();
                } catch (_) {}
            });
            if (isPlaying) startMetaPolling();
        } else {
            document.body.classList.remove('night-drive');
            if (nightDriveBtn) nightDriveBtn.classList.remove('active');
            setPalette(paletteBeforeDrive, false);
            setDisplayMode();
        }
        saveState();
    } catch (err) {
        console.warn('setNightDrive', err);
    }
}

/* Drive cover: tap = play/stop, swipe = skip (IDDQD only), double via keyboard elsewhere */
let ptrStartX = 0, ptrStartY = 0, ptrMoved = false, ptrOnCover = false;

function animateSwipe(dir) {
    if (!vibeUnlocked) return; /* no misleading affordance for guests — swipe is a no-op */
    const cls = dir < 0 ? 'swipe-left' : 'swipe-right';
    driveCover.classList.add(cls);
    setTimeout(() => {
        driveCover.classList.remove(cls);
        nextTrack();
    }, 280); /* match CSS transition 0.28s */
}

function onPtrDown(x, y, target) {
    ptrStartX = x; ptrStartY = y; ptrMoved = false;
    ptrOnCover = target === driveCover || driveCover.contains(target);
}
function onPtrMove(x, y) {
    if (Math.abs(x - ptrStartX) > 14 || Math.abs(y - ptrStartY) > 14) ptrMoved = true;
}
function onPtrUp(x, y) {
    const now = performance.now();
    if (now - lastPointerTs < 280) return; // debounce touch+mouse
    lastPointerTs = now;

    const dx = x - ptrStartX;
    const dy = y - ptrStartY;

    if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        animateSwipe(dx < 0 ? -1 : 1);
        return;
    }
    if (!ptrMoved && ptrOnCover) {
        togglePlay();
    }
}

let driveTouchActive = false;
driveCoverZone.addEventListener('touchstart', e => {
    driveTouchActive = true;
    const t = e.changedTouches[0];
    onPtrDown(t.clientX, t.clientY, e.target);
}, { passive: true });
driveCoverZone.addEventListener('touchmove', e => {
    const t = e.changedTouches[0];
    onPtrMove(t.clientX, t.clientY);
}, { passive: true });
driveCoverZone.addEventListener('touchend', e => {
    const t = e.changedTouches[0];
    onPtrUp(t.clientX, t.clientY);
    setTimeout(() => { driveTouchActive = false; }, 400);
}, { passive: true });

driveCoverZone.addEventListener('mousedown', e => {
    if (driveTouchActive) return;
    onPtrDown(e.clientX, e.clientY, e.target);
});
driveCoverZone.addEventListener('mouseup', e => {
    if (driveTouchActive) return;
    onPtrUp(e.clientX, e.clientY);
});

function setupDriveCanvases() {
    const dpr = getDpr();
    const tr = driveTickerCanvas.parentElement.getBoundingClientRect();
    if (tr.width > 0) {
        driveTickerCanvas.width = (tr.width * dpr) | 0;
        driveTickerCanvas.height = (tr.height * dpr) | 0;
    }
    const vr = driveVizCanvas.parentElement.getBoundingClientRect();
    if (vr.width > 0) {
        driveVizCanvas.width = (vr.width * dpr) | 0;
        driveVizCanvas.height = (vr.height * dpr) | 0;
    }
}

function updateDriveSpin() {
    driveCover.classList.remove('is-spinning');
    driveCover.style.transform = '';
    if (vfdDisplay) vfdDisplay.classList.toggle('is-playing', isPlaying);
    updateDriveVfdStatus();
}

function updateDriveVfdStatus() {
    if (!driveVfdInds) return;
    let active = 'standby';
    if (streamError) active = 'standby';
    else if (isPlaying && isBuffering) active = 'buffer';
    else if (isPlaying) active = 'onair';
    driveVfdInds.querySelectorAll('.vfd-ind').forEach(el => {
        el.classList.toggle('is-lit', el.dataset.ind === active);
    });
    if (driveVfdMeta) {
        const st = stations[activeStationIdx];
        driveVfdMeta.textContent = 'OwO.FM // ' + st.name.toUpperCase();
    }
}

/* Rectangular VFD spectrum: horizontal phosphor bricks, bar + peak */
function drawDriveViz() {
    const dpr = getDpr();
    const ctx = driveVizCtx;
    const w = driveVizCanvas.width / dpr;
    const h = driveVizCanvas.height / dpr;
    if (w < 8 || h < 8) return;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;

    if (isPlaying && analyser && freqData) {
        analyser.getByteFrequencyData(freqData);
    }

    const binCount = freqData ? freqData.length : 0;
    const usable = binCount ? Math.max(VFD_COLS, Math.floor(binCount * 0.42)) : 0;

    for (let i = 0; i < VFD_COLS; i++) {
        let target = 0;
        if (isPlaying && usable) {
            const idx = Math.min(usable - 1, Math.floor(i * usable / VFD_COLS));
            target = (freqData[idx] / 255) * VFD_ROWS;
            if (target < 0.6) target = 0;
        }
        const speed = target > vfdValues[i] ? 0.6 : 0.42;
        vfdValues[i] += (target - vfdValues[i]) * speed;
        if (vfdValues[i] >= vfdPeaks[i]) {
            vfdPeaks[i] = vfdValues[i];
            vfdPeakTimers[i] = 12;
        } else if (vfdPeakTimers[i] > 0) {
            vfdPeakTimers[i]--;
        } else {
            vfdPeaks[i] -= 0.55;
            if (vfdPeaks[i] < 0) vfdPeaks[i] = 0;
        }
    }

    const COL_GAP = 2;
    const SEG_GAP = 1.5;
    const totalColGaps = COL_GAP * (VFD_COLS - 1);
    const colWidth = Math.max(2, Math.floor((w - totalColGaps) / VFD_COLS));
    const totalGridWidth = colWidth * VFD_COLS + totalColGaps;
    const startX = Math.floor((w - totalGridWidth) / 2);
    const padTop = 2;
    const usableH = h - padTop;
    const totalRowGaps = SEG_GAP * (VFD_ROWS - 1);
    let segHeight = Math.floor((usableH - totalRowGaps) / VFD_ROWS);
    if (segHeight < 1) segHeight = 1;
    const maxSeg = Math.max(1, Math.floor(colWidth * 0.65));
    if (segHeight > maxSeg) segHeight = maxSeg;
    const startY = Math.floor(h);

    const ON = 'rgba(0, 255, 213, 0.78)';
    const OFF = 'rgba(0, 255, 213, 0.03)';

    for (let i = 0; i < VFD_COLS; i++) {
        const x = startX + i * (colWidth + COL_GAP);
        const activeCount = Math.min(VFD_ROWS, Math.floor(vfdValues[i]));
        const peakIndex = Math.min(VFD_ROWS, Math.floor(vfdPeaks[i]));
        for (let j = 0; j < VFD_ROWS; j++) {
            const y = startY - (j + 1) * (segHeight + SEG_GAP);
            ctx.fillStyle = (j < activeCount) ? ON : OFF;
            ctx.fillRect(x, y, colWidth, segHeight);
        }
        if (peakIndex > 0) {
            const peakY = startY - peakIndex * (segHeight + SEG_GAP);
            ctx.fillStyle = ON;
            ctx.fillRect(x, peakY, colWidth, segHeight);
        }
    }

    ctx.restore();
}

function drawDriveTicker() {
    const dpr = getDpr();
    const cssW = driveTickerCanvas.clientWidth || driveTickerCanvas.width;
    const cssH = driveTickerCanvas.clientHeight || driveTickerCanvas.height;
    const bw = Math.max(1, Math.floor(cssW * dpr));
    const bh = Math.max(1, Math.floor(cssH * dpr));
    if (driveTickerCanvas.width !== bw || driveTickerCanvas.height !== bh) {
        driveTickerCanvas.width = bw;
        driveTickerCanvas.height = bh;
    }
    const ctx = driveTickerCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    ctx.imageSmoothingEnabled = false;

    const st = stations[activeStationIdx];
    const now = performance.now();
    const announcing = now < stationAnnounceUntil;
    const ph = '#5ef0d0';

    let cell = Math.floor(dpr * 2.5);
    if (cell < 2) cell = 2;
    if (cell > 4) cell = 4;
    const gap = Math.max(1, Math.round(cell * 0.35));
    const step = cell + gap;
    const letterW = 6 * step;
    const letterH = 7 * step;

    /* K.I.T.T. scanner during buffer — short cycle, not a lying percentage */
    if (isPlaying && isBuffering && !streamError && !tempNotice) {
        const barY = Math.floor((bh - cell) / 2);
        const barH = cell;
        const travel = bw - cell * 6;
        const cycle = 900;
        const t = (now % (cycle * 2)) / cycle;
        const goingRight = t < 1;
        const p = goingRight ? t : (2 - t);
        const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        const headX = Math.floor(ease * travel);
        for (let k = 0; k < 6; k++) {
            const x = headX + (goingRight ? -k : k) * (cell + 1);
            const a = 0.9 - k * 0.14;
            if (a <= 0.05) continue;
            ctx.globalAlpha = a;
            ctx.fillStyle = ph;
            ctx.fillRect(x, barY, cell * 2, barH);
        }
        ctx.globalAlpha = 1;
        return;
    }

    let text = '';
    let staticCenter = true;
    if (streamError) text = 'STREAM ERROR';
    else if (tempNotice) text = tempNotice;
    else if (announcing) text = st.name.toUpperCase();
    else if (isPlaying && currentTrack) { text = currentTrack.toUpperCase(); staticCenter = false; }
    else if (isPlaying) text = st.name.toUpperCase();
    else text = 'PRESS PLAY';

    const textW = text.length * letterW;

    if (!staticCenter) {
        driveTickerScrollX -= dpr * 2.2;
        if (driveTickerScrollX < -textW - 20) driveTickerScrollX = bw + 10;
    } else {
        driveTickerScrollX = 0;
    }

    let x = staticCenter ? Math.floor((bw - textW) / 2) : Math.floor(driveTickerScrollX);
    const y = Math.floor((bh - letterH) / 2);

    for (let i = 0; i < text.length; i++) {
        const m = FONT_5X7[text[i]] || FONT_5X7[' '];
        if (x > -letterW && x < bw + letterW) {
            for (let row = 0; row < 7; row++) {
                const bits = m[row] || 0;
                for (let col = 0; col < 5; col++) {
                    const bit = (bits >> (4 - col)) & 1;
                    const px = x + col * step;
                    const py = y + row * step;
                    ctx.globalAlpha = bit ? 0.92 : 0.04;
                    ctx.fillStyle = ph;
                    ctx.fillRect(px, py, cell, cell);
                }
            }
        }
        x += letterW;
    }
    ctx.globalAlpha = 1;
}

/* ===== Bootstrap =====
   Runs once both player.js and drive.js have finished declaring their
   functions — safe place to actually kick off playback. */
(function boot() {
    initPlayer();

    let pendingAutoplay = false;
    try {
        if (sessionStorage.getItem(AUTOPLAY_FLAG_KEY) === '1') {
            pendingAutoplay = true;
            sessionStorage.removeItem(AUTOPLAY_FLAG_KEY);
        }
    } catch (_) {}

    loadStation(activeStationIdx, pendingAutoplay);

    if (loadState().nightDrive) setNightDrive(true);
})();

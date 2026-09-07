/* OwO.FM boot — index.html */
(function () {
    'use strict';

    /* Boot timeline: void → fox → text → UI */
    let started = false;
    function runBootTimeline() {
        if (started) return;
        started = true;
        document.documentElement.classList.add('ready');
        document.documentElement.classList.remove('boot');
        document.body.setAttribute('data-boot', 'void');

        const boot = document.getElementById('boot-screen');
        if (boot) {
            boot.classList.add('boot-hide');
            setTimeout(function () { try { boot.remove(); } catch (_) {} }, 420);
        }

        const timeline = [
            { stage: 'fox-entry', delay: 90 },
            { stage: 'text-reveal', delay: 340 },
            { stage: 'ui-ready', delay: 580 },
            { stage: 'done', delay: 920 }
        ];
        timeline.forEach(function (item) {
            setTimeout(function () { document.body.setAttribute('data-boot', item.stage); }, item.delay);
        });
    }
    if (document.readyState === 'complete') runBootTimeline();
    else window.addEventListener('load', runBootTimeline);
    setTimeout(runBootTimeline, 1600);

    const VIBE_UNLOCK_KEY = 'owofm_vibe_unlock_v1';

    /* Parallax (phase1) */
    let tiltX = 0;
    function onOrient(e) {
        tiltX = Math.max(-1, Math.min(1, (e.gamma || 0) / 35));
    }
    function onMouse(e) {
        const cx = window.innerWidth / 2;
        tiltX = Math.max(-1, Math.min(1, (e.clientX - cx) / (cx * 0.85)));
    }
    if (window.DeviceOrientationEvent) {
        window.addEventListener('deviceorientation', onOrient, { passive: true });
    }
    window.addEventListener('mousemove', onMouse, { passive: true });

    /* Fox words */
    const foxSounds = ['RING DING DING!', 'WA PA PA PA!', 'HATEE HATEE!', 'JACHA CHACHA!', 'FRAKA KAKA!', 'A-OOO-OO-OOO!', 'YIP YIP!', 'PAW PAW!'];
    const fxContainer = document.getElementById('fx-container');
    let spawnInterval = setInterval(spawnWord, 650);

    function spawnWord() {
        const el = document.createElement('div');
        el.className = 'fox-word';
        el.textContent = foxSounds[(Math.random() * foxSounds.length) | 0];
        el.style.left = ((Math.random() * 55 + 22) | 0) + '%';
        el.style.top = '78%';
        const drift = (Math.random() - 0.5) * 90 + tiltX * 160;
        const rot0 = (Math.random() - 0.5) * 14;
        el.style.setProperty('--dx-start', '0px');
        el.style.setProperty('--dx-end', drift + 'px');
        el.style.setProperty('--rot-start', rot0 + 'deg');
        el.style.setProperty('--rot-end', (rot0 + (Math.random() - 0.5) * 18) + 'deg');
        fxContainer.appendChild(el);
        setTimeout(function () { el.remove(); }, 3800);
    }

    /* Easter egg chain → ABOUT */
    const eggBtn = document.getElementById('eggBtn');
    const eggLabel = document.getElementById('eggLabel');
    const aboutOverlay = document.getElementById('aboutOverlay');
    const aboutClose = document.getElementById('aboutClose');
    const aboutDone = document.getElementById('aboutDone');
    let eggStep = 0;

    const EGG_STEPS = [
        { text: 'OFF', cls: 'egg-toggle', on: false },
        { text: 'ON', cls: 'egg-toggle is-on', on: true },
        { text: 'ON AIR', cls: 'egg-radio', on: false },
        { text: 'OwO', cls: 'egg-cute', on: false },
        { text: 'UwU', cls: 'egg-cute', on: false },
        { text: 'YIFF', cls: 'egg-hot', on: false },
        { text: 'OR KNOT?', cls: 'egg-hot', on: false },
        { text: 'OPEN DEN', cls: 'egg-final', on: false }
    ];

    function applyEggStep(i) {
        const s = EGG_STEPS[i];
        eggBtn.className = 'egg-btn ' + s.cls;
        eggLabel.textContent = s.text;
        eggBtn.setAttribute('aria-label', s.text);
    }

    function openAbout() {
        aboutOverlay.classList.add('open');
        aboutOverlay.setAttribute('aria-hidden', 'false');
    }
    function closeAbout() {
        aboutOverlay.classList.remove('open');
        aboutOverlay.setAttribute('aria-hidden', 'true');
        eggStep = 0;
        applyEggStep(0);
    }

    if (eggBtn) {
        applyEggStep(0);
        eggBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            eggStep += 1;
            if (eggStep >= EGG_STEPS.length) {
                openAbout();
                return;
            }
            applyEggStep(eggStep);
        });
    }
    if (aboutClose) aboutClose.addEventListener('click', closeAbout);
    if (aboutDone) aboutDone.addEventListener('click', closeAbout);
    if (aboutOverlay) {
        aboutOverlay.addEventListener('click', function (e) {
            if (e.target === aboutOverlay) closeAbout();
        });
    }
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && aboutOverlay && aboutOverlay.classList.contains('open')) {
            closeAbout();
        }
    });

    /* Telegram Mini App — no-op outside TG */
    (function initTelegramWebApp() {
        try {
            var tg = window.Telegram && window.Telegram.WebApp;
            if (!tg) return;
            tg.ready();
            if (typeof tg.expand === 'function') tg.expand();
            if (typeof tg.setHeaderColor === 'function') tg.setHeaderColor('#050308');
            if (typeof tg.setBackgroundColor === 'function') tg.setBackgroundColor('#050308');
            document.documentElement.classList.add('tg-webapp');
        } catch (_) {}
    })();

    /* PWA install prompt */
    let deferredInstallPrompt = null;
    const installAppBtn = document.getElementById('installAppBtn');
    window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault();
        deferredInstallPrompt = e;
        if (installAppBtn) {
            installAppBtn.hidden = false;
            installAppBtn.classList.add('is-visible');
        }
    });
    window.addEventListener('appinstalled', function () {
        deferredInstallPrompt = null;
        if (installAppBtn) {
            installAppBtn.hidden = true;
            installAppBtn.classList.remove('is-visible');
        }
    });
    if (installAppBtn) {
        installAppBtn.addEventListener('click', async function () {
            if (!deferredInstallPrompt) return;
            try {
                deferredInstallPrompt.prompt();
                await deferredInstallPrompt.userChoice;
            } catch (_) {}
            deferredInstallPrompt = null;
            installAppBtn.hidden = true;
            installAppBtn.classList.remove('is-visible');
        });
    }

    /* IDDQD — fox pats (local UI only) */
    const mascotLayer = document.getElementById('mascotLayer');
    const mascotHit = document.getElementById('mascotHit');
    const mascotFlash = document.getElementById('mascotFlash');
    const laserField = document.getElementById('laserField');
    let foxPatCount = 0;
    let vibeUnlocked = false;
    try { vibeUnlocked = localStorage.getItem(VIBE_UNLOCK_KEY) === '1'; } catch (_) {}

    function setIddqdStatus(on) {
        const ind = document.getElementById('statusIndicator');
        const txt = document.getElementById('statusText');
        const tag = document.getElementById('taglineText');
        if (!ind || !txt) return;
        if (on) {
            ind.classList.add('is-iddqd');
            txt.textContent = 'IDDQD';
            if (tag) tag.textContent = 'Endless playback. Track skipping allowed.';
        } else {
            ind.classList.remove('is-iddqd');
            txt.textContent = 'IDLE';
            if (tag) tag.textContent = 'No skip. No pause. The stream just runs.';
        }
    }

    function applyLaserUnlock(animateIn) {
        vibeUnlocked = true;
        try { localStorage.setItem(VIBE_UNLOCK_KEY, '1'); } catch (_) {}
        if (mascotLayer) {
            mascotLayer.classList.add('is-laser-live');
            mascotLayer.classList.remove('is-pat-shake-1', 'is-pat-shake-2', 'is-pat-shake-3', 'is-pat-glow');
        }
        const aura = document.getElementById('mascotAura');
        if (aura) aura.classList.remove('is-on');
        const tune = document.getElementById('enter-btn');
        if (tune) tune.classList.add('is-unlocked');
        setIddqdStatus(true);
        if (laserField) {
            if (animateIn) {
                laserField.classList.remove('is-on');
                void laserField.offsetWidth;
            }
            laserField.classList.add('is-on');
            laserField.setAttribute('aria-hidden', 'false');
        }
    }

    if (mascotHit) {
        mascotHit.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (vibeUnlocked) return;
            foxPatCount += 1;
            const aura = document.getElementById('mascotAura');
            if (foxPatCount >= 4) {
                if (aura) aura.classList.add('is-on');
                if (mascotLayer) {
                    mascotLayer.classList.add('is-pat-glow');
                    const stage = Math.min(3, foxPatCount - 5);
                    mascotLayer.classList.remove('is-pat-shake-1', 'is-pat-shake-2', 'is-pat-shake-3');
                    if (stage >= 1) mascotLayer.classList.add('is-pat-shake-' + stage);
                }
            }
            if (foxPatCount >= 8) {
                if (mascotFlash) {
                    mascotFlash.classList.remove('is-pop', 'is-rise');
                    void mascotFlash.offsetWidth;
                    mascotFlash.classList.add('is-pop', 'is-rise');
                }
                setTimeout(function () { applyLaserUnlock(true); }, 420);
            }
        });
    }

    if (vibeUnlocked) {
        if (mascotLayer) mascotLayer.classList.add('is-laser-live');
        const tune0 = document.getElementById('enter-btn');
        if (tune0) tune0.classList.add('is-unlocked');
        setIddqdStatus(true);
        if (laserField) {
            laserField.classList.add('is-on');
            laserField.setAttribute('aria-hidden', 'false');
        }
    }

    /* TUNE IN → player.html */
    const enterBtn = document.getElementById('enter-btn');
    const btnText = document.getElementById('btn-text');
    const btnIcon = enterBtn && enterBtn.querySelector('.btn-icon');
    const loader = document.getElementById('loader');

    if (enterBtn) {
        enterBtn.addEventListener('click', function () {
            enterBtn.style.pointerEvents = 'none';
            if (btnIcon) btnIcon.style.display = 'none';
            if (btnText) btnText.style.display = 'none';
            if (loader) loader.style.display = 'block';
            clearInterval(spawnInterval);
            try { sessionStorage.setItem('owofm_autoplay', '1'); } catch (_) {}
            window.location.href = '/player.html';
        });
    }
})();

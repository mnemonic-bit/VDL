const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');

test.beforeEach(async ({ page }) => {
    await reset(page);
    await page.evaluate(() => {
        const states = new WeakMap();
        window.__media = video => {
            if (!states.has(video)) states.set(video, {
                duration: 30, currentTime: 0, paused: true, ended: false, readyState: 4,
            });
            return states.get(video);
        };
        for (const key of ['duration', 'currentTime', 'paused', 'ended', 'readyState']) {
            Object.defineProperty(HTMLMediaElement.prototype, key, {
                configurable: true,
                get() { return window.__media(this)[key]; },
                set(value) { window.__media(this)[key] = value; },
            });
        }
        window.__loads = [];
        HTMLMediaElement.prototype.load = function load() {
            const state = window.__media(this);
            state.currentTime = 0;
            state.paused = true;
            state.ended = false;
            state.readyState = window.__standbyNotReady && this.id === 'playerStandby' ? 1 : 4;
            window.__loads.push(this.querySelector('source')?.getAttribute('src') || null);
            if (this.querySelector('source')) queueMicrotask(() => {
                this.dispatchEvent(new Event('loadedmetadata'));
                this.dispatchEvent(new Event('canplay'));
            });
        };
        HTMLMediaElement.prototype.pause = function pause() {
            if (window.__media(this).paused) return;
            window.__media(this).paused = true;
            this.dispatchEvent(new Event('pause'));
        };
        HTMLMediaElement.prototype.play = function play() {
            if (this.id === 'playerStandby' && window.__denyStandby) {
                return Promise.reject(new DOMException('Gesture required', 'NotAllowedError'));
            }
            window.__media(this).paused = false;
            this.dispatchEvent(new Event('play'));
            queueMicrotask(() => this.dispatchEvent(new Event('playing')));
            return Promise.resolve();
        };
    });
    for (const id of ['fade-old', 'fade-current']) {
        await seed(page, {
            id, name: `${id}.mp4`, status: 'finished', file: true,
            resolution: '720p', duration_seconds: 30, media_metadata_probed: true,
        });
    }
    await refresh(page);
});

async function start(page, mode = 'sequential') {
    await page.evaluate(mode => startEndlessPlayback(
        mode === 'sequential' ? 'fade-current' : null, 'Current', 'mp4', mode,
    ), mode);
    await expect.poll(() => page.evaluate(() => endlessPlayback.sessionId)).not.toBeNull();
    await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
}

async function clock(page, seconds, standbySeconds = null) {
    await page.evaluate(({ seconds, standbySeconds }) => {
        const outgoing = playerPreparation?.outgoing || document.getElementById('playerVideo');
        outgoing.currentTime = seconds;
        if (standbySeconds !== null && playerPreparation) {
            playerPreparation.incoming.currentTime = standbySeconds;
        }
        outgoing.dispatchEvent(new Event('timeupdate'));
    }, { seconds, standbySeconds });
}

async function prepare(page) {
    await clock(page, 20);
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
}

async function fade(page) {
    await prepare(page);
    await clock(page, 27);
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
}

for (const mode of ['sequential', 'shuffle']) {
    test(`${mode} prepares at ten seconds and blends the final three seconds without restarting`, async ({ page }) => {
        const prepares = [];
        const advances = [];
        page.on('request', request => {
            if (request.url().endsWith('/prepare')) prepares.push(request);
            if (request.url().endsWith('/advance')) advances.push(request);
        });
        await start(page, mode);
        const first = await page.evaluate(() => endlessPlayback.currentDownloadId);
        await page.locator('#playerVideo').evaluate(video => { video.volume = 0.8; });
        await clock(page, 19);
        expect(prepares).toHaveLength(0);
        await prepare(page);
        expect(prepares).toHaveLength(1);
        expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(0);
        await expect(page.locator('#playerStandby')).toHaveAttribute('preload', 'auto');
        await expect(page.locator('#playerStandby')).toHaveAttribute('aria-hidden', 'true');
        await expect(page.locator('#playerStandby source')).toHaveAttribute('type', 'video/mp4');
        await clock(page, 27);
        await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
        expect(await page.evaluate(() => endlessPlayback.currentDownloadId)).not.toBe(first);
        expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(1);
        await clock(page, 28.5, 1.5);
        const overlap = await page.evaluate(() => ({
            opacity: Number(document.getElementById('playerVideo').style.opacity),
            oldOpacity: getComputedStyle(document.getElementById('playerStandby')).opacity,
            volumes: [playerPreparation.outgoing.volume, playerPreparation.incoming.volume],
            moving: !playerPreparation.outgoing.paused && !playerPreparation.incoming.paused,
            controls: [playerPreparation.outgoing.controls, playerPreparation.incoming.controls],
        }));
        expect(overlap.opacity).toBeCloseTo(0.5);
        expect(overlap.oldOpacity).toBe('1');
        expect(overlap.volumes[0]).toBeCloseTo(0.8 * Math.SQRT1_2);
        expect(overlap.volumes[1]).toBeCloseTo(0.8 * Math.SQRT1_2);
        expect(overlap.moving).toBe(true);
        expect(overlap.controls).toEqual([false, false]);
        await clock(page, 30, 3);
        await expect.poll(() => page.evaluate(() => playerPreparation)).toBeNull();
        expect(await page.locator('#playerVideo').evaluate(video => video.currentTime)).toBe(3);
        expect(await page.locator('#playerVideo').evaluate(video => video.volume)).toBeCloseTo(0.8);
        await expect(page.locator('#playerStandby source')).toHaveCount(0);
        expect(advances).toHaveLength(1);
        const rows = await (await page.request.get('/api/library')).json();
        expect(rows.reduce((sum, row) => sum + row.view_count, 0)).toBe(1);
        await page.evaluate(() => closePlayer());
        await expect(page.locator('#playerMediaStage source')).toHaveCount(0);
        expect(await page.locator('#playerMediaStage video').count()).toBe(2);
    });
}

test('pause, resume, rate, volume, mute, and seeking operate on the incoming item', async ({ page }) => {
    await start(page);
    await fade(page);
    await clock(page, 28.5, 1.5);
    await page.evaluate(() => togglePlayerPlayback());
    expect(await page.evaluate(() => [playerPreparation.outgoing.paused, playerPreparation.incoming.paused]))
        .toEqual([true, true]);
    await page.evaluate(() => togglePlayerPlayback());
    expect(await page.evaluate(() => [playerPreparation.outgoing.paused, playerPreparation.incoming.paused]))
        .toEqual([false, false]);
    await page.locator('#playerVideo').evaluate(video => {
        video.volume = 0.4;
        video.muted = true;
        video.playbackRate = 1.5;
    });
    await expect.poll(() => page.evaluate(() => playerPreparation.baseVolume)).toBeCloseTo(0.4);
    const state = await page.evaluate(() => ({
        volumes: [playerPreparation.outgoing.volume, playerPreparation.incoming.volume],
        muted: [playerPreparation.outgoing.muted, playerPreparation.incoming.muted],
        rates: [playerPreparation.outgoing.playbackRate, playerPreparation.incoming.playbackRate],
    }));
    state.volumes.forEach(volume => expect(volume).toBeCloseTo(0.4 * Math.SQRT1_2));
    expect(state.muted).toEqual([true, true]);
    expect(state.rates).toEqual([1.5, 1.5]);
    await page.locator('#playerVideo').evaluate(video => {
        video.currentTime = 12;
        video.dispatchEvent(new Event('seeking'));
    });
    await expect(page.locator('#playerStandby source')).toHaveCount(0);
    expect(await page.locator('#playerVideo').evaluate(video => video.currentTime)).toBe(12);
    expect(await page.locator('#playerVideo').evaluate(video => video.volume)).toBeCloseTo(0.4);
});

test('reduced motion switches the picture while retaining the audio fade', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await start(page);
    await fade(page);
    await clock(page, 28.5, 1.5);
    await expect(page.locator('#playerVideo')).toHaveCSS('opacity', '1');
    expect(await page.locator('#playerVideo').evaluate(video => video.volume)).toBeCloseTo(Math.SQRT1_2);
});

test('late buffering shortens the fade and preserves elapsed incoming playback', async ({ page }) => {
    await page.evaluate(() => { window.__standbyNotReady = true; });
    await start(page);
    await prepare(page);
    await clock(page, 27);
    expect(await page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(false);
    await clock(page, 28);
    await page.locator('#playerStandby').evaluate(video => {
        video.readyState = 4;
        video.dispatchEvent(new Event('canplay'));
    });
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
    expect(await page.evaluate(() => playerPreparation.fadeDuration)).toBe(2);
    await clock(page, 29, 1);
    await expect(page.locator('#playerVideo')).toHaveCSS('opacity', '0.5');
    await clock(page, 30, 2);
    expect(await page.locator('#playerVideo').evaluate(video => video.currentTime)).toBe(2);
});

for (const failure of ['preload', 'denied', 'not-ready', 'too-late', 'webkit', 'locked-volume', 'incoming-short', 'incoming-unknown']) {
    test(`${failure} leaves the outgoing video until ended and reuses its element`, async ({ page }) => {
        await start(page);
        await page.evaluate(failure => {
            window.__originalPlayer = document.getElementById('playerVideo');
            if (failure === 'denied') window.__denyStandby = true;
            if (failure === 'not-ready' || failure === 'too-late') window.__standbyNotReady = true;
            if (failure === 'webkit') endlessPlayback.presentation = 'webkit-fullscreen';
            const standby = document.getElementById('playerStandby');
            if (failure === 'locked-volume') Object.defineProperty(standby, 'volume', {
                configurable: true, get: () => 1, set() {},
            });
            if (failure === 'incoming-short') standby.duration = 3;
            if (failure === 'incoming-unknown') standby.duration = Infinity;
        }, failure);
        await prepare(page);
        if (failure === 'preload') await page.locator('#playerStandby').dispatchEvent('error');
        await clock(page, failure === 'too-late' ? 29.5 : 27);
        if (failure === 'too-late') await page.locator('#playerStandby').evaluate(video => {
            video.readyState = 4;
            video.dispatchEvent(new Event('canplay'));
        });
        if (failure === 'denied') await expect.poll(() => page.evaluate(() => playerPreparation.disabled)).toBe(true);
        expect(await page.evaluate(() => document.getElementById('playerVideo') === window.__originalPlayer)).toBe(true);
        expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
        await page.locator('#playerVideo').evaluate(video => {
            video.ended = true;
            video.dispatchEvent(new Event('ended'));
        });
        await expect.poll(() => page.evaluate(() => endlessPlayback.sequence)).toBe(1);
        expect(await page.evaluate(() => document.getElementById('playerVideo') === window.__originalPlayer)).toBe(true);
        await expect(page.locator('#playerStandby source')).toHaveCount(0);
    });
}

test('incoming stall restores outgoing and offers retry for the committed Shuffle item', async ({ page }) => {
    await start(page, 'shuffle');
    await fade(page);
    const committed = await page.evaluate(() => endlessPlayback.currentDownloadId);
    await page.locator('#playerVideo').dispatchEvent('waiting');
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
    await page.locator('#playerVideo').evaluate(video => {
        video.ended = true;
        video.dispatchEvent(new Event('ended'));
    });
    await expect(page.locator('#playerRetry')).toBeVisible();
    expect(await page.evaluate(() => endlessPlayback.currentDownloadId)).toBe(committed);
    expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(1);
    await page.locator('#playerRetry').click();
    await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
    expect(await page.evaluate(() => endlessPlayback.currentDownloadId)).toBe(committed);
});

test('unknown duration and pause defer preparation; seeking into the final seconds prepares once', async ({ page }) => {
    await start(page);
    await page.locator('#playerVideo').evaluate(video => {
        video.duration = Infinity;
        video.currentTime = 20;
        video.dispatchEvent(new Event('timeupdate'));
    });
    expect(await page.evaluate(() => playerPreparation)).toBeNull();
    await page.locator('#playerVideo').evaluate(video => {
        video.duration = 8;
        video.pause();
        video.currentTime = 0;
        video.dispatchEvent(new Event('timeupdate'));
    });
    expect(await page.evaluate(() => playerPreparation)).toBeNull();
    await page.locator('#playerVideo').evaluate(video => video.play());
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    const reserved = await page.locator('#playerStandby source').getAttribute('src');
    await page.locator('#playerVideo').evaluate(video => {
        video.currentTime = 1;
        video.dispatchEvent(new Event('seeking'));
        video.dispatchEvent(new Event('seeked'));
    });
    expect(await page.locator('#playerStandby source').getAttribute('src')).toBe(reserved);
});

test('close while prepare is pending ignores its response and clears both sources', async ({ page }) => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let requested;
    const arrived = new Promise(resolve => { requested = resolve; });
    await page.route('**/api/playback-sessions/*/prepare', async route => {
        const response = await route.fetch();
        requested();
        await held;
        await route.fulfill({ response }).catch(() => {});
    });
    await start(page);
    await clock(page, 20);
    await arrived;
    await page.evaluate(() => closePlayer());
    release();
    await expect(page.locator('#playerMediaStage source')).toHaveCount(0);
    expect(await page.evaluate(() => endlessPlayback.sessionId)).toBeNull();
    expect(await page.evaluate(() => playerPreparation)).toBeNull();
});

test('Stop during overlap completes the switch and releases standby while preserving current', async ({ page }) => {
    await start(page);
    await fade(page);
    const incoming = await page.evaluate(() => endlessPlayback.currentDownloadId);
    await clock(page, 28, 1);
    await page.evaluate(() => stopEndlessPlayback());
    expect(await page.evaluate(() => endlessPlayback.active)).toBe(false);
    await expect(page.locator('#playerStandby source')).toHaveCount(0);
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', `/api/file/${incoming}`);
    expect(await page.locator('#playerVideo').evaluate(video => video.currentTime)).toBe(1);
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
});

test('standard fullscreen uses the stable media stage across the swap', async ({ page }) => {
    await start(page);
    await page.evaluate(() => requestPlayerFullscreen());
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('playerContainer');
    await fade(page);
    await expect(page.getByRole('button', { name: 'Close player', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe('playerContainer');
    await page.evaluate(() => document.exitFullscreen());
    await expect(page.locator('#playerReturnFullscreen')).toBeVisible();
    expect(await page.evaluate(() => endlessPlayback.active)).toBe(true);
});

test('a changed live Shuffle pool discards the prepared media and uses the committed replacement at ended', async ({ page }) => {
    await start(page, 'shuffle');
    await prepare(page);
    const reserved = await page.evaluate(() => playerPreparation.item.id);
    await page.request.post('/__test__/row', { data: { id: reserved, status: 'error' } });
    await seed(page, {
        id: 'replacement', name: 'replacement.mp4', status: 'finished', file: true,
        resolution: '720p', duration_seconds: 30, media_metadata_probed: true,
    });
    await clock(page, 27);
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.response))).toBe(true);
    const replacement = await page.evaluate(() => playerPreparation.data.item.id);
    expect(replacement).not.toBe(reserved);
    await expect(page.locator('#playerStandby source')).toHaveCount(0);
    expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(0);
    await page.locator('#playerVideo').dispatchEvent('ended');
    await expect.poll(() => page.evaluate(() => endlessPlayback.currentDownloadId)).toBe(replacement);
    expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(1);
});

for (const status of [204, 404, 500]) {
    test(`early advance ${status} preserves outgoing until ended and then exposes recovery`, async ({ page }) => {
        await page.route('**/api/playback-sessions/*/advance', route => route.fulfill({
            status, ...(status === 204 ? {} : { json: { error: 'Advance failed' } }),
        }));
        await start(page);
        await prepare(page);
        await clock(page, 27);
        await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.response))).toBe(true);
        expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
        expect(await page.evaluate(() => endlessPlayback.currentDownloadId)).toBe('fade-current');
        await expect(page.locator('#playerTransition')).toBeHidden();
        await page.locator('#playerVideo').dispatchEvent('ended');
        const action = status === 404 ? '#playerRestart' : status === 500 ? '#playerRetry' : '#playerTransitionClose';
        await expect(page.locator(action)).toBeVisible();
        await expect(page.locator('#playerStandby source')).toHaveCount(0);
    });
}

test('a late advance after close cannot start or reveal its reserved video', async ({ page }) => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let arrived;
    const requested = new Promise(resolve => { arrived = resolve; });
    await page.route('**/api/playback-sessions/*/advance', async route => {
        const response = await route.fetch();
        arrived();
        await held;
        await route.fulfill({ response }).catch(() => {});
    });
    await start(page);
    await prepare(page);
    await clock(page, 27);
    await requested;
    await page.evaluate(() => closePlayer());
    release();
    await expect(page.locator('#playerMediaStage source')).toHaveCount(0);
    expect(await page.evaluate(() => playerPreparation)).toBeNull();
    await expect(page.locator('#playerBackdrop')).not.toHaveClass(/open/);
});

test('seeking while advance is pending keeps the reservation for the ordinary handoff', async ({ page }) => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let arrived;
    const requested = new Promise(resolve => { arrived = resolve; });
    await page.route('**/api/playback-sessions/*/advance', async route => {
        const response = await route.fetch();
        arrived();
        await held;
        await route.fulfill({ response });
    });
    await start(page);
    await prepare(page);
    await clock(page, 27);
    await requested;
    await page.locator('#playerVideo').evaluate(video => {
        video.currentTime = 12;
        video.dispatchEvent(new Event('seeking'));
        video.dispatchEvent(new Event('seeked'));
    });
    release();
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.response))).toBe(true);
    expect(await page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(false);
    expect(await page.evaluate(() => endlessPlayback.currentDownloadId)).toBe('fade-current');
    await page.locator('#playerVideo').dispatchEvent('ended');
    await expect.poll(() => page.evaluate(() => endlessPlayback.currentDownloadId)).toBe('fade-old');
});

test('play promise fulfillment without playing does not switch the logical current video', async ({ page }) => {
    await page.evaluate(() => {
        const original = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function play() {
            if (this.id === 'playerStandby') return Promise.resolve();
            return original.call(this);
        };
    });
    await start(page);
    await prepare(page);
    await clock(page, 27);
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.playResolved))).toBe(true);
    expect(await page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(false);
    expect(await page.evaluate(() => endlessPlayback.currentDownloadId)).toBe('fade-current');
    await page.locator('#playerVideo').dispatchEvent('ended');
    await expect.poll(() => page.evaluate(() => endlessPlayback.currentDownloadId)).toBe('fade-old');
});

test('a second handoff reuses the two connected nodes and layers incoming above outgoing', async ({ page }) => {
    await start(page);
    await page.evaluate(() => { window.__mediaNodes = [...document.querySelectorAll('#playerMediaStage video')]; });
    await fade(page);
    await clock(page, 30, 3);
    await fade(page);
    await clock(page, 28.5, 1.5);
    expect(await page.locator('#playerVideo').evaluate(video => getComputedStyle(video).position)).toBe('relative');
    expect(await page.locator('#playerVideo').evaluate(video => getComputedStyle(video).zIndex)).toBe('1');
    expect(await page.evaluate(() => window.__mediaNodes.every(video => video.isConnected))).toBe(true);
    expect(await page.locator('#playerMediaStage video').count()).toBe(2);
    await page.evaluate(() => closePlayer());
    await expect(page.locator('#playerMediaStage source')).toHaveCount(0);
});

test('a moving current clock remains eligible with current data, while waiting defers preparation', async ({ page }) => {
    await start(page);
    await page.locator('#playerVideo').evaluate(video => {
        video.readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
        video.currentTime = 20;
        video.dispatchEvent(new Event('waiting'));
    });
    await clock(page, 20);
    expect(await page.evaluate(() => playerPreparation)).toBeNull();
    await clock(page, 21);
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    await clock(page, 27);
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
});

test('Shuffle Clips uses excerpt time for a half-length fade and retains volume, rate, and pause controls', async ({ page }) => {
    await page.evaluate(() => { Math.random = () => 0; });
    await start(page, 'shuffle_clips');
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    await clock(page, 12.5);
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
    expect(await page.evaluate(() => playerPreparation.fadeDuration)).toBe(2.5);
    await clock(page, 13.75, 11.25);
    await page.locator('#playerVideo').evaluate(video => {
        video.volume = 0.6;
        video.playbackRate = 2;
        video.muted = true;
    });
    await expect.poll(() => page.evaluate(() => playerPreparation.baseVolume)).toBeCloseTo(0.6);
    const controls = await page.evaluate(() => ({
        rates: [playerPreparation.outgoing.playbackRate, playerPreparation.incoming.playbackRate],
        mute: [playerPreparation.outgoing.muted, playerPreparation.incoming.muted],
        bounds: [playerBoundaries.get(playerPreparation.incoming).start, playerBoundaries.get(playerPreparation.incoming).end],
    }));
    expect(controls.rates).toEqual([2, 2]);
    expect(controls.mute).toEqual([true, true]);
    expect(controls.bounds).toEqual([10, 15]);
    await page.evaluate(() => togglePlayerPlayback());
    expect(await page.evaluate(() => [playerPreparation.outgoing.paused, playerPreparation.incoming.paused])).toEqual([true, true]);
    const opacity = await page.locator('#playerVideo').evaluate(video => video.style.opacity);
    await page.waitForTimeout(100);
    expect(await page.locator('#playerVideo').evaluate(video => video.style.opacity)).toBe(opacity);
    await page.evaluate(() => togglePlayerPlayback());
    expect(await page.evaluate(() => [playerPreparation.outgoing.paused, playerPreparation.incoming.paused])).toEqual([false, false]);
    await page.evaluate(() => {
        // Native pause events are queued, so buffering may resolve before they arrive.
        HTMLMediaElement.prototype.pause = function pause() {
            const state = window.__media(this);
            if (state.paused) return;
            state.paused = true;
            setTimeout(() => this.dispatchEvent(new Event('pause')), 0);
        };
        document.getElementById('playerVideo').dispatchEvent(new Event('waiting'));
    });
    expect(await page.evaluate(() => [playerPreparation.outgoing.paused, playerPreparation.incoming.paused])).toEqual([true, true]);
    await page.locator('#playerVideo').dispatchEvent('canplay');
    await page.waitForTimeout(50);
    await expect.poll(() => page.evaluate(() => [playerPreparation.outgoing.paused, playerPreparation.incoming.paused])).toEqual([false, false]);
});

const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');

// Model seek completion separately from metadata so a play at 0:00 cannot pass.
async function installClipMedia(page, duration = 60) {
    await page.evaluate(duration => {
        const states = new WeakMap();
        window.__clipState = video => {
            if (!states.has(video)) states.set(video, {
                duration, currentTime: 0, readyState: 0, paused: true,
                ended: false, seeking: false, token: 0,
            });
            return states.get(video);
        };
        window.__clipLoads = [];
        window.__clipPlays = [];
        window.__clipDraws = [0, 0];
        Math.random = () => window.__clipDraws.length ? window.__clipDraws.shift() : 0;
        for (const key of ['duration', 'readyState', 'paused', 'ended', 'seeking']) {
            Object.defineProperty(HTMLMediaElement.prototype, key, {
                configurable: true,
                get() { return window.__clipState(this)[key]; },
                set(value) { window.__clipState(this)[key] = value; },
            });
        }
        Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
            configurable: true,
            get() { return window.__clipState(this).currentTime; },
            set(value) {
                const state = window.__clipState(this);
                if (window.__clipSeekFails) throw new DOMException('Cannot seek', 'InvalidStateError');
                state.currentTime = value;
                if (!state.readyState) return;
                state.seeking = true;
                const token = ++state.token;
                this.dispatchEvent(new Event('seeking'));
                const finish = () => {
                    if (token !== state.token) return;
                    state.seeking = false;
                    this.dispatchEvent(new Event('seeked'));
                    this.dispatchEvent(new Event('canplay'));
                };
                if (window.__clipHoldSeek) window.__clipFinishSeek = finish;
                else queueMicrotask(finish);
            },
        });
        HTMLMediaElement.prototype.load = function load() {
            const state = window.__clipState(this);
            state.token += 1;
            state.currentTime = 0;
            state.readyState = 0;
            state.paused = true;
            state.seeking = false;
            state.ended = false;
            const source = this.querySelector('source');
            if (!source) return;
            const id = source.getAttribute('src').split('/').pop();
            window.__clipLoads.push(id);
            const metadata = () => {
                state.duration = window.__clipDurations?.[id] ?? duration;
                state.readyState = this.id === 'playerStandby' && window.__clipStandbyNotReady ? 1 : 4;
                this.dispatchEvent(new Event('loadedmetadata'));
                this.dispatchEvent(new Event('canplay'));
            };
            if (window.__clipHoldMetadata) window.__clipMetadata = metadata;
            else queueMicrotask(metadata);
        };
        HTMLMediaElement.prototype.play = function play() {
            const state = window.__clipState(this);
            window.__clipPlays.push({
                id: this.id, time: state.currentTime, seeking: state.seeking,
                ready: state.readyState,
            });
            state.paused = false;
            this.dispatchEvent(new Event('play'));
            queueMicrotask(() => this.dispatchEvent(new Event('playing')));
            return Promise.resolve();
        };
        HTMLMediaElement.prototype.pause = function pause() {
            const state = window.__clipState(this);
            if (state.paused) return;
            state.paused = true;
            this.dispatchEvent(new Event('pause'));
        };
    }, duration);
}

async function startClips(page, { count = 2, duration = 60 } = {}) {
    for (let index = 0; index < count; index += 1) {
        await seed(page, {
            id: `clip-${index}`, status: 'finished', file: true,
            resolution: '720p', duration_seconds: duration, media_metadata_probed: true,
        });
    }
    await refresh(page);
    await page.evaluate(() => startEndlessPlayback(null, '', '', 'shuffle_clips'));
    await expect.poll(() => page.evaluate(() => endlessPlayback.sessionId)).not.toBeNull();
}

async function clipBounds(page, selector = '#playerVideo') {
    return page.locator(selector).evaluate(video => {
        const boundary = playerBoundaries.get(video);
        return { start: boundary.start, end: boundary.end, time: video.currentTime };
    });
}

async function clipTick(page, outgoingTime, incomingTime = null) {
    await page.evaluate(({ outgoingTime, incomingTime }) => {
        const outgoing = playerPreparation?.outgoing || document.getElementById('playerVideo');
        window.__clipState(outgoing).currentTime = outgoingTime;
        if (incomingTime !== null && playerPreparation) {
            window.__clipState(playerPreparation.incoming).currentTime = incomingTime;
        }
        outgoing.dispatchEvent(new Event('timeupdate'));
    }, { outgoingTime, incomingTime });
}

test.beforeEach(async ({ page }) => reset(page));

test('clip sampling uses both feasible uniform ranges, including short and invalid media', async ({ page }) => {
    const samples = await page.evaluate(() => {
        const durations = [120, 40, 20, 8, 7.5];
        return durations.flatMap(duration => [0, 0.5, 1].flatMap(startDraw =>
            [0, 0.5, 1].map(lengthDraw => {
                const draws = [startDraw, lengthDraw];
                return { duration, startDraw, lengthDraw, bounds: sampleShuffleClip(duration, () => draws.shift()) };
            })));
    });
    for (const { duration, startDraw, lengthDraw, bounds } of samples) {
        const start = duration / 3 + startDraw * (Math.min(7 * duration / 8, duration - 5) - duration / 3);
        const length = 5 + lengthDraw * (Math.min(20, duration - start) - 5);
        expect(bounds.start).toBeCloseTo(start, 10);
        expect(bounds.length).toBeCloseTo(length, 10);
        expect(bounds.end).toBeCloseTo(start + length, 10);
        expect(bounds.start).toBeGreaterThanOrEqual(duration / 3 - 1e-10);
        expect(bounds.start).toBeLessThanOrEqual(7 * duration / 8 + 1e-10);
        expect(bounds.length).toBeGreaterThanOrEqual(5 - 1e-10);
        expect(bounds.length).toBeLessThanOrEqual(20 + 1e-10);
        expect(bounds.end).toBeLessThanOrEqual(duration + 1e-10);
    }
    expect(await page.evaluate(() => [7.49, 0, -1, NaN, Infinity].map(value => sampleShuffleClip(value))))
        .toEqual([null, null, null, null, null]);
});

test('initial metadata and seek finish before playback; duplicate events retain the occurrence', async ({ page }) => {
    await installClipMedia(page);
    await page.evaluate(() => { window.__clipHoldSeek = true; });
    await startClips(page);
    await expect.poll(() => page.evaluate(() => Boolean(window.__clipFinishSeek))).toBe(true);
    expect(await page.evaluate(() => window.__clipPlays)).toEqual([]);
    expect(await clipBounds(page)).toEqual({ start: 20, end: 25, time: 20 });
    await page.evaluate(() => { window.__clipHoldSeek = false; window.__clipFinishSeek(); });
    await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
    await page.locator('#playerVideo').evaluate(video => {
        video.dispatchEvent(new Event('loadedmetadata'));
        video.dispatchEvent(new Event('durationchange'));
        video.pause();
        video.play();
    });
    expect(await clipBounds(page)).toEqual({ start: 20, end: 25, time: 20 });
    const plays = await page.evaluate(() => window.__clipPlays);
    expect(plays.length).toBeGreaterThan(0);
    plays.forEach(play => {
        expect(play.time).toBeGreaterThanOrEqual(20);
        expect(play.seeking).toBe(false);
        expect(play.ready).toBeGreaterThanOrEqual(3);
    });
});

test('five-second excerpts preload immediately and preserve bounds through consecutive half-length fades', async ({ page }) => {
    await installClipMedia(page);
    const advances = [];
    page.on('request', request => { if (request.url().endsWith('/advance')) advances.push(request); });
    await startClips(page);
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    const prepared = await clipBounds(page, '#playerStandby');
    expect(prepared).toEqual({ start: 20, end: 25, time: 20 });
    expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(0);
    const before = await (await page.request.get('/api/library')).json();
    expect(before.reduce((sum, row) => sum + row.view_count, 0)).toBe(1);
    await clipTick(page, 22.5);
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
    expect(await page.evaluate(() => playerPreparation.fadeDuration)).toBe(2.5);
    expect(await clipBounds(page)).toEqual(prepared);
    await clipTick(page, 23.75, 21.25);
    const overlap = await page.evaluate(() => ({
        opacity: Number(document.getElementById('playerVideo').style.opacity),
        volumes: [playerPreparation.outgoing.volume, playerPreparation.incoming.volume],
        moving: !playerPreparation.outgoing.paused && !playerPreparation.incoming.paused,
    }));
    expect(overlap.opacity).toBeCloseTo(0.5);
    overlap.volumes.forEach(volume => expect(volume).toBeCloseTo(Math.SQRT1_2));
    expect(overlap.moving).toBe(true);
    await clipTick(page, 25, 22.5);
    await expect.poll(() => page.evaluate(() => endlessPlayback.sequence)).toBe(2);
    expect(await page.evaluate(() => playerPreparation.outgoing.currentTime)).toBe(22.5);
    expect(await page.evaluate(() => playerPreparation.fadeDuration)).toBe(2.5);
    expect((await clipBounds(page)).time).toBe(20);
    expect(await page.locator('#playerMediaStage video').count()).toBe(2);
    expect(advances).toHaveLength(2);
    await page.evaluate(() => closePlayer());
    await expect(page.locator('#playerMediaStage source')).toHaveCount(0);
});

test('a one-video pool draws again for a new occurrence and never redraws on seeks', async ({ page }) => {
    await installClipMedia(page);
    await page.evaluate(() => { window.__clipDraws = [0, 0, 0.5, 0.5]; });
    await startClips(page, { count: 1 });
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    const next = await clipBounds(page, '#playerStandby');
    expect(next.start).toBeCloseTo(36.25);
    expect(next.end).toBeCloseTo(48.75);
    await page.locator('#playerVideo').evaluate(video => { video.currentTime = 1; });
    await expect.poll(() => clipBounds(page)).toEqual({ start: 20, end: 25, time: 20 });
    await page.locator('#playerVideo').evaluate(video => { video.currentTime = 21; });
    expect(await clipBounds(page)).toEqual({ start: 20, end: 25, time: 21 });
    await clipTick(page, 22.5);
    await expect.poll(() => page.evaluate(() => endlessPlayback.sequence)).toBe(1);
    expect(await clipBounds(page)).toEqual(next);
});

for (const failure of ['duration', 'seek']) {
    test(`${failure} failures exhaust each candidate once without full-video playback`, async ({ page }) => {
        await installClipMedia(page, failure === 'duration' ? 7 : 60);
        if (failure === 'seek') await page.evaluate(() => { window.__clipSeekFails = true; });
        await startClips(page);
        await expect(page.locator('#playerRetry')).toBeVisible();
        const loads = await page.evaluate(() => window.__clipLoads);
        expect(loads).toHaveLength(2);
        expect(new Set(loads).size).toBe(2);
        expect(await page.evaluate(() => window.__clipPlays)).toEqual([]);
    });
}

test('failed preloads retry and fullscreen fallback promotes ready media exactly once', async ({ page }) => {
    await installClipMedia(page);
    await startClips(page);
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    await page.evaluate(() => { endlessPlayback.presentation = 'webkit-fullscreen'; });
    await page.locator('#playerStandby').dispatchEvent('error');
    await clipTick(page, 22.4);
    expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(0);
    await clipTick(page, 22.5);
    await expect.poll(() => page.evaluate(() => endlessPlayback.sequence)).toBe(1);
    expect((await clipBounds(page)).time).toBe(20);
    await page.locator('#playerVideo').dispatchEvent('ended');
    expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(1);
    await page.evaluate(() => closePlayer());
    await page.locator('#playerVideo').dispatchEvent('loadedmetadata');
    await page.locator('#playerVideo').dispatchEvent('seeked');
    await expect(page.locator('#playerMediaStage source')).toHaveCount(0);
});

test('unusable metadata times out once per candidate and remains recoverable', async ({ page }) => {
    await page.clock.install();
    await installClipMedia(page);
    await page.evaluate(() => { window.__clipHoldMetadata = true; });
    await startClips(page);
    await expect.poll(() => page.evaluate(() => window.__clipLoads.length)).toBe(1);
    await page.clock.fastForward(20_100);
    await expect.poll(() => page.evaluate(() => window.__clipLoads.length)).toBe(2);
    await page.clock.fastForward(20_100);
    await expect(page.locator('#playerRetry')).toBeVisible();
    const loads = await page.evaluate(() => window.__clipLoads);
    expect(new Set(loads).size).toBe(2);
    expect(await page.evaluate(() => window.__clipPlays)).toEqual([]);
    await page.evaluate(() => closePlayer());
});

test('exhausted preloads keep the outgoing clip through its endpoint and EOF with useful recovery', async ({ page }) => {
    await installClipMedia(page);
    await startClips(page);
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    const first = await page.evaluate(() => {
        window.__clipOutgoing = document.getElementById('playerVideo');
        return playerPreparation.item.id;
    });
    await page.locator('#playerStandby').dispatchEvent('error');
    await expect.poll(() => page.evaluate(() => playerPreparation?.item?.id)).not.toBe(first);
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    await page.locator('#playerStandby').dispatchEvent('error');
    await expect(page.locator('#playerRetry')).toBeVisible();
    await clipTick(page, 26);
    expect(await page.evaluate(() => document.getElementById('playerVideo') === window.__clipOutgoing)).toBe(true);
    expect(await page.evaluate(() => window.__clipOutgoing.paused)).toBe(false);
    expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(0);
    const attempts = await page.evaluate(() => window.__clipLoads.slice(1));
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts).size).toBe(2);
    await page.locator('#playerVideo').evaluate(video => {
        window.__clipState(video).currentTime = 60;
        video.ended = true;
        video.dispatchEvent(new Event('ended'));
        video.dispatchEvent(new Event('ended'));
    });
    expect(await page.locator('#playerVideo source').count()).toBe(1);
    expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(0);
    await expect(page.locator('#playerStatus')).toContainText('Retry or stop');
    await page.evaluate(() => closePlayer());
});

test('a timed-out preparation retains outgoing playback and Retry permits a fresh bounded attempt', async ({ page }) => {
    await page.clock.install();
    await installClipMedia(page);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let requested = false;
    await page.route('**/api/playback-sessions/*/prepare', async route => {
        const response = await route.fetch();
        requested = true;
        await gate;
        await route.fulfill({ response });
    });
    try {
        await startClips(page);
        await expect.poll(() => requested).toBe(true);
        await page.clock.fastForward(20_100);
        await expect(page.locator('#playerRetry')).toBeVisible();
        await clipTick(page, 26);
        expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
        expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(0);
        release();
        await page.locator('#playerRetry').press('Enter');
        await expect.poll(() => page.evaluate(() => endlessPlayback.sequence)).toBe(1);
        expect(await page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
    } finally {
        release();
        await page.evaluate(() => closePlayer());
    }
});

test('pause after incoming play resolves defers a late playing event until resume', async ({ page }) => {
    await installClipMedia(page);
    await page.evaluate(() => {
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            if (this.id !== 'playerStandby') return play.call(this);
            window.__clipState(this).paused = false;
            this.dispatchEvent(new Event('play'));
            window.__clipLatePlaying = () => this.dispatchEvent(new Event('playing'));
            return Promise.resolve();
        };
    });
    await startClips(page);
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    await clipTick(page, 22.5);
    await expect.poll(() => page.evaluate(() => playerPreparation?.playResolved)).toBe(true);
    await page.locator('#playerVideo').evaluate(video => video.pause());
    await page.evaluate(() => window.__clipLatePlaying());
    expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(0);
    expect(await page.locator('#playerStandby').evaluate(video => video.paused)).toBe(true);
    await page.locator('#playerVideo').evaluate(video => video.play());
    await expect.poll(() => page.evaluate(() => playerPreparation?.playResolved)).toBe(true);
    await page.evaluate(() => window.__clipLatePlaying());
    await expect.poll(() => page.evaluate(() => endlessPlayback.sequence)).toBe(1);
    expect(await page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
    await page.evaluate(() => closePlayer());
});

test('duration changes before initial seek completion discard bounds without redrawing or playing', async ({ page }) => {
    await installClipMedia(page);
    await page.evaluate(() => { window.__clipHoldSeek = true; });
    await startClips(page);
    await expect.poll(() => page.evaluate(() => Boolean(window.__clipFinishSeek))).toBe(true);
    const first = await page.evaluate(() => endlessPlayback.currentDownloadId);
    const original = await clipBounds(page);
    await page.locator('#playerVideo').evaluate(video => {
        video.duration = 30;
        video.dispatchEvent(new Event('durationchange'));
    });
    expect(await clipBounds(page)).toEqual(original);
    await page.locator('#playerVideo').evaluate(video => {
        video.duration = 90;
        video.dispatchEvent(new Event('durationchange'));
    });
    await expect.poll(() => page.evaluate(() => endlessPlayback.currentDownloadId)).not.toBe(first);
    expect(await page.evaluate(() => window.__clipPlays)).toEqual([]);
    await page.evaluate(() => closePlayer());
});

test('a committed replacement discards stale prepared bounds and seeks its own excerpt before fading', async ({ page }) => {
    await installClipMedia(page);
    await page.evaluate(() => { window.__clipDraws = [0, 0, 0.5, 0.5, 0.75, 0.25]; });
    await startClips(page, { count: 3 });
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    const reserved = await page.evaluate(() => playerPreparation.item.id);
    const staleBounds = await clipBounds(page, '#playerStandby');
    expect(staleBounds.start).toBe(36.25);
    await page.request.post('/__test__/row', { data: { id: reserved, status: 'error' } });
    await clipTick(page, 22.5);
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.response))).toBe(true);
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
    await expect.poll(() => page.evaluate(() => endlessPlayback.sequence)).toBe(1);
    expect(await page.evaluate(() => endlessPlayback.currentDownloadId)).not.toBe(reserved);
    const committed = await clipBounds(page);
    expect(committed.start).toBe(44.375);
    expect(committed.start).not.toBe(staleBounds.start);
    expect(committed.time).toBe(committed.start);
    await clipTick(page, 25, committed.start + 2.5);
});

test('a failed fade retries the committed occurrence with its original excerpt bounds', async ({ page }) => {
    await installClipMedia(page);
    await page.evaluate(() => { window.__clipDraws = [0, 0, 0.5, 0.5]; });
    await startClips(page);
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    const prepared = await clipBounds(page, '#playerStandby');
    await clipTick(page, 22.5);
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
    await page.locator('#playerVideo').dispatchEvent('error');
    await clipTick(page, 25);
    expect(await page.evaluate(() => playerPreparation.outgoing.paused)).toBe(false);
    await clipTick(page, 60);
    await page.locator('#playerVideo').evaluate(video => {
        video.ended = true;
        video.dispatchEvent(new Event('ended'));
    });
    await expect(page.locator('#playerRetry')).toBeVisible();
    expect((await clipBounds(page)).start).toBe(prepared.start);
    expect((await clipBounds(page)).end).toBe(prepared.end);
    await page.locator('#playerRetry').click();
    await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
    expect(await clipBounds(page)).toEqual(prepared);
    expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(1);
});

test('duration invalidation after an adopted fade recovers and automatic occurrences do not add views', async ({ page }) => {
    await installClipMedia(page);
    await page.evaluate(() => { window.__clipDraws = [0, 0, 0.5, 1]; });
    await startClips(page);
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    await clipTick(page, 22.5);
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
    await clipTick(page, 25, 38.75);
    await expect.poll(() => page.evaluate(() => playerPreparation)).toBeNull();
    const adoptedId = await page.evaluate(() => endlessPlayback.currentDownloadId);
    const rows = await (await page.request.get('/api/library')).json();
    expect(rows.reduce((sum, row) => sum + row.view_count, 0)).toBe(1);
    await page.locator('#playerVideo').evaluate(video => {
        video.duration = 120;
        video.dispatchEvent(new Event('durationchange'));
    });
    await expect.poll(() => page.evaluate(() => endlessPlayback.currentDownloadId)).not.toBe(adoptedId);
    await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
});

test('seeking to the excerpt end before initial readiness advances once and cannot resume stale playback', async ({ page }) => {
    await installClipMedia(page);
    await page.evaluate(() => { window.__clipHoldSeek = true; });
    await startClips(page);
    await expect.poll(() => page.evaluate(() => Boolean(window.__clipFinishSeek))).toBe(true);
    await page.locator('#playerVideo').evaluate(video => {
        window.__clipStaleSeek = window.__clipFinishSeek;
        video.currentTime = playerBoundaries.get(video).end;
    });
    await expect.poll(() => page.evaluate(() => endlessPlayback.sequence)).toBe(1);
    await page.evaluate(() => window.__clipStaleSeek());
    expect(await page.evaluate(() => window.__clipPlays)).toEqual([]);
    await page.evaluate(() => {
        window.__clipHoldSeek = false;
        window.__clipFinishSeek();
    });
    await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
    expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(1);
    expect(await clipBounds(page)).toEqual({ start: 20, end: 25, time: 20 });
});

test('same-ID source replacement discards stale standby and draws bounds for the committed revision', async ({ page }) => {
    await installClipMedia(page);
    await page.evaluate(() => { window.__clipDraws = [0, 0, 0.5, 0.5, 0.75, 0.25]; });
    await page.route('**/api/playback-sessions/*/advance', async route => {
        const response = await route.fetch();
        const body = await response.json();
        body.item.source_revision = `${body.item.source_revision}-replacement`;
        await route.fulfill({ response, json: body });
    });
    await startClips(page);
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    const reserved = await page.evaluate(() => {
        window.__clipOriginalActive = document.getElementById('playerVideo');
        return playerPreparation.item.id;
    });
    const preparedBounds = await clipBounds(page, '#playerStandby');
    expect(preparedBounds.start).toBe(36.25);
    await clipTick(page, 22.5);
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.response))).toBe(true);
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
    expect(await page.evaluate(() => playerPreparation.outgoing === window.__clipOriginalActive)).toBe(true);
    await expect.poll(() => page.evaluate(() => endlessPlayback.sequence)).toBe(1);
    expect(await page.evaluate(() => endlessPlayback.currentDownloadId)).toBe(reserved);
    expect(await page.evaluate(() => document.getElementById('playerVideo') === window.__clipOriginalActive)).toBe(false);
    const committed = await clipBounds(page);
    expect(committed.start).toBe(44.375);
    expect(committed.time).toBe(committed.start);
    expect(await page.evaluate(id => window.__clipLoads.filter(loaded => loaded === id).length, reserved)).toBe(2);
});

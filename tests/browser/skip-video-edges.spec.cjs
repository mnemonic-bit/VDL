const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openSettings } = require('./support.cjs');

test.beforeEach(async ({ page }) => {
    await reset(page);
    await page.request.post('/api/preferences', { data: { skip_video_edges: true } });
    await page.evaluate(() => loadPreferences());
    await page.evaluate(() => {
        const states = new WeakMap();
        window.__edgeMedia = video => {
            if (!states.has(video)) states.set(video, {
                duration: 60, currentTime: 0, paused: true, ended: false,
                readyState: 0, seeking: false, token: 0,
            });
            return states.get(video);
        };
        for (const key of ['duration', 'paused', 'ended', 'readyState', 'seeking']) {
            Object.defineProperty(HTMLMediaElement.prototype, key, {
                configurable: true,
                get() { return window.__edgeMedia(this)[key]; },
                set(value) { window.__edgeMedia(this)[key] = value; },
            });
        }
        Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
            configurable: true,
            get() { return window.__edgeMedia(this).currentTime; },
            set(value) {
                if (window.__edgeSeekFails) throw new DOMException('Cannot seek', 'InvalidStateError');
                const state = window.__edgeMedia(this);
                state.currentTime = value;
                if (!state.readyState) return;
                state.seeking = true;
                const token = ++state.token;
                this.dispatchEvent(new Event('seeking'));
                const finish = () => {
                    if (state.token !== token) return;
                    state.seeking = false;
                    this.dispatchEvent(new Event('seeked'));
                };
                if (window.__edgeHoldSeek) window.__edgeFinishSeek = finish;
                else queueMicrotask(finish);
            },
        });
        window.__edgePlays = [];
        HTMLMediaElement.prototype.play = function play() {
            const state = window.__edgeMedia(this);
            window.__edgePlays.push({ id: this.id, time: state.currentTime, seeking: state.seeking });
            if (this.id === 'playerStandby' && window.__edgeDenyStandby) {
                return Promise.reject(new DOMException('Denied', 'NotAllowedError'));
            }
            state.paused = false;
            this.dispatchEvent(new Event('play'));
            queueMicrotask(() => this.dispatchEvent(new Event('playing')));
            return Promise.resolve();
        };
        HTMLMediaElement.prototype.pause = function pause() {
            const state = window.__edgeMedia(this);
            if (state.paused) return;
            state.paused = true;
            this.dispatchEvent(new Event('pause'));
        };
        HTMLMediaElement.prototype.load = function load() {
            const state = window.__edgeMedia(this);
            state.token += 1;
            state.currentTime = 0;
            state.paused = true;
            state.ended = false;
            state.seeking = false;
            state.readyState = 0;
            if (!this.querySelector('source')) return;
            const metadata = () => {
                state.readyState = this.id === 'playerStandby' && window.__edgeStandbyNotReady ? 1 : 4;
                this.dispatchEvent(new Event('loadedmetadata'));
                this.dispatchEvent(new Event('canplay'));
                if (this.autoplay) this.play();
            };
            if (window.__edgeHoldMetadata) window.__edgeMetadata = metadata;
            else queueMicrotask(metadata);
        };
    });
    for (const id of ['edge-old', 'edge-current']) {
        await seed(page, {
            id, name: `${id}.mp4`, status: 'finished', file: true,
            resolution: '720p', duration_seconds: 60, media_metadata_probed: true,
        });
    }
    await refresh(page);
});

async function direct(page) {
    await page.evaluate(() => playVideo('edge-current', 'Current', 'mp4'));
}

async function start(page, mode = 'sequential') {
    await page.evaluate(mode => startEndlessPlayback(
        mode === 'shuffle' ? null : 'edge-current', 'Current', 'mp4', mode,
    ), mode);
    await expect.poll(() => page.evaluate(() => endlessPlayback.sessionId)).not.toBeNull();
    await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
}

async function tick(page, seconds, incomingSeconds = null) {
    await page.evaluate(({ seconds, incomingSeconds }) => {
        const video = playerPreparation?.fade ? playerPreparation.outgoing : document.getElementById('playerVideo');
        window.__edgeMedia(video).currentTime = seconds;
        if (incomingSeconds !== null && playerPreparation) {
            window.__edgeMedia(playerPreparation.incoming).currentTime = incomingSeconds;
        }
        video.dispatchEvent(new Event('timeupdate'));
    }, { seconds, incomingSeconds });
}

async function time(page, seconds) {
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBe(seconds);
}

test('eligible direct playback waits for metadata and the start seek, then pauses and replays', async ({ page }) => {
    await page.evaluate(() => { window.__edgeHoldMetadata = true; window.__edgeHoldSeek = true; });
    await direct(page);
    expect(await page.evaluate(() => window.__edgePlays)).toEqual([]);
    await page.evaluate(() => window.__edgeMetadata());
    await time(page, 10);
    expect(await page.evaluate(() => window.__edgePlays)).toEqual([]);
    await page.evaluate(() => window.__edgeFinishSeek());
    await expect.poll(() => page.evaluate(() => window.__edgePlays.length)).toBe(1);
    expect(await page.evaluate(() => window.__edgePlays[0])).toMatchObject({ time: 10, seeking: false });
    await tick(page, 50);
    await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', true);
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    expect(await page.locator('#playerVideo').evaluate(video => video.duration)).toBe(60);
    await page.evaluate(() => { window.__edgeHoldSeek = false; togglePlayerPlayback(); });
    await time(page, 10);
    await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', false);
    const rows = await (await page.request.get('/api/history')).json();
    expect(rows.find(row => row.id === 'edge-current').duration_seconds).toBe(60);
});

for (const duration of ['20', '12', '0', 'NaN', 'Infinity']) {
    test(`duration ${duration} plays without edge skipping`, async ({ page }) => {
        await page.locator('#playerVideo').evaluate((video, duration) => { video.duration = Number(duration); }, duration);
        await direct(page);
        await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', false);
        await time(page, 0);
        await tick(page, 10);
        await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', false);
    });
}

test('late duration seeks only after metadata; unreliable later duration disables early end', async ({ page }) => {
    await page.locator('#playerVideo').evaluate(video => { video.duration = NaN; });
    await direct(page);
    await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', false);
    await page.locator('#playerVideo').evaluate(video => {
        video.duration = 60;
        video.dispatchEvent(new Event('durationchange'));
    });
    await time(page, 10);
    await page.locator('#playerVideo').evaluate(video => {
        video.duration = Infinity;
        video.dispatchEvent(new Event('durationchange'));
        video.duration = 60;
        video.dispatchEvent(new Event('durationchange'));
    });
    await tick(page, 50);
    await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', false);
});

test('manual intro and tail seeks are respected, while seeking back re-arms early finish', async ({ page }) => {
    await direct(page);
    await time(page, 10);
    await page.locator('#playerVideo').evaluate(video => { video.currentTime = 0; });
    await tick(page, 1);
    await time(page, 1);
    await page.locator('#playerVideo').evaluate(video => { video.currentTime = 55; });
    await tick(page, 59);
    await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', false);
    await page.locator('#playerVideo').evaluate(video => { video.currentTime = 30; });
    await tick(page, 50);
    await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', true);
});

test('failed start seeks continue playback instead of reporting a broken file', async ({ page }) => {
    await page.evaluate(() => { window.__edgeSeekFails = true; });
    await direct(page);
    await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', false);
    await time(page, 0);
    await expect(page.locator('#playerRetry')).toBeHidden();
});

for (const mode of ['sequential', 'shuffle']) {
    test(`${mode} pauses without advancing and falls back exactly once at the effective end`, async ({ page }) => {
        await page.evaluate(() => { window.__edgeStandbyNotReady = true; });
        const advances = [];
        page.on('request', request => { if (request.url().endsWith('/advance')) advances.push(request); });
        await start(page, mode);
        await time(page, 10);
        await page.locator('#playerVideo').evaluate(video => video.pause());
        await tick(page, 49);
        expect(advances).toHaveLength(0);
        await page.evaluate(() => togglePlayerPlayback());
        await tick(page, 50);
        await expect.poll(() => page.evaluate(() => endlessPlayback.sequence)).toBe(1);
        await time(page, 10);
        // A late ended event from the previous load cannot complete the new one.
        await page.locator('#playerVideo').dispatchEvent('ended');
        expect(advances).toHaveLength(1);
    });

    test(`${mode} prepares and fades relative to the effective end and preserves incoming time`, async ({ page }) => {
        await start(page, mode);
        await tick(page, 39);
        expect(await page.evaluate(() => playerPreparation)).toBeNull();
        await tick(page, 40);
        await expect(page.locator('#playerStandby source')).toHaveCount(1);
        await expect.poll(() => page.locator('#playerStandby').evaluate(video => video.currentTime)).toBe(10);
        await tick(page, 47);
        await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
        await tick(page, 48.5, 11.5);
        await expect(page.locator('#playerVideo')).toHaveCSS('opacity', '0.5');
        await tick(page, 50, 13);
        await expect.poll(() => page.evaluate(() => playerPreparation)).toBeNull();
        await time(page, 13);
        expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(1);
    });
}

test('a seek into the outro cancels preloading and waits for the natural end', async ({ page }) => {
    await start(page);
    await tick(page, 40);
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    await page.locator('#playerVideo').evaluate(video => { video.currentTime = 55; });
    await tick(page, 59);
    expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(0);
    expect(await page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(false);
    await page.locator('#playerVideo').evaluate(video => {
        window.__edgeMedia(video).currentTime = 60;
        video.ended = true;
        video.dispatchEvent(new Event('ended'));
    });
    await expect.poll(() => page.evaluate(() => endlessPlayback.sequence)).toBe(1);
});

test('a prepared start seek must finish before a fade can commit', async ({ page }) => {
    await start(page);
    await page.evaluate(() => { window.__edgeHoldSeek = true; });
    await tick(page, 40);
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    await tick(page, 47);
    expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(0);
    await page.evaluate(() => window.__edgeFinishSeek());
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
});

for (const resume of [0, 5, 24, 50, 55]) {
    test(`playlist resume ${resume} uses original-time bounds and records early completion`, async ({ page }) => {
        const playlist = await (await page.request.post('/api/playlists', {
            data: { name: 'Edges', download_ids: ['edge-current'] },
        })).json();
        await page.request.put(`/api/playlists/${playlist.id}/progress`, {
            data: { download_id: 'edge-current', position_seconds: resume, completed: false, write_sequence: 1 },
        });
        await page.evaluate(id => startPlaylistPlayback(id), playlist.id);
        await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
        await time(page, resume > 10 && resume < 50 ? resume : 10);
        await page.locator('#playerVideo').evaluate(video => video.pause());
        await expect.poll(async () => (await (await page.request.get(`/api/playlists/${playlist.id}`)).json()).progress.position_seconds)
            .toBe(resume > 10 && resume < 50 ? resume : 10);
        await page.evaluate(() => togglePlayerPlayback());
        await tick(page, 50);
        await expect(page.locator('#playerStatus')).toHaveText('Playlist complete.');
        expect((await (await page.request.get(`/api/playlists/${playlist.id}`)).json()).progress.completed).toBe(true);
    });
}

test('saved preference changes affect the next load, and a browser tab retains the full file URL', async ({ page }) => {
    await direct(page);
    await time(page, 10);
    await page.request.post('/api/preferences', { data: { skip_video_edges: false } });
    await page.evaluate(() => loadPreferences());
    await tick(page, 50);
    await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', true);
    await page.evaluate(() => playVideo('edge-old', 'Old', 'mp4'));
    await time(page, 0);
    await tick(page, 50);
    await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', false);
    await page.evaluate(() => {
        playerMode = 'new_tab';
        skipVideoEdges = true;
        window.open = (...args) => { window.__opened = args; };
        playVideo('edge-current', 'Current', 'mp4');
    });
    expect(await page.evaluate(() => window.__opened)).toEqual(['/api/file/edge-current', '_blank', 'noopener']);
});

test('skip setting is searchable, saved, and restored on reload and reopen', async ({ page }) => {
    await page.request.post('/api/preferences', { data: { skip_video_edges: false } });
    await openSettings(page);
    await expect(page.locator('#prefSkipVideoEdges')).not.toBeChecked();
    for (const term of ['intro', 'outro', 'advertisement', 'ads', 'skip']) {
        await page.getByRole('searchbox', { name: 'Search settings' }).fill(term);
        await expect(page.getByLabel('Skip video intro and outro', { exact: true })).toBeVisible();
    }
    await page.getByRole('searchbox', { name: 'Search settings' }).fill('');
    await page.locator('#prefSkipVideoEdges').check();
    await page.locator('#prefPlayer').selectOption('new_tab');
    await expect(page.locator('#prefSkipVideoEdges')).toBeEnabled();
    await page.locator('#saveBtn').click();
    await expect(page.locator('#saveBtn')).toContainText('Saved');
    expect((await (await page.request.get('/api/preferences')).json()).skip_video_edges).toBe('true');
    await page.reload();
    await openSettings(page);
    await expect(page.locator('#prefSkipVideoEdges')).toBeChecked();
    await page.getByRole('button', { name: 'Back to videos', exact: true }).click();
    await openSettings(page);
    await expect(page.locator('#prefSkipVideoEdges')).toBeChecked();
});

test('buffering at the boundary waits for playback and closed loads ignore late metadata', async ({ page }) => {
    await direct(page);
    await time(page, 10);
    await page.locator('#playerVideo').evaluate(video => {
        window.__edgeMedia(video).currentTime = 50;
        video.dispatchEvent(new Event('waiting'));
        video.dispatchEvent(new Event('timeupdate'));
    });
    await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', false);
    await page.locator('#playerVideo').dispatchEvent('playing');
    await tick(page, 50);
    await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', true);
    await page.evaluate(() => {
        closePlayer();
        window.__edgeHoldMetadata = true;
        window.__edgePlays = [];
        playVideo('edge-old', 'Old', 'mp4');
        closePlayer();
        window.__edgeMetadata();
    });
    expect(await page.evaluate(() => window.__edgePlays)).toEqual([]);
    await expect(page.locator('#playerBackdrop')).not.toHaveClass(/open/);
});

test('a saved setting invalidates prepared media while the current video keeps its own bounds', async ({ page }) => {
    await start(page);
    await tick(page, 40);
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    await page.request.post('/api/preferences', { data: { skip_video_edges: false } });
    await page.evaluate(() => loadPreferences());
    await expect(page.locator('#playerStandby source')).toHaveCount(0);
    await tick(page, 47);
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
    await tick(page, 50, 3);
    await expect.poll(() => page.evaluate(() => playerPreparation)).toBeNull();
    await time(page, 3);
    await tick(page, 50);
    expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(1);
    await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', false);
});

for (const failure of ['short incoming', 'start seek failure', 'preload failure', 'autoplay denial', 'fade stall']) {
    test(`${failure} falls back at the effective end`, async ({ page }) => {
        await start(page);
        if (failure === 'short incoming') {
            await page.locator('#playerStandby').evaluate(video => { video.duration = 22; });
        }
        if (failure === 'autoplay denial') await page.evaluate(() => { window.__edgeDenyStandby = true; });
        if (failure === 'start seek failure') await page.evaluate(() => { window.__edgeSeekFails = true; });
        await tick(page, 40);
        await expect(page.locator('#playerStandby source')).toHaveCount(1);
        if (failure === 'preload failure') await page.locator('#playerStandby').dispatchEvent('error');
        await tick(page, 47);
        if (failure === 'autoplay denial') {
            await expect.poll(() => page.evaluate(() => playerPreparation?.disabled)).toBe(true);
        }
        if (failure === 'fade stall') {
            await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
            await page.locator('#playerVideo').dispatchEvent('waiting');
        }
        await tick(page, 50);
        await expect.poll(() => page.evaluate(() => endlessPlayback.sequence)).toBe(1);
        await expect(page.locator('#playerStandby source')).toHaveCount(0);
        if (failure === 'fade stall') {
            await expect(page.locator('#playerRetry')).toBeVisible();
            await page.locator('#playerRetry').click();
            await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
            await time(page, 10);
        }
    });
}

test('unreliable duration during a fade restores outgoing playback until its natural end', async ({ page }) => {
    await start(page);
    await tick(page, 40);
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    await tick(page, 47);
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
    await page.evaluate(() => {
        const video = playerPreparation.outgoing;
        video.duration = Infinity;
        video.dispatchEvent(new Event('durationchange'));
    });
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', '/api/file/edge-current');
    await tick(page, 50);
    await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', false);
    await page.locator('#playerVideo').evaluate(video => {
        video.ended = true;
        video.dispatchEvent(new Event('ended'));
    });
    await expect(page.locator('#playerRetry')).toBeVisible();
});

test('an old ended event before new metadata cannot disarm the new item boundary', async ({ page }) => {
    await direct(page);
    await time(page, 10);
    await page.evaluate(() => {
        window.__edgeHoldMetadata = true;
        playVideo('edge-old', 'Old', 'mp4');
        document.getElementById('playerVideo').dispatchEvent(new Event('ended'));
        window.__edgeMetadata();
    });
    await time(page, 10);
    await tick(page, 50);
    await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', true);
});

test('stopping after a failed fade retains the restored item boundary', async ({ page }) => {
    await start(page);
    await tick(page, 40);
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    await tick(page, 47);
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
    await page.locator('#playerVideo').dispatchEvent('waiting');
    await page.evaluate(() => stopEndlessPlayback());
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', '/api/file/edge-current');
    await tick(page, 50);
    await expect(page.locator('#playerVideo')).toHaveJSProperty('paused', true);
    await time(page, 50);
});

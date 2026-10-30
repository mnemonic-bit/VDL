const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

async function addVideo(page, id = 'buffer-actions', fixture = 'edges') {
    await seed(page, {
        id, name: `${id}.webm`, status: 'finished', file: true,
        media_fixture: fixture, duration_seconds: fixture === 'edges' ? 30 : 60, media_metadata_probed: true,
    });
    await refresh(page);
}

async function openVideo(page, id = 'buffer-actions') {
    await page.locator(`[data-row-id="${id}"]`).getByRole('button', { name: 'Play', exact: true }).click();
}

async function playing(page) {
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => ({
        paused: video.paused, readyState: video.readyState, error: video.error?.message,
        progressing: video.currentTime > 0,
    }))).toMatchObject({ paused: false, progressing: true });
}

async function expectCenteredBuffering(page) {
    const spinner = page.locator('#playerBufferingSpinner');
    await expect(spinner).toBeVisible();
    await expect(page.locator('#playerStatus')).toHaveText('Buffering');
    const video = await page.locator('#playerVideo').boundingBox();
    const feedback = await page.locator('#playerTransition').boundingBox();
    const text = await page.locator('#playerStatus').boundingBox();
    // The animated border rotates its own bounding box; measure its layout box.
    const wheel = await spinner.evaluate(node => ({ top: node.offsetTop, height: node.offsetHeight }));
    expect(Math.abs(feedback.x + feedback.width / 2 - video.x - video.width / 2)).toBeLessThan(2);
    expect(Math.abs(feedback.y + feedback.height / 2 - video.y - video.height / 2)).toBeLessThan(2);
    expect(feedback.y + wheel.top + wheel.height).toBeLessThanOrEqual(text.y + 1);
    const controls = await page.locator('#playerControls').boundingBox();
    expect(feedback.y + feedback.height).toBeLessThan(controls.y);
}

for (const { playlist, fullscreen, theme, motion } of [
    { playlist: false, fullscreen: false, theme: 'light', motion: 'no-preference' },
    { playlist: false, fullscreen: true, theme: 'dark', motion: 'reduce' },
    { playlist: true, fullscreen: false, theme: 'dark', motion: 'no-preference' },
    { playlist: true, fullscreen: true, theme: 'light', motion: 'reduce' },
]) {
    test(`delayed initial buffering is centered in ${playlist ? 'playlist' : 'direct'} ${fullscreen ? 'fullscreen' : 'overlay'} (${theme}, ${motion})`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: motion });
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await addVideo(page);
        let playlistId;
        if (playlist) {
            const response = await page.request.post('/api/playlists', {
                data: { name: 'Buffer queue', download_ids: ['buffer-actions'] },
            });
            playlistId = (await response.json()).id;
            await refresh(page);
        }
        let release;
        const held = new Promise(resolve => { release = resolve; });
        await page.route('**/api/file/buffer-actions', async route => {
            await held;
            await route.continue();
        });
        try {
            if (playlist) await page.evaluate(id => startPlaylistPlayback(id), playlistId);
            else await openVideo(page);
            if (fullscreen) {
                await page.locator('#playerFullscreen').click();
                await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('playerContainer');
            }
            await expectCenteredBuffering(page);
            await expect(page.locator('#playerBufferingSpinner')).toHaveCSS('animation-name', motion === 'reduce' ? 'none' : 'options-spin');
            if (playlist) await expect(page.locator('#playlistQueue')).toBeVisible();
            const videoBounds = await page.locator('#playerVideo').boundingBox();
            await page.evaluate(() => {
                window.__statusChanges = 0;
                new MutationObserver(records => { window.__statusChanges += records.length; })
                    .observe(document.getElementById('playerStatus'), { childList: true, characterData: true, subtree: true });
                const video = document.getElementById('playerVideo');
                for (let index = 0; index < 3; index++) video.dispatchEvent(new Event('waiting'));
            });
            expect(await page.evaluate(() => window.__statusChanges)).toBe(0);
            expect(await page.locator('#playerVideo').boundingBox()).toEqual(videoBounds);
        } finally {
            release();
        }
        await playing(page);
        await expect(page.locator('#playerTransition')).toBeHidden();
        await page.locator('#playerPlayPause').click();
        await expect(page.locator('#playerTransition')).toBeHidden();
        await page.locator('#playerVideo').evaluate(video => {
            video.dispatchEvent(new Event('waiting'));
            video.dispatchEvent(new Event('stalled'));
        });
        await expect(page.locator('#playerBufferingSpinner')).toBeHidden();
    });
}

for (const { fullscreen, playlist } of [
    { fullscreen: false, playlist: false },
    { fullscreen: true, playlist: false },
    { fullscreen: true, playlist: true },
]) {
    test(`unbuffered real-media seek waits, recovers and clears on close (${playlist ? 'playlist' : 'direct'} ${fullscreen ? 'fullscreen' : 'overlay'})`, async ({ page }) => {
        test.setTimeout(20_000);
        await addVideo(page, 'buffer-actions', 'fit-16-9');
        await addVideo(page, 'replacement');
        const supported = await page.evaluate(() => typeof MediaSource !== 'undefined'
            && MediaSource.isTypeSupported('video/webm; codecs="vp8"'));
        test.skip(!supported, 'This engine cannot incrementally decode the WebM fixture.');
        const media = await (await page.request.get('/api/file/buffer-actions')).body();
        if (playlist) {
            const response = await page.request.post('/api/playlists', {
                data: { name: 'Buffer queue', download_ids: ['buffer-actions'] },
            });
            await page.evaluate(id => startPlaylistPlayback(id), (await response.json()).id);
        } else await openVideo(page);
        await playing(page);
        await page.locator('#playerVideo').evaluate(async (video, bytes) => {
            const media = new Uint8Array(bytes);
            const source = new MediaSource();
            const opened = new Promise(resolve => source.addEventListener('sourceopen', resolve, { once: true }));
            video.src = URL.createObjectURL(source);
            video.load();
            await opened;
            const buffer = source.addSourceBuffer('video/webm; codecs="vp8"');
            const append = bytes => new Promise(resolve => {
                buffer.addEventListener('updateend', resolve, { once: true });
                buffer.appendBuffer(bytes);
            });
            // Delay the later real frames independently of demuxer HTTP read
            // ahead, which otherwise downloads this small fixture in full.
            await append(media.slice(0, 64000));
            source.duration = 60;
            window.__releaseMediaFrames = async () => {
                await append(media.slice(64000));
                source.endOfStream();
            };
            video.play().catch(() => {});
        }, [...media]);
        await playing(page);
        if (fullscreen) {
            await page.locator('#playerFullscreen').click();
            await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('playerContainer');
        }
        await expect(page.locator('#playerBufferingSpinner')).toBeHidden();
        await page.locator('#playerVideo').evaluate(video => {
            window.__nativeWaiting = 0;
            video.addEventListener('waiting', () => { window.__nativeWaiting += 1; });
            video.currentTime = 50;
        });
        await expect.poll(() => page.evaluate(() => window.__nativeWaiting)).toBeGreaterThan(0);
        await expectCenteredBuffering(page);
        await page.evaluate(() => window.__releaseMediaFrames());
        await expect(page.locator('#playerBufferingSpinner')).toBeHidden();
        await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeGreaterThan(50);
        const objectUrl = await page.locator('#playerVideo').getAttribute('src');
        await page.locator('.player-close').click();
        await page.evaluate(url => URL.revokeObjectURL(url), objectUrl);
        await expect(page.locator('#playerBufferingSpinner')).toBeHidden();
        await openVideo(page, 'replacement');
        await playing(page);
        await expect(page.locator('#playerTransition')).toBeHidden();
    });
}

test('closing during initial buffering clears feedback before a different video opens', async ({ page }) => {
    await addVideo(page);
    await addVideo(page, 'replacement');
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/file/buffer-actions', async route => {
        await held;
        await route.continue();
    });
    try {
        await openVideo(page);
        await expectCenteredBuffering(page);
        await page.locator('.player-close').click();
        await expect(page.locator('#playerBufferingSpinner')).toBeHidden();
        await openVideo(page, 'replacement');
        release();
        await playing(page);
        await expect(page.locator('#playerTransition')).toBeHidden();
        await expect(page.locator('#playerVideo source')).toHaveAttribute('src', '/api/file/replacement');
    } finally {
        release();
    }
});

test('media errors replace buffering with distinct usable recovery actions', async ({ page }) => {
    await seed(page, { id: 'buffer-actions', name: 'broken.webm', status: 'finished', file: true });
    await refresh(page);
    await openVideo(page);
    await expect(page.locator('#playerStatus')).toContainText('missing or uses an unsupported format');
    await expect(page.locator('#playerBufferingSpinner')).toBeHidden();
    await expect(page.locator('#playerTransitionClose')).toBeVisible();
    await page.locator('#playerTransitionClose').click();
    await expect(page.locator('#playerBackdrop')).not.toHaveClass(/open/);
});

test('volume is hidden until speaker hover and stays usable while crossing onto the slider', async ({ page }) => {
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await addVideo(page);
    await openVideo(page);
    await playing(page);
    const slider = page.locator('#playerVolume');
    await expect(slider).toBeHidden();
    await page.locator('#playerMute').hover();
    await expect(slider).toBeVisible();
    await slider.hover();
    await expect(slider).toBeVisible();
    await page.locator('#playerVideo').hover();
    await expect(slider).toBeHidden();
    await page.locator('#playerForward').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#playerMute')).toBeFocused();
    await expect(slider).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(slider).toBeFocused();
    await page.keyboard.press('Home');
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.volume)).toBe(0);
    await page.keyboard.press('Tab');
    await expect(slider).toBeHidden();
    await page.locator('#playerMute').hover();
    const bounds = await slider.boundingBox();
    await page.mouse.move(bounds.x + 8, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.volume)).toBeGreaterThan(0.3);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y - 80);
    await expect(slider).toBeVisible();
    await page.mouse.up();
    await expect(slider).toBeHidden();
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
});

for (const { mode, fullscreen, paused } of [
    { mode: 'direct', fullscreen: false, paused: true },
    { mode: 'direct', fullscreen: true, paused: false },
    { mode: 'playlist', fullscreen: true, paused: true },
    { mode: 'sequential', fullscreen: false, paused: false },
]) {
    test(`ten-second actions seek once and clamp in ${mode} ${fullscreen ? 'fullscreen' : 'overlay'} (${paused ? 'paused' : 'playing'})`, async ({ page }) => {
        await addVideo(page);
        if (mode === 'playlist') {
            const response = await page.request.post('/api/playlists', {
                data: { name: 'Seek queue', download_ids: ['buffer-actions'] },
            });
            await page.evaluate(id => startPlaylistPlayback(id), (await response.json()).id);
        } else if (mode === 'sequential') await page.locator('#endlessPlaybackButton').click();
        else await openVideo(page);
        await playing(page);
        if (fullscreen) {
            await page.locator('#playerFullscreen').click();
            await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('playerContainer');
        }
        if (paused) await page.locator('#playerPlayPause').click();
        await page.locator('#playerVideo').evaluate(video => {
            video.currentTime = 25;
            window.__seekWrites = [];
            window.__buttonPlaybackEvents = [];
            for (const name of ['play', 'pause']) {
                video.addEventListener(name, () => window.__buttonPlaybackEvents.push(name));
            }
            const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
            Object.defineProperty(video, 'currentTime', {
                configurable: true,
                get: () => descriptor.get.call(video),
                set: value => { window.__seekWrites.push(value); descriptor.set.call(video, value); },
            });
        });
        const rewind = page.getByRole('button', { name: 'Rewind 10 seconds', exact: true });
        const forward = page.getByRole('button', { name: 'Forward 10 seconds', exact: true });
        await expect(rewind).toBeVisible();
        await expect(forward).toBeVisible();
        await rewind.click();
        await rewind.click();
        await rewind.click();
        const writes = await page.evaluate(() => window.__seekWrites);
        expect(writes).toHaveLength(3);
        expect(writes[0]).toBeCloseTo(15, paused ? 5 : 0);
        expect(writes[1]).toBeCloseTo(5, paused ? 5 : 0);
        expect(writes[2]).toBe(0);
        await forward.click();
        await forward.click();
        const allWrites = await page.evaluate(() => window.__seekWrites);
        expect(allWrites).toHaveLength(5);
        expect(allWrites[3]).toBeCloseTo(10, paused ? 5 : 0);
        expect(allWrites[4]).toBeCloseTo(20, paused ? 5 : 0);
        expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(paused);
        expect(await page.evaluate(() => window.__buttonPlaybackEvents)).toEqual([]);
        await expect(page.locator('#playerVideo source')).toHaveAttribute('src', '/api/file/buffer-actions');
        await expect(rewind).toHaveAttribute('title', 'Rewind 10 seconds');
        await expect(forward).toHaveAttribute('title', 'Forward 10 seconds');
        if (!paused) await page.locator('#playerPlayPause').click();
        await forward.click();
        await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(30, 0);
        await page.locator('#playerVideo').evaluate(video => {
            Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 0 } });
            video.dispatchEvent(new Event('progress'));
        });
        await expect(rewind).toBeDisabled();
        await expect(forward).toBeDisabled();
    });
}

test('ten-second buttons preserve explicit seeks into configured intro and outro boundaries', async ({ page }) => {
    await page.request.post('/api/preferences', { data: { skip_video_edges: true } });
    await page.evaluate(() => loadPreferences());
    await addVideo(page);
    await openVideo(page);
    await playing(page);
    await page.locator('#playerPlayPause').click();
    await page.getByRole('button', { name: 'Rewind 10 seconds', exact: true }).click();
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeLessThan(1);
    await page.getByRole('button', { name: 'Forward 10 seconds', exact: true }).click();
    await page.getByRole('button', { name: 'Forward 10 seconds', exact: true }).click();
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeGreaterThanOrEqual(20);
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
    await page.locator('#playerPlayPause').click();
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeGreaterThan(20);
});

test('touch can reveal volume and mute while narrow controls stay inside the player', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, hasTouch: true, viewport: { width: 360, height: 740 } });
    const page = await context.newPage();
    try {
        await reset(page);
        await addVideo(page);
        await openVideo(page);
        await playing(page);
        const volume = page.locator('#playerVolume');
        await expect(volume).toBeHidden();
        await page.locator('#playerMute').tap();
        await expect(volume).toBeVisible();
        expect(await page.locator('#playerVideo').evaluate(video => video.muted)).toBe(true);
        const bounds = await volume.boundingBox();
        await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.volume)).toBeCloseTo(0.5, 1);
        const player = await page.locator('#playerContainer').boundingBox();
        for (const control of await page.locator('#playerControls button:visible, #playerControls input:visible, #playerSpeed').all()) {
            const bounds = await control.boundingBox();
            expect(bounds.x).toBeGreaterThanOrEqual(player.x);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(player.x + player.width + 1);
        }
        await page.locator('#playerPlayPause').tap();
        await expect(volume).toBeHidden();
        await page.locator('#playerMute').tap();
        expect(await page.locator('#playerVideo').evaluate(video => video.muted)).toBe(false);
    } finally {
        await context.close();
    }
});

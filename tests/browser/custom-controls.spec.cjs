const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, switchAccount } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

async function realVideo(page, id = 'controls-one') {
    await seed(page, {
        id, name: `${id}.webm`, title: id, status: 'finished', file: true,
        media_fixture: 'crossfade', resolution: '720p', duration_seconds: 14, media_metadata_probed: true,
    });
    await refresh(page);
}

async function openDirect(page, id = 'controls-one') {
    await page.locator(`[data-row-id="${id}"]`).getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.locator('#playerControls')).toBeVisible();
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
    // WebKit may retain HAVE_CURRENT_DATA during successful playback.
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeGreaterThan(0);
}

async function setRange(page, id, value) {
    await page.locator(id).evaluate((range, value) => {
        range.value = String(value);
        range.dispatchEvent(new Event('input', { bubbles: true }));
        range.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
}

async function pause(page) {
    await page.locator('#playerPlayPause').click();
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
    await expect(page.locator('#playerPlayPause')).toHaveAccessibleName('Play');
}

test('direct controls follow real media, preserve paused keyboard seeks, and retain native range keys', async ({ page }) => {
    await realVideo(page);
    await openDirect(page);
    await expect(page.locator('#playerTitle')).toHaveText('controls-one.webm');
    await expect(page.locator('#playerNext')).toBeHidden();
    await expect(page.locator('#playerPrevious')).toBeHidden();
    expect(await page.locator('#playerVideo').evaluate(video => video.controls)).toBe(false);
    await expect(page.locator('#playerSeek')).toBeEnabled();
    await expect(page.locator('#playerTime')).toContainText('0:14');
    await expect(page.locator('#playerTime')).not.toHaveAttribute('aria-live', /.+/);
    await pause(page);
    const seek = page.locator('#playerSeek');
    const before = await page.locator('#playerVideo').evaluate(video => video.currentTime);
    await seek.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeGreaterThan(before);
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
    await expect(seek).toHaveAttribute('aria-valuetext', /second.*of/);
    await page.keyboard.press('Space');
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
    await page.locator('#playerContainer').evaluate(container => {
        window.__controlFullscreenRequests = 0;
        container.requestFullscreen = () => {
            window.__controlFullscreenRequests += 1;
            return Promise.resolve();
        };
        const editor = document.createElement('div');
        editor.id = 'playerTestEditor';
        editor.setAttribute('contenteditable', '');
        container.appendChild(editor);
        editor.focus();
    });
    await page.keyboard.press('Space');
    await page.keyboard.press('f');
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
    expect(await page.evaluate(() => window.__controlFullscreenRequests)).toBe(0);
    await page.locator('#playerTestEditor').evaluate(editor => editor.remove());
    await page.locator('#playerPlayPause').click();
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
    await expect(page.locator('#playerPlayPause')).toHaveAccessibleName('Pause');
});

test('pointer dragging previews once and pointer cancellation leaves the real clock alone', async ({ page }) => {
    await realVideo(page);
    await openDirect(page);
    await pause(page);
    // Reproduce the CI clock that rounds to the range's zero-valued step.
    await page.locator('#playerVideo').evaluate(async video => {
        const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
        video.currentTime = 0.03502;
        await seeked;
        const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
        window.__controlSeekWrites = 0;
        Object.defineProperty(video, 'currentTime', {
            configurable: true,
            get: () => descriptor.get.call(video),
            set: value => { window.__controlSeekWrites += 1; descriptor.set.call(video, value); },
        });
    });
    const range = page.locator('#playerSeek');
    const before = await page.locator('#playerVideo').evaluate(video => video.currentTime);
    await range.dispatchEvent('pointerdown', { pointerId: 17, pointerType: 'touch', isPrimary: true });
    await range.evaluate(range => {
        range.value = '8';
        range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(await page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(before, 1);
    await expect(page.locator('#playerTime')).toContainText('0:08');
    await range.dispatchEvent('pointercancel', { pointerId: 17, pointerType: 'touch' });
    expect(await page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(before, 1);
    expect(await page.evaluate(() => window.__controlSeekWrites)).toBe(0);
    await expect(range).toHaveValue('0');
    // Home emits no change when the rounded range is already at its minimum.
    // Move one native step first so Home reliably commits the drag's baseline.
    await range.press('ArrowRight');
    await expect(range).toHaveValue('0.1');
    await range.press('Home');
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(0);
    expect(await page.evaluate(() => window.__controlSeekWrites)).toBe(2);
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
    await page.evaluate(() => { window.__controlSeekWrites = 0; });
    const bounds = await range.boundingBox();
    // WebKit jumps on a track click, but starts a drag only on the thumb.
    await page.mouse.move(bounds.x + 8, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height / 2);
    expect(await page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(0);
    await page.mouse.up();
    expect(await page.evaluate(() => window.__controlSeekWrites)).toBe(1);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeGreaterThan(6);
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
    await range.dispatchEvent('pointerdown', { pointerId: 18, pointerType: 'touch', isPrimary: true });
    await range.evaluate(range => {
        range.value = '9';
        range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('body').dispatchEvent('pointerup', { pointerId: 18, pointerType: 'touch' });
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(9);
    expect(await page.evaluate(() => window.__controlSeekWrites)).toBe(2);
});

test('unknown metadata and rejected seeks restore the accepted clock without invalid labels', async ({ page }) => {
    await realVideo(page);
    await openDirect(page);
    await pause(page);
    await page.locator('#playerVideo').evaluate(video => {
        Object.defineProperty(video, 'duration', { configurable: true, get: () => Infinity });
        video.dispatchEvent(new Event('durationchange'));
    });
    await expect(page.locator('#playerSeek')).toBeDisabled();
    await expect(page.locator('#playerTime')).toContainText('--:--');
    await expect(page.locator('#playerTime')).not.toContainText(/NaN|Infinity/);
    await page.locator('#playerVideo').evaluate(video => {
        delete video.duration;
        video.dispatchEvent(new Event('durationchange'));
        const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
        Object.defineProperty(video, 'currentTime', {
            configurable: true,
            get: () => descriptor.get.call(video),
            set: () => { throw new DOMException('Seeking rejected', 'InvalidStateError'); },
        });
    });
    await expect(page.locator('#playerSeek')).toBeEnabled();
    const before = await page.locator('#playerVideo').evaluate(video => video.currentTime);
    await setRange(page, '#playerSeek', 8);
    expect(await page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(before, 1);
    await expect.poll(async () => Math.abs(Number(await page.locator('#playerSeek').inputValue()) - before)).toBeLessThanOrEqual(0.051);
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
});

test('volume, mute and all offered rates survive direct close and reopen', async ({ page }) => {
    await realVideo(page);
    await realVideo(page, 'controls-two');
    await openDirect(page);
    await pause(page);
    await setRange(page, '#playerVolume', 37);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.volume)).toBeCloseTo(0.37);
    await page.locator('#playerMute').click();
    await expect(page.locator('#playerMute')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.locator('#playerVideo').evaluate(video => video.muted)).toBe(true);
    await expect(page.locator('#playerVolume')).toHaveValue('37');
    for (const rate of ['0.5', '0.75', '1', '1.25', '1.5', '2']) {
        await page.locator('#playerSpeed').selectOption(rate);
        await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.playbackRate)).toBe(Number(rate));
    }
    await page.locator('.player-close').click();
    await page.locator('#playerVideo').evaluate(video => {
        video.volume = 1;
        video.muted = false;
        video.playbackRate = 1;
        video.dispatchEvent(new Event('volumechange'));
        video.dispatchEvent(new Event('ratechange'));
    });
    await openDirect(page, 'controls-two');
    await expect(page.locator('#playerVolume')).toHaveValue('37');
    await expect(page.locator('#playerSpeed')).toHaveValue('2');
    const reopened = await page.locator('#playerVideo').evaluate(video => ({
        volume: video.volume, muted: video.muted, rate: video.playbackRate,
    }));
    expect(reopened.volume).toBeCloseTo(0.37);
    expect(reopened).toMatchObject({ muted: true, rate: 2 });
    await page.locator('#playerMute').click();
    expect(await page.locator('#playerVideo').evaluate(video => video.muted)).toBe(false);
    expect(await page.locator('#playerVideo').evaluate(video => video.volume)).toBeCloseTo(0.37);
});

test('media volume and rate events synchronize controls without reopening', async ({ page }) => {
    await realVideo(page);
    await openDirect(page);
    await page.locator('#playerVideo').evaluate(video => {
        video.volume = 0.64;
    });
    await expect(page.locator('#playerVolume')).toHaveValue('64');
    await page.locator('#playerVideo').evaluate(video => { video.muted = true; });
    await expect(page.locator('#playerMute')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#playerVideo').evaluate(video => { video.playbackRate = 1.5; });
    await expect(page.locator('#playerSpeed')).toHaveValue('1.5');
});

test('controls hide after three seconds and remain available while paused or focused', async ({ page }) => {
    test.setTimeout(20_000);
    await realVideo(page);
    await openDirect(page);
    await page.locator('#playerContainer').focus();
    await page.mouse.move(0, 0);
    await expect(page.locator('#playerContainer')).toHaveClass(/player-controls-visible/);
    await page.waitForTimeout(2400);
    await expect(page.locator('#playerContainer')).toHaveClass(/player-controls-visible/);
    await expect(page.locator('#playerContainer')).not.toHaveClass(/player-controls-visible/, { timeout: 2000 });
    await expect(page.locator('#playerControls')).not.toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.locator('#playerContainer')).toHaveClass(/player-controls-visible/);
    expect(await page.evaluate(() => document.getElementById('playerContainer').contains(document.activeElement))).toBe(true);
    await page.locator('#playerPlayPause').focus();
    await page.waitForTimeout(3200);
    await expect(page.locator('#playerControls')).toBeVisible();
    await pause(page);
    await page.locator('#playerContainer').focus();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(3200);
    await expect(page.locator('#playerControls')).toBeVisible();
});

test('modal focus stays inside and returns to the direct playback launcher', async ({ page }) => {
    await realVideo(page);
    const launcher = page.locator('[data-row-id="controls-one"]').getByRole('button', { name: 'Play', exact: true });
    await openDirect(page);
    await pause(page);
    await page.locator('.player-close').focus();
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.getElementById('playerContainer').contains(document.activeElement))).toBe(true);
    await page.locator('#playerSpeed').focus();
    await page.keyboard.press('f');
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    await page.keyboard.press('Escape');
    await expect(page.locator('#playerBackdrop')).not.toHaveClass(/open/);
    await expect(launcher).toBeFocused();
    await openDirect(page);
    await launcher.evaluate(button => { button.hidden = true; });
    await page.locator('.player-close').click();
    await expect(page.locator('#historySearchToggle')).toBeFocused();
});

for (const colorScheme of ['light', 'dark']) {
    test(`narrow ${colorScheme} player keeps touch targets, timeline, and fullscreen in view`, async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, colorScheme);
        await realVideo(page);
        await openDirect(page);
        await pause(page);
        const bounds = await page.locator('#playerContainer').evaluate(container => {
            const rect = container.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
        });
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(bounds.width);
        expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width);
        for (const selector of ['#playerPlayPause', '#playerMute', '#playerFullscreen', '.player-close']) {
            const box = await page.locator(selector).boundingBox();
            expect(box.width).toBeGreaterThanOrEqual(43.99);
            expect(box.height).toBeGreaterThanOrEqual(43.99);
            expect(box.x + box.width).toBeLessThanOrEqual(390);
            expect(box.y + box.height).toBeLessThanOrEqual(844);
        }
        await expect(page.locator('#playerSeek')).toBeVisible();
        await expect(page.locator('#playerTime')).toBeVisible();
    });
}

test('playlist toolbar serializes progress and selection, uses boundaries, and toggles the queue without reloading', async ({ page }) => {
    await realVideo(page, 'queue-first');
    await realVideo(page, 'queue-unavailable');
    await realVideo(page, 'queue-second');
    const response = await page.request.post('/api/playlists', {
        data: { name: 'Controls queue', download_ids: ['queue-first', 'queue-unavailable', 'queue-second'] },
    });
    expect(response.status()).toBe(201);
    await seed(page, { id: 'queue-unavailable', status: 'error' });
    await page.evaluate(() => fetchPlaylists());
    await page.getByRole('button', { name: 'Resume playlist: Controls queue' }).click();
    await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
    await expect(page.locator('#playerPrevious')).toBeDisabled();
    await expect(page.locator('#playerNext')).toBeEnabled();
    await expect(page.locator('.playlist-queue-row.is-unavailable')).toHaveCount(1);
    const source = await page.locator('#playerVideo source').getAttribute('src');
    await page.locator('#playerQueueToggle').click();
    await expect(page.locator('#playlistQueue')).toBeHidden();
    await page.locator('#playerQueueToggle').click();
    await expect(page.locator('#playlistQueue')).toBeVisible();
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', source);
    const selections = [];
    page.on('request', request => { if (request.url().endsWith('/select')) selections.push(request); });
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    await page.route('**/api/playlists/*/progress', async route => {
        await hold;
        await route.continue();
    });
    await page.locator('#playerNext').click();
    await expect(page.locator('#playerNext')).toBeDisabled();
    await page.evaluate(() => {
        document.getElementById('playerNext').click();
        document.querySelectorAll('.playlist-queue-row')[2].click();
    });
    release();
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', '/api/file/queue-second');
    await expect(page.locator('#playerNext')).toBeDisabled();
    await expect(page.locator('#playerPrevious')).toBeEnabled();
    expect(selections).toHaveLength(1);
    await page.locator('#playerPrevious').click();
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', '/api/file/queue-first');
    await expect(page.locator('#playerPrevious')).toBeDisabled();
});

test('real overlapping media follow incoming controls, preserve intended volume, and cancel on a paused seek', async ({ page }) => {
    test.setTimeout(20_000);
    await realVideo(page, 'overlap-old');
    await realVideo(page, 'overlap-current');
    await page.locator('#endlessPlaybackButton').click();
    await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
    await setRange(page, '#playerVolume', 70);
    await page.locator('#playerVideo').evaluate(video => { window.__controlsOutgoing = video; video.currentTime = 4.2; });
    await expect(page.locator('#playerStandby source')).toHaveAttribute('src', '/api/file/overlap-old');
    await expect.poll(() => page.locator('#playerStandby').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(3);
    await page.locator('#playerVideo').evaluate(video => { video.currentTime = 10.8; });
    await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
    await expect(page.locator('#playerTitle')).toHaveText('overlap-old');
    await expect(page.locator('#playerVolume')).toHaveValue('70');
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeGreaterThan(0.25);
    await pause(page);
    await expect.poll(() => page.evaluate(() => window.__controlsOutgoing.paused)).toBe(true);
    await setRange(page, '#playerVolume', 45);
    await page.locator('#playerMute').click();
    await page.locator('#playerSpeed').selectOption('2');
    const paused = await page.evaluate(() => ({
        gains: [playerPreparation.outgoing.volume, playerPreparation.incoming.volume],
        rates: [playerPreparation.outgoing.playbackRate, playerPreparation.incoming.playbackRate],
        mutes: [playerPreparation.outgoing.muted, playerPreparation.incoming.muted],
        times: [playerPreparation.outgoing.currentTime, playerPreparation.incoming.currentTime],
    }));
    expect(paused.rates).toEqual([2, 2]);
    expect(paused.mutes).toEqual([true, true]);
    for (const gain of paused.gains) expect(gain).toBeLessThanOrEqual(0.45001);
    expect(paused.gains[0] ** 2 + paused.gains[1] ** 2).toBeCloseTo(0.45 ** 2, 2);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
    await expect(page.locator('#playerVolume')).toHaveValue('45');
    // Leave time for real browser interactions before this overlap finishes.
    await page.locator('#playerSpeed').selectOption('0.5');
    await page.locator('#playerPlayPause').click();
    await expect.poll(() => page.evaluate(() => !window.__controlsOutgoing.paused)).toBe(true);
    await pause(page);
    expect(await page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
    await setRange(page, '#playerSeek', 1);
    await expect.poll(() => page.evaluate(() => playerPreparation === null)).toBe(true);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(1);
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
    expect(await page.locator('#playerVideo').evaluate(video => video.volume)).toBeCloseTo(0.45);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.muted)).toBe(true);
    await expect(page.locator('#playerMute')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#playerVolume')).toHaveValue('45');
    await expect(page.locator('#playerStandby source')).toHaveCount(0);
});

test('missing control markup retains native controls and a usable close action', async ({ page }) => {
    await page.route('**/', async route => {
        const response = await route.fetch();
        const body = (await response.text()).replace('id="playerSpeed"', 'id="missingPlayerSpeed"');
        await route.fulfill({ response, body });
    });
    await page.reload();
    await realVideo(page);
    await page.locator('[data-row-id="controls-one"]').getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
    expect(await page.locator('#playerVideo').evaluate(video => video.controls)).toBe(true);
    await expect(page.locator('#playerControls')).toBeHidden();
    await page.locator('.player-close').click();
    await expect(page.locator('#playerBackdrop')).not.toHaveClass(/open/);
});

test('seek targets clamp to real file bounds and nearest available seekable range', async ({ page }) => {
    await realVideo(page);
    await openDirect(page);
    await pause(page);
    await page.locator('#playerVideo').evaluate(video => {
        Object.defineProperty(video, 'seekable', {
            configurable: true,
            get: () => ({ length: 2, start: index => index ? 8 : 2, end: index => index ? 12 : 4 }),
        });
        video.dispatchEvent(new Event('progress'));
    });
    await setRange(page, '#playerSeek', 5);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(4);
    await setRange(page, '#playerSeek', 0);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(2);
    await setRange(page, '#playerSeek', 14);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(12);
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
});

test('simulated native-only fullscreen enables native video controls and restores custom controls on return', async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: undefined });
        HTMLVideoElement.prototype.webkitEnterFullscreen = function () {
            window.__nativeEntered = true;
            this.dispatchEvent(new Event('webkitbeginfullscreen'));
        };
        HTMLVideoElement.prototype.webkitExitFullscreen = function () {
            this.dispatchEvent(new Event('webkitendfullscreen'));
        };
    });
    await page.reload();
    await realVideo(page);
    await openDirect(page);
    await page.locator('#playerFullscreen').click();
    expect(await page.evaluate(() => window.__nativeEntered)).toBe(true);
    expect(await page.locator('#playerVideo').evaluate(video => video.controls)).toBe(true);
    await page.locator('#playerVideo').evaluate(video => video.webkitExitFullscreen());
    expect(await page.locator('#playerVideo').evaluate(video => video.controls)).toBe(false);
    await expect(page.locator('#playerControls')).toBeVisible();
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
});

test('simulated unavailable fullscreen and fixed device volume leave other controls usable', async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: undefined });
        Object.defineProperty(HTMLVideoElement.prototype, 'webkitEnterFullscreen', { configurable: true, value: undefined });
        Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
            configurable: true, get: () => 1, set: () => {},
        });
    });
    await page.reload();
    await realVideo(page);
    await openDirect(page);
    await expect(page.locator('#playerFullscreen')).toBeDisabled();
    await expect(page.locator('#playerVolume')).toBeDisabled();
    await expect(page.locator('#playerVolumeHint')).toBeVisible();
    await expect(page.locator('#playerVolumeHint')).toContainText(/device controls/i);
    await expect(page.locator('#playerPlayPause')).toBeEnabled();
    await expect(page.locator('.player-close')).toBeEnabled();
});

test('rejected fullscreen leaves the overlay usable and retains the launch preference', async ({ page }) => {
    await page.addInitScript(() => {
        Element.prototype.requestFullscreen = () => Promise.reject(new DOMException('Denied', 'NotAllowedError'));
    });
    await page.request.post('/__test__/preferences', { data: { start_fullscreen: 'true' } });
    await page.reload();
    await realVideo(page);
    await openDirect(page);
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    await expect(page.locator('#playerPlayPause')).toBeEnabled();
    await pause(page);
    await page.locator('.player-close').click();
    const preferences = await page.request.get('/api/preferences');
    expect((await preferences.json()).start_fullscreen).toBe('true');
});

test('intro and outro toolbar seeks keep full-file time and explicit-seek behavior', async ({ page }) => {
    await page.request.post('/api/preferences', { data: { skip_video_edges: true } });
    await page.evaluate(() => loadPreferences());
    await seed(page, {
        id: 'controls-edges', name: 'controls-edges.webm', status: 'finished', file: true,
        media_fixture: 'edges', duration_seconds: 30, media_metadata_probed: true,
    });
    await refresh(page);
    await openDirect(page, 'controls-edges');
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeGreaterThanOrEqual(10);
    await pause(page);
    expect(Number(await page.locator('#playerSeek').getAttribute('max'))).toBeCloseTo(30, 1);
    await setRange(page, '#playerSeek', 2);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(2);
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
    await expect(page.locator('#playerTime')).toHaveText('0:02 / 0:30');
    await setRange(page, '#playerSeek', 27);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(27);
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
    await expect(page.locator('#playerTime')).toHaveText('0:27 / 0:30');
});

test('Shuffle Clips toolbar seeks retain the sampled excerpt and complete it once', async ({ page }) => {
    await page.evaluate(() => { Math.random = () => 0; });
    await realVideo(page, 'controls-clip-one');
    await realVideo(page, 'controls-clip-two');
    await page.getByRole('button', { name: 'Choose playback mode' }).click();
    await page.getByRole('menuitem', { name: 'Shuffle Clips', exact: true }).click();
    await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
    await pause(page);
    const initial = await page.locator('#playerVideo').evaluate(video => ({
        start: playerBoundaries.get(video).start, end: playerBoundaries.get(video).end,
        duration: video.duration, id: endlessPlayback.currentDownloadId,
    }));
    await expect(page.locator('#playerModeLabel')).toHaveText('Shuffle Clips');
    expect(Number(await page.locator('#playerSeek').getAttribute('max'))).toBeCloseTo(initial.duration);
    await setRange(page, '#playerSeek', 0);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(initial.start, 1);
    const inside = Math.ceil((initial.start + 1) * 10) / 10;
    await setRange(page, '#playerSeek', inside);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(inside, 1);
    expect(await page.locator('#playerVideo').evaluate(video => ({
        start: playerBoundaries.get(video).start, end: playerBoundaries.get(video).end,
    }))).toEqual({ start: initial.start, end: initial.end });
    expect(await page.evaluate(() => endlessPlayback.sequence)).toBe(0);
    const advances = [];
    page.on('request', request => { if (request.url().endsWith('/advance')) advances.push(request); });
    await setRange(page, '#playerSeek', Math.ceil(initial.end * 10) / 10);
    await expect.poll(() => page.evaluate(() => endlessPlayback.sequence)).toBe(1);
    expect(await page.evaluate(() => endlessPlayback.currentDownloadId)).not.toBe(initial.id);
    expect(advances).toHaveLength(1);
});

test('cancelled drag and its late native change never seek a replacement item', async ({ page }) => {
    await realVideo(page);
    await realVideo(page, 'controls-replacement');
    await openDirect(page);
    await pause(page);
    const seek = page.locator('#playerSeek');
    await seek.dispatchEvent('pointerdown', { pointerId: 25, pointerType: 'touch', isPrimary: true });
    await seek.evaluate(range => { range.value = '9'; range.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.evaluate(() => playVideo('controls-replacement', 'Replacement', 'webm'));
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', '/api/file/controls-replacement');
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
    await seek.dispatchEvent('pointerup', { pointerId: 25, pointerType: 'touch' });
    await seek.evaluate(range => { range.value = '9'; range.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(await page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeLessThan(2);
    await expect(page.locator('#playerTitle')).toHaveText('Replacement');
});

test('listening choices persist from direct playback through a session advance and back', async ({ page }) => {
    await realVideo(page, 'listening-first');
    await realVideo(page, 'listening-second');
    await openDirect(page, 'listening-first');
    await setRange(page, '#playerVolume', 55);
    await page.locator('#playerMute').click();
    await page.locator('#playerSpeed').selectOption('1.25');
    await page.locator('.player-close').click();
    await page.locator('#endlessPlaybackButton').click();
    await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
    const initial = await page.evaluate(() => endlessPlayback.currentDownloadId);
    await page.locator('#playerNext').click();
    await expect.poll(() => page.evaluate(() => endlessPlayback.currentDownloadId)).not.toBe(initial);
    await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
    const advanced = await page.locator('#playerVideo').evaluate(video => ({
        volume: video.volume, muted: video.muted, rate: video.playbackRate,
    }));
    expect(advanced.volume).toBeCloseTo(0.55);
    expect(advanced).toMatchObject({ muted: true, rate: 1.25 });
    await expect(page.locator('#playerVolume')).toHaveValue('55');
    await page.locator('.player-close').click();
    await openDirect(page, 'listening-first');
    await expect(page.locator('#playerVolume')).toHaveValue('55');
    await expect(page.locator('#playerSpeed')).toHaveValue('1.25');
    await expect(page.locator('#playerMute')).toHaveAttribute('aria-pressed', 'true');
});

test('sign-out clears listening state and media before navigation, and the next account starts with defaults', async ({ page }) => {
    test.setTimeout(20_000);
    const username = `controls-user-${Date.now()}`;
    const password = 'browser-controls-password';
    const created = await page.request.post('/api/users', { data: { username, password, role: 'normal' } });
    expect(created.status()).toBe(201);
    const user = await created.json();
    await realVideo(page);
    await openDirect(page);
    await setRange(page, '#playerVolume', 29);
    await page.locator('#playerMute').click();
    await page.locator('#playerSpeed').selectOption('1.5');
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/logout', async route => { await held; await route.continue(); });
    try {
        const cleared = await page.evaluate(() => {
            document.querySelector('form.logout-form').requestSubmit();
            const video = document.getElementById('playerVideo');
            return {
                open: document.getElementById('playerBackdrop').classList.contains('open'),
                sources: document.querySelectorAll('#playerMediaStage source').length,
                media: { volume: video.volume, muted: video.muted, rate: video.playbackRate, paused: video.paused },
            };
        });
        expect(cleared).toEqual({
            open: false, sources: 0,
            media: { volume: 1, muted: false, rate: 1, paused: true },
        });
    } finally { release(); }
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await openDirect(page);
    await expect(page.locator('#playerVolume')).toHaveValue('100');
    await expect(page.locator('#playerSpeed')).toHaveValue('1');
    await expect(page.locator('#playerMute')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.locator('#playerVideo').evaluate(video => ({
        volume: video.volume, muted: video.muted, rate: video.playbackRate,
    }))).toEqual({ volume: 1, muted: false, rate: 1 });
    await page.locator('.player-close').click();
    await switchAccount(page, 'admin', 'browser-test-password');
    await page.request.delete(`/api/users/${user.id}`);
});

test('a rejected direct Play remains paused with a usable retry and clears feedback on real playback', async ({ page }) => {
    await realVideo(page);
    await openDirect(page);
    await pause(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('#playerVideo').evaluate(video => {
        const originalPlay = HTMLMediaElement.prototype.play;
        window.__directControlPlayAttempts = 0;
        video.play = function () {
            window.__directControlPlayAttempts += 1;
            if (window.__directControlPlayAttempts === 1) {
                return Promise.reject(new DOMException('A user gesture is required', 'NotAllowedError'));
            }
            return originalPlay.call(this);
        };
    });
    await page.locator('#playerPlayPause').click();
    await expect(page.locator('#playerStatus')).toContainText(/Press Play/i);
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
    await expect(page.locator('#playerPlayPause')).toHaveAccessibleName('Play');
    await expect(page.locator('#playerPlayPause')).toBeEnabled();
    await expect(page.locator('#playerTransition button:visible')).toHaveCount(0);
    await page.locator('#playerPlayPause').click();
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeGreaterThan(0.2);
    await expect(page.locator('#playerPlayPause')).toHaveAccessibleName('Pause');
    await expect(page.locator('#playerStatus')).toHaveText('');
    await expect(page.locator('#playerTransition')).toBeHidden();
    expect(await page.evaluate(() => window.__directControlPlayAttempts)).toBe(2);
    expect(errors).toEqual([]);
});

test('a late fullscreen rejection from a closed player cannot add recovery or change its replacement session', async ({ page }) => {
    await realVideo(page, 'fullscreen-first');
    await realVideo(page, 'fullscreen-second');
    await openDirect(page, 'fullscreen-first');
    await page.locator('#playerContainer').evaluate(container => {
        container.requestFullscreen = () => new Promise((_resolve, reject) => {
            window.__rejectOldFullscreen = reject;
        });
    });
    await page.locator('#playerFullscreen').click();
    await expect.poll(() => page.evaluate(() => typeof window.__rejectOldFullscreen)).toBe('function');
    await page.locator('.player-close').click();
    await page.locator('#endlessPlaybackButton').click();
    await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
    const sessionId = await page.evaluate(() => endlessPlayback.sessionId);
    const source = await page.locator('#playerVideo source').getAttribute('src');
    await page.evaluate(async () => {
        window.__rejectOldFullscreen(new DOMException('Old fullscreen request denied', 'NotAllowedError'));
        await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(await page.evaluate(() => endlessPlayback.sessionId)).toBe(sessionId);
    expect(await page.evaluate(() => endlessPlayback.returnFullscreenNeeded)).toBe(false);
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', source);
    await expect(page.locator('#playerStatus')).toHaveText('');
    await expect(page.locator('#playerTransition')).toBeHidden();
    await expect(page.locator('#playerReturnFullscreen')).toBeHidden();
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
    expect(await page.locator('#playerVideo').evaluate(video => video.controls)).toBe(false);
});

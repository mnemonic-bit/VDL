const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

async function addVideo(page, id = 'interaction-one', fixture = 'crossfade') {
    await seed(page, {
        id, name: `${id}.webm`, status: 'finished', file: true,
        resolution: '720p',
        media_fixture: fixture, duration_seconds: fixture === 'crossfade' ? 14 : 60,
        media_metadata_probed: true,
    });
    await refresh(page);
}

async function openVideo(page, id = 'interaction-one') {
    await page.locator(`[data-row-id="${id}"]`).getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeGreaterThan(0);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
}

test('one video-surface click uses the Space playback action exactly once', async ({ page }) => {
    await addVideo(page);
    await openVideo(page);
    await page.locator('#playerVideo').evaluate(video => {
        window.__interactionEvents = [];
        for (const event of ['play', 'pause']) video.addEventListener(event, () => window.__interactionEvents.push(event));
    });
    await page.locator('#playerVideo').click();
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
    expect(await page.evaluate(() => window.__interactionEvents)).toEqual(['pause']);
    await page.locator('#playerVideo').click();
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
    expect(await page.evaluate(() => window.__interactionEvents)).toEqual(['pause', 'play']);
    await page.locator('#playerContainer').focus();
    await page.keyboard.press('Space');
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
    await page.keyboard.press('Space');
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
    expect(await page.evaluate(() => window.__interactionEvents)).toEqual(['pause', 'play', 'pause', 'play']);
});

test('speed presents factors only and keeps its accessible name and real rate', async ({ page }) => {
    await addVideo(page);
    await openVideo(page);
    const speed = page.locator('#playerSpeed');
    await expect(speed).toHaveAccessibleName(/speed|playback rate/i);
    const visibleLabel = await speed.evaluate(select => [...select.parentElement.childNodes]
        .filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim());
    expect(visibleLabel).toBe('');
    expect(await speed.locator('option').allTextContents()).toEqual(['0.5×', '0.75×', '1×', '1.25×', '1.5×', '2×']);
    await speed.selectOption('1.5');
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.playbackRate)).toBe(1.5);
});

test('stationary header and pointer-focused controls do not pin the idle bars', async ({ page }) => {
    test.setTimeout(20_000);
    await addVideo(page, 'interaction-one', 'fit-16-9');
    await openVideo(page);
    const container = page.locator('#playerContainer');
    await container.focus();
    await page.locator('#playerTitle').hover();
    await expect(container).not.toHaveClass(/player-controls-visible/, { timeout: 3800 });
    await page.locator('#playerVideo').hover();
    await page.locator('#playerMute').click();
    await expect(container).not.toHaveClass(/player-controls-visible/, { timeout: 3800 });
    await page.locator('#playerVideo').hover();
    await page.locator('#playerMute').click();
    await page.locator('#playerVideo').hover();
    await expect(container).not.toHaveClass(/player-controls-visible/, { timeout: 3800 });
});

const idleScenarios = ['no-preference', 'reduce'].flatMap(reducedMotion =>
    [false, true].map(fullscreen => ({ reducedMotion, fullscreen })));
for (const { reducedMotion, fullscreen } of idleScenarios) {
    test(`idle controls fade and slide, reveal and reset, with ${reducedMotion} motion (${fullscreen ? 'fullscreen' : 'overlay'})`, async ({ page }) => {
        test.setTimeout(20_000);
        await page.emulateMedia({ reducedMotion });
        await addVideo(page, 'interaction-one', 'fit-16-9');
        await openVideo(page);
        const container = page.locator('#playerContainer');
        const header = page.locator('.player-chrome');
        const controls = page.locator('#playerControls');
        await container.focus();
        if (fullscreen) {
            await page.keyboard.press('f');
            await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('playerContainer');
            await container.focus();
        }
        await page.locator('#playerVideo').hover();
        await container.evaluate(container => {
            window.__idleAnimations = [];
            window.__idleSamples = [];
            container.addEventListener('transitionrun', event => {
                if (event.target.matches('.player-chrome, #playerControls')) {
                    window.__idleAnimations.push([event.target.id || 'header', event.propertyName]);
                }
            });
            const observer = new MutationObserver(() => {
                if (container.classList.contains('player-controls-visible')) return;
                observer.disconnect();
                for (const [selector, property] of [['.player-chrome', 'opacity'], ['#playerControls', 'transform']]) {
                    const target = container.querySelector(selector);
                    const animation = target.getAnimations().find(animation => animation.transitionProperty === property);
                    if (!animation) continue;
                    const duration = animation.effect.getTiming().duration;
                    const currentTime = animation.currentTime;
                    // Frame callbacks can run before the animation clock advances or
                    // after it finishes. Seek the real CSS transition before yielding.
                    animation.pause();
                    try {
                        animation.currentTime = duration / 2;
                        const style = getComputedStyle(target);
                        const value = property === 'opacity' ? Number(style.opacity)
                            : new DOMMatrixReadOnly(style.transform).m42 / target.getBoundingClientRect().height;
                        window.__idleSamples.push({ target: target.id || 'header', property, duration, value });
                    } finally {
                        animation.currentTime = currentTime;
                        animation.play();
                    }
                }
            });
            observer.observe(container, { attributes: true, attributeFilter: ['class'] });
        });
        await page.waitForTimeout(2200);
        await expect(header).toBeVisible();
        await expect(controls).toBeVisible();
        await expect(container).not.toHaveClass(/player-controls-visible/, { timeout: 1800 });
        await expect(header).toHaveCSS('opacity', '0');
        await expect(header).toHaveCSS('pointer-events', 'none');
        await expect(controls).toHaveCSS('pointer-events', 'none');
        const hidden = await controls.evaluate(bar => ({
            translateY: new DOMMatrixReadOnly(getComputedStyle(bar).transform).m42,
            height: bar.getBoundingClientRect().height,
            property: getComputedStyle(bar).transitionProperty,
            duration: getComputedStyle(bar).transitionDuration,
        }));
        expect(hidden.translateY).toBeGreaterThanOrEqual(hidden.height - 0.1);
        if (reducedMotion === 'reduce') {
            expect(hidden.duration.split(',').every(duration => parseFloat(duration) === 0)).toBe(true);
            await expect(header).toHaveCSS('transition-duration', '0s');
        } else {
            expect(hidden.property).toContain('transform');
            expect(await header.evaluate(node => getComputedStyle(node).transitionProperty)).toContain('opacity');
            const transitions = await page.evaluate(() => window.__idleAnimations);
            expect(transitions).toContainEqual(['header', 'opacity']);
            expect(transitions).toContainEqual(['playerControls', 'transform']);
            const samples = await page.evaluate(() => window.__idleSamples);
            for (const [target, property] of [['header', 'opacity'], ['playerControls', 'transform']]) {
                const sample = samples.find(sample => sample.target === target && sample.property === property);
                expect(sample, `${target} ${property} transition: ${JSON.stringify(samples)}`).toBeDefined();
                expect(sample.duration).toBeGreaterThan(0);
                expect(sample.value).toBeGreaterThan(0);
                expect(sample.value).toBeLessThan(1);
            }
        }
        // Hit testing at the old bar position must reach the media beneath it.
        expect(await page.evaluate(() => {
            const container = document.getElementById('playerContainer').getBoundingClientRect();
            return document.elementFromPoint(container.x + container.width / 2, container.bottom - 10)?.tagName;
        })).toBe('VIDEO');
        await page.mouse.move(500, 350);
        await expect(container).toHaveClass(/player-controls-visible/);
        await expect(header).toHaveCSS('opacity', '1');
        await expect(controls).toHaveCSS('transform', 'none');
        await page.waitForTimeout(1800);
        await page.mouse.move(510, 350);
        await page.waitForTimeout(1800);
        await expect(container).toHaveClass(/player-controls-visible/);
        await expect(container).not.toHaveClass(/player-controls-visible/, { timeout: 1800 });
        await page.keyboard.press('Tab');
        await expect(container).toHaveClass(/player-controls-visible/);
        await expect(page.locator('.player-close')).toBeFocused();
        await page.waitForTimeout(3200);
        await expect(header).toBeVisible();
        await expect(controls).toBeVisible();
    });
}

for (const fixture of ['fit-16-9', 'fit-wide', 'fit-portrait']) {
    test(`${fixture} fullscreen video fills the viewport before bars hide and never shifts`, async ({ page }) => {
        test.setTimeout(15_000);
        await page.setViewportSize({ width: 1280, height: 720 });
        await addVideo(page, 'interaction-one', fixture);
        await openVideo(page);
        await page.locator('#playerContainer').focus();
        await page.keyboard.press('f');
        await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('playerContainer');
        const video = page.locator('#playerVideo');
        const container = page.locator('#playerContainer');
        await container.focus();
        await page.mouse.move(400, 300);
        await expect(container).toHaveClass(/player-controls-visible/);
        const visible = await video.boundingBox();
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        expect(visible).toEqual({ x: 0, y: 0, ...viewport });
        await expect(video).toHaveCSS('object-fit', 'contain');
        await expect(container).not.toHaveClass(/player-controls-visible/, { timeout: 3800 });
        expect(await video.boundingBox()).toEqual(visible);
        await page.mouse.move(410, 300);
        await expect(container).toHaveClass(/player-controls-visible/);
        expect(await video.boundingBox()).toEqual(visible);
    });
}

test('controls keep their own actions and pointer range drags do not toggle playback', async ({ page }) => {
    await addVideo(page);
    await openVideo(page);
    await page.locator('#playerVideo').evaluate(video => {
        window.__controlPlaybackEvents = [];
        for (const event of ['play', 'pause']) video.addEventListener(event, () => window.__controlPlaybackEvents.push(event));
    });
    await page.locator('#playerTitle').click();
    await page.locator('#playerMute').click();
    await page.locator('#playerSpeed').selectOption('1.5');
    await page.locator('#playerMute').hover();
    const volume = await page.locator('#playerVolume').boundingBox();
    await page.mouse.move(volume.x + volume.width - 8, volume.y + volume.height / 2);
    await page.mouse.down();
    await page.mouse.move(volume.x + volume.width * 0.4, volume.y + volume.height / 2);
    await page.mouse.up();
    const seek = await page.locator('#playerSeek').boundingBox();
    await page.mouse.move(seek.x + seek.width * 0.1, seek.y + seek.height / 2);
    await page.mouse.down();
    await page.mouse.move(seek.x + seek.width * 0.4, seek.y + seek.height / 2);
    await page.mouse.up();
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
    expect(await page.evaluate(() => window.__controlPlaybackEvents)).toEqual([]);
    await page.locator('#playerPlayPause').click();
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
    expect(await page.evaluate(() => window.__controlPlaybackEvents)).toEqual(['pause']);
    await page.locator('.player-close').click();
    await expect(page.locator('#playerBackdrop')).not.toHaveClass(/open/);
});

test('a held range and keyboard-operated speed selector remain usable past the idle deadline', async ({ page }) => {
    test.setTimeout(15_000);
    await addVideo(page, 'interaction-one', 'fit-16-9');
    await openVideo(page);
    const seek = await page.locator('#playerSeek').boundingBox();
    await page.mouse.move(seek.x + seek.width / 2, seek.y + seek.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(3300);
    await expect(page.locator('#playerControls')).toBeVisible();
    await page.mouse.up();
    await page.locator('#playerVideo').hover();
    await page.locator('#playerContainer').focus();
    await page.keyboard.press('Tab');
    await page.locator('#playerSpeed').focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(3300);
    await expect(page.locator('#playerSpeed')).toBeVisible();
    await expect(page.locator('#playerSpeed')).toBeFocused();
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
});

test('repeat restarts the same real video, disabling restores EOF, and reopening resets it', async ({ page }) => {
    test.setTimeout(15_000);
    await addVideo(page);
    await addVideo(page, 'interaction-two');
    await openVideo(page);
    const repeat = page.getByRole('button', { name: 'Repeat current video', exact: true });
    await expect(repeat).toHaveAttribute('aria-pressed', 'false');
    const offBackground = await repeat.evaluate(button => getComputedStyle(button).backgroundColor);
    await repeat.click();
    await expect(repeat).toHaveAttribute('aria-pressed', 'true');
    expect(await repeat.evaluate(button => getComputedStyle(button).backgroundColor)).not.toBe(offBackground);
    const source = await page.locator('#playerVideo source').getAttribute('src');
    await page.locator('#playerVideo').evaluate(video => { video.currentTime = video.duration - 0.3; });
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeLessThan(2);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', source);
    await repeat.click();
    await expect(repeat).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#playerVideo').evaluate(video => { video.currentTime = video.duration - 0.3; });
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.ended)).toBe(true);
    await repeat.click();
    await page.locator('.player-close').click();
    await openVideo(page, 'interaction-two');
    await expect(repeat).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#playerVideo').evaluate(video => { video.currentTime = video.duration - 0.3; });
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.ended)).toBe(true);
});

for (const mode of ['sequential', 'shuffle', 'shuffle_clips']) {
    test(`repeat keeps ${mode} mode and resumes its normal advancement when disabled`, async ({ page }) => {
        test.setTimeout(15_000);
        await addVideo(page, 'interaction-one', 'fit-16-9');
        await addVideo(page, 'interaction-two', 'fit-16-9');
        await page.evaluate(mode => startEndlessPlayback(null, '', '', mode), mode);
        await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
        await page.locator('#playerRepeat').click();
        const original = await page.locator('#playerVideo source').getAttribute('src');
        const session = await page.evaluate(() => endlessPlayback.sessionId);
        await page.locator('#playerVideo').evaluate((video, mode) => {
            const boundary = playerBoundaries.get(video);
            video.currentTime = (mode === 'shuffle_clips' ? video.duration
                : boundary.valid ? boundary.end : video.duration) - 0.3;
        }, mode);
        await expect.poll(() => page.locator('#playerVideo').evaluate((video, mode) => {
            const boundary = playerBoundaries.get(video);
            return video.currentTime - (mode === 'shuffle_clips' ? 0 : boundary.valid ? boundary.start : 0);
        }, mode)).toBeLessThan(2);
        await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
        await expect(page.locator('#playerVideo source')).toHaveAttribute('src', original);
        expect(await page.evaluate(() => ({ mode: endlessPlayback.mode, session: endlessPlayback.sessionId })))
            .toEqual({ mode, session });
        await page.locator('#playerRepeat').click();
        await expect(page.locator('#playerRepeat')).toHaveAttribute('aria-pressed', 'false');
        // The ordinary boundary path should once again be allowed to advance.
        await page.locator('#playerVideo').evaluate(video => {
            const boundary = playerBoundaries.get(video);
            video.currentTime = (boundary.valid ? boundary.end : video.duration) - 0.1;
        });
        await expect.poll(() => page.locator('#playerVideo source').getAttribute('src'), { timeout: 6000 }).not.toBe(original);
        expect(await page.evaluate(() => endlessPlayback.mode)).toBe(mode);
    });
}

test('closing a native speed popup without changing its rate does not pin idle controls', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Chromium exposes the native select popup through :open');
    test.setTimeout(15_000);
    await addVideo(page, 'interaction-one', 'fit-16-9');
    await openVideo(page);
    const speed = page.locator('#playerSpeed');
    await speed.click();
    await expect.poll(() => speed.evaluate(select => select.matches(':open'))).toBe(true);
    await page.waitForTimeout(3300);
    await expect(page.locator('#playerContainer')).toHaveClass(/player-controls-visible/);
    await page.keyboard.press('Escape');
    await expect.poll(() => speed.evaluate(select => select.matches(':open'))).toBe(false);
    await expect(speed).toHaveValue('1');
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    await expect(page.locator('#playerContainer')).not.toHaveClass(/player-controls-visible/, { timeout: 3800 });
});

test('repeat holds the current playlist video and disabling it restores queue advancement', async ({ page }) => {
    test.setTimeout(15_000);
    await addVideo(page, 'repeat-list-one');
    await addVideo(page, 'repeat-list-two');
    const created = await page.request.post('/api/playlists', {
        data: { name: 'Repeat queue', download_ids: ['repeat-list-one', 'repeat-list-two'] },
    });
    expect(created.status()).toBe(201);
    await page.evaluate(() => fetchPlaylists());
    await page.getByRole('button', { name: 'Resume playlist: Repeat queue' }).click();
    await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', '/api/file/repeat-list-one');
    const session = await page.evaluate(() => endlessPlayback.sessionId);
    await page.locator('#playerRepeat').click();
    await expect(page.locator('#playerRepeat')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#playerVideo').evaluate(video => { video.currentTime = video.duration - 0.3; });
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeLessThan(2);
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', '/api/file/repeat-list-one');
    expect(await page.evaluate(() => ({ mode: endlessPlayback.mode, session: endlessPlayback.sessionId })))
        .toEqual({ mode: 'playlist', session });
    await page.locator('#playerRepeat').click();
    await page.locator('#playerVideo').evaluate(video => { video.currentTime = video.duration - 0.3; });
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', '/api/file/repeat-list-two', { timeout: 6000 });
    await expect(page.locator('#playerRepeat')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => endlessPlayback.mode)).toBe('playlist');
});

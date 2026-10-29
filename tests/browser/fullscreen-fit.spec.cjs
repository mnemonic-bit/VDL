const { test, expect } = require('@playwright/test');
const { reset, seed } = require('./support.cjs');

test.use({ viewport: { width: 1280, height: 720 } });
test.beforeEach(async ({ page }) => reset(page));

async function expectCompleteFrame(page, width, height, capture = null) {
    const video = page.locator('#playerVideo');
    await expect.poll(() => video.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2);
    await page.mouse.move(0, 0);
    const rectangle = await video.boundingBox();
    // Firefox fullscreen uses the headless display's viewport; a default
    // screenshot clips it to the context's configured window dimensions.
    const screenshot = capture ? await capture() : await page.screenshot({
        fullPage: page.context().browser().browserType().name() === 'firefox',
    });
    const samples = await page.evaluate(async ({ png, width, height, rectangle }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${png}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const scale = Math.min(rectangle.width / width, rectangle.height / height);
        const w = width * scale;
        const h = height * scale;
        const x = rectangle.x + (rectangle.width - w) / 2;
        const y = rectangle.y + (rectangle.height - h) / 2;
        const pixel = (px, py) => Array.from(context.getImageData(Math.floor(px), Math.floor(py), 1, 1).data).slice(0, 3);
        return {
            edges: [pixel(x + w / 2, y + 10 * scale), pixel(x + w / 2, y + h - 10 * scale),
                pixel(x + 10 * scale, y + h / 2), pixel(x + w - 10 * scale, y + h / 2)],
            center: pixel(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2),
            bars: x - rectangle.x > 1
                ? [pixel(rectangle.x + (x - rectangle.x) / 2, y + h / 2),
                    pixel(x + w + (rectangle.width - w) / 4, y + h / 2)]
                : y - rectangle.y > 1
                    ? [pixel(x + w / 2, rectangle.y + (y - rectangle.y) / 2),
                        pixel(x + w / 2, y + h + (rectangle.height - h) / 4)] : [],
        };
    }, { png: screenshot.toString('base64'), width, height, rectangle });
    for (const edge of samples.edges) {
        for (const channel of edge) expect(channel, `complete white edge: ${JSON.stringify(samples)}`).toBeGreaterThan(220);
    }
    expect(samples.center[2]).toBeGreaterThan(220);
    expect(samples.center[0]).toBeLessThan(30);
    for (const bar of samples.bars) {
        for (const channel of bar) expect(channel).toBeLessThan(20);
    }
}

const pictures = [
    { name: '4-3', width: 1600, height: 1200 },
    { name: 'portrait', width: 900, height: 1600 },
    { name: 'wide', width: 1920, height: 800 },
    { name: '16-9', width: 1600, height: 900 },
];

const scenarios = pictures.flatMap(picture => ['single', 'continuous'].flatMap(mode =>
    ['manual', 'launch'].map(entry => ({ ...picture, mode, entry }))));

for (const { name, width, height, mode, entry } of scenarios) {
    test(`${name} complete frame in ${mode} fullscreen (${entry})`, async ({ page }) => {
        test.setTimeout(20_000);
        await page.request.post('/__test__/preferences', {
            data: { start_fullscreen: String(entry === 'launch') },
        });
        await seed(page, {
            id: 'fit-video', name: 'fit.webm', status: 'finished', file: true,
            media_fixture: `fit-${name}`, duration_seconds: 60, media_metadata_probed: true,
        });
        await page.reload();
        const video = page.locator('#playerVideo');
        const open = async () => {
            if (mode === 'continuous') await page.locator('#endlessPlaybackButton').click();
            else await page.locator('[data-row-id="fit-video"]').getByRole('button', { name: 'Play', exact: true }).click();
            await expect.poll(() => video.evaluate(element => element.videoWidth)).toBe(width);
        };
        await open();
        if (entry === 'manual') await page.keyboard.press('f');
        await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id))
            .toBe('playerContainer');
        await expectCompleteFrame(page, width, height);

        await page.evaluate(() => document.exitFullscreen());
        await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
        // Resize the window between entries; Chromium rejects window resizing
        // while fullscreen. The live viewport test below uses device emulation.
        await page.setViewportSize({ width: 720, height: 960 });
        if (entry === 'launch') {
            await expect(page.locator('#playerBackdrop')).not.toHaveClass(/open/);
            await open();
        } else {
            await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
            await page.keyboard.press('f');
        }
        await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
        await expectCompleteFrame(page, width, height);
        await page.evaluate(() => document.exitFullscreen());

        if (entry === 'launch') {
            await page.request.post('/__test__/preferences', { data: { start_fullscreen: 'false' } });
            await page.reload();
            await open();
        }
        await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
        await expect.poll(() => video.evaluate(element => element.paused)).toBe(false);
        await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThan(0);
        const bounds = await video.boundingBox();
        const container = await page.locator('#playerContainer').boundingBox();
        expect(container.width).toBeLessThanOrEqual(720);
        expect(container.height).toBeLessThanOrEqual(960);
        expect(bounds.x).toBeGreaterThanOrEqual(container.x);
        expect(bounds.y).toBeGreaterThanOrEqual(container.y);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(container.x + container.width + 1);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(container.y + container.height + 1);
    });
}

test('continuous fullscreen fits a live viewport resize', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP viewport emulation requires Chromium');
    await seed(page, {
        id: 'fit-resize', name: 'resize.webm', status: 'finished', file: true,
        media_fixture: 'fit-4-3', duration_seconds: 60, media_metadata_probed: true,
    });
    await page.reload();
    await page.locator('#endlessPlaybackButton').click();
    await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.videoWidth)).toBe(1600);
    await page.keyboard.press('f');
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('playerContainer');
    const session = await page.context().newCDPSession(page);
    for (const viewport of [{ width: 960, height: 720 }, { width: 720, height: 960 }]) {
        await session.send('Emulation.setDeviceMetricsOverride', {
            ...viewport, deviceScaleFactor: 1, mobile: false,
        });
        await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(viewport);
        // Playwright's page.screenshot restores its configured viewport, undoing
        // CDP emulation before capture. Capture directly to measure the resize.
        await expectCompleteFrame(page, 1600, 1200, async () => Buffer.from(
            (await session.send('Page.captureScreenshot', {
                format: 'png', captureBeyondViewport: false,
            })).data, 'base64',
        ));
    }
});

for (const { name, width, height } of pictures) {
    test(`${name} complete frame with playlist queue expanded and collapsed`, async ({ page }) => {
        test.setTimeout(20_000);
        await seed(page, {
            id: 'fit-queue', name: 'queue.webm', status: 'finished', file: true,
            media_fixture: `fit-${name}`, duration_seconds: 60, media_metadata_probed: true,
        });
        const response = await page.request.post('/api/playlists', {
            data: { name: 'Marked pictures', download_ids: ['fit-queue'] },
        });
        expect(response.status()).toBe(201);
        await page.reload();
        await page.getByRole('button', { name: 'Resume playlist: Marked pictures' }).click();
        await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.videoWidth)).toBe(width);
        await page.locator('#playerFullscreen').click();
        await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('playerContainer');
        await expect(page.locator('#playlistQueue')).toBeVisible();
        await expectCompleteFrame(page, width, height);
        await page.locator('#playerQueueToggle').click();
        await expect(page.locator('#playlistQueue')).toBeHidden();
        await expectCompleteFrame(page, width, height);
        await page.locator('#playerQueueToggle').click();
        await expect(page.locator('#playlistQueue')).toBeVisible();
        await expectCompleteFrame(page, width, height);
    });

    test(`${name} complete frame during an actual fullscreen fade`, async ({ page }) => {
        test.setTimeout(20_000);
        for (const id of ['fit-incoming', 'fit-outgoing']) {
            await seed(page, {
                id, name: `${id}.webm`, status: 'finished', file: true,
                media_fixture: `fit-${name}`, duration_seconds: 60, media_metadata_probed: true,
            });
        }
        await page.reload();
        await page.locator('#endlessPlaybackButton').click();
        await expect.poll(() => page.evaluate(() => endlessPlayback.phase)).toBe('playing');
        await page.locator('#playerFullscreen').click();
        await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('playerContainer');
        await page.locator('#playerVideo').evaluate(video => { video.currentTime = 50.2; });
        await expect.poll(() => page.locator('#playerStandby').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(3);
        await page.locator('#playerVideo').evaluate(video => { video.currentTime = 57.1; });
        await expect.poll(() => page.evaluate(() => Boolean(playerPreparation?.fade))).toBe(true);
        await page.locator('#playerVideo').evaluate(video => video.pause());
        await expect.poll(() => page.evaluate(() => [
            playerPreparation.incoming.paused, playerPreparation.outgoing.paused,
        ])).toEqual([true, true]);
        const overlap = await page.evaluate(() => ({
            active: endlessPlayback.currentDownloadId,
            paused: [playerPreparation.incoming.paused, playerPreparation.outgoing.paused],
            fullscreen: document.fullscreenElement?.id,
        }));
        expect(overlap).toEqual({ active: 'fit-incoming', paused: [true, true], fullscreen: 'playerContainer' });
        await expectCompleteFrame(page, width, height);
    });
}

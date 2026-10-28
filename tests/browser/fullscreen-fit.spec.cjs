const { test, expect } = require('@playwright/test');
const { reset, seed } = require('./support.cjs');

test.use({ viewport: { width: 1280, height: 720 } });
test.beforeEach(async ({ page }) => reset(page));

async function expectCompleteFrame(page, width, height) {
    const video = page.locator('#playerVideo');
    await expect.poll(() => video.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2);
    await video.evaluate(element => { element.controls = false; });
    await page.mouse.move(0, 0);
    // Native fullscreen controls can cover an edge even when controls=false.
    const screenshot = await page.screenshot({ style: 'video::-webkit-media-controls { display: none !important; }' });
    const samples = await page.evaluate(async ({ png, width, height }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${png}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const scale = Math.min(image.width / width, image.height / height);
        const w = width * scale;
        const h = height * scale;
        const x = (image.width - w) / 2;
        const y = (image.height - h) / 2;
        const pixel = (px, py) => Array.from(context.getImageData(Math.floor(px), Math.floor(py), 1, 1).data).slice(0, 3);
        return {
            edges: [pixel(x + w / 2, y + 10 * scale), pixel(x + w / 2, y + h - 10 * scale),
                pixel(x + 10 * scale, y + h / 2), pixel(x + w - 10 * scale, y + h / 2)],
            center: pixel(image.width / 2, image.height / 2),
            bars: x > 1 ? [pixel(x / 2, image.height / 2), pixel(image.width - x / 2, image.height / 2)]
                : y > 1 ? [pixel(image.width / 2, y / 2), pixel(image.width / 2, image.height - y / 2)] : [],
        };
    }, { png: screenshot.toString('base64'), width, height });
    for (const edge of samples.edges) {
        for (const channel of edge) expect(channel, `complete white edge: ${JSON.stringify(samples)}`).toBeGreaterThan(220);
    }
    expect(samples.center[2]).toBeGreaterThan(220);
    expect(samples.center[0]).toBeLessThan(30);
    for (const bar of samples.bars) {
        for (const channel of bar) expect(channel).toBeLessThan(20);
    }
    await video.evaluate(element => { element.controls = true; });
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
            .toBe(mode === 'single' ? 'playerVideo' : 'playerMediaStage');
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
        expect(bounds.width).toBeLessThanOrEqual(720 * 0.9 + 1);
        expect(bounds.height).toBeLessThanOrEqual(960 * 0.9 + 1);
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
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('playerMediaStage');
    const session = await page.context().newCDPSession(page);
    for (const viewport of [{ width: 960, height: 720 }, { width: 720, height: 960 }]) {
        await session.send('Emulation.setDeviceMetricsOverride', {
            ...viewport, deviceScaleFactor: 1, mobile: false,
        });
        await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(viewport);
        await expectCompleteFrame(page, 1600, 1200);
    }
});

const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

async function installFullscreenHarness(page) {
    await page.addInitScript(() => {
        Object.defineProperty(document, 'fullscreenElement', {
            configurable: true,
            get: () => window.__fullscreenElement || null,
        });
        HTMLVideoElement.prototype.requestFullscreen = function requestFullscreen() {
            window.__fullscreenElement = this;
            document.dispatchEvent(new Event('fullscreenchange'));
            return Promise.resolve();
        };
        window.__browserEscapeFullscreen = () => {
            window.__fullscreenElement = null;
            document.dispatchEvent(new Event('fullscreenchange'));
        };
    });
}

test('overlay playback assigns MIME, supports Range, and Escape closes it', async ({ page }) => {
    await seed(page, { id: 'play0001', status: 'finished', file: true, name: 'fixture.mp4' });
    await refresh(page);
    await page.locator('[data-row-id="play0001"]').getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    await expect(page.locator('#playerVideo source')).toHaveAttribute('type', 'video/mp4');
    const range = await page.request.get('/api/file/play0001', { headers: { Range: 'bytes=10-19' } });
    expect(range.status()).toBe(206);
    expect((await range.body()).length).toBe(10);
    await page.keyboard.press('Escape');
    await expect(page.locator('#playerBackdrop')).not.toHaveClass(/open/);
});

test('Escape closes playback that started in full screen', async ({ page }) => {
    await installFullscreenHarness(page);
    await page.request.post('/__test__/preferences', {
        data: { start_fullscreen: 'true' },
    });
    await seed(page, {
        id: 'play-fullscreen', status: 'finished', file: true, name: 'fixture.mp4',
    });
    await page.reload();
    await page.locator('[data-row-id="play-fullscreen"]')
        .getByRole('button', { name: 'Play', exact: true }).click();

    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id || null))
        .toBe('playerVideo');
    await page.evaluate(() => window.__browserEscapeFullscreen());

    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
    await expect(page.locator('#playerBackdrop')).not.toHaveClass(/open/);
    await expect(page.locator('#playerVideo source')).toHaveCount(0);
    expect(await page.locator('#playerVideo').evaluate(video => video.paused)).toBe(true);
});

test('Escape returns manually entered full screen to overlay playback', async ({ page }) => {
    await installFullscreenHarness(page);
    await seed(page, {
        id: 'play-overlay', status: 'finished', file: true, name: 'fixture.mp4',
    });
    await page.reload();
    await page.locator('[data-row-id="play-overlay"]')
        .getByRole('button', { name: 'Play', exact: true }).click();
    await page.locator('#playerVideo').evaluate(video => video.requestFullscreen());
    await page.evaluate(() => window.__browserEscapeFullscreen());

    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    await expect(page.locator('#playerVideo source')).toHaveCount(1);
});

test('overlay omits the title and reveals its inner close button on mouse activity', async ({ page }) => {
    test.setTimeout(15_000);
    await seed(page, { id: 'player-ui', status: 'finished', file: true, name: 'fixture.mp4' });
    await refresh(page);
    await page.locator('[data-row-id="player-ui"]').getByRole('button', { name: 'Play', exact: true }).click();

    const player = page.locator('.player-box');
    const video = page.locator('#playerVideo');
    const close = page.getByRole('button', { name: 'Close player' });
    await expect(page.locator('#playerTitle')).toHaveCount(0);
    await expect(close).toHaveCSS('opacity', '0');

    const videoBounds = await video.boundingBox();
    const closeBounds = await close.boundingBox();
    expect(closeBounds.x).toBeGreaterThanOrEqual(videoBounds.x);
    expect(closeBounds.y).toBeGreaterThanOrEqual(videoBounds.y);
    expect(closeBounds.x + closeBounds.width).toBeLessThanOrEqual(videoBounds.x + videoBounds.width);
    expect(closeBounds.y + closeBounds.height).toBeLessThanOrEqual(videoBounds.y + videoBounds.height);

    await page.mouse.move(
        videoBounds.x + videoBounds.width / 2,
        videoBounds.y + videoBounds.height / 2,
    );
    await expect(player).toHaveClass(/player-controls-visible/);
    await expect(close).toHaveCSS('opacity', '1');
    await page.waitForTimeout(2_100);
    expect(await player.evaluate(element =>
        element.classList.contains('player-controls-visible'))).toBe(false);
    await expect(close).toHaveCSS('opacity', '0');

    await close.focus();
    await expect(close).toHaveCSS('opacity', '1');
});

test('new-tab player mode opens the stored file endpoint', async ({ page }) => {
    await page.request.post('/__test__/preferences', { data: { player_mode: 'new_tab' } });
    await seed(page, { id: 'playtab1', status: 'finished', file: true, name: 'fixture.webm' });
    await page.reload();
    await page.evaluate(() => {
        window.__opened = null;
        window.open = (...args) => { window.__opened = args; };
    });
    await page.locator('[data-row-id="playtab1"]').getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__opened)).not.toBeNull();
    expect((await page.evaluate(() => window.__opened))[0]).toBe('/api/file/playtab1');
});

test('three-dot menu downloads the stored video to the browser', async ({ page }) => {
    await seed(page, {
        id: 'download-file', status: 'finished', file: true, name: 'saved video.mp4',
    });
    await refresh(page);

    const row = page.locator('[data-row-id="download-file"]');
    await row.locator('.kebab-btn').click();
    const downloadPromise = page.waitForEvent('download');
    await row.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('saved video.mp4');
    expect(await download.failure()).toBeNull();
});

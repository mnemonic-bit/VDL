const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

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

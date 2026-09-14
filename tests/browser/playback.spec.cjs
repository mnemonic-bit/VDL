const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

test('overlay playback assigns MIME, supports Range, and Escape closes it', async ({ page }) => {
    await seed(page, { id: 'play0001', status: 'finished', file: true, name: 'fixture.mp4' });
    await page.locator('[data-tab=history]').click();
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
    await page.locator('[data-tab=history]').click();
    await page.evaluate(() => {
        window.__opened = null;
        window.open = (...args) => { window.__opened = args; };
    });
    await page.locator('[data-row-id="playtab1"]').getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__opened)).not.toBeNull();
    expect((await page.evaluate(() => window.__opened))[0]).toBe('/api/file/playtab1');
});

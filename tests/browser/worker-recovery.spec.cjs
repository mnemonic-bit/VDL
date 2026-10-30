const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openCurrent } = require('./support.cjs');

test.beforeEach(async ({ page }) => {
    await reset(page);
});

for (const stage of [
    'Waiting for a download slot',
    'Preparing download',
    'Reading source information',
    'Waiting for media',
    'Stopping download; waiting for the source to respond',
]) {
    test(`Current downloads explains zero-byte state: ${stage}`, async ({ page }) => {
        await seed(page, {
            id: 'waiting-source', status: 'starting', progress: stage,
        });
        await refresh(page);
        await openCurrent(page);
        const summary = page.locator('[data-row-id="waiting-source"] .download-summary-row');
        await expect(summary).toContainText(stage);
        await expect(summary).toContainText('Bytes downloaded: 0 B');
        await expect(summary).toContainText('Downloaded: —');
        await expect(page.locator('[data-row-id="waiting-source"]').getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    });
}

test('preparation text is escaped and partial bytes remain visible while stopping', async ({ page }) => {
    await seed(page, {
        id: 'escaped-source', status: 'starting',
        progress: '<img src=x onerror="window.unescapedStage=true">',
    });
    await seed(page, {
        id: 'stopping-source', status: 'downloading', downloaded_bytes: 4096,
        progress: 'Stopping download; waiting for the source to respond',
    });
    await refresh(page);
    await openCurrent(page);
    await expect(page.locator('[data-row-id="escaped-source"] .download-summary-row')).toContainText('<img src=x');
    await expect(page.locator('[data-row-id="escaped-source"] .download-summary-row img')).toHaveCount(0);
    expect(await page.evaluate(() => window.unescapedStage)).toBeUndefined();
    const summary = page.locator('[data-row-id="stopping-source"] .download-summary-row');
    await expect(summary).toContainText('Stopping download');
    await expect(summary).toContainText('Bytes downloaded: 4.0 KB');
});

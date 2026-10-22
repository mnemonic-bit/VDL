const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openCurrent, openSettings } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

async function reject(page, path, message) {
    await page.route(`**${path}`, route => route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: message }),
    }));
}

test('failed Pause request reports the error and preserves the row', async ({ page }) => {
    await seed(page, { id: 'failpause', status: 'downloading', progress: '25%' });
    await refresh(page);
    await openCurrent(page);
    await reject(page, '/api/pause/failpause', 'pause was rejected');
    const row = page.locator('[data-row-id="failpause"]');
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByText('pause was rejected')).toBeVisible();
    await expect(row).toBeVisible();
});

test('failed Stop request reports the error and preserves the row', async ({ page }) => {
    await seed(page, { id: 'failstop', status: 'downloading', progress: '25%' });
    await refresh(page);
    await openCurrent(page);
    await reject(page, '/api/stop/failstop', 'stop was rejected');
    const row = page.locator('[data-row-id="failstop"]');
    await row.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByText('stop was rejected')).toBeVisible();
    await expect(row).toBeVisible();
});

test('failed Continue request reports the error and preserves the row', async ({ page }) => {
    await seed(page, { id: 'failcontinue', status: 'cancelled', progress: 'Stopped' });
    await refresh(page);
    await openCurrent(page);
    await reject(page, '/api/resume/failcontinue', 'continue was rejected');
    const row = page.locator('[data-row-id="failcontinue"]');
    await row.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('continue was rejected')).toBeVisible();
    await expect(row).toBeVisible();
});

test('failed Delete request restores the row and reports the error', async ({ page }) => {
    await seed(page, { id: 'faildelete', status: 'finished', file: true });
    await refresh(page);
    await reject(page, '/api/remove/faildelete', 'delete was rejected');
    const row = page.locator('[data-row-id="faildelete"]');
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(row).toBeVisible();
    await expect(page.getByText('delete was rejected')).toBeVisible();
});

test('failed Retry reports the error and preserves the attempt', async ({ page }) => {
    await seed(page, { id: 'failreload', status: 'error', progress: 'fixture error' });
    await page.locator('#accountMenuButton').click();
    await page.locator('#attemptHistoryButton').click();
    await reject(page, '/api/retry/failreload', 'retry was rejected');
    const row = page.locator('.attempt-row').filter({ hasText: 'fixture error' });
    await row.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByText('retry was rejected')).toBeVisible();
    await expect(row).toBeVisible();
});

test('failed Clear reports the error and preserves History', async ({ page }) => {
    await seed(page, { id: 'failclear', status: 'finished', file: true });
    await openSettings(page);
    await refresh(page);
    await reject(page, '/api/clear', 'clear was rejected');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Clear History', exact: true }).click();
    await expect(page.getByText('clear was rejected')).toBeVisible();
    await page.getByRole('button', { name: 'Back to videos', exact: true }).click();
    await expect(page.locator('[data-row-id="failclear"]')).toBeVisible();
});

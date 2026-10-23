const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openCurrent } = require('./support.cjs');

const busyBody = JSON.stringify({
    code: 'database_busy', retryable: true, error: 'Database is busy; please retry shortly',
});

async function busy(route) {
    await route.fulfill({
        status: 503,
        contentType: 'application/json',
        headers: { 'Retry-After': '0' },
        body: busyBody,
    });
}

test.beforeEach(async ({ page }) => {
    // Exercise explicit refreshes without unrelated fixture SSE events racing them.
    await page.addInitScript(() => { window.EventSource = class extends EventTarget {}; });
    await reset(page);
});

test('Current Downloads recovers when authentication reads briefly encounter a busy database', async ({ page }) => {
    await seed(page, { id: 'busy-current', status: 'downloading' });
    let requests = 0;
    await page.route('**/api/current-downloads', async route => {
        if (++requests === 1) await busy(route);
        else await route.continue();
    });
    await refresh(page);
    expect(requests).toBe(2);
    await openCurrent(page);
    await expect(page.locator('#activeList [data-row-id="busy-current"]')).toBeVisible();
    await expect(page.locator('#serverStatus')).toBeHidden();
});

test('exhausted refresh preserves existing rows, displays an error, and later recovers', async ({ page }) => {
    await seed(page, { id: 'busy-library', status: 'finished' });
    await refresh(page);
    let requests = 0;
    await page.route('**/api/library', async route => { requests++; await busy(route); });
    await refresh(page);
    expect(requests).toBe(3);
    await expect(page.locator('#historyList [data-row-id="busy-library"]')).toBeVisible();
    await expect(page.locator('#actionError')).toBeVisible();
    await expect(page.locator('#actionErrorMessage')).toContainText('Database is busy');
    await page.unroute('**/api/library');
    await refresh(page);
    await expect(page.locator('#actionError')).toBeHidden();
    await expect(page.locator('#historyList [data-row-id="busy-library"]')).toBeVisible();
});

test('initial database contention displays a refresh failure instead of an empty library', async ({ page }) => {
    await page.route('**/api/current-downloads', busy);
    await page.reload();
    await expect(page.locator('#actionError')).toBeVisible();
    await expect(page.locator('#historyEmptyTitle')).toHaveText('Could not load downloads');
    await expect(page.locator('#historyEmptyAction')).toBeHidden();
    await expect(page.locator('#currentEmpty')).toContainText('Could not refresh');
    await page.unroute('**/api/current-downloads');
    await refresh(page);
    await expect(page.locator('#historyEmptyTitle')).toHaveText('No downloads yet');
    await expect(page.locator('#actionError')).toBeHidden();
});

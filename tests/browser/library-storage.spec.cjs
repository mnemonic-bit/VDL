const { test, expect } = require('@playwright/test');
const { reset, switchAccount } = require('./support.cjs');

const snapshot = (total_bytes = 30100000, state = 'ready') => ({
    total_bytes, state,
    measured_at: '2026-11-06T12:00:00+00:00',
    next_refresh_at: '2026-11-07T12:00:00+00:00',
});
const unknown = state => ({ total_bytes: null, measured_at: null, next_refresh_at: null, state });

test('storage footer exposes loading, ready, stale, unavailable, malformed, and recovery states', async ({ page }) => {
    let body = unknown('calculating');
    let status = 200;
    await page.route('**/api/library-storage', route => route.fulfill({
        status, contentType: 'application/json', body: JSON.stringify(body),
    }));
    await reset(page);
    const label = page.locator('#libraryStorageLabel');
    await expect(label).toHaveText('Videos calculating…');
    body = snapshot();
    await page.evaluate(() => fetchLibraryStorage());
    await expect(label).toHaveText('Videos 30.1 M');
    await label.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#libraryStorageDescription')).toBeVisible();
    await expect(page.locator('#libraryStorageDescription')).toHaveText('Video storage, updated daily.');
    await expect(page.locator('#libraryStorageUpdated')).toContainText('Last successful measurement:');
    await expect(label).toBeFocused();

    body = snapshot(30100000, 'stale');
    await page.evaluate(() => fetchLibraryStorage());
    await expect(label).toHaveText('Videos 30.1 M (stale)');
    await expect(page.locator('#libraryStorageUpdated')).toContainText('This measurement is stale');
    for (const malformed of [{}, { ...snapshot(), total_bytes: -100 }, { ...snapshot(), measured_at: null }]) {
        body = malformed;
        await page.evaluate(() => fetchLibraryStorage());
        await expect(label).toHaveText('Videos 30.1 M (stale)');
    }
    status = 503;
    await page.evaluate(() => fetchLibraryStorage());
    await expect(label).toHaveText('Videos 30.1 M (stale)');
    status = 200;
    body = snapshot(0);
    await page.evaluate(() => fetchLibraryStorage());
    await expect(label).toHaveText('Videos 0 B');
    body = unknown('unavailable');
    await page.reload();
    await expect(label).toHaveText('Videos unavailable');
    body = snapshot(999950);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(label).toHaveText('Videos 1.0 M');
    await expect(page.locator('#itemCount')).toHaveText('0 items');
    await expect(page.locator('#apiVersion')).toContainText('API v');
    await expect(page.locator('#uptime')).toContainText('Uptime');
});

test('storage details wrap inside both themes on a narrow touch viewport', async ({ page }) => {
    await page.route('**/api/library-storage', route => route.fulfill({
        contentType: 'application/json', body: JSON.stringify(snapshot(1e18, 'stale')),
    }));
    await page.setViewportSize({ width: 320, height: 640 });
    await reset(page);
    const label = page.locator('#libraryStorageLabel');
    for (const theme of ['light', 'dark']) {
        await page.evaluate(value => applyTheme(value), theme);
        await label.click();
        await expect(page.locator('#libraryStorageUpdated')).toBeVisible();
        const bounds = await page.locator('.library-storage-details').boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
        const footer = await page.locator('#versionFooter').boundingBox();
        expect(footer.x).toBe(0);
        expect(footer.width).toBe(320);
        await expect(page.locator('#libraryStorage')).toHaveAttribute('data-state', 'stale');
        await label.click();
        await expect(page.locator('#libraryStorageUpdated')).toBeHidden();
    }
});

test('storage reconciles hints, reconnects, and focus without a browser refresh timer', async ({ page }) => {
    await page.addInitScript(() => {
        const NativeEventSource = window.EventSource;
        window.EventSource = class extends NativeEventSource {
            constructor(...args) {
                super(...args);
                window.storageTestEvents = this;
            }
        };
    });
    let bytes = 1000;
    let reads = 0;
    await page.route('**/api/library-storage', route => {
        reads += 1;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot(bytes)) });
    });
    await reset(page);
    await expect(page.locator('#libraryStorageLabel')).toHaveText('Videos 1.0 k');
    bytes = 2000;
    await page.evaluate(() => storageTestEvents.dispatchEvent(new MessageEvent('library_storage', { data: '{}' })));
    await expect(page.locator('#libraryStorageLabel')).toHaveText('Videos 2.0 k');
    bytes = 3000;
    await page.evaluate(() => storageTestEvents.dispatchEvent(new MessageEvent('ready', { data: '{}' })));
    await expect(page.locator('#libraryStorageLabel')).toHaveText('Videos 3.0 k');
    bytes = 4000;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#libraryStorageLabel')).toHaveText('Videos 4.0 k');
    await page.clock.install();
    const before = reads;
    await page.clock.fastForward(120000);
    await expect(page.locator('#libraryStorageLabel')).toHaveText('Videos 4.0 k');
    expect(reads).toBe(before);
});

test('account switches discard an earlier user measurement even when the next request fails', async ({ page }) => {
    let available = true;
    await page.route('**/api/library-storage', route => route.fulfill({
        status: available ? 200 : 503,
        contentType: 'application/json', body: JSON.stringify(snapshot()),
    }));
    await reset(page);
    await expect(page.locator('#libraryStorageLabel')).toHaveText('Videos 30.1 M');
    const response = await page.request.post('/api/users', { data: {
        username: 'storage-reader', name: 'Storage reader', password: 'storage-password', role: 'normal',
    } });
    expect(response.ok()).toBeTruthy();
    available = false;
    await switchAccount(page, 'storage-reader', 'storage-password');
    await expect(page.locator('#libraryStorageLabel')).toHaveText('Videos unavailable');
    await expect(page.locator('#libraryStorageLabel')).not.toContainText('30.1 M');
});

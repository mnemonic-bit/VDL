const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openSettings } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

test('light, dark, and system theme choices apply immediately', async ({ page }) => {
    await openSettings(page);
    await page.locator('#prefTheme').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('#prefTheme').selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.locator('#prefTheme').selectOption('system');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('Settings waits for preferences before accepting edits', async ({ page }) => {
    let releasePreferences;
    let markRequestStarted;
    const requestStarted = new Promise(resolve => {
        markRequestStarted = resolve;
    });
    await page.route('**/api/preferences', async route => {
        if (route.request().method() !== 'GET') {
            await route.continue();
            return;
        }
        markRequestStarted();
        await new Promise(resolve => {
            releasePreferences = resolve;
        });
        await route.continue();
    });

    await page.locator('#accountMenuButton').click();
    await page.locator('#settingsButton').click();
    await requestStarted;
    await expect(page.locator('#settingsPage')).toBeHidden();

    releasePreferences();
    await expect(page.locator('#settingsPage')).toBeVisible();
    await page.locator('#prefTheme').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('preferences persist and the temporary Saved icon restores to Save', async ({ page }) => {
    await page.clock.install();
    await openSettings(page);
    await page.locator('#prefTheme').selectOption('dark');
    await page.locator('#prefMax').fill('1');
    await page.locator('#prefPageSize').selectOption('20');
    await page.locator('#saveBtn').click();
    await expect(page.locator('#saveBtn use')).toHaveAttribute('href', '#i-check');
    await page.clock.fastForward(1600);
    await expect(page.locator('#saveBtn use')).toHaveAttribute('href', '#i-save');
    await expect(page.locator('#saveBtn')).toBeEnabled();
    const preferences = await (await page.request.get('/api/preferences')).json();
    expect(preferences.max_concurrent).toBe('1');
    expect(preferences.history_page_size).toBe('20');
    expect(preferences.theme).toBe('dark');
});

test('rejected preferences stay editable and are not displayed as saved', async ({ page }) => {
    await openSettings(page);
    const original = await (await page.request.get('/api/preferences')).json();
    await page.route('**/api/preferences', async route => {
        if (route.request().method() === 'POST') {
            await route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: '{"error":"preferences were not saved"}',
            });
        } else {
            await route.continue();
        }
    });

    await page.locator('#prefMax').fill('1');
    await page.locator('#prefPlayer').selectOption('new_tab');
    await page.locator('#prefTheme').selectOption('dark');
    await page.locator('#saveBtn').click();

    await expect(page.locator('#saveBtn')).toBeEnabled();
    await expect(page.locator('#saveBtn')).toContainText('Save');
    await expect(page.getByText('preferences were not saved')).toBeVisible();
    await expect(page.locator('#prefMax')).toHaveValue('1');
    const persisted = await (await page.request.get('/api/preferences')).json();
    expect(persisted).toEqual(original);

    await seed(page, { id: 'failedpref1', status: 'finished', file: true, name: 'fixture.mp4' });
    await page.getByRole('button', { name: 'Back to videos', exact: true }).click();
    await refresh(page);
    await page.locator('[data-row-id="failedpref1"]').getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
});

test('settings sections navigate and search across General and Playback', async ({ page }) => {
    await openSettings(page);
    await expect(page.locator('#tab-history')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Playback', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Danger Zone', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Playback', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Playback', exact: true }))
        .toHaveAttribute('aria-current', 'page');

    await page.getByRole('searchbox', { name: 'Search settings' }).fill('full screen');
    await expect(page.getByText('Start videos in full screen', { exact: true })).toBeVisible();
    await expect(page.getByText('Download directory', { exact: true })).toBeHidden();
    await page.getByRole('searchbox', { name: 'Search settings' }).fill('not a setting');
    await expect(page.getByText('No settings match your search.')).toBeVisible();
});

test('Clear History is grouped in the Danger Zone section', async ({ page }) => {
    await openSettings(page);
    const dangerZone = page.locator('#settings-danger');

    await expect(page.locator('#settings-general').getByRole(
        'button', { name: 'Clear History', exact: true })).toHaveCount(0);
    await expect(dangerZone.getByRole(
        'button', { name: 'Clear History', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Danger Zone', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Danger Zone', exact: true }))
        .toHaveAttribute('aria-current', 'page');
});

test('saved full-screen playback preference requests full screen for the overlay', async ({ page }) => {
    await page.addInitScript(() => {
        HTMLVideoElement.prototype.requestFullscreen = function requestFullscreen() {
            window.__fullscreenRequestCount = (window.__fullscreenRequestCount || 0) + 1;
            return Promise.resolve();
        };
    });
    await page.reload();
    await expect(page.locator('#prefDir')).not.toHaveValue('');
    await seed(page, { id: 'fullscreen1', status: 'finished', file: true, name: 'fixture.mp4' });
    await refresh(page);

    await openSettings(page);
    await page.locator('#prefStartFullscreen').check();
    await page.locator('#saveBtn').click();
    await page.getByRole('button', { name: 'Back to videos', exact: true }).click();
    await page.locator('[data-row-id="fullscreen1"]')
        .getByRole('button', { name: 'Play', exact: true }).click();

    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    expect(await page.evaluate(() => window.__fullscreenRequestCount)).toBe(1);
    const preferences = await (await page.request.get('/api/preferences')).json();
    expect(preferences.start_fullscreen).toBe('true');
});

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
    await page.locator('#prefShuffleMinHeight').selectOption('1080');
    await page.locator('#prefShuffleMinDuration').fill('12');
    await page.locator('#saveBtn').click();
    await expect(page.locator('#saveBtn use')).toHaveAttribute('href', '#i-check');
    await page.clock.fastForward(1600);
    await expect(page.locator('#saveBtn use')).toHaveAttribute('href', '#i-save');
    await expect(page.locator('#saveBtn')).toBeEnabled();
    const preferences = await (await page.request.get('/api/preferences')).json();
    expect(preferences.max_concurrent).toBe('1');
    expect(preferences.history_page_size).toBe('20');
    expect(preferences.theme).toBe('dark');
    expect(preferences.shuffle_min_height).toBe('1080');
    expect(preferences.shuffle_min_duration_minutes).toBe('12');
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
    await page.getByRole('searchbox', { name: 'Search settings' }).fill('shuffle duration');
    await expect(page.getByText('Minimum video length (minutes)', { exact: true }))
        .toBeVisible();
    await page.getByRole('searchbox', { name: 'Search settings' }).fill('not a setting');
    await expect(page.getByText('No settings match your search.')).toBeVisible();
});

test('Settings keeps its header available and aligns search with its options', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 500 });
    await openSettings(page);

    await expect(page.getByText('Choose how downloads and playback work.')).toHaveCount(0);
    const geometry = await page.evaluate(() => {
        const header = document.querySelector('.settings-page-header').getBoundingClientRect();
        const nav = document.querySelector('.settings-nav').getBoundingClientRect();
        const search = document.querySelector('.settings-search').getBoundingClientRect();
        const content = document.querySelector('.settings-content').getBoundingClientRect();
        return {
            headerBottom: header.bottom,
            headerRight: header.right,
            headerTop: header.top,
            headerWidth: header.width,
            navTop: nav.top,
            navWidth: nav.width,
            searchHeight: search.height,
            searchLeft: search.left,
            searchRight: search.right,
            contentLeft: content.left,
            contentRight: content.right,
        };
    });
    expect(Math.abs(geometry.searchLeft - geometry.contentLeft)).toBeLessThan(1);
    expect(Math.abs(geometry.searchRight - geometry.contentRight)).toBeLessThan(1);
    expect(Math.abs(geometry.headerWidth - geometry.navWidth)).toBeLessThan(1);
    expect(geometry.headerRight).toBeLessThanOrEqual(geometry.contentLeft);
    expect(geometry.navTop - geometry.headerBottom)
        .toBeGreaterThanOrEqual(geometry.searchHeight);

    const scrollOwners = await page.evaluate(() => ({
        documentOverflow: getComputedStyle(document.body).overflowY,
        settingsOverflow: getComputedStyle(
            document.querySelector('.settings-page-body'),
        ).overflowY,
    }));
    expect(scrollOwners.documentOverflow).not.toBe('hidden');
    expect(scrollOwners.settingsOverflow).toBe('visible');

    await page.evaluate(() => {
        const search = document.querySelector('.settings-search').getBoundingClientRect();
        const appHeader = document.querySelector('.app-header').getBoundingClientRect();
        window.scrollBy(0, search.bottom - appHeader.bottom);
    });
    await expect.poll(() => page.evaluate(() => {
        const search = document.querySelector('.settings-search').getBoundingClientRect();
        const appHeader = document.querySelector('.app-header').getBoundingClientRect();
        return search.bottom <= appHeader.bottom + 1;
    })).toBe(true);
    const collapsedGap = await page.evaluate(() => {
        const header = document.querySelector('.settings-page-header').getBoundingClientRect();
        const nav = document.querySelector('.settings-nav').getBoundingClientRect();
        return nav.top - header.bottom;
    });
    expect(collapsedGap).toBeGreaterThanOrEqual(0);
    expect(collapsedGap).toBeLessThan(geometry.searchHeight);

    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Back to videos' })).toBeVisible();
    const stickyPosition = await page.evaluate(() => ({
        appHeaderBottom: document.querySelector('.app-header').getBoundingClientRect().bottom,
        settingsHeaderTop: document.querySelector('.settings-page-header')
            .getBoundingClientRect().top,
    }));
    expect(Math.abs(stickyPosition.settingsHeaderTop - stickyPosition.appHeaderBottom))
        .toBeLessThan(1);
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

const { test, expect } = require('@playwright/test');
const { reset } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

test('light, dark, and system theme choices apply immediately', async ({ page }) => {
    await page.locator('[data-tab=preferences]').click();
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

test('preferences persist and the temporary Saved icon restores to Save', async ({ page }) => {
    await page.clock.install();
    await page.locator('[data-tab=preferences]').click();
    await page.locator('#prefTheme').selectOption('dark');
    await page.locator('#prefMax').fill('1');
    await page.locator('#saveBtn').click();
    await expect(page.locator('#saveBtn use')).toHaveAttribute('href', '#i-check');
    await page.clock.fastForward(1600);
    await expect(page.locator('#saveBtn use')).toHaveAttribute('href', '#i-save');
    await expect(page.locator('#saveBtn')).toBeEnabled();
    const preferences = await (await page.request.get('/api/preferences')).json();
    expect(preferences.max_concurrent).toBe('1');
    expect(preferences.theme).toBe('dark');
});

test('rejected preferences stay editable and are not displayed as saved', async ({ page }) => {
    test.fail(true, 'BUG 21: failed Preferences saves are displayed as successful');
    await page.locator('[data-tab=preferences]').click();
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
    await page.locator('#prefTheme').selectOption('dark');
    await page.locator('#saveBtn').click();

    await expect(page.locator('#saveBtn')).toBeEnabled();
    await expect(page.locator('#saveBtn')).toContainText('Save');
    await expect(page.getByText('preferences were not saved')).toBeVisible();
    await expect(page.locator('#prefMax')).toHaveValue('1');
    const persisted = await (await page.request.get('/api/preferences')).json();
    expect(persisted).toEqual(original);
});

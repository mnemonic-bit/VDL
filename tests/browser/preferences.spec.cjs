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

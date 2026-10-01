const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openCurrent, openSettings } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

test('Browser Extension settings disclose HTTPS pairing and public installation', async ({ page }) => {
    await openSettings(page);
    await page.getByRole('button', { name: 'Browser Extension' }).click();
    const section = page.locator('#settings-browser-extension');
    await expect(section).toBeVisible();
    await expect(section.getByText('Cookies can grant the same website access')).toBeVisible();
    await expect(page.locator('#extensionCreatePairing')).toBeDisabled();
    await expect(page.locator('#extensionHttpsStatus')).toContainText('trusted HTTPS');
    await expect(page.locator('#extensionInstallLink')).toHaveAttribute(
        'href', '/browser-extension/vdl-companion-firefox.xpi',
    );
    await expect(page.locator('#extensionNoConnections')).toBeVisible();
});

test('authenticated stopped rows require a fresh Firefox handoff', async ({ page }) => {
    await seed(page, {
        id: 'firefox1',
        status: 'cancelled',
        title: 'Signed-in fixture',
        url: 'https://video.example/watch/1',
        browser_authenticated: true,
    });
    await refresh(page);
    await openCurrent(page);
    const row = page.locator('[data-row-id="firefox1"]');
    await expect(row.getByText('Firefox session')).toBeVisible();
    await expect(row.getByText('Re-send from Firefox')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Continue' })).toHaveCount(0);
});

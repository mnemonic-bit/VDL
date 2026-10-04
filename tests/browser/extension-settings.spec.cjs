const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openCurrent, openSettings } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

test('Browser Extension settings allow operator-approved private HTTP pairing', async ({ page }) => {
    await openSettings(page);
    await page.getByRole('button', { name: 'Browser Extension' }).click();
    const section = page.locator('#settings-browser-extension');
    await expect(section).toBeVisible();
    await expect(section.getByText('Cookies can grant the same website access')).toBeVisible();
    await expect(page.locator('#extensionCreatePairing')).toBeEnabled();
    await expect(page.locator('#extensionHttpsStatus')).toContainText('private HTTP');
    expect(await page.evaluate(() => isPairableVdlLocation({
        protocol: 'http:', hostname: '192.168.1.20',
    }, false))).toBe(false);
    expect(await page.evaluate(() => isPairableVdlLocation({
        protocol: 'http:', hostname: '192.168.1.20',
    }, true))).toBe(true);
    expect(await page.evaluate(() => isPairableVdlLocation({
        protocol: 'http:', hostname: '100.96.0.2',
    }, true))).toBe(true);
    expect(await page.evaluate(() => isPairableVdlLocation({
        protocol: 'https:', hostname: 'vdl.example',
    }))).toBe(true);
    await expect(page.locator('#extensionInstallLink')).toHaveAttribute(
        'href', '/browser-extension/vdl-companion-firefox.xpi',
    );
    await expect(page.locator('#extensionNoConnections')).toBeVisible();
    await page.locator('#extensionCreatePairing').click();
    await expect(page.locator('#extensionPairingOutput')).toBeVisible();
    await expect(page.locator('#extensionPairingString')).toHaveValue(/^vdl-pair-v1:/);
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

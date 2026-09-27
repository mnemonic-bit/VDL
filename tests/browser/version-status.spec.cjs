const { test, expect } = require('@playwright/test');
const { reset } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

test('version footer renders matching, mismatched, missing, malformed, and unavailable APIs', async ({ page }) => {
    const uiVersion = await page.locator('#versionFooter').getAttribute('data-ui-version');
    let health = { status: 200, body: { ok: true, version: uiVersion, uptime_seconds: 13 } };
    await page.route('**/api/health', route => route.fulfill({
        status: health.status,
        contentType: 'application/json',
        body: JSON.stringify(health.body),
    }));

    await page.reload();
    await expect(page.locator('#apiVersion')).toHaveText(`API v${uiVersion}`);
    await expect(page.locator('#uptime')).toHaveText('Uptime 13 Seconds');
    await expect(page.locator('#versionWarning')).toBeHidden();
    await expect(page.locator('#versionFooter')).not.toHaveClass(/version-mismatch/);

    health = { status: 200, body: { ok: true, version: '99.0.0' } };
    await page.reload();
    await expect(page.locator('#apiVersion')).toHaveText('API v99.0.0');
    await expect(page.locator('#versionWarning')).toBeVisible();
    await expect(page.locator('#versionFooter')).toHaveClass(/version-mismatch/);

    for (const body of [
        { ok: true },
        { ok: true, version: null },
        { ok: true, version: '' },
        { ok: true, version: { malformed: true } },
    ]) {
        health = { status: 200, body };
        await page.reload();
        await expect(page.locator('#apiVersion')).toHaveText('API unknown');
        await expect(page.locator('#versionWarning')).toBeVisible();
    }

    health = { status: 503, body: { error: 'unavailable' } };
    await page.reload();
    await expect(page.locator('#apiVersion')).toHaveText('API unavailable');
    await expect(page.locator('#versionWarning')).toBeHidden();
    await expect(page.locator('#versionStatus')).toHaveText('API version is unavailable.');
    await expect(page.locator('#uptime')).toHaveText('Uptime unavailable');
});

test('uptime uses progressively larger human-readable units', async ({ page }) => {
    const cases = [
        [0, '0 Seconds'],
        [1, '1 Second'],
        [13, '13 Seconds'],
        [5 * 60, '5 Minutes'],
        [3 * 60 * 60, '3 Hours'],
        [8 * 24 * 60 * 60, '8 Days'],
        [6 * 30 * 24 * 60 * 60, '6 Months'],
        [2 * 365 * 24 * 60 * 60, '2 Years'],
    ];

    for (const [seconds, expected] of cases) {
        expect(await page.evaluate(value => formatUptime(value), seconds)).toBe(expected);
    }

    await page.evaluate(() => {
        updateUptime(13, false);
        uptimeBaseline.receivedAt -= 2000;
        renderUptime();
    });
    await expect(page.locator('#uptime')).toHaveText('Uptime 15 Seconds');
});

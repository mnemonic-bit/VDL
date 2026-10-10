const { test, expect } = require('@playwright/test');
const { reset } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

test('version mismatch offers a same-tab refresh link to the current UI', async ({ page }) => {
    const uiVersion = await page.locator('#versionFooter').getAttribute('data-ui-version');
    let apiVersion = '99.0.0';
    await page.route('**/api/health', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, version: apiVersion, uptime_seconds: 13 }),
    }));

    await page.reload();

    const message = page.getByText('version mismatch', { exact: true });
    const refreshLink = page.getByRole('link', { name: 'Refresh page', exact: true });
    await expect(message).toBeVisible();
    await expect(refreshLink).toBeVisible();
    await expect(refreshLink).toHaveAttribute('href', '/');
    await expect(refreshLink).not.toHaveAttribute('target', /.+/);

    const messageBox = await message.boundingBox();
    const linkBox = await refreshLink.boundingBox();
    expect(Math.abs(linkBox.y - messageBox.y)).toBeLessThan(2);
    expect(linkBox.x).toBeGreaterThanOrEqual(messageBox.x + messageBox.width);

    apiVersion = uiVersion;
    await refreshLink.click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#apiVersion')).toHaveText(`API v${uiVersion}`);
    await expect(refreshLink).toBeHidden();
});

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
    await expect(page.getByRole('link', { name: 'Refresh page', exact: true })).toBeHidden();
    await expect(page.locator('#versionFooter')).not.toHaveClass(/version-mismatch/);

    health = { status: 200, body: { ok: true, version: '99.0.0' } };
    await page.reload();
    await expect(page.locator('#apiVersion')).toHaveText('API v99.0.0');
    await expect(page.locator('#versionWarning')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Refresh page', exact: true })).toBeVisible();
    await expect(page.locator('#versionStatus')).toHaveText(
        `Version mismatch: UI version ${uiVersion}; API v99.0.0. `
        + 'Use the Refresh page link to load the current UI.'
    );
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
        await expect(page.getByRole('link', { name: 'Refresh page', exact: true })).toBeVisible();
    }

    health = { status: 503, body: { error: 'unavailable' } };
    await page.reload();
    await expect(page.locator('#apiVersion')).toHaveText('API unavailable');
    await expect(page.locator('#versionWarning')).toBeHidden();
    await expect(page.getByRole('link', { name: 'Refresh page', exact: true })).toBeHidden();
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

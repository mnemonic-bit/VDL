const { test, expect } = require('@playwright/test');
const { reset } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

test('empty Options accepts the disabled-fields-behind-message contract', async ({ page }) => {
    await page.locator('.options-summary').click();
    await expect(page.locator('#optionsOverlay')).toBeVisible();
    await expect(page.locator('#optionsOverlay')).toContainText('URL');
    await expect(page.locator('#optionsQualitySelect')).toBeDisabled();
    await expect(page.locator('#optionsContainerSelect')).toBeDisabled();
    await expect(page.locator('.options-summary svg')).toHaveCount(1);
    expect(await page.locator('.options-summary').evaluate(el => getComputedStyle(el).listStyleType)).toBe('none');
});

test('MP4 option builds a compatible MP4-video plus M4A-audio selector', async ({ page }) => {
    await page.locator('#urlInput').fill('https://fixture.invalid/options');
    await expect(page.locator('#optionsQualitySelect')).toBeEnabled({ timeout: 3000 });
    await page.locator('#optionsQualitySelect').selectOption('bestvideo[height<=360]+bestaudio/best');
    await page.locator('#optionsContainerSelect').selectOption('mp4');
    let payload;
    await page.route('**/api/download', async route => {
        payload = route.request().postDataJSON();
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"format01"}' });
    });
    await page.locator('#downloadForm button[type=submit]').click();
    await expect(page.locator('#urlInput')).toHaveValue('');
    expect(payload.format).toBe('bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]');
});

test('probe quality controls never emit NaN selectors', async ({ page }) => {
    await page.locator('#urlInput').fill('https://fixture.invalid/options');
    await expect(page.locator('#optionsQualitySelect')).toBeEnabled({ timeout: 3000 });
    const values = await page.locator('#optionsQualitySelect option').evaluateAll(options => options.map(option => option.value));
    expect(values.some(value => value.includes('NaN'))).toBeFalsy();
});

test('only the newest probe can update Options', async ({ page }) => {
    await page.locator('#urlInput').fill('https://fixture.invalid/slow-probe-A');
    await page.waitForRequest(request => request.url().endsWith('/api/probe'));
    const slowProbe = page.waitForResponse(response => (
        response.url().endsWith('/api/probe')
        && response.request().postDataJSON().url.endsWith('/slow-probe-A')
    ));
    await page.locator('#urlInput').fill('https://fixture.invalid/fast-B');
    await expect(page.locator('#optionsFilename')).toHaveAttribute('placeholder', /fast-B/);
    await slowProbe;
    await expect(page.locator('#optionsFilename')).toHaveAttribute('placeholder', /fast-B/);
});

test('clearing the URL invalidates an in-flight probe', async ({ page }) => {
    await page.locator('#urlInput').fill('https://fixture.invalid/slow-probe-A');
    await page.waitForRequest(request => request.url().endsWith('/api/probe'));
    const slowProbe = page.waitForResponse(response => response.url().endsWith('/api/probe'));
    await page.locator('#urlClear').click();
    await slowProbe;
    await expect(page.locator('#optionsFilename')).toHaveAttribute(
        'placeholder',
        'Will be auto-filled from video title',
    );
    await expect(page.locator('#optionsQualitySelect')).toBeDisabled();
    await expect(page.locator('#optionsContainerSelect')).toBeDisabled();
    await expect(page.locator('#optionsOverlay')).not.toHaveClass(/hidden/);
});

test('probe title is assigned as raw text to the filename hint', async ({ page }) => {
    await page.locator('#urlInput').fill('https://fixture.invalid/raw-title');
    await expect(page.locator('#optionsFilename')).toHaveAttribute(
        'placeholder',
        'Will be auto-filled: Rock & Roll <Live>',
        { timeout: 3000 },
    );
});

test('custom filename controls the resulting downloaded basename', async ({ page }) => {
    test.fail(true, 'BUG 3: backend ignores the custom filename');
    await page.locator('#urlInput').fill('https://fixture.invalid/custom');
    await page.locator('#optionsFilename').fill('chosen-browser-name');
    await page.locator('#downloadForm button[type=submit]').click();
    await page.locator('[data-tab=history]').click();
    await expect(page.locator('#historyList')).toContainText('chosen-browser-name.mp4', { timeout: 5000 });
});

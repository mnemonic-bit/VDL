const { test, expect } = require('@playwright/test');
const { reset } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

test('Download control has rounded trailing corners, leading icon, and SVG favicon', async ({ page }) => {
    const button = page.locator('#downloadForm button[type=submit]');
    await expect(button.locator('use')).toHaveAttribute('href', '#i-download');
    expect(await button.evaluate(el => getComputedStyle(el).borderTopRightRadius)).not.toBe('0px');
    await expect(page.locator('link[rel=icon]')).toHaveAttribute('href', /svg/);
});

test('Enter submits and clears the accepted URL', async ({ page }) => {
    let submitted;
    await page.route('**/api/download', async route => {
        submitted = route.request().postDataJSON();
        await route.fulfill({ status: 202, contentType: 'application/json', body: '{"id":"form0001"}' });
    });
    await page.locator('#urlInput').fill('https://fixture.invalid/enter');
    await page.locator('#urlInput').press('Enter');
    await expect(page.locator('#urlInput')).toHaveValue('');
    expect(submitted.url).toBe('https://fixture.invalid/enter');
});

test('Ctrl-V outside editable controls focuses the URL input and pastes', async ({ page }) => {
    await page.evaluate(() => navigator.clipboard.writeText('https://fixture.invalid/paste'));
    await page.locator('h2').click();
    await page.keyboard.press('Control+v');
    await expect(page.locator('#urlInput')).toHaveValue('https://fixture.invalid/paste');
});

test('rejected submission retains the form and reports the server error', async ({ page }) => {
    test.fail(true, 'BUG 12: rejected download submission clears the form');
    await page.route('**/api/download', route => route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"fixture rejected the request"}',
    }));
    await page.locator('#urlInput').fill('https://fixture.invalid/rejected');
    await page.locator('#downloadForm button[type=submit]').click();
    await expect(page.locator('#urlInput')).toHaveValue('https://fixture.invalid/rejected');
    await expect(page.getByText('fixture rejected the request')).toBeVisible();
});

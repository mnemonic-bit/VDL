const { test, expect } = require('@playwright/test');
const { reset, openNewDownload } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

test('Download control has rounded trailing corners, leading icon, and SVG favicon', async ({ page }) => {
    await expect(page.locator('#newDownloadDialog')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Download History' })).toHaveCount(0);
    await openNewDownload(page);
    await expect(page.getByRole('heading', { name: 'New download' })).toBeVisible();
    await expect(page.locator('#urlInput')).toHaveAccessibleName('Download URL');
    const button = page.locator('#downloadForm button[type=submit]');
    await expect(button.locator('use')).toHaveAttribute('href', '#i-download');
    expect(await button.evaluate(el => getComputedStyle(el).borderTopRightRadius)).not.toBe('0px');
    await expect(page.locator('link[rel=icon]')).toHaveAttribute('href', /svg/);
});

test('Enter submits and clears the accepted URL without opening Current downloads', async ({ page }) => {
    let submitted;
    let submissions = 0;
    await page.route('**/api/download', async route => {
        submitted = route.request().postDataJSON();
        submissions += 1;
        await route.fulfill({ status: 202, contentType: 'application/json', body: '{"id":"form0001"}' });
    });
    await openNewDownload(page);
    await page.locator('#urlInput').fill('https://fixture.invalid/enter');
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await page.locator('#urlInput').press('Enter');
    await expect(page.locator('#urlInput')).toHaveValue('');
    await expect(page.locator('#newDownloadDialog')).toBeHidden();
    await expect(page.locator('#currentDownloadsDrawer')).toBeHidden();
    expect(submitted.url).toBe('https://fixture.invalid/enter');
    expect(submissions).toBe(1);
    await openNewDownload(page);
    await expect(page.locator('#downloadSubmit')).toBeDisabled();
    await expect(page.locator('#optionsSpinner')).toBeHidden();
});

test('empty History points new users back to the download field', async ({ page }) => {
    await expect(page.locator('#historyEmptyTitle')).toHaveText('No downloads yet');
    await expect(page.locator('#historyEmptyMessage')).toContainText('Add a video URL');
    await page.locator('#historyEmptyAction').click();
    await expect(page.locator('#newDownloadDialog')).toBeVisible();
    await expect(page.locator('#urlInput')).toBeFocused();
});

test('Ctrl-V outside editable controls opens New download and pastes any clipboard text', async ({ page }) => {
    await page.evaluate(() => navigator.clipboard.writeText('not necessarily a URL'));
    await page.locator('.app-title').click();
    await page.keyboard.press('Control+v');
    await expect(page.locator('#newDownloadDialog')).toBeVisible();
    await expect(page.locator('#urlInput')).toHaveValue('not necessarily a URL');
});

test('Escape closes New download without discarding its draft', async ({ page }) => {
    const url = 'https://fixture.invalid/draft';
    await openNewDownload(page);
    await page.locator('#urlInput').fill(url);
    await page.keyboard.press('Escape');
    await expect(page.locator('#newDownloadDialog')).toBeHidden();

    await openNewDownload(page);
    await expect(page.locator('#urlInput')).toHaveValue(url);
});

test('rejected submission retains the form and reports the server error', async ({ page }) => {
    await page.route('**/api/download', route => route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"fixture rejected the request"}',
    }));
    await openNewDownload(page);
    await page.locator('#urlInput').fill('https://fixture.invalid/rejected');
    await expect(page.locator('#optionsQualitySelect')).toBeEnabled({ timeout: 3000 });
    await page.locator('#optionsQualitySelect').selectOption('bestvideo[height<=360]+bestaudio/best');
    await page.locator('#optionsContainerSelect').selectOption('mp4');
    await page.locator('#optionsFilename').fill('keep-this-name');
    await page.locator('#downloadForm button[type=submit]').click();
    await expect(page.locator('#urlInput')).toHaveValue('https://fixture.invalid/rejected');
    await expect(page.locator('#optionsQualitySelect')).toHaveValue('bestvideo[height<=360]+bestaudio/best');
    await expect(page.locator('#optionsContainerSelect')).toHaveValue('mp4');
    await expect(page.locator('#optionsFilename')).toHaveValue('keep-this-name');
    await expect(page.getByText('fixture rejected the request')).toBeVisible();
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await expect(page.locator('#optionsContent')).toHaveAttribute('data-state', 'ready');
});

test('a pending submission preserves selections and blocks repeated Enter and clicks', async ({ page }) => {
    let pendingDownload;
    let submissions = 0;
    await page.route('**/api/download', route => {
        submissions += 1;
        pendingDownload = route;
    });
    await openNewDownload(page);
    await page.locator('#urlInput').fill('https://fixture.invalid/submit-once');
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await page.locator('#optionsQualitySelect').selectOption('bestvideo[height<=360]+bestaudio/best');
    await page.locator('#optionsFilename').fill('chosen-name');
    await page.locator('#downloadSubmit').click();
    await expect.poll(() => Boolean(pendingDownload)).toBe(true);
    await expect(page.locator('#downloadSubmit')).toBeDisabled();
    await expect(page.locator('#optionsQualitySelect')).toHaveValue('bestvideo[height<=360]+bestaudio/best');
    await expect(page.locator('#optionsFilename')).toHaveValue('chosen-name');
    await page.locator('#urlInput').press('Enter');
    await page.evaluate(() => { startDownload(); document.getElementById('downloadSubmit').click(); });
    expect(submissions).toBe(1);
    await pendingDownload.fulfill({ status: 500, json: { error: 'Try again' } });
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await expect(page.locator('#optionsFilename')).toHaveValue('chosen-name');
    await expect(page.locator('#newDownloadError')).toContainText('Try again');
});

test('editing the URL during submission keeps its newer draft and blocks another request', async ({ page }) => {
    let pendingDownload;
    let submissions = 0;
    await page.route('**/api/download', route => {
        submissions += 1;
        pendingDownload = route;
    });
    await openNewDownload(page);
    await page.locator('#urlInput').fill('https://fixture.invalid/accepted');
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await page.locator('#downloadSubmit').click();
    await expect.poll(() => Boolean(pendingDownload)).toBe(true);
    await page.locator('#urlInput').fill('https://fixture.invalid/new-draft');
    await expect(page.locator('#optionsFilename')).toHaveAttribute('placeholder', /new-draft/);
    await expect(page.locator('#downloadSubmit')).toBeDisabled();
    await page.evaluate(() => startDownload());
    expect(submissions).toBe(1);
    await pendingDownload.fulfill({ json: { id: 'accepted' } });
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await expect(page.locator('#urlInput')).toHaveValue('https://fixture.invalid/new-draft');
    await expect(page.locator('#newDownloadDialog')).toBeVisible();
});

test('Enter from the ready filename field submits the selected name', async ({ page }) => {
    let payload;
    await page.route('**/api/download', route => {
        payload = route.request().postDataJSON();
        return route.fulfill({ json: { id: 'filename-enter' } });
    });
    await openNewDownload(page);
    await page.locator('#urlInput').fill('https://fixture.invalid/filename-enter');
    await page.locator('#optionsFilename').fill('keyboard-name');
    await page.locator('#optionsFilename').press('Enter');
    await expect(page.locator('#newDownloadDialog')).toBeHidden();
    expect(payload.filename).toBe('keyboard-name');
});

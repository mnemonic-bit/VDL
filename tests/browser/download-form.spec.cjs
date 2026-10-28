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

for (const mode of ['immediate', 'delayed', 'queued']) {
    test(`pasted URL closes the dialog after ${mode} acceptance`, async ({ page }) => {
        const delayed = mode === 'delayed';
        const queued = mode === 'queued';
        const url = 'https://fixture.invalid/pasted-download';
        let pendingDownload;
        let submissions = 0;
        await page.request.post('/__test__/hold-downloads');
        if (queued) {
            await page.request.post('/__test__/preferences', { data: { max_concurrent: '1' } });
            const first = await page.request.post('/api/download', {
                data: { url: 'https://fixture.invalid/running-first' },
            });
            expect(first.ok()).toBe(true);
        }
        await page.route('**/api/download', async route => {
            submissions += 1;
            const response = await route.fetch();
            if (delayed) {
                pendingDownload = () => route.fulfill({ response });
            } else {
                await route.fulfill({ response });
            }
        });
        try {
            await openNewDownload(page);
            await page.evaluate(value => navigator.clipboard.writeText(value), url);
            await page.locator('#urlInput').press('Control+v');
            await expect(page.locator('#urlInput')).toHaveValue(url);
            await expect(page.locator('#downloadSubmit')).toBeEnabled();
            await page.locator('#downloadSubmit').click();
            if (delayed) {
                await expect.poll(() => Boolean(pendingDownload)).toBe(true);
                await expect(page.locator('#currentBadge')).toHaveText('1');
                await expect(page.locator('#newDownloadDialog')).toBeVisible();
                // Equivalent input used to invalidate the submission's close
                // callback despite leaving the submitted URL unchanged.
                await page.locator('#urlInput').press('End');
                await page.locator('#urlInput').press('Space');
                await pendingDownload();
            }
            await expect(page.locator('#currentBadge')).toHaveText(queued ? '2' : '1');
            await expect(page.locator('#newDownloadDialog')).toBeHidden();
            await expect(page.locator('#currentDownloadsDrawer')).toBeHidden();
            const current = await (await page.request.get('/api/current-downloads')).json();
            expect(current).toHaveLength(queued ? 2 : 1);
            const accepted = current.find(row => row.url === url);
            expect(accepted).toBeTruthy();
            if (queued) expect(accepted).toMatchObject({ status: 'starting', progress: 'Waiting for a download slot' });
            expect(submissions).toBe(1);
            await page.request.post('/__test__/release-downloads');
            await expect(page.locator('#historyList')).toContainText('pasted-download');
        } finally {
            await page.request.post('/__test__/release-downloads');
        }
    });
}

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
    await expect(page.locator('#newDownloadDialog')).toBeVisible();
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
    await expect(page.locator('#newDownloadDialog')).toBeVisible();
    await expect(page.locator('#urlInput')).toHaveValue('https://fixture.invalid/submit-once');
    await expect(page.locator('#optionsQualitySelect')).toHaveValue('bestvideo[height<=360]+bestaudio/best');
});

test('an invalid URL keeps the dialog open without submitting', async ({ page }) => {
    let submissions = 0;
    await page.route('**/api/download', route => {
        submissions += 1;
        return route.fulfill({ json: { id: 'unexpected' } });
    });
    await openNewDownload(page);
    await page.locator('#urlInput').fill('not-a-url');
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await page.locator('#downloadSubmit').click();
    expect(await page.locator('#urlInput').evaluate(input => input.validity.typeMismatch)).toBe(true);
    await expect(page.locator('#newDownloadDialog')).toBeVisible();
    await expect(page.locator('#urlInput')).toHaveValue('not-a-url');
    expect(submissions).toBe(0);
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

test('delayed acceptance preserves a reopened dialog even with the same URL', async ({ page }) => {
    let pendingDownload;
    await page.route('**/api/download', route => { pendingDownload = route; });
    await openNewDownload(page);
    await page.locator('#urlInput').fill('https://fixture.invalid/reopened');
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await page.locator('#downloadSubmit').click();
    await expect.poll(() => Boolean(pendingDownload)).toBe(true);
    await page.getByRole('button', { name: 'Close new download' }).click();
    await expect(page.locator('#newDownloadDialog')).toBeHidden();
    await openNewDownload(page);
    await pendingDownload.fulfill({ json: { id: 'older-submission' } });
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await expect(page.locator('#newDownloadDialog')).toBeVisible();
    await expect(page.locator('#urlInput')).toHaveValue('https://fixture.invalid/reopened');
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

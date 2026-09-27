const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

test('History groups media details and shows a human-readable duration', async ({ page }) => {
    const fixtures = [
        ['history-day', 86400 + 5 * 3600 + 17 * 60, '1 Day and 5 Hours'],
        ['history-hours', 11 * 3600 + 35 * 60, '11 Hours and 35 Minutes'],
        ['history-minutes', 3 * 60 + 45, '3 Minutes and 45 Seconds'],
        ['history-singular', 60 + 1, '1 Minute and 1 Second'],
    ];

    for (const [id, durationSeconds] of fixtures) {
        const row = await seed(page, {
            id, status: 'finished', resolution: '720p', filesize: 2048,
        });
        await seed(page, {
            id, status: 'finished', finished_at: row.created_at + durationSeconds,
        });
    }

    await page.locator('[data-tab=history]').click();
    await refresh(page);

    for (const [id, , durationLabel] of fixtures) {
        const row = page.locator(`[data-row-id="${id}"]`);
        await expect(row.locator('.history-media-row')).toHaveText('Quality: 720p · Size: 2.0 KB');
        await expect(row.locator('.history-timing-row')).toContainText('Started:');
        await expect(row.locator('.history-timing-row')).toContainText(`Duration: ${durationLabel}`);
        await expect(row).not.toContainText('Finished:');
    }
});

test('History places a readable requested format on the media line', async ({ page }) => {
    await seed(page, {
        id: 'history-format-id',
        status: 'finished',
        resolution: '2160p',
        filesize: 2048,
        requested_format: '625',
        formats: JSON.stringify([{
            format_id: '625',
            ext: 'mp4',
            height: 2160,
            fps: 60,
            vcodec: 'av01',
            acodec: 'none',
        }]),
    });
    await seed(page, {
        id: 'history-format-selector',
        status: 'finished',
        requested_format: 'bestvideo[height<=720]+bestaudio/best',
    });

    await page.locator('[data-tab=history]').click();
    await refresh(page);

    const idRow = page.locator('[data-row-id="history-format-id"]');
    await expect(idRow.locator('.history-media-row')).toHaveText(
        'Quality: 2160p · Size: 2.0 KB · Requested format: 2160p 60fps MP4 video'
    );
    await expect(idRow.locator('.fmt-code')).toHaveCount(0);

    const selectorRow = page.locator('[data-row-id="history-format-selector"]');
    await expect(selectorRow.locator('.history-media-row')).toHaveText(
        'Requested format: Up to 720p video + audio'
    );
});

test('inline rename supports cancel, save, and extension preservation', async ({ page }) => {
    await seed(page, { id: 'rename01', status: 'finished', file: true, name: 'original.mp4' });
    await page.locator('[data-tab=history]').click();
    await refresh(page);
    const row = page.locator('[data-row-id="rename01"]');
    await row.getByRole('button', { name: 'Edit name', exact: true }).click();
    await row.locator('.rename-input').fill('discarded');
    await row.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(row.locator('.rename-display')).toHaveText('original.mp4');
    await row.getByRole('button', { name: 'Edit name', exact: true }).click();
    await row.locator('.rename-input').fill('renamed.webm');
    await row.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row.locator('.rename-display')).toHaveText('renamed.mp4');
});

test('Copy URL uses plain confirmation icon and restores the copy action', async ({ page }) => {
    await page.clock.install();
    const url = 'https://fixture.invalid/copy';
    await seed(page, { id: 'copy0001', status: 'finished', file: true, url });
    await page.locator('[data-tab=history]').click();
    await refresh(page);
    const row = page.locator('[data-row-id="copy0001"]');
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Copy URL', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Copied', exact: true }).locator('use')).toHaveAttribute('href', '#i-check');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    await page.clock.fastForward(1600);
    await expect(row.getByRole('button', { name: 'Copy URL', exact: true })).toBeVisible();
});

test('error details fold and Reload removes then resubmits the stored URL', async ({ page }) => {
    const url = 'https://fixture.invalid/missing';
    await seed(page, { id: 'error001', status: 'error', progress: 'HTTP Error 404', url });
    await page.locator('[data-tab=history]').click();
    await refresh(page);
    const row = page.locator('[data-row-id="error001"]');
    await row.locator('.error-details summary').click();
    await expect(row.locator('.error-text')).toContainText('404');
    const calls = [];
    await page.route('**/api/remove/error001', async route => {
        calls.push('remove');
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.route('**/api/download', async route => {
        calls.push(route.request().postDataJSON().url);
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"retry001"}' });
    });
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Reload', exact: true }).click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls).toEqual(['remove', url]);
});

test('stored URL remains data for Open, Reload, Continue, and Copy actions', async ({ page }) => {
    const url = "https://fixture.invalid/a');window.__injected=1;//<b>";
    for (const [id, status] of [['safe-error', 'error'], ['safe-cancel', 'cancelled']]) {
        await seed(page, { id, status, progress: 'fixture error', url });
    }
    await refresh(page);
    await page.locator('[data-tab=history]').click();
    await refresh(page);
    const errorRow = page.locator('[data-row-id="safe-error"]');
    const actions = errorRow.locator('[data-url-action]');
    await expect(actions).toHaveCount(3);
    for (const action of await actions.all()) {
        await expect(action).not.toHaveAttribute('onclick', /./);
        expect(await action.getAttribute('data-url')).toBe(url);
    }
    await page.locator('[data-tab=current]').click();
    const continueAction = page.locator('[data-row-id="safe-cancel"] [data-url-action="continue"]');
    await expect(continueAction).not.toHaveAttribute('onclick', /./);
    expect(await continueAction.getAttribute('data-url')).toBe(url);
    expect(await page.evaluate(() => window.__injected)).toBeUndefined();
});

test('renamed filename remains data when Play is clicked', async ({ page }) => {
    await seed(page, { id: 'safe-play', status: 'finished', file: true, name: 'original.mp4' });
    await page.locator('[data-tab=history]').click();
    await refresh(page);
    const row = page.locator('[data-row-id="safe-play"]');
    const hostileName = 'safe&apos;);self[&quot;__filenameInjected&quot;]=1;void(&apos;';
    await row.getByRole('button', { name: 'Edit name', exact: true }).click();
    await row.locator('.rename-input').fill(hostileName);
    await row.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row.locator('.rename-display')).toContainText(hostileName);

    const play = row.getByRole('button', { name: 'Play', exact: true });
    const inlineHandler = await play.getAttribute('onclick');
    expect(await play.getAttribute('data-play-label')).toBe(`${hostileName}.mp4`);
    await play.click();
    expect(await page.evaluate(() => window.__filenameInjected)).toBeUndefined();
    expect(inlineHandler).toBeNull();
});

test('Clear History confirms and deletes stored files', async ({ page }) => {
    await seed(page, { id: 'clear001', status: 'finished', file: true });
    await page.locator('[data-tab=history]').click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Clear History', exact: true }).click();
    await expect(page.locator('[data-row-id="clear001"]')).toHaveCount(0);
    expect((await page.request.get('/api/file/clear001')).status()).toBe(404);
});

test('Clear History leaves resumable Current rows intact', async ({ page }) => {
    await seed(page, { id: 'finished1', status: 'finished', file: true });
    await seed(page, { id: 'cancelled1', status: 'cancelled', progress: 'Stopped' });
    await page.locator('[data-tab=history]').click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Clear History', exact: true }).click();
    await page.locator('[data-tab=current]').click();
    await expect(page.locator('[data-row-id="cancelled1"]')).toBeVisible();
});

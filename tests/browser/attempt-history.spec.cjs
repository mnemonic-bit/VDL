const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openSettings } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

async function openHistory(page) {
    await page.locator('#accountMenuButton').click();
    await page.locator('#attemptHistoryButton').click();
    await expect(page.locator('#attemptHistoryPage')).toBeVisible();
}

async function filterHistory(page, value) {
    if (!(await page.locator('#attemptSearchInput').isVisible())) await page.locator('#attemptSearchToggle').click();
    await page.locator('#attemptSearchInput').fill(value);
}

test('Videos are the untabbed default; History owns Duplicates and restores Library search', async ({ page }) => {
    await seed(page, { id: 'video', status: 'finished', title: 'Blue bird', file: true });
    await seed(page, { id: 'failure', status: 'error', title: 'Red fish', progress: 'No access' });
    await refresh(page);
    await expect(page.locator('#tab-history [role="tablist"]')).toHaveCount(0);
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(1);
    await page.locator('#historySearchToggle').click();
    await page.locator('#historySearchInput').fill('Blue');
    await openHistory(page);
    await expect(page.locator('#tab-history')).toBeHidden();
    await expect(page.locator('.attempt-row')).toHaveCount(2);
    await expect(page.locator('#playbackModeControl')).toBeHidden();
    await filterHistory(page, 'status:error');
    await expect(page.locator('.attempt-row')).toHaveCount(1);
    await page.locator('#duplicatesViewButton').click();
    await expect(page.locator('#duplicatesPanel')).toBeVisible();
    await page.locator('#historyViewButton').click();
    await expect(page.locator('#attemptSearchInput')).toHaveValue('status:error');
    await page.locator('#historyBackButton').click();
    await expect(page.locator('#historySearchInput')).toHaveValue('Blue');
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(1);
    await openHistory(page);
    await expect(page.locator('#attemptSearchInput')).toHaveValue('status:error');
    await openSettings(page);
    await page.locator('#settingsBackButton').click();
    await expect(page.locator('#attemptHistoryPage')).toBeVisible();
});

test('attempts stay in full width rows and only finished available media requests thumbnails', async ({ page }) => {
    const thumbnails = [];
    await page.route('**/api/thumbnail/**', route => {
        thumbnails.push(route.request().url());
        return route.fulfill({ status: 404 });
    });
    await seed(page, { id: 'good', status: 'finished', title: 'Good', file: true, thumbnail: true });
    await seed(page, { id: 'bad', status: 'error', title: 'Bad', progress: 'Diagnostic '.repeat(200) });
    await seed(page, { id: 'partial', status: 'downloading', title: 'Partial', file: true });
    await openHistory(page);
    await expect(page.locator('.attempt-row')).toHaveCount(3);
    await expect.poll(() => thumbnails.some(url => url.includes('/good?'))).toBeTruthy();
    expect(thumbnails.some(url => /\/(bad|partial)\?/.test(url))).toBeFalsy();
    for (const width of [1000, 375]) {
        await page.setViewportSize({ width, height: 850 });
        const boxes = await page.locator('.attempt-row').evaluateAll(rows => rows.map(row => {
            const box = row.getBoundingClientRect();
            return { left: box.left, width: box.width, top: box.top, bottom: box.bottom };
        }));
        expect(boxes[0].left).toBe(boxes[1].left);
        expect(boxes[0].width).toBe(boxes[1].width);
        expect(boxes[1].top).toBeGreaterThanOrEqual(boxes[0].bottom);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    }
    const bad = page.locator('.attempt-row').filter({ hasText: 'Bad' });
    await bad.locator('summary').click();
    await expect(bad.locator('.attempt-details')).toContainText('Diagnostic');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('SSE preserves Details and focus while live progress and completion reconcile', async ({ page }) => {
    await seed(page, { id: 'live', status: 'downloading', title: 'Live', progress: '10%', speed: 1000, eta: 12 });
    await openHistory(page);
    const row = page.locator('.attempt-row');
    await expect(row).toContainText('10%');
    await row.locator('summary').click();
    await row.locator('summary').focus();
    await seed(page, { id: 'live', status: 'downloading', progress: '70%' });
    await expect(row).toContainText('70%');
    await expect(row.locator('details')).toHaveAttribute('open', '');
    await expect(row.locator('summary')).toBeFocused();
    await seed(page, { id: 'live', status: 'finished', file: true });
    await expect(row).toContainText('Finished');
    await expect(row.getByRole('button', { name: 'View in Library' })).toBeVisible();
    await expect(page.locator('#historyList [data-row-id="live"]')).toHaveCount(1);
    await row.getByRole('button', { name: 'View in Library' }).click();
    await expect(page.locator('#history-item-live')).toBeVisible();
});

test('filter and pagination are independent, quote aware, and keyboard accessible', async ({ page }) => {
    for (let index = 0; index < 22; index++) await seed(page, {
        id: `log-${index}`, status: 'error', title: `Blue bird ${index}`, progress: 'Remote refusal',
    });
    await seed(page, { id: 'different', status: 'error', title: 'Other', progress: 'Elsewhere' });
    await openHistory(page);
    await filterHistory(page, '"blue bird" refusal status:error');
    await expect(page.locator('#attemptHistoryStatus')).toHaveText('22 attempts');
    await expect(page.locator('.attempt-row')).toHaveCount(20);
    await page.locator('#attemptPageNext').click();
    await expect(page.locator('.attempt-row')).toHaveCount(2);
    await expect(page.locator('#attemptPageInfo')).toContainText('Page 2');
    await filterHistory(page, 'nonexistent');
    await expect(page.locator('#attemptHistoryStatus')).toHaveText('No attempts match this filter.');
    await page.locator('#attemptSearchInput').press('Escape');
    await expect(page.locator('#attemptSearchToggle')).toBeFocused();
    await expect(page.locator('#attemptHistoryStatus')).toHaveText('23 attempts');
    await page.locator('#historyViewButton').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#duplicatesViewButton')).toBeFocused();
    await expect(page.locator('#duplicatesPanel')).toBeVisible();
    await page.keyboard.press('Home');
    await expect(page.locator('#historyViewButton')).toBeFocused();
});

test('removed media retains its outcome and Clear History leaves videos and current work', async ({ page }) => {
    await seed(page, { id: 'removed', status: 'finished', title: 'Removed video', file: true });
    await seed(page, { id: 'kept', status: 'finished', title: 'Kept video', file: true });
    await seed(page, { id: 'active', status: 'downloading', title: 'Active video' });
    await openHistory(page);
    await page.request.post('/api/remove/removed');
    const removed = page.locator('.attempt-row').filter({ hasText: 'Removed video' });
    await expect(removed).toContainText('Media removed');
    await expect(removed).toContainText('Finished');
    await expect(removed.locator('img')).toHaveCount(0);
    await expect(removed.getByRole('button', { name: 'View in Library' })).toHaveCount(0);
    await openSettings(page);
    page.once('dialog', dialog => {
        expect(dialog.message()).toContain('Library videos and files will be kept');
        dialog.accept();
    });
    await page.getByRole('button', { name: 'Clear History', exact: true }).click();
    await page.locator('#settingsBackButton').click();
    await expect(page.locator('.attempt-row')).toHaveCount(1);
    await expect(page.locator('.attempt-row')).toContainText('Active video');
    expect((await page.request.get('/api/file/kept')).ok()).toBeTruthy();
});

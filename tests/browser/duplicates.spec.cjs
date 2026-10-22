const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

test('Duplicates shows confirmed members and links to their History items', async ({ page }) => {
    await seed(page, { id: 'duplicate-one', status: 'finished', file: true, name: 'first.mp4' });
    await seed(page, { id: 'duplicate-two', status: 'finished', file: true, name: 'second.mp4' });
    await refresh(page);
    const entries = await (await page.request.get('/api/library')).json();
    const first = entries.find(entry => entry.id === 'duplicate-one');
    const second = entries.find(entry => entry.id === 'duplicate-two');
    await page.route('**/api/duplicates', route => route.fulfill({
        json: {
            groups: [{
                byte_size: 100,
                item_count: 2,
                items: [
                    { ...first, title: 'First video', display_filename: 'source.mp4',
                        filename: 'first--a1b2c3d4e5f6.mp4', mounted_import: true,
                        source_type: 'upload', tags: ['Archive'] },
                    { ...second, title: 'Second video', display_filename: 'other.mp4',
                        source_type: 'upload', tags: ['Inbox'] },
                ],
            }],
            pending_count: 1,
            unavailable_count: 2,
        },
    }));

    await page.locator('#accountMenuButton').click();
    await page.locator('#attemptHistoryButton').click();
    await page.locator('#duplicatesViewButton').click();
    await expect(page.locator('#historyMain')).toBeHidden();
    await expect(page.locator('#duplicatesStatus')).toHaveText(
        '1 confirmed group · 1 pending · 2 unavailable');
    await expect(page.locator('.duplicate-group')).toHaveCount(1);
    await expect(page.locator('.duplicate-member')).toHaveCount(2);
    await expect(page.locator('.duplicate-member').first()).toContainText('source.mp4');
    await expect(page.locator('.duplicate-member').first()).toContainText('Mounted import');
    await expect(page.locator('.duplicate-member').first()).toContainText('Archive');
    await expect(page.locator('#duplicatesPanel')).not.toContainText('first--a1b2c3d4e5f6.mp4');

    await page.locator('[data-duplicate-id="duplicate-one"] .duplicate-history-link').click();
    await expect(page.locator('#historyMain')).toBeVisible();
    await expect(page.locator('#history-item-duplicate-one')).toBeVisible();
});

test('Duplicates reports incomplete indexing and can request a refresh', async ({ page }) => {
    let refreshes = 0;
    await page.route('**/api/duplicates', route => route.fulfill({
        json: { groups: [], pending_count: 1, unavailable_count: 1 },
    }));
    await page.route('**/api/duplicates/refresh', route => {
        refreshes += 1;
        return route.fulfill({ status: 202, json: { message: 'Duplicate index refresh started' } });
    });
    await page.locator('#accountMenuButton').click();
    await page.locator('#attemptHistoryButton').click();
    await page.locator('#duplicatesViewButton').click();
    await expect(page.locator('#duplicatesList')).toContainText('Some files are still pending');
    await page.locator('#duplicatesRefresh').click();
    await expect.poll(() => refreshes).toBe(1);
    await expect(page.locator('#duplicatesRefresh')).toBeEnabled();
});

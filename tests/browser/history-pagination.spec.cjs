const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

test('History pagination preserves ordering and clamps after a page becomes empty', async ({ page }) => {
    for (let index = 1; index <= 21; index += 1) {
        await seed(page, {
            id: `page${String(index).padStart(4, '0')}`,
            status: 'finished',
            file: true,
            name: `page-${index}.mp4`,
        });
    }
    await page.locator('[data-tab=history]').click();
    await refresh(page);

    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(10);
    await expect(page.locator('#historyList [data-row-id]').first()).toHaveAttribute('data-row-id', 'page0021');
    await expect(page.locator('#pagerInfo')).toHaveText('Page 1 of 3 · 21 items');
    await expect(page.locator('#pagerPrev')).toBeDisabled();
    await expect(page.locator('#pagerFirst')).toBeDisabled();
    await expect(page.locator('#pagerLast')).toBeVisible();

    await page.locator('#pagerLast').click();
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(1);
    await expect(page.locator('#historyList [data-row-id="page0001"]')).toBeVisible();
    await expect(page.locator('#pagerNext')).toBeDisabled();
    await expect(page.locator('#pagerLast')).toBeDisabled();

    const lastRow = page.locator('[data-row-id="page0001"]');
    await lastRow.locator('.kebab-btn').click();
    await lastRow.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(10);
    await expect(page.locator('#pagerInfo')).toHaveText('Page 2 of 2 · 20 items');
    await expect(page.locator('[data-row-id="page0001"]')).toHaveCount(0);
    await page.locator('#pagerPrev').click();
    await expect(page.locator('#historyList [data-row-id]').first()).toHaveAttribute('data-row-id', 'page0021');
    await expect(page.locator('#pagerPrev')).toBeDisabled();
});

const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openCurrent, closeCurrent } = require('./support.cjs');

async function attachTag(page, id, tag) {
    const response = await page.request.post(`/api/tags/${id}`, { data: { tag } });
    expect(response.ok()).toBeTruthy();
}

test.beforeEach(async ({ page }) => reset(page));

test('inline tag editor commits, discards drafts, and removes with Backspace', async ({ page }) => {
    await seed(page, { id: 'tag-edit', status: 'cancelled', progress: 'Stopped' });
    await refresh(page);
    await openCurrent(page);
    const row = page.locator('[data-row-id="tag-edit"]');

    await row.getByText('Add tags', { exact: true }).click();
    const input = row.locator('.tag-entry-input');
    await input.fill('Music Videos');
    await input.press('Enter');
    await expect(row.locator('.tag-chip')).toContainText('Music Videos');
    await expect(row.locator('.tag-entry-input')).toHaveValue('');

    await row.locator('.tag-entry-input').fill('not committed');
    await row.locator('.tag-entry-input').press('Escape');
    await expect(row.locator('.tag-display-row')).toBeVisible();
    await expect(row.locator('.tag-chip')).toHaveText('Music Videos');

    await row.locator('.tag-display-row').click();
    await row.locator('.tag-entry-input').press('Backspace');
    await expect(row.locator('.tag-chip')).toHaveCount(0);
    await expect(row.locator('.tag-entry-input')).toBeFocused();
});

test('failed tag commits restore the draft for correction', async ({ page }) => {
    await seed(page, { id: 'tag-fail', status: 'cancelled', progress: 'Stopped' });
    await refresh(page);
    await openCurrent(page);
    await page.route('**/api/tags/tag-fail', route => route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Tag save failed' }),
    }));
    const row = page.locator('[data-row-id="tag-fail"]');

    await row.getByText('Add tags', { exact: true }).click();
    await row.locator('.tag-entry-input').fill('Keep this draft');
    await row.locator('.tag-entry-input').press('Enter');

    await expect(page.locator('#currentDrawerError')).toContainText('Tag save failed');
    await expect(row.locator('.tag-entry-input')).toHaveValue('Keep this draft');
});

test('tag affordance fills its row and disappears when editing starts', async ({ page }) => {
    await seed(page, { id: 'tag-layout', status: 'cancelled', progress: 'Stopped' });
    await refresh(page);
    await openCurrent(page);
    const row = page.locator('[data-row-id="tag-layout"]');
    const tagLine = row.locator('.tag-display-row');
    const hint = tagLine.getByText('Add tags', { exact: true });

    await expect(hint).toBeVisible();
    const rowBox = await row.boundingBox();
    const tagBox = await tagLine.boundingBox();
    expect(tagBox.width).toBeGreaterThan(rowBox.width * 0.7);
    await expect(tagLine).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await tagLine.hover();
    await expect(tagLine).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    const hintColor = await hint.evaluate(element => getComputedStyle(element).color);

    await tagLine.click();
    const input = row.locator('.tag-entry-input');
    await expect(input).toBeFocused();
    await expect(row.getByText('Add tags', { exact: true })).toHaveCount(0);
    const inputColor = await input.evaluate(element => getComputedStyle(element).color);
    expect(hintColor).not.toBe(inputColor);
});

test('History tag filter supports ALL and ANY without hiding Current downloads', async ({ page }) => {
    for (const row of [
        { id: 'current-both', status: 'cancelled' },
        { id: 'current-music', status: 'interrupted' },
        { id: 'history-tutorial', status: 'finished', file: true, name: 'tutorial.mp4' },
        { id: 'history-both', status: 'error', progress: 'fixture error' },
    ]) {
        await seed(page, row);
    }
    for (const id of ['current-both', 'current-music', 'history-both']) {
        await attachTag(page, id, 'Music Videos');
    }
    for (const id of ['current-both', 'history-tutorial', 'history-both']) {
        await attachTag(page, id, 'Tutorial');
    }
    await refresh(page);

    const filter = page.locator('#tagFilter');
    await filter.locator('input').click();
    await filter.getByRole('option', { name: 'Music Videos', exact: true }).click();
    await filter.getByRole('option', { name: 'Tutorial', exact: true }).click();
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(1);
    await expect(page.locator('[data-row-id="history-both"]')).toBeVisible();
    await openCurrent(page);
    await expect(page.locator('#activeList [data-row-id]')).toHaveCount(2);
    await expect(page.locator('[data-row-id="current-both"]')).toBeVisible();
    await expect(page.locator('[data-row-id="current-music"]')).toBeVisible();
    await closeCurrent(page);

    await filter.locator('select').selectOption('any');
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(2);
    await openCurrent(page);
    await expect(page.locator('#activeList [data-row-id]')).toHaveCount(2);
    await closeCurrent(page);

    await filter.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(2);
});

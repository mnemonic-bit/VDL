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

test('Header search uses ANY matching without hiding Current downloads', async ({ page }) => {
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

    const search = page.locator('#historySearch');
    const input = search.locator('input');
    await search.locator('#historySearchToggle').click();
    await input.fill('"Music Videos" Tutorial');
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(2);
    await expect(page.locator('[data-row-id="history-both"]')).toBeVisible();
    await expect(page.locator('[data-row-id="history-tutorial"]')).toBeVisible();
    await openCurrent(page);
    await expect(page.locator('#activeList [data-row-id]')).toHaveCount(2);
    await expect(page.locator('[data-row-id="current-both"]')).toBeVisible();
    await expect(page.locator('[data-row-id="current-music"]')).toBeVisible();
    await closeCurrent(page);

    await search.locator('#historySearchClear').click();
    await expect(input).toHaveValue('');
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(2);
});

test('History search matches title fragments, tags, and quoted phrases', async ({ page }) => {
    for (const row of [
        {
            id: 'history-hybrid',
            status: 'finished',
            title: 'An Alpine Sunset Walk',
            file: true,
            name: 'hybrid.mp4',
        },
        {
            id: 'history-phrase',
            status: 'finished',
            title: 'This Is the Exact Title I Am Looking For',
            file: true,
            name: 'phrase.mp4',
        },
        {
            id: 'history-other',
            status: 'finished',
            title: 'An Alpine Tutorial',
            file: true,
            name: 'other.mp4',
        },
    ]) {
        await seed(page, row);
    }
    await attachTag(page, 'history-hybrid', 'Music Videos');
    await refresh(page);

    const search = page.locator('#historySearch');
    const input = search.locator('input');
    await search.locator('#historySearchToggle').click();

    await input.fill('alpin "Music Videos"');
    await expect(input).toHaveValue('alpin "Music Videos"');
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(2);
    await expect(page.locator('[data-row-id="history-hybrid"]')).toBeVisible();
    await expect(page.locator('[data-row-id="history-other"]')).toBeVisible();

    await input.fill('"exact title I am"');
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(1);
    await expect(page.locator('[data-row-id="history-phrase"]')).toBeVisible();

    await input.fill('sun');
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(1);
    await expect(page.locator('[data-row-id="history-hybrid"]')).toBeVisible();
});

test('History search filters by downloader with the user qualifier', async ({ page }) => {
    for (const row of [
        {
            id: 'alice-tutorial',
            status: 'finished',
            title: 'Alpine Tutorial',
            downloaded_by: 'Alice Smith',
        },
        {
            id: 'alice-news',
            status: 'finished',
            title: 'Weekly News',
            downloaded_by: 'Alice Smith',
        },
        {
            id: 'bob-tutorial',
            status: 'finished',
            title: 'City Tutorial',
            downloaded_by: 'Bob',
        },
    ]) {
        await seed(page, row);
    }
    await refresh(page);

    const input = page.locator('#historySearchInput');
    await page.locator('#historySearchToggle').click();

    await input.fill('user:"alice smith"');
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(2);
    await expect(page.locator('[data-row-id="alice-tutorial"]')).toBeVisible();
    await expect(page.locator('[data-row-id="alice-news"]')).toBeVisible();

    await input.fill('USER:"ALICE SMITH" tutorial');
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(1);
    await expect(page.locator('[data-row-id="alice-tutorial"]')).toBeVisible();

    await input.fill('user:"Alice Smith" user:bob');
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(3);
    await expect(page.locator('[data-row-id="alice-news"]')).toBeVisible();
    await expect(page.locator('[data-row-id="bob-tutorial"]')).toBeVisible();

    await input.fill('user:');
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(0);
    await expect(page.locator('#historyEmptyTitle')).toHaveText('No matching downloads');
});

test('History search filters by minimum quality, favorite state, and views', async ({ page }) => {
    for (const row of [
        {
            id: 'filter-8k', status: 'finished', file: true,
            name: 'filter-8k.mp4', title: 'Cinema showcase', resolution: '7680x4320',
        },
        {
            id: 'filter-4k', status: 'finished', file: true,
            name: 'filter-4k.mp4', title: 'Mountain documentary', resolution: '2160p',
        },
        {
            id: 'filter-720', status: 'finished', file: true,
            name: 'filter-720.mp4', title: 'Mountain tutorial', resolution: '1280x720',
        },
        {
            id: 'filter-480', status: 'finished', file: true,
            name: 'filter-480.mp4', title: 'Small clip', resolution: '480p',
        },
    ]) {
        await seed(page, row);
    }
    const favorite = await page.request.post('/api/favorite/filter-4k', {
        data: { favorite: true },
    });
    expect(favorite.ok()).toBeTruthy();
    for (let count = 0; count < 10; count += 1) {
        const response = await page.request.post('/api/view/filter-4k');
        expect(response.ok()).toBeTruthy();
    }
    for (let count = 0; count < 9; count += 1) {
        const response = await page.request.post('/api/view/filter-720');
        expect(response.ok()).toBeTruthy();
    }
    await refresh(page);

    const input = page.locator('#historySearchInput');
    const cards = page.locator('#historyList [data-row-id]');
    await page.locator('#historySearchToggle').click();

    await input.fill('quality:4k');
    await expect(cards).toHaveCount(2);
    await expect(page.locator('[data-row-id="filter-8k"]')).toBeVisible();
    await expect(page.locator('[data-row-id="filter-4k"]')).toBeVisible();

    await input.fill('quality:720');
    await expect(cards).toHaveCount(3);
    await input.fill('quality:720p');
    await expect(cards).toHaveCount(3);

    await input.fill('star:yes');
    await expect(cards).toHaveCount(1);
    await expect(page.locator('[data-row-id="filter-4k"]')).toBeVisible();
    await input.fill('starred:no');
    await expect(cards).toHaveCount(3);

    await input.fill('views:new');
    await expect(cards).toHaveCount(2);
    await expect(page.locator('[data-row-id="filter-8k"]')).toBeVisible();
    await expect(page.locator('[data-row-id="filter-480"]')).toBeVisible();
    await input.fill('views:10');
    await expect(cards).toHaveCount(1);
    await expect(page.locator('[data-row-id="filter-4k"]')).toBeVisible();

    await input.fill('quality:4k star:yes views:10 mountain');
    await expect(cards).toHaveCount(1);
    await expect(page.locator('[data-row-id="filter-4k"]')).toBeVisible();
});

test('Header search expands from the leftmost magnifier', async ({ page }) => {
    const header = page.locator('#appHeader');
    const search = header.locator('#historySearch');
    const toggle = search.locator('#historySearchToggle');
    const input = search.locator('#historySearchInput');
    const clear = search.locator('#historySearchClear');

    await expect(toggle.locator('use')).toHaveAttribute('href', '#i-search');
    await expect(input).toHaveAttribute('type', 'text');
    await expect(input).toHaveAttribute('placeholder', 'Search title, tag, or filters');
    await expect(input).toHaveAttribute(
        'aria-label', 'Search history by title, tag, user, quality, star, or views');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(input).toBeHidden();
    await expect(header.locator('select')).toHaveCount(0);
    expect(await search.evaluate(element => (
        element.getBoundingClientRect().right <= document.querySelector('#newDownloadButton').getBoundingClientRect().left
    ))).toBeTruthy();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await expect(clear).toBeHidden();
    expect(await search.evaluate(element => {
        const searchStyle = getComputedStyle(element);
        const inputStyle = getComputedStyle(element.querySelector('input'));
        return {
            borderStyle: searchStyle.borderStyle,
            borderWidth: searchStyle.borderWidth,
            borderRadius: searchStyle.borderRadius,
            inputBorderWidth: inputStyle.borderWidth,
        };
    })).toEqual({
        borderStyle: 'solid',
        borderWidth: '1px',
        borderRadius: '999px',
        inputBorderWidth: '0px',
    });

    await input.fill('alpine');
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await expect(clear).toBeHidden();

    await input.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(input).toBeHidden();
    await expect(toggle).toBeFocused();

    await page.setViewportSize({ width: 390, height: 800 });
    await toggle.click();
    await expect(input).toBeVisible();
    expect(await search.evaluate(element => {
        const box = element.getBoundingClientRect();
        return {
            left: Math.round(box.left),
            right: Math.round(window.innerWidth - box.right),
        };
    })).toEqual({ left: 12, right: 12 });
});

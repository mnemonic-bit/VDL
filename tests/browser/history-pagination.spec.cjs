const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openSettings } = require('./support.cjs');

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
    await refresh(page);

    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(10);
    await expect(page.locator('#historyList [data-row-id]').first()).toHaveAttribute('data-row-id', 'page0021');
    await expect(page.locator('#pagerInfo')).toHaveText('Page 1 of 3 · 21 items');
    await expect(page.locator('#pagerPrev')).toBeDisabled();
    await expect(page.locator('#pagerFirst')).toBeHidden();
    await expect(page.locator('#pagerLast')).toBeHidden();

    await page.locator('#pagerNext').click();
    await page.locator('#pagerNext').click();
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

test('page-size preference controls pagination and enables long-range jumps', async ({ page }) => {
    for (let index = 1; index <= 21; index += 1) {
        await seed(page, {
            id: `size${String(index).padStart(4, '0')}`,
            status: 'finished',
        });
    }
    await refresh(page);

    await openSettings(page);
    await page.locator('#prefPageSize').selectOption('5');
    await page.locator('#saveBtn').click();
    await expect(page.locator('#saveBtn')).toContainText('Saved');
    await page.getByRole('button', { name: 'Back to videos', exact: true }).click();

    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(5);
    await expect(page.locator('#pagerInfo')).toHaveText('Page 1 of 5 · 21 items');
    await expect(page.locator('#pagerFirst')).toBeVisible();
    await expect(page.locator('#pagerFirst')).toBeDisabled();
    await expect(page.locator('#pagerLast')).toBeVisible();
    await page.locator('#pagerLast').click();
    await expect(page.locator('#pagerInfo')).toHaveText('Page 5 of 5 · 21 items');
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(1);
});

test('endless scrolling reveals the next batch at the end of the library', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 400 });
    for (let index = 1; index <= 21; index += 1) {
        await seed(page, {
            id: `endless${String(index).padStart(4, '0')}`,
            status: 'finished',
        });
    }
    await refresh(page);

    await openSettings(page);
    await page.locator('#prefPageSize').selectOption('endless');
    await page.locator('#saveBtn').click();
    await expect(page.locator('#saveBtn')).toContainText('Saved');
    await page.getByRole('button', { name: 'Back to videos', exact: true }).click();

    const cards = page.locator('#historyList [data-row-id]');
    const sentinel = page.locator('#historyEndlessSentinel');
    await expect(cards).toHaveCount(10);
    await expect(page.locator('#historyPager')).toBeHidden();
    await expect(sentinel).toBeVisible();

    await sentinel.scrollIntoViewIfNeeded();
    await expect.poll(async () => cards.count()).toBeGreaterThanOrEqual(20);
    // DOM insertion precedes the new cards' expanded layout. Scroll to the
    // settled end so their entrance animations cannot move it away afterward.
    await expect(page.locator('#historyList .item-fade-in')).toHaveCount(0);
    if (await sentinel.isVisible()) {
        await sentinel.scrollIntoViewIfNeeded();
    }
    await expect(cards).toHaveCount(21);
    await expect(sentinel).toBeHidden();
});

test('endless scrolling keeps its first batch when cards arrive while Settings is open', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 400 });
    await openSettings(page);
    await page.locator('#prefPageSize').selectOption('endless');
    await page.locator('#saveBtn').click();
    await expect(page.locator('#saveBtn')).toContainText('Saved');

    for (let index = 1; index <= 21; index += 1) {
        await seed(page, {
            id: `hidden${String(index).padStart(4, '0')}`,
            status: 'finished',
        });
    }
    await refresh(page);
    await expect(page.locator('#historyList .item-fade-in')).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to videos', exact: true }).click();

    const cards = page.locator('#historyList [data-row-id]');
    await expect(page.locator('#historyList .item-fade-in')).toHaveCount(0);
    await expect(cards).toHaveCount(10);
    await page.locator('#historyEndlessSentinel').scrollIntoViewIfNeeded();
    await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(20);
});

for (const trigger of ['observer', 'scroll fallback']) {
    test(`endless scrolling waits for the second batch's expanded layout (${trigger})`, async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 400 });
        await page.addInitScript(useFallback => {
            window.__testIntersectionObserver = window.IntersectionObserver;
            if (useFallback) delete window.IntersectionObserver;
        }, trigger === 'scroll fallback');
        for (let index = 1; index <= 21; index += 1) {
            await seed(page, {
                id: `layout${String(index).padStart(4, '0')}`,
                status: 'finished',
            });
        }
        await page.request.post('/__test__/preferences', {
            data: { history_page_size: 'endless' },
        });
        await page.route('**/static/styles.css*', async route => {
            const response = await route.fetch();
            await route.fulfill({
                response,
                body: `${await response.text()}\n#historyList .item-fade-in:nth-child(n+11):nth-child(-n+20) { animation-play-state: paused; }`,
            });
        });
        await page.reload();
        const cards = page.locator('#historyList [data-row-id]');
        const sentinel = page.locator('#historyEndlessSentinel');
        await expect(page.locator('#historyList .item-fade-in')).toHaveCount(0);
        await expect(cards).toHaveCount(10);
        await sentinel.scrollIntoViewIfNeeded();
        await expect(cards).toHaveCount(20);
        // Reproduce the original test's scroll into the collapsed second batch.
        await sentinel.evaluate(element => new Promise(resolve => {
            const observer = new window.__testIntersectionObserver(entries => {
                if (!entries.some(entry => entry.isIntersecting)) return;
                observer.disconnect();
                resolve();
            });
            observer.observe(element);
            element.scrollIntoView();
        }));
        await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
        await page.evaluate(async () => {
            document.getElementById('historyList').getAnimations({ subtree: true })
                .forEach(animation => animation.finish());
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        await expect(page.locator('#historyList .item-fade-in')).toHaveCount(0);
        await expect(cards).toHaveCount(20);
        expect(await sentinel.evaluate(element =>
            element.getBoundingClientRect().top > window.innerHeight + HISTORY_ENDLESS_PREFETCH_MARGIN)).toBe(true);
        await sentinel.scrollIntoViewIfNeeded();
        await expect(cards).toHaveCount(21);
        await expect(sentinel).toBeHidden();
    });

    test(`endless scrolling retains a final-batch trigger during a pending refresh (${trigger})`, async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 400 });
        await page.addInitScript(useFallback => {
            if (useFallback) {
                delete window.IntersectionObserver;
            } else {
                const NativeObserver = window.IntersectionObserver;
                window.__sentinelIntersections = 0;
                window.IntersectionObserver = class extends NativeObserver {
                    constructor(callback, options) {
                        super((entries, observer) => {
                            callback(entries, observer);
                            window.__sentinelIntersections += entries.filter(entry =>
                                entry.target.id === 'historyEndlessSentinel' && entry.isIntersecting).length;
                        }, options);
                    }
                };
            }
        }, trigger === 'scroll fallback');
        for (let index = 1; index <= 21; index += 1) {
            await seed(page, {
                id: `pending${String(index).padStart(4, '0')}`,
                status: 'finished',
            });
        }
        await page.request.post('/__test__/preferences', {
            data: { history_page_size: 'endless' },
        });
        await page.reload();
        await page.evaluate(() => fetchHistory());
        await page.evaluate(async () => {
            await Promise.all(document.getElementById('historyList').getAnimations({ subtree: true })
                .map(animation => animation.finished));
        });
        const cards = page.locator('#historyList [data-row-id]');
        const sentinel = page.locator('#historyEndlessSentinel');
        await expect(cards).toHaveCount(10);

        // Library renders independently of Current Downloads. Keep the latter
        // pending while the user reaches the end of the newly rendered batch.
        let releaseCurrent;
        const currentGate = new Promise(resolve => { releaseCurrent = resolve; });
        await page.route('**/api/current-downloads', async route => {
            await currentGate;
            await route.continue();
        });
        try {
            await sentinel.scrollIntoViewIfNeeded();
            await expect(cards).toHaveCount(20);
            await page.evaluate(async () => {
                await Promise.all(document.getElementById('historyList').getAnimations({ subtree: true })
                    .map(animation => animation.finished));
            });
            await expect(sentinel).not.toBeInViewport();
            const intersections = await page.evaluate(() => window.__sentinelIntersections);
            await sentinel.evaluate(element => element.scrollIntoView());
            if (trigger === 'observer') {
                await expect.poll(() => page.evaluate(() => window.__sentinelIntersections))
                    .toBeGreaterThan(intersections);
            } else {
                await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
            }
            expect(await page.evaluate(() => historyEndlessLoadPending)).toBe(true);
            await expect(cards).toHaveCount(20);
        } finally {
            releaseCurrent();
        }
        await expect(cards).toHaveCount(21);
        await expect(sentinel).toBeHidden();
        const ids = await cards.evaluateAll(elements => elements.map(element => element.dataset.rowId));
        expect(ids).toEqual(Array.from({ length: 21 }, (_, index) =>
            `pending${String(21 - index).padStart(4, '0')}`));
    });

    test(`endless scrolling rechecks the sentinel after visible card animations finish (${trigger})`, async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 400 });
        await page.addInitScript(useFallback => {
            window.__testIntersectionObserver = window.IntersectionObserver;
            if (useFallback) delete window.IntersectionObserver;
        }, trigger === 'scroll fallback');
        for (let index = 1; index <= 21; index += 1) {
            await seed(page, {
                id: `animated${String(index).padStart(4, '0')}`,
                status: 'finished',
            });
        }
        await page.request.post('/__test__/preferences', {
            data: { history_page_size: 'endless' },
        });
        await page.route('**/static/styles.css*', async route => {
            const response = await route.fetch();
            // Hold the real entrance animation at its collapsed first frame so
            // observer delivery cannot depend on the runner's rendering speed.
            await route.fulfill({
                response,
                body: `${await response.text()}\n#historyList .item-fade-in { animation-play-state: paused; }`,
            });
        });
        await page.reload();
        const cards = page.locator('#historyList [data-row-id]');
        const sentinel = page.locator('#historyEndlessSentinel');
        await expect(sentinel).toBeInViewport();
        await sentinel.evaluate(element => new Promise(resolve => {
            const observer = new window.__testIntersectionObserver(entries => {
                if (!entries.some(entry => entry.isIntersecting)) return;
                observer.disconnect();
                resolve();
            });
            observer.observe(element);
        }));
        await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
        await page.evaluate(async () => {
            document.getElementById('historyList').getAnimations({ subtree: true })
                .forEach(animation => animation.finish());
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        await expect(page.locator('#historyList .item-fade-in')).toHaveCount(0);
        await expect(cards).toHaveCount(10);
        await sentinel.scrollIntoViewIfNeeded();
        await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(20);
    });
}

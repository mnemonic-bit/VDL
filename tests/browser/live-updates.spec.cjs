const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

test('SSE reconciliation renders Current metadata and moves finished rows to History', async ({ page }) => {
    await seed(page, {
        id: 'live0001', status: 'downloading', progress: '25.0%',
        filesize: 2048, resolution: '720p', eta: 12, title: 'Live fixture',
    });
    const current = page.locator('#activeList [data-row-id="live0001"]');
    await expect(current).toBeVisible();
    await expect(current.locator('.status-row')).toContainText('downloading (25.0%)');
    await expect(current.locator('.eta-right')).toContainText('12s');
    await expect(current).toContainText('Total size:');
    await expect(current).toContainText('Quality: 720p');
    expect(await current.locator('.progress-bar-bottom').evaluate(el => el === el.parentElement.lastElementChild)).toBeTruthy();

    await seed(page, { id: 'live0001', status: 'finished', progress: '100%', file: true, resolution: '720p' });
    await page.locator('[data-tab=history]').click();
    await expect(page.locator('#historyList [data-row-id="live0001"]')).toBeVisible();
    await expect(page.locator('#activeList [data-row-id="live0001"]')).toHaveCount(0);
});

test('pause, unpause, stop, and continue buttons call their dedicated endpoints', async ({ page }) => {
    await seed(page, { id: 'actions1', status: 'downloading', progress: '10%' });
    await refresh(page);
    const calls = [];
    for (const action of ['pause', 'unpause', 'stop', 'resume']) {
        await page.route(`**/api/${action}/actions1`, async route => {
            calls.push(action);
            await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        });
    }
    let row = page.locator('[data-row-id="actions1"]');
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Pause', exact: true }).click();
    await seed(page, { id: 'actions1', status: 'paused' });
    await refresh(page);
    row = page.locator('[data-row-id="actions1"]');
    await row.getByRole('button', { name: 'Resume', exact: true }).click();
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Stop', exact: true }).click();
    await seed(page, { id: 'actions1', status: 'cancelled' });
    await refresh(page);
    await page.locator('[data-row-id="actions1"]').getByRole('button', { name: 'Continue', exact: true }).click();
    expect(calls).toEqual(['pause', 'unpause', 'stop', 'resume']);
});

test('closing a row menu reconciles a deferred live update', async ({ page }) => {
    test.fail(true, 'BUG 11: open row menu discards live reconciliation');
    await seed(page, { id: 'menu0001', status: 'downloading', progress: '90%' });
    await refresh(page);
    await page.locator('[data-row-id="menu0001"] .kebab-btn').click();
    await seed(page, { id: 'menu0001', status: 'finished', progress: '100%', file: true });
    await page.waitForTimeout(100);
    await page.locator('h2').click();
    await page.locator('[data-tab=history]').click();
    await expect(page.locator('#historyList [data-row-id="menu0001"]')).toBeVisible();
});

test('History insertion animates occupied space before visibility', async ({ page }) => {
    test.fail(true, 'BUG 7: History insertion only animates opacity');
    await page.locator('[data-tab=history]').click();
    await page.evaluate(() => {
        window.__historyAnimations = [];
        document.addEventListener('animationstart', event => {
            if (event.target.matches('#historyList .history-item')) {
                window.__historyAnimations.push(
                    event.target.getAnimations().flatMap(animation => animation.effect.getKeyframes()),
                );
            }
        });
    });
    await seed(page, { id: 'animate1', status: 'finished', progress: '100%', file: true });
    await expect(page.locator('[data-row-id="animate1"]')).toBeVisible();
    const frames = await page.evaluate(() => window.__historyAnimations.flat());
    expect(frames.some(frame => 'height' in frame || 'maxHeight' in frame || 'transform' in frame)).toBeTruthy();
});

test('health checks use the scheduled clock and recovery hides the banner', async ({ page }) => {
    await page.clock.install();
    let unavailable = false;
    let count = 0;
    await page.route('**/api/health', async route => {
        count += 1;
        if (unavailable) return route.abort('connectionrefused');
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"version":"0.2.0"}' });
    });
    await page.reload();
    await expect(page.locator('#serverBanner')).toBeHidden();
    unavailable = true;
    await page.clock.fastForward(30_001);
    await expect(page.locator('#serverBanner')).toBeVisible();
    unavailable = false;
    await page.clock.fastForward(30_001);
    await expect(page.locator('#serverBanner')).toBeHidden();
    expect(count).toBeGreaterThanOrEqual(3);
});

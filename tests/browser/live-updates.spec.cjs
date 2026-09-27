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

test('unknown-size downloads render an indeterminate Current progress state', async ({ page }) => {
    await seed(page, {
        id: 'unknown1', status: 'downloading', progress: 'Downloading',
        speed: 1024, resolution: '720p', title: 'Unknown length fixture',
    });
    await refresh(page);
    const row = page.locator('[data-row-id="unknown1"]');
    await expect(row.locator('.status-row')).toContainText('downloading');
    await expect(row).toContainText('Unknown length fixture');
    const animationName = await row.locator('.progress-bar-fill').evaluate(
        element => getComputedStyle(element).animationName,
    );
    expect(animationName).not.toBe('none');
});

test('favicon shows aggregate progress across active downloads', async ({ page }) => {
    const favicon = page.locator('#appFavicon');
    const idleHref = await favicon.getAttribute('href');

    await seed(page, {
        id: 'favicon1', status: 'downloading', progress: '25%', filesize: 100,
        downloaded_bytes: 25, total_bytes: 100,
    });
    await seed(page, {
        id: 'favicon2', status: 'downloading', progress: '75%', filesize: 300,
        downloaded_bytes: 225, total_bytes: 300,
    });
    await refresh(page);
    await expect(favicon).toHaveAttribute('data-progress', '62.5');
    await expect(favicon).toHaveAttribute('data-running-count', '2');
    expect(await favicon.getAttribute('href')).not.toBe(idleHref);

    await seed(page, { id: 'favicon2', status: 'paused' });
    await refresh(page);
    await expect(favicon).toHaveAttribute('data-progress', '62.5');
    await expect(favicon).toHaveAttribute('data-running-count', '2');

    await seed(page, { id: 'favicon1', status: 'finished', progress: '100%' });
    await refresh(page);
    await expect(favicon).toHaveAttribute('data-progress', '75');
    await expect(favicon).toHaveAttribute('data-running-count', '1');

    await seed(page, { id: 'favicon2', status: 'finished', progress: '100%' });
    await refresh(page);
    await expect(favicon).not.toHaveAttribute('data-progress');
    await expect(favicon).not.toHaveAttribute('data-running-count');
    await expect(favicon).toHaveAttribute('href', idleHref);
});

test('progress indicators remain indeterminate when any active size is unknown', async ({ page }) => {
    const favicon = page.locator('#appFavicon');
    const idleHref = await favicon.getAttribute('href');
    await seed(page, {
        id: 'favicon3', status: 'downloading', progress: '20%', filesize: 100,
        downloaded_bytes: 20, total_bytes: 100,
    });
    await seed(page, {
        id: 'favicon4', status: 'downloading', progress: 'Downloading',
    });
    await refresh(page);

    await expect(favicon).not.toHaveAttribute('data-progress');
    await expect(favicon).toHaveAttribute('data-running-count', '2');
    await expect(favicon).toHaveAttribute('href', idleHref);
    await expect(page.locator('#appTitleProgressRing')).toBeHidden();
    await expect(page.locator('#appTitleIcon')).not.toHaveAttribute('data-progress');
});

test('header ring shows byte-weighted progress clockwise from twelve o’clock', async ({ page }) => {
    const icon = page.locator('#appTitleIcon');
    const ring = page.locator('#appTitleProgressRing');
    await expect(ring).toBeHidden();
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    await expect(ring).toHaveAttribute('transform', 'rotate(-90 8 8)');
    await expect(ring).toHaveAttribute('pathLength', '100');

    await seed(page, {
        id: 'ring0001', status: 'downloading', progress: '0%',
        downloaded_bytes: 0, total_bytes: 200,
    });
    await refresh(page);
    await expect(ring).toBeHidden();
    await expect(icon).not.toHaveAttribute('data-progress');
    await expect(icon).toHaveAttribute('data-running-count', '1');

    await seed(page, {
        id: 'ring0001', status: 'downloading', progress: '50%',
        downloaded_bytes: 100, total_bytes: 200,
    });
    await refresh(page);
    await expect(icon).toHaveAttribute('data-progress', '50');
    await expect(ring).toBeVisible();
    await expect(ring).toHaveCSS('stroke-dashoffset', '50px');

    await seed(page, {
        id: 'ring0002', status: 'downloading', progress: '12.5%',
        downloaded_bytes: 100, total_bytes: 800,
    });
    await refresh(page);
    await expect(icon).toHaveAttribute('data-progress', '20');
    await expect(icon).toHaveAttribute('data-running-count', '2');
    await expect(ring).toBeVisible();
    await expect(ring).toHaveCSS('stroke-dashoffset', '80px');

    await seed(page, { id: 'ring0002', status: 'paused' });
    await refresh(page);
    await expect(icon).toHaveAttribute('data-progress', '20');
    await expect(icon).toHaveAttribute('data-running-count', '2');

    await seed(page, {
        id: 'ring0001', status: 'downloading', progress: '100%',
        downloaded_bytes: 500, total_bytes: 200,
    });
    await seed(page, {
        id: 'ring0002', status: 'paused', progress: '100%',
        downloaded_bytes: 800, total_bytes: 800,
    });
    await refresh(page);
    await expect(icon).toHaveAttribute('data-progress', '100');
    await expect(ring).toHaveCSS('stroke-dashoffset', '0px');

    await seed(page, { id: 'ring0001', status: 'finished', progress: '100%' });
    await seed(page, { id: 'ring0002', status: 'finished', progress: '100%' });
    await refresh(page);
    await expect(ring).toBeHidden();
    await expect(icon).not.toHaveAttribute('data-progress');
    await expect(icon).not.toHaveAttribute('data-running-count');
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

test('Stop pressed during live reconciliation still requests cancellation', async ({ page }) => {
    await seed(page, { id: 'stop0001', status: 'downloading', progress: '10%' });
    await refresh(page);
    let stopRequests = 0;
    await page.route('**/api/stop/stop0001', async route => {
        stopRequests += 1;
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    const stop = page.locator('[data-row-id="stop0001"] .stop-btn');
    const box = await stop.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await refresh(page);
    await page.mouse.up();

    await expect.poll(() => stopRequests).toBe(1);
});

test('closing a row menu reconciles a deferred live update', async ({ page }) => {
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
    await expect.poll(() => page.evaluate(() => window.__historyAnimations.length)).toBeGreaterThan(0);
    const frames = await page.evaluate(() => window.__historyAnimations.flat());
    expect(frames.some(frame => 'height' in frame || 'maxHeight' in frame || 'transform' in frame)).toBeTruthy();
    expect(frames.some(frame => frame.opacity === '0' && parseFloat(frame.maxHeight) > 0)).toBeTruthy();
    await expect(page.locator('[data-row-id="animate1"]')).not.toHaveClass(/item-fade-in/);
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

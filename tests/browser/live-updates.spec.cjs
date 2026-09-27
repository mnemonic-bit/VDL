const { test, expect } = require('@playwright/test');
const { reset, seed, refresh } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

test('SSE reconciliation renders Current metadata and moves finished rows to History', async ({ page }) => {
    await seed(page, {
        id: 'live0001', status: 'downloading', progress: '25.0%',
        filesize: 2048, downloaded_bytes: 512, total_bytes: 2048,
        resolution: '720p', eta: 12, title: 'Live fixture',
    });
    const current = page.locator('#activeList [data-row-id="live0001"]');
    await expect(current).toBeVisible();
    await expect(current.locator('.status-row')).toHaveCount(0);
    await expect(current).not.toContainText('Status:');
    await expect(current).not.toContainText('URL:');
    await expect(current).not.toContainText('https://fixture.invalid/video');
    await current.locator('.kebab-btn').click();
    await expect(current.getByRole('button', { name: 'Open URL', exact: true })).toBeVisible();
    await current.locator('.kebab-btn').click();
    await expect(current).toContainText('Total size:');
    await expect(current).toContainText('Quality: 720p');
    const summaryRow = current.locator('.download-summary-row');
    await expect(summaryRow).toContainText('Total size: 2.0 KB');
    await expect(summaryRow).toContainText('Quality: 720p');
    await expect(summaryRow).toContainText('Downloaded: 25%');
    await expect(summaryRow.locator('.eta-right')).toContainText('12s');
    await expect(current.locator(':scope > :last-child')).toHaveClass(/download-summary-row/);
    const etaRightDelta = await summaryRow.evaluate(element => {
        const eta = element.querySelector('.eta-right');
        return Math.abs(element.getBoundingClientRect().right - eta.getBoundingClientRect().right);
    });
    expect(etaRightDelta).toBeLessThanOrEqual(1);
    await expect(current.locator('.progress-bar-bg')).toHaveCount(0);
    await expect(current.locator('.action-progress-track')).toBeVisible();

    await seed(page, { id: 'live0001', status: 'finished', progress: '100%', file: true, resolution: '720p' });
    await page.locator('[data-tab=history]').click();
    await expect(page.locator('#historyList [data-row-id="live0001"]')).toBeVisible();
    await expect(page.locator('#activeList [data-row-id="live0001"]')).toHaveCount(0);
});

test('active download shows progress around the Stop action', async ({ page }) => {
    await seed(page, {
        id: 'itemring1', status: 'downloading', progress: '25%',
        downloaded_bytes: 25, total_bytes: 100,
    });
    await refresh(page);

    const row = page.locator('[data-row-id="itemring1"]');
    const stop = row.getByRole('button', { name: 'Stop', exact: true });
    const icon = stop.locator('.action-progress-icon');
    const ring = stop.locator('.action-progress-ring');
    await expect(row.locator('.progress-bar-bg')).toHaveCount(0);
    await expect(stop).toHaveAttribute('aria-label', 'Stop');
    await expect(stop).toHaveAttribute('title', 'Stop');
    expect(await stop.evaluate(element => element.textContent.trim())).toBe('');
    await expect(stop.locator('use')).toHaveAttribute('href', '#i-pause');
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    await expect(icon).toHaveAttribute('data-progress', '25');
    await expect(row.locator('.action-progress-track')).toBeVisible();
    await expect(ring).toBeVisible();
    await expect(ring).toHaveAttribute('pathLength', '100');
    await expect(ring).toHaveAttribute('transform', 'rotate(-90 8 8)');
    await expect(ring).toHaveCSS('stroke-dashoffset', '75px');
    await expect(stop).toHaveCSS('height', '32px');
    await expect(stop).toHaveCSS('width', '32px');
    const appearance = await icon.evaluate(element => {
        const ringElement = element.querySelector('.action-progress-ring');
        const useBox = element.querySelector('use').getBBox();
        const viewBox = element.viewBox.baseVal;
        const strokeRadius = parseFloat(getComputedStyle(ringElement).strokeWidth) / 2;
        const outerRadius = ringElement.r.baseVal.value + strokeRadius;
        return {
            color: getComputedStyle(element).color,
            ringStroke: getComputedStyle(ringElement).stroke,
            renderedWidth: element.getBoundingClientRect().width,
            iconCenterDeltaX: Math.abs(
                useBox.x + useBox.width / 2 - ringElement.cx.baseVal.value),
            iconCenterDeltaY: Math.abs(
                useBox.y + useBox.height / 2 - ringElement.cy.baseVal.value),
            fits: ringElement.cx.baseVal.value - outerRadius >= viewBox.x
                && ringElement.cy.baseVal.value - outerRadius >= viewBox.y
                && ringElement.cx.baseVal.value + outerRadius <= viewBox.x + viewBox.width
                && ringElement.cy.baseVal.value + outerRadius <= viewBox.y + viewBox.height,
        };
    });
    expect(appearance.ringStroke).toBe(appearance.color);
    expect(appearance.iconCenterDeltaX).toBeLessThanOrEqual(0.01);
    expect(appearance.iconCenterDeltaY).toBeLessThanOrEqual(0.01);
    expect(appearance.renderedWidth).toBe(22);
    expect(appearance.fits).toBeTruthy();

    await seed(page, {
        id: 'itemring1', status: 'downloading', progress: '150%',
        downloaded_bytes: 150, total_bytes: 100,
    });
    await refresh(page);
    await expect(row.locator('.action-progress-icon')).toHaveAttribute('data-progress', '100');
    await expect(row.locator('.action-progress-ring')).toHaveCSS('stroke-dashoffset', '0px');
});

test('paused download keeps progress around the Resume action', async ({ page }) => {
    await seed(page, {
        id: 'itemring2', status: 'downloading', progress: '40%',
        filesize: 100, downloaded_bytes: 40, total_bytes: 100,
        resolution: '720p',
    });
    await refresh(page);
    await seed(page, { id: 'itemring2', status: 'paused' });
    await refresh(page);

    let row = page.locator('[data-row-id="itemring2"]');
    const resume = row.getByRole('button', { name: 'Resume', exact: true });
    await expect(row.locator('.progress-bar-bg')).toHaveCount(0);
    await expect(resume.locator('use')).toHaveAttribute('href', '#i-play');
    await expect(resume.locator('.action-progress-icon')).toHaveAttribute('data-progress', '40');
    await expect(resume.locator('.action-progress-ring')).toHaveCSS('stroke-dashoffset', '60px');
    const summaryRow = row.locator('.download-summary-row');
    await expect(summaryRow).toContainText('Total size: 100 B');
    await expect(summaryRow).toContainText('Quality: 720p');
    await expect(summaryRow).toContainText('Downloaded: 40%');
    await expect(summaryRow.locator('.warn-icon')).toHaveCount(0);
    await expect(row).not.toContainText('Status:');

    await row.locator('.kebab-btn').click();
    await expect(row.getByRole('button', { name: 'Stop', exact: true }).locator('.action-progress-ring')).toHaveCount(0);
    await row.locator('.kebab-btn').click();

    await seed(page, { id: 'itemring2', status: 'downloading' });
    await refresh(page);
    row = page.locator('[data-row-id="itemring2"]');
    const stop = row.getByRole('button', { name: 'Stop', exact: true });
    await expect(stop.locator('use')).toHaveAttribute('href', '#i-pause');
    await expect(stop.locator('.action-progress-ring')).toHaveCSS('stroke-dashoffset', '60px');
});

test('unknown-size download shows only the action progress track', async ({ page }) => {
    await seed(page, {
        id: 'unknown1', status: 'downloading', progress: 'Downloading',
        speed: 1024, resolution: '720p', title: 'Unknown length fixture',
    });
    await refresh(page);
    const row = page.locator('[data-row-id="unknown1"]');
    await expect(row.locator('.status-row')).toHaveCount(0);
    await expect(row).not.toContainText('Status:');
    await expect(row.locator('.download-summary-row')).toContainText('Quality: 720p · Downloaded: —');
    await expect(row).toContainText('Unknown length fixture');
    const icon = row.locator('.action-progress-icon');
    const ring = row.locator('.action-progress-ring');
    await expect(row.locator('.progress-bar-bg')).toHaveCount(0);
    await expect(icon).not.toHaveAttribute('data-progress');
    await expect(row.locator('.action-progress-track')).toBeVisible();
    await expect(ring).toBeHidden();
    const animationName = await ring.evaluate(
        element => getComputedStyle(element).animationName,
    );
    expect(animationName).toBe('none');
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
    await expect(page.locator('#appTitleProgressTrack')).toHaveCSS('stroke', 'rgb(57, 151, 72)');
    await expect(page.locator('#appTitleIcon')).not.toHaveAttribute('data-progress');
});

test('header ring shows byte-weighted progress clockwise from twelve o’clock', async ({ page }) => {
    const title = page.locator('.app-title');
    const icon = page.locator('#appTitleIcon');
    const track = page.locator('#appTitleProgressTrack');
    const ring = page.locator('#appTitleProgressRing');
    const geometry = await icon.evaluate(element => {
        const titleElement = element.closest('.app-title');
        const titleStyle = getComputedStyle(titleElement);
        const iconRect = element.getBoundingClientRect();
        const titleRect = titleElement.getBoundingClientRect();
        return {
            widthEm: iconRect.width / parseFloat(titleStyle.fontSize),
            heightEm: iconRect.height / parseFloat(titleStyle.fontSize),
            centerDelta: Math.abs(
                iconRect.top + iconRect.height / 2
                - (titleRect.top + titleRect.height / 2),
            ),
        };
    });
    expect(geometry.widthEm).toBeCloseTo(1.3, 2);
    expect(geometry.heightEm).toBeCloseTo(1.3, 2);
    expect(geometry.centerDelta).toBeLessThanOrEqual(1);
    await expect(title).toHaveCSS('align-items', 'center');
    await expect(track).toBeVisible();
    await expect(track).toHaveCSS('stroke', 'rgb(31, 138, 59)');
    expect(await track.evaluate(element => element.nextElementSibling?.id))
        .toBe('appTitleProgressRing');
    await expect(ring).toHaveCSS('stroke-width', '2.2px');
    await expect(ring).toBeHidden();
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    await expect(ring).toHaveAttribute('transform', 'rotate(-90 8 8)');
    await expect(ring).toHaveAttribute('pathLength', '100');

    const ringFitsViewport = await ring.evaluate(element => {
        const svg = element.ownerSVGElement;
        const viewBox = svg.viewBox.baseVal;
        const strokeRadius = parseFloat(getComputedStyle(element).strokeWidth) / 2;
        const outerRadius = element.r.baseVal.value + strokeRadius;
        const cx = element.cx.baseVal.value;
        const cy = element.cy.baseVal.value;
        return cx - outerRadius >= viewBox.x
            && cy - outerRadius >= viewBox.y
            && cx + outerRadius <= viewBox.x + viewBox.width
            && cy + outerRadius <= viewBox.y + viewBox.height;
    });
    expect(ringFitsViewport).toBeTruthy();

    await seed(page, {
        id: 'ring0001', status: 'downloading', progress: '0%',
        downloaded_bytes: 0, total_bytes: 200,
    });
    await refresh(page);
    await expect(ring).toBeHidden();
    await expect(track).toHaveCSS('stroke', 'rgb(57, 151, 72)');
    await expect(icon).not.toHaveAttribute('data-progress');
    await expect(icon).toHaveAttribute('data-running-count', '1');

    await seed(page, {
        id: 'ring0001', status: 'downloading', progress: '50%',
        downloaded_bytes: 100, total_bytes: 200,
    });
    await refresh(page);
    await expect(icon).toHaveAttribute('data-progress', '50');
    await expect(track).toHaveCSS('stroke', 'rgb(57, 151, 72)');
    await expect(ring).toBeVisible();
    await expect(ring).toHaveCSS('stroke', 'rgb(19, 77, 119)');
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
    await expect(track).toHaveCSS('stroke', 'rgb(31, 138, 59)');
    await expect(icon).not.toHaveAttribute('data-progress');
    await expect(icon).not.toHaveAttribute('data-running-count');
});

test('pause, unpause, stop, and continue buttons call their dedicated endpoints', async ({ page }) => {
    await seed(page, {
        id: 'actions1', status: 'downloading', progress: '10%',
        downloaded_bytes: 10, total_bytes: 100,
    });
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
    row = page.locator('[data-row-id="actions1"]');
    const continueButton = row.getByRole('button', { name: 'Continue', exact: true });
    await expect(continueButton).toHaveAttribute('aria-label', 'Continue');
    await expect(continueButton).toHaveAttribute('title', 'Continue');
    expect(await continueButton.evaluate(element => element.textContent.trim())).toBe('');
    await expect(continueButton).toHaveCSS('width', '32px');
    await expect(continueButton.locator('use')).toHaveAttribute('href', '#i-play');
    await expect(continueButton.locator('.action-progress-icon')).toHaveAttribute('data-progress', '10');
    await expect(continueButton.locator('.action-progress-ring')).toHaveCSS('stroke-dashoffset', '90px');
    await expect(row.locator('.progress-bar-bg')).toHaveCount(0);
    await expect(row.locator('.download-summary-row')).toContainText('Downloaded: 10%');
    await expect(row.locator('.download-summary-row .warn-icon')).toHaveCount(0);
    await expect(row).not.toContainText('URL:');
    await expect(row).not.toContainText('Status:');
    await continueButton.click();
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

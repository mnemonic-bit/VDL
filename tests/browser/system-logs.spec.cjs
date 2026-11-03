const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, switchAccount } = require('./support.cjs');

async function openLogs(page) {
    await page.locator('#accountMenuButton').click();
    await page.locator('#attemptHistoryButton').click();
    await page.locator('#logsViewButton').click();
}

async function installLogs(page, { fail = false } = {}) {
    const calls = [];
    const state = { fail, extra: false };
    await page.route('**/api/preview-maintenance', route => route.fulfill({ json: {
        state: 'running', discovery_complete: true, counters: { updated: 3, left: 49, failed: 1, skipped: 0 },
    } }));
    await page.route('**/api/system/logs?*', async route => {
        const query = new URL(route.request().url()).searchParams;
        calls.push(Object.fromEntries(query));
        if (state.fail) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
        const pageNumber = Number(query.get('page'));
        let entries = Array.from({ length: 52 }, (_, index) => ({
            id: 52 - index, created_at: 1793700000 - index, severity: index % 2 ? 'warning' : 'info',
            component: 'Preview cache', message: index === 0 ? '<script>private()</script>' : `Updating cached preview sequences: ${index} updated.`,
        }));
        if (state.extra && !query.has('snapshot_id')) entries.unshift({ id: 53, created_at: 1793700001, severity: 'error', component: 'Preview cache', message: 'New entry' });
        if (query.get('severity')) entries = entries.filter(item => item.severity === query.get('severity'));
        if (query.get('filter')) entries = entries.filter(item => item.message.includes(query.get('filter')));
        return route.fulfill({ json: {
            items: entries.slice((pageNumber - 1) * 50, pageNumber * 50), page: pageNumber,
            page_size: 50, total: entries.length, pages: Math.max(1, Math.ceil(entries.length / 50)), snapshot_id: Number(query.get('snapshot_id') || 52),
        } });
    });
    return { calls, state };
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.__logStreams = [];
        const BrowserEventSource = window.EventSource;
        window.EventSource = class extends BrowserEventSource {
            constructor(...args) { super(...args); window.__logStreams.push(this); }
        };
    });
    await reset(page);
});

test('History Logs render escaped events and accessible independent filters in both themes', async ({ page }) => {
    await installLogs(page);
    await openLogs(page);
    await expect(page.locator('#systemLogsPanel')).toBeVisible();
    await expect(page.locator('#previewMaintenanceStatus')).toContainText('3 updated, 49 left, 1 failed');
    await expect(page.locator('.system-log-entry')).toHaveCount(50);
    await expect(page.locator('.system-log-entry').first()).toContainText('<script>private()</script>');
    expect(await page.locator('#systemLogsList script').count()).toBe(0);
    const time = page.locator('.system-log-entry time').first();
    await expect(time).toHaveAttribute('datetime', /Z$/);
    await page.locator('#systemLogSeverity').selectOption('warning');
    await expect(page.locator('.system-log-entry')).toHaveCount(26);
    await page.locator('#systemLogFilter').fill('nonexistent');
    await expect(page.locator('#systemLogsStatus')).toHaveText('No system logs match these filters.');
    await page.locator('#historyViewButton').click();
    await page.locator('#historyViewButton').focus();
    await page.keyboard.press('End');
    await expect(page.locator('#logsViewButton')).toBeFocused();
    await expect(page.locator('#systemLogFilter')).toHaveValue('nonexistent');
    for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await page.setViewportSize({ width: 375, height: 800 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
});

test('maintenance hints, reconnect, and focus retain older page and focused controls', async ({ page }) => {
    const { calls, state } = await installLogs(page);
    await openLogs(page);
    await page.locator('#systemLogNext').click();
    await expect(page.locator('#systemLogPageInfo')).toHaveText('Page 2 of 2');
    await expect(page.locator('.system-log-entry')).toHaveCount(2);
    const first = await page.locator('.system-log-entry').first().getAttribute('data-log-id');
    await page.locator('.system-log-entry').first().evaluate(node => { window.__retainedLog = node; });
    await page.locator('#systemLogsRefresh').focus();
    state.extra = true;
    for (const event of ['maintenance', 'ready', 'focus']) {
        const previous = calls.length;
        await page.evaluate(event => {
            if (event === 'focus') window.dispatchEvent(new Event('focus'));
            else window.__logStreams.at(-1).dispatchEvent(new MessageEvent(event, { data: '{}' }));
        }, event);
        await expect.poll(() => calls.length).toBeGreaterThan(previous);
        await expect(page.locator('#systemLogPageInfo')).toHaveText('Page 2 of 2');
        expect(calls.at(-1).snapshot_id).toBe('52');
        await expect(page.locator('#systemLogsRefresh')).toBeFocused();
        expect(await page.locator('.system-log-entry').first().evaluate(node => node === window.__retainedLog)).toBe(true);
        expect(await page.locator('.system-log-entry').first().getAttribute('data-log-id')).toBe(first);
    }
});

test('logs distinguish load failure, retry, and an empty installation', async ({ page }) => {
    const { state } = await installLogs(page, { fail: true });
    await openLogs(page);
    await expect(page.locator('#systemLogsStatus')).toContainText('Could not load system logs');
    state.fail = false;
    await page.locator('#systemLogsRefresh').click();
    await expect(page.locator('.system-log-entry')).toHaveCount(50);
    await page.route('**/api/system/logs?*', route => route.fulfill({ json: { items: [], total: 0, page: 1, page_size: 50, pages: 1 } }));
    await page.locator('#systemLogsRefresh').click();
    await expect(page.locator('#systemLogsStatus')).toHaveText('No system logs yet.');
});

test('legacy hover keeps the selected identity until pointer leaves after publication', async ({ page }) => {
    await page.clock.install();
    const leases = [];
    await page.route('**/api/preview/legacy-hover/lease', route => {
        leases.push(route.request().postDataJSON());
        return route.fulfill({ json: { available: true } });
    });
    let delivery = { available: true, current: false, identity: 'legacy-id', url: '/api/preview/legacy-hover?asset=legacy-id' };
    await page.route('**/api/assets/demand', route => {
        const demand = route.request().postDataJSON();
        return route.fulfill({ json: { assets: Object.fromEntries(demand.ids.map(id => [id, { thumbnail: 'queued', montage: delivery.current ? 'ready' : 'queued', montage_delivery: delivery }])) } });
    });
    await seed(page, { id: 'legacy-hover', status: 'finished' });
    await refresh(page);
    await page.evaluate(() => {
        window.__previewPlayCalls = 0;
        HTMLMediaElement.prototype.load = function () {};
        HTMLMediaElement.prototype.pause = function () {};
        HTMLMediaElement.prototype.play = function () { window.__previewPlayCalls++; this.dispatchEvent(new Event('playing')); return Promise.resolve(); };
    });
    const preview = page.locator('[data-row-id="legacy-hover"] .history-preview');
    await preview.hover();
    await expect(preview.locator('video')).toHaveAttribute('src', '/api/preview/legacy-hover?asset=legacy-id');
    delivery = { available: true, current: true, identity: 'current-id', url: '/api/preview/legacy-hover?asset=current-id' };
    await page.evaluate(() => window.__logStreams.at(-1).dispatchEvent(new MessageEvent('assets', { data: '{}' })));
    await page.waitForTimeout(400);
    await expect(preview.locator('video')).toHaveAttribute('src', '/api/preview/legacy-hover?asset=legacy-id');
    expect(await page.evaluate(() => window.__previewPlayCalls)).toBe(1);
    await page.clock.fastForward(31000);
    await expect.poll(() => leases.length).toBe(1);
    expect(leases[0]).toEqual({ asset: 'legacy-id' });
    await page.locator('.app-header').hover();
    await page.clock.fastForward(31000);
    expect(leases).toHaveLength(1);
    await preview.hover();
    await expect(preview.locator('video')).toHaveAttribute('src', '/api/preview/legacy-hover?asset=current-id');
    expect(await page.evaluate(() => window.__previewPlayCalls)).toBe(2);
});


test('normal accounts cannot see Logs or fetch installation maintenance data', async ({ page }) => {
    const username = `logs-reader-${Date.now()}`;
    const password = 'browser-logs-password';
    const response = await page.request.post('/api/users', { data: { username, password, role: 'normal' } });
    expect(response.status()).toBe(201);
    await switchAccount(page, username, password);
    await page.locator('#accountMenuButton').click();
    await page.locator('#attemptHistoryButton').click();
    await expect(page.locator('#logsViewButton')).toHaveCount(0);
    await expect(page.locator('#systemLogsPanel')).toHaveCount(0);
    expect((await page.request.get('/api/system/logs')).status()).toBe(403);
    expect((await page.request.get('/api/preview-maintenance')).status()).toBe(403);
    await page.locator('#historyViewButton').focus();
    await page.keyboard.press('End');
    await expect(page.locator('#duplicatesViewButton')).toBeFocused();
});

test('expired card identity reconciles once and starts the replacement during the same hover', async ({ page }) => {
    let identity = 'expired';
    const calls = [];
    await page.route('**/api/assets/demand', route => {
        const demand = route.request().postDataJSON();
        calls.push(demand);
        return route.fulfill({ json: { assets: Object.fromEntries(demand.ids.map(id => [id, {
            thumbnail: 'queued', montage: 'ready', montage_delivery: {
                available: true, current: identity === 'replacement', identity,
                url: `/api/preview/stale-hover?asset=${identity}`,
            },
        }])) } });
    });
    await seed(page, { id: 'stale-hover', status: 'finished' });
    await refresh(page);
    await expect.poll(() => calls.length).toBeGreaterThan(0);
    await page.evaluate(() => {
        window.__stalePlayCalls = 0;
        HTMLMediaElement.prototype.load = function () {};
        HTMLMediaElement.prototype.pause = function () {};
        HTMLMediaElement.prototype.play = function () { window.__stalePlayCalls++; this.dispatchEvent(new Event('playing')); return Promise.resolve(); };
    });
    const preview = page.locator('[data-row-id="stale-hover"] .history-preview');
    await preview.hover();
    await expect(preview.locator('video')).toHaveAttribute('src', '/api/preview/stale-hover?asset=expired');
    identity = 'replacement';
    await preview.locator('video').evaluate(video => video.dispatchEvent(new Event('error')));
    await expect(preview.locator('video')).toHaveAttribute('src', '/api/preview/stale-hover?asset=replacement');
    expect(await page.evaluate(() => window.__stalePlayCalls)).toBe(2);
    await preview.locator('video').evaluate(video => video.dispatchEvent(new Event('error')));
    await page.waitForTimeout(500);
    const previous = calls.length;
    await page.waitForTimeout(500);
    expect(calls).toHaveLength(previous);
    expect(await page.evaluate(() => window.__stalePlayCalls)).toBe(2);
});

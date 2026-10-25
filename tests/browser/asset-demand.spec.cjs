const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openSettings } = require('./support.cjs');

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="green"/></svg>';

async function emitAssets(page, assets = {}) {
    await page.evaluate(assets => {
        window.__assetStreams.at(-1).dispatchEvent(new MessageEvent('assets', {
            data: JSON.stringify({ assets }),
        }));
    }, assets);
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.__assetStreams = [];
        const BrowserEventSource = window.EventSource;
        window.EventSource = class extends BrowserEventSource {
            constructor(...args) {
                super(...args);
                window.__assetStreams.push(this);
            }
        };
    });
    await reset(page);
});

test('asset hints reconcile dropped completions in place without image probes or collection refreshes', async ({ page }) => {
    const demandCalls = [];
    const imageRequests = [];
    const states = {
        pending: { thumbnail: 'queued', montage: 'queued' },
        healthy: { thumbnail: 'ready', montage: 'ready' },
    };
    await page.route('**/api/assets/demand', async route => {
        const demand = route.request().postDataJSON();
        demandCalls.push(demand);
        await route.fulfill({ json: { assets: Object.fromEntries(demand.ids.map(id => [id, states[id]])) } });
    });
    await page.route('**/api/thumbnail/**', async route => {
        imageRequests.push({ url: route.request().url(), method: route.request().method() });
        await route.fulfill({ contentType: 'image/svg+xml', body: svg });
    });
    await seed(page, { id: 'pending', status: 'finished' });
    await seed(page, { id: 'healthy', status: 'finished', thumbnail: true, montage: true });
    await refresh(page);
    const pending = page.locator('[data-row-id="pending"] .history-preview');
    const healthy = page.locator('[data-row-id="healthy"] .history-preview');
    await expect(pending).toContainText('Preparing preview');
    await expect(pending.locator('img')).not.toHaveAttribute('src', /./);
    await expect(pending).toBeEnabled();
    await expect.poll(() => healthy.locator('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    await healthy.locator('img').evaluate(image => { window.__healthyAssetImage = image; });
    await expect.poll(() => demandCalls.some(call => call.ids.length === 2)).toBe(true);
    await page.waitForTimeout(250);
    let collectionReads = 0;
    page.on('request', request => {
        if (/\/api\/(library|current-downloads|playlists)(\?|$)/.test(request.url())) collectionReads++;
    });

    // The completion ID was dropped. An unrelated, empty assets hint still
    // reconciles the bounded displayed demand set and removes its placeholder.
    states.pending = { thumbnail: 'ready', montage: 'queued' };
    await emitAssets(page);
    await expect(pending.locator('img')).toHaveAttribute('src', '/api/thumbnail/pending?v=2');
    await expect(pending).not.toHaveClass(/thumbnail-pending/);
    await expect.poll(() => pending.locator('img').evaluate(image => image.naturalWidth > 0)).toBe(true);
    expect(await healthy.locator('img').evaluate(image => image === window.__healthyAssetImage)).toBe(true);
    expect(imageRequests.filter(request => request.method === 'HEAD')).toHaveLength(0);
    expect(imageRequests.filter(request => request.url.includes('/pending?'))).toHaveLength(1);
    expect(collectionReads).toBe(0);
    expect(demandCalls.at(-1).interaction).toBe(false);

    states.pending = { thumbnail: 'failed', montage: 'failed' };
    await emitAssets(page, { pending: states.pending });
    await expect(pending).toContainText('Preview unavailable');
    await expect(pending.locator('img')).not.toHaveAttribute('src', /./);
    await expect(pending).toBeEnabled();
});

test('page demand keeps one request in flight and replaces obsolete navigation with the latest revision', async ({ page }) => {
    await page.waitForTimeout(250);
    const calls = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/assets/demand', async route => {
        const demand = route.request().postDataJSON();
        calls.push(demand);
        if (calls.length === 1) await gate;
        await route.fulfill({ json: { assets: {}, accepted: true } });
    });
    try {
        for (let index = 1; index <= 12; index++) {
            await seed(page, { id: `demand-${index.toString().padStart(2, '0')}`, status: 'finished' });
        }
        await refresh(page);
        await expect.poll(() => calls.length).toBe(1);
        await page.evaluate(() => goToPage(1));
        await expect(page.locator('#pagerInfo')).toContainText('Page 2 of 2');
        await page.evaluate(() => { goToPage(0); goToPage(1); });
        await page.waitForTimeout(200);
        expect(calls).toHaveLength(1);
        release();
        await expect.poll(() => calls.length).toBe(2);
        expect(calls[1].ids).toEqual(['demand-02', 'demand-01']);
        expect(calls[1].revision).toBeGreaterThan(calls[0].revision);
        expect(calls[1].tab_id).toBe(calls[0].tab_id);
        await page.waitForTimeout(300);
        expect(calls).toHaveLength(2);
    } finally { release(); }
});

test('endless demand follows the viewport and clearing Library sends an empty set', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 400 });
    await page.request.post('/__test__/preferences', { data: { history_page_size: 'endless' } });
    const calls = [];
    await page.route('**/api/assets/demand', async route => {
        calls.push(route.request().postDataJSON());
        await route.fulfill({ json: { assets: {} } });
    });
    for (let index = 1; index <= 25; index++) {
        await seed(page, { id: `viewport-${index}`, status: 'finished' });
    }
    await page.reload();
    await expect.poll(() => calls.some(call => call.ids.length > 0)).toBe(true);
    await expect.poll(() => calls.at(-1).ids.length).toBeLessThan(10);
    const first = calls.at(-1).ids;
    await page.locator('#historyList [data-row-id]').last().scrollIntoViewIfNeeded();
    await expect.poll(() => calls.at(-1).ids.includes(first[0])).toBe(false);
    expect(await page.locator('#historyList [data-row-id]').count()).toBeGreaterThan(first.length);
    await expect.poll(() => calls.at(-1).ids.length).toBeLessThanOrEqual(10);
    await openSettings(page);
    await expect.poll(() => calls.at(-1).ids).toEqual([]);
    await page.locator('#settingsBackButton').click();
    await expect.poll(() => calls.at(-1).ids.length).toBeGreaterThan(0);
    expect(calls.at(-1).interaction).toBe(true);
});

test('montage readiness starts only a still-intentional hover and never records a view', async ({ page }) => {
    const calls = [];
    let ready = false;
    await page.route('**/api/assets/demand', async route => {
        const demand = route.request().postDataJSON();
        calls.push(demand);
        const state = { thumbnail: 'queued', montage: ready ? 'ready' : 'queued' };
        await route.fulfill({ json: { assets: Object.fromEntries(demand.ids.map(id => [id, state])) } });
    });
    await seed(page, { id: 'late-hover', status: 'finished' });
    await refresh(page);
    await page.evaluate(() => {
        window.__assetPlayCalls = 0;
        HTMLMediaElement.prototype.load = function () {};
        HTMLMediaElement.prototype.pause = function () {};
        HTMLMediaElement.prototype.play = function () {
            window.__assetPlayCalls++;
            this.dispatchEvent(new Event('playing'));
            return Promise.resolve();
        };
    });
    const preview = page.locator('[data-row-id="late-hover"] .history-preview');
    await preview.hover();
    await expect.poll(() => calls.at(-1).hovered_id).toBe('late-hover');
    await expect(preview.locator('video')).not.toHaveAttribute('src', /./);
    await page.locator('.app-header').hover();
    ready = true;
    await emitAssets(page);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.__assetPlayCalls)).toBe(0);
    await preview.hover();
    await expect(preview).toHaveClass(/preview-playing/);
    expect(await page.evaluate(() => window.__assetPlayCalls)).toBe(1);
    await page.locator('.app-header').hover();
    ready = false;
    await emitAssets(page, { 'late-hover': { thumbnail: 'queued', montage: 'queued' } });
    await preview.hover();
    await expect.poll(() => calls.at(-1).hovered_id).toBe('late-hover');
    ready = true;
    await emitAssets(page);
    await expect(preview).toHaveClass(/preview-playing/);
    expect(await page.evaluate(() => window.__assetPlayCalls)).toBe(2);
    const rows = await page.request.get('/api/library').then(response => response.json());
    expect(rows.find(info => info.id === 'late-hover').view_count).toBe(0);
});

test('SSE reconnect and focus reconcile current demand without passive interaction renewal', async ({ page }) => {
    const calls = [];
    await page.route('**/api/assets/demand', async route => {
        const demand = route.request().postDataJSON();
        calls.push(demand);
        await route.fulfill({ json: { assets: {} } });
    });
    await seed(page, { id: 'reconnect-asset', status: 'finished' });
    await refresh(page);
    await expect.poll(() => calls.some(call => call.ids.includes('reconnect-asset'))).toBe(true);
    await page.waitForTimeout(200);
    const previous = calls.length;
    await page.evaluate(() => window.__assetStreams.at(-1).dispatchEvent(new MessageEvent('ready', { data: '{}' })));
    await expect.poll(() => calls.length).toBeGreaterThan(previous);
    expect(calls.at(-1).interaction).toBe(false);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => calls.at(-1).interaction).toBe(true);
});

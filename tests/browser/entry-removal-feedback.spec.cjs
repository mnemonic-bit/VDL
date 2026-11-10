const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openCurrent, closeCurrent, switchAccount } = require('./support.cjs');

const card = (page, id) => page.locator(`[data-row-id="${id}"]`);
const status = (surface, id) => surface.locator(`[data-removal-status="${id}"]`).first();
const summary = page => page.locator('#removal-mutation-summary');
const recovery = (surface, action) => surface.locator(`[data-removal-action="${action}"]`).first();
const collectionRequest = request => /\/api\/(library|history|current-downloads)(\?|$)/.test(request.url());

async function ready(page, rows) {
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    await expect.poll(() => page.evaluate(() => tagCapabilities?.entry_removal)).toBe(1);
    for (const row of rows) await seed(page, { status: 'finished', ...row });
    await refresh(page);
    for (const row of rows.filter(row => !row.status || row.status === 'finished')) {
        await expect(card(page, row.id)).not.toHaveClass(/item-fade-in/);
    }
}

async function removeThroughMenu(row) {
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
}

async function gate(page, id, { committed = false } = {}) {
    const requests = [];
    const releases = [];
    await page.route(`**/api/remove/${id}`, async route => {
        const response = committed ? await route.fetch() : null;
        requests.push(route.request().postDataJSON());
        await new Promise(resolve => releases.push(resolve));
        if (response) await route.fulfill({ response }).catch(() => {});
        else await route.continue().catch(() => {});
    });
    return { requests, releases, release: () => releases.splice(0).forEach(release => release()) };
}

async function missingReceipts(page) {
    await page.route('**/api/mutations/*', route => route.fulfill({
        status: 404, json: { error: 'Mutation unavailable', final: false },
    }));
}

async function flush(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test.beforeEach(async ({ page }) => reset(page));
test.setTimeout(25_000);

test('removal retains its row within 50 ms and canonical acknowledgement needs neither SSE nor collection reads', async ({ page }, testInfo) => {
    const id = 'remove-immediate';
    await ready(page, [{ id }, { id: 'remove-neighbor' }]);
    const row = card(page, id);
    const before = await page.locator('#historyList [data-row-id]').evaluateAll(rows => rows.map(row => row.dataset.rowId));
    const held = await gate(page, id);
    try {
        const local = await row.evaluate((element, id) => {
            window.removalOriginalCard = element;
            const started = performance.now();
            deleteDownload(id);
            return { elapsed: performance.now() - started, text: element.textContent, connected: element.isConnected };
        }, id);
        expect(local.elapsed).toBeLessThan(50);
        expect(local.text).toContain('Removing');
        expect(local.connected).toBe(true);
        await testInfo.attach('entry-removal-local-feedback', { body: JSON.stringify({ local_feedback_ms: local.elapsed }), contentType: 'application/json' });
        await expect(status(row, id)).toContainText('Removing');
        await expect(row).not.toHaveClass(/item-fade-out/);
        await expect.poll(() => held.requests.length).toBe(1);
        expect(held.requests[0].expected_revision).toMatch(/^\d+$/);
        expect(held.requests[0].scope).toBe('entry-and-files');
        await refresh(page);
        expect(await row.evaluate(element => element === window.removalOriginalCard)).toBe(true);
        expect(await page.locator('#historyList [data-row-id]').evaluateAll(rows => rows.map(row => row.dataset.rowId))).toEqual(before);
        let reads = 0;
        page.on('request', request => { if (collectionRequest(request)) reads++; });
        held.release();
        await expect(row).toHaveCount(0);
        expect(reads).toBe(0);
        expect((await page.request.get(`/api/file/${id}`)).status()).toBe(404);
        await expect(card(page, 'remove-neighbor')).toBeVisible();
        const metrics = await page.evaluate(() => VDL.entryRemovalMetrics());
        expect(metrics.submissions).toBe(1);
        expect(metrics.acknowledgements).toBe(1);
        expect(metrics.pending).toBe(0);
        expect(JSON.stringify(metrics)).not.toContain(id);
        expect(await page.evaluate(() => Object.isFrozen(VDL.entryRemovalMetrics()))).toBe(true);
    } finally { held.release(); }
});

test('real Delete control prevents duplicate removals and contradictory metadata writes while a neighbor stays editable', async ({ page }) => {
    const id = 'remove-duplicates';
    await ready(page, [{ id }, { id: 'remove-editable' }]);
    const row = card(page, id);
    const held = await gate(page, id);
    let otherWrites = 0;
    page.on('request', request => {
        if (/\/api\/(favorite|rename|visibility)\/remove-duplicates/.test(request.url())) otherWrites++;
    });
    try {
        await removeThroughMenu(row);
        await expect.poll(() => held.requests.length).toBe(1);
        await page.evaluate(id => {
            deleteDownload(id);
            deleteDownload(id);
            const button = document.querySelector(`[data-row-id="${id}"] .favorite-toggle`);
            if (button) toggleFavorite(button);
        }, id);
        await expect(status(row, id)).toContainText('Removing');
        expect(held.requests).toHaveLength(1);
        expect(otherWrites).toBe(0);
        const neighbor = card(page, 'remove-editable');
        await neighbor.locator('.favorite-toggle').first().click();
        await expect(neighbor.locator('.favorite-toggle').first()).toHaveAttribute('aria-pressed', 'true');
        held.release();
        await expect(row).toHaveCount(0);
    } finally { held.release(); }
});

test('pending Current removal survives closing and reopening the drawer with an accessible recovery summary', async ({ page }) => {
    const id = 'remove-current';
    await ready(page, [{ id, status: 'cancelled', progress: 'Stopped' }]);
    await openCurrent(page);
    const row = card(page, id);
    const held = await gate(page, id);
    try {
        await removeThroughMenu(row);
        await expect(status(row, id)).toContainText('Removing');
        await closeCurrent(page);
        await expect(summary(page)).toContainText('Removing');
        await openCurrent(page);
        await expect(status(row, id)).toContainText('Removing');
        held.release();
        await expect(row).toHaveCount(0);
        await expect(summary(page)).not.toContainText('Removing');
    } finally { held.release(); }
});

test('a committed removal with a lost response is established by its receipt without replaying deletion', async ({ page }) => {
    const id = 'remove-lost-response';
    await ready(page, [{ id }]);
    let writes = 0;
    await page.route(`**/api/remove/${id}`, async route => {
        writes++;
        await route.fetch();
        await route.abort('failed');
    });
    await removeThroughMenu(card(page, id));
    await expect(card(page, id)).toHaveCount(0);
    expect(writes).toBe(1);
    expect((await page.request.get(`/api/file/${id}`)).status()).toBe(404);
});

test('unknown removal retains its exact attempt until deliberate replay confirms the result', async ({ page }) => {
    const id = 'remove-frozen-replay';
    await ready(page, [{ id }]);
    await missingReceipts(page);
    const requests = [];
    await page.route(`**/api/remove/${id}`, route => {
        requests.push(route.request().postDataJSON());
        if (requests.length === 1) return route.fulfill({ status: 503, json: {} });
        return route.continue();
    });
    const row = card(page, id);
    await removeThroughMenu(row);
    await expect(status(row, id)).toContainText('Removal not confirmed');
    await refresh(page);
    await expect(status(row, id)).toContainText('Removal not confirmed');
    await expect(summary(page)).toContainText('Removal not confirmed');
    expect(requests).toHaveLength(1);
    await page.unroute('**/api/mutations/*');
    await recovery(row, 'replay').click();
    await expect(row).toHaveCount(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
});

for (const failure of ['generic server error', 'malformed success', 'network loss']) {
    test(`${failure} never announces removal or retries automatically`, async ({ page }) => {
        const id = `remove-unknown-${failure.replaceAll(' ', '-')}`;
        await ready(page, [{ id }]);
        await missingReceipts(page);
        let writes = 0;
        await page.route(`**/api/remove/${id}`, route => {
            writes++;
            if (failure === 'network loss') return route.abort('failed');
            return route.fulfill({ status: failure === 'malformed success' ? 200 : 500, json: { removed: true } });
        });
        const row = card(page, id);
        await removeThroughMenu(row);
        await expect(status(row, id)).toContainText('Removal not confirmed');
        await flush(page);
        await refresh(page);
        await expect(row).toBeVisible();
        await expect(status(row, id)).toContainText('Removal not confirmed');
        expect(writes).toBe(1);
        expect((await page.request.get(`/api/file/${id}`)).ok()).toBe(true);
    });
}

test('explicit receipt checking resolves a committed unknown removal after its surface closes', async ({ page }) => {
    const id = 'remove-check-closed';
    await ready(page, [{ id, status: 'cancelled' }]);
    await openCurrent(page);
    await missingReceipts(page);
    let writes = 0;
    await page.route(`**/api/remove/${id}`, async route => {
        writes++;
        await route.fetch();
        await route.abort('failed');
    });
    await removeThroughMenu(card(page, id));
    await expect(status(card(page, id), id)).toContainText('Removal not confirmed');
    await closeCurrent(page);
    await expect(summary(page)).toContainText('Removal not confirmed');
    await page.unroute('**/api/mutations/*');
    await recovery(summary(page), 'check').click();
    await expect(summary(page)).not.toContainText('Removal not confirmed');
    await expect(card(page, id)).toHaveCount(0);
    expect(writes).toBe(1);
});

test('a definite refusal retains current fields and enables a corrected future action', async ({ page }) => {
    const id = 'remove-rejected';
    await ready(page, [{ id }]);
    await page.route(`**/api/remove/${id}`, route => {
        const payload = route.request().postDataJSON();
        return route.fulfill({ status: 400, json: {
            id, removed: false, scope: payload.scope, removal_revision: payload.expected_revision,
            error: 'Removal is temporarily prohibited',
            mutation: { id: payload.client_mutation_id, action: 'entry.remove', domain: 'entry-removal', outcome: 'rejected', revision: payload.expected_revision },
        } });
    });
    const row = card(page, id);
    await removeThroughMenu(row);
    await expect(status(row, id)).toContainText('Removal is temporarily prohibited');
    await expect(row).toBeVisible();
    expect((await page.request.get(`/api/file/${id}`)).ok()).toBe(true);
    await seed(page, { id, status: 'finished', title: 'Newer confirmed title', display_filename: 'Newer confirmed title' });
    await refresh(page);
    await expect(row).toContainText('Newer confirmed title');
    await page.unroute(`**/api/remove/${id}`);
    await recovery(row, 'resolve').click();
    await page.evaluate(id => deleteDownload(id), id);
    await expect(row).toHaveCount(0);
});

test('a remote rename conflicts with an older removal rather than deleting the newly named file', async ({ page }) => {
    const id = 'remove-generation-conflict';
    await ready(page, [{ id }]);
    const row = card(page, id);
    const held = await gate(page, id);
    try {
        await removeThroughMenu(row);
        await expect.poll(() => held.requests.length).toBe(1);
        expect((await page.request.post(`/api/rename/${id}`, { data: { filename: 'Remote renamed file' } })).ok()).toBe(true);
        held.release();
        await expect(status(row, id)).toContainText(/changed|conflict|review/i);
        await expect(row).toBeVisible();
        expect((await page.request.get(`/api/file/${id}`)).ok()).toBe(true);
        expect(held.requests).toHaveLength(1);
    } finally { held.release(); }
});

test('an older collection response cannot restore a confirmed removed card', async ({ page }) => {
    const id = 'remove-stale-collection';
    await ready(page, [{ id }, { id: 'remove-stale-neighbor' }]);
    let releaseRead;
    let captured;
    await page.route('**/api/library?include_order=true', async route => {
        const response = await route.fetch();
        captured = response;
        await new Promise(resolve => { releaseRead = resolve; });
        await route.fulfill({ response }).catch(() => {});
    });
    const read = page.evaluate(() => fetchHistory());
    await expect.poll(() => Boolean(captured && releaseRead)).toBe(true);
    await removeThroughMenu(card(page, id));
    await expect(card(page, id)).toHaveCount(0);
    releaseRead();
    await read;
    await expect(card(page, id)).toHaveCount(0);
    expect(await page.evaluate(id => tagState.selectDownload(id), id)).toBeNull();
    await expect(card(page, 'remove-stale-neighbor')).toBeVisible();
});

test('confirmed removal preserves attempt History with truthful media-removed state', async ({ page }) => {
    const id = 'remove-history-preserved';
    await ready(page, [{ id, title: 'History retained after removal' }]);
    const before = await (await page.request.get('/api/history')).json();
    const attempt = before.items.find(attempt => attempt.download_id === id);
    expect(attempt).toBeTruthy();
    await removeThroughMenu(card(page, id));
    await expect(card(page, id)).toHaveCount(0);
    await page.locator('#accountMenuButton').click();
    await page.locator('#attemptHistoryButton').click();
    const history = page.locator('.attempt-row', { hasText: 'History retained after removal' });
    await expect(history).toContainText('Media removed');
    await expect(history).toContainText('Finished');
    await expect(history.getByRole('button', { name: 'View in Library' })).toHaveCount(0);
    const after = await (await page.request.get('/api/history')).json();
    expect(after.items.filter(item => item.id === attempt.id)).toHaveLength(1);
});

for (const theme of ['light', 'dark']) {
    test(`keyboard removal in ${theme} theme supports reduced motion and narrow layouts`, async ({ page }) => {
        const id = `remove-keyboard-${theme}`;
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await ready(page, [{ id }]);
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        const row = card(page, id);
        const held = await gate(page, id);
        try {
            await row.locator('.kebab-btn').focus();
            await row.locator('.kebab-btn').press('Enter');
            await row.getByRole('button', { name: 'Delete', exact: true }).focus();
            await row.getByRole('button', { name: 'Delete', exact: true }).press('Enter');
            await expect(status(row, id)).toContainText('Removing');
            await expect(page.locator('#tagMutationStatus')).toContainText(/Removing/i);
            const spinner = status(row, id).locator('.options-spinner');
            if (await spinner.count()) {
                await expect(spinner).toHaveAttribute('aria-hidden', 'true');
                await expect(spinner).toHaveCSS('animation-name', 'none');
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            held.release();
            await expect(row).toHaveCount(0);
        } finally { held.release(); }
    });
}

test('a slow removal explains its pending state after five seconds without another write', async ({ page }) => {
    const id = 'remove-slow';
    await page.clock.install();
    await ready(page, [{ id }]);
    const held = await gate(page, id);
    try {
        await removeThroughMenu(card(page, id));
        await expect.poll(() => held.requests.length).toBe(1);
        await page.clock.fastForward(5_100);
        await expect(status(card(page, id), id)).toContainText(/waiting|taking|not confirmed/i);
        expect(held.requests).toHaveLength(1);
        held.release();
        await expect(card(page, id)).toHaveCount(0);
    } finally { held.release(); }
});

test('old callbacks cannot revive a removed entry or private state after authentication reset', async ({ page }) => {
    const id = 'remove-auth-reset';
    await ready(page, [{ id, visibility: 'private' }]);
    const held = await gate(page, id, { committed: true });
    try {
        await removeThroughMenu(card(page, id));
        await expect.poll(() => held.releases.length).toBe(1);
        await page.evaluate(() => resetTagSession());
        held.release();
        await flush(page);
        expect(await page.evaluate(id => tagState.selectDownload(id), id)).toBeNull();
        await expect(summary(page)).toBeEmpty();
        expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
    } finally { held.release(); }
});

test('real account switching clears a held private removal and fences its old acknowledgement', async ({ page }) => {
    const id = 'remove-account-private';
    await ready(page, [{ id, visibility: 'private' }]);
    expect((await page.request.post('/api/users', { data: {
        username: 'removal-next-account', name: 'Removal next account', password: 'next-password', role: 'normal',
    } })).ok()).toBe(true);
    const held = await gate(page, id, { committed: true });
    try {
        await removeThroughMenu(card(page, id));
        await expect.poll(() => held.releases.length).toBe(1);
        await switchAccount(page, 'removal-next-account', 'next-password');
        held.release();
        await expect(card(page, id)).toHaveCount(0);
        expect(await page.evaluate(id => tagState.selectDownload(id), id)).toBeNull();
        await expect(summary(page)).toBeEmpty();
    } finally { held.release(); }
});

test('unsupported servers retain truthful pending and unknown feedback without receipt recovery or replay', async ({ page }) => {
    const id = 'remove-legacy';
    await page.route('**/api/client-capabilities', async route => {
        const response = await route.fetch();
        const capabilities = await response.json();
        capabilities.actions = capabilities.actions.filter(action => action !== 'entry.remove');
        delete capabilities.entry_removal;
        await route.fulfill({ response, json: capabilities });
    });
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    await seed(page, { id, status: 'finished' });
    await refresh(page);
    await expect(card(page, id)).not.toHaveClass(/item-fade-in/);
    let release;
    let writes = 0;
    let receipts = 0;
    page.on('request', request => { if (/\/api\/mutations\//.test(request.url())) receipts++; });
    await page.route(`**/api/remove/${id}`, async route => {
        writes++;
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ status: 503, json: {} });
    });
    await removeThroughMenu(card(page, id));
    await expect(status(card(page, id), id)).toContainText('Removing');
    await expect.poll(() => Boolean(release)).toBe(true);
    release();
    await expect(status(card(page, id), id)).toContainText('Removal not confirmed');
    await expect(recovery(card(page, id), 'replay')).toHaveCount(0);
    expect(writes).toBe(1);
    expect(receipts).toBe(0);
});

test('pending removal preserves active playback until authoritative confirmation retires its target', async ({ page }) => {
    const id = 'remove-playing';
    await ready(page, [{ id }]);
    await page.route('**/api/file/**', () => {});
    await page.evaluate(() => {
        HTMLMediaElement.prototype.load = function () {};
        HTMLMediaElement.prototype.pause = function () {};
        HTMLMediaElement.prototype.play = function () {
            queueMicrotask(() => this.dispatchEvent(new Event('playing')));
            return Promise.resolve();
        };
    });
    const row = card(page, id);
    await row.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    const source = await page.locator('#playerVideo source').getAttribute('src');
    await page.locator('#playerVideo').evaluate(element => { window.removalOriginalVideo = element; });
    const held = await gate(page, id);
    try {
        await page.evaluate(id => deleteDownload(id), id);
        await expect(status(row, id)).toContainText('Removing');
        await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
        expect(await page.locator('#playerVideo source').getAttribute('src')).toBe(source);
        expect(await page.locator('#playerVideo').evaluate(element => element === window.removalOriginalVideo)).toBe(true);
        held.release();
        await expect(row).toHaveCount(0);
        await expect(page.locator('#playerBackdrop')).not.toHaveClass(/open/);
        await expect(page.locator('#playerVideo source')).toHaveCount(0);
    } finally { held.release(); }
});

test('an older canonical favorite acknowledgement cannot recreate a confirmed deleted entry', async ({ page }) => {
    const id = 'remove-old-favorite';
    await ready(page, [{ id }]);
    let releaseFavorite;
    let capturedFavorite;
    await page.route(`**/api/favorite/${id}`, async route => {
        const response = await route.fetch();
        capturedFavorite = response;
        await new Promise(resolve => { releaseFavorite = resolve; });
        await route.fulfill({ response }).catch(() => {});
    });
    const row = card(page, id);
    await row.locator('.favorite-toggle').first().click();
    await expect.poll(() => Boolean(capturedFavorite && releaseFavorite)).toBe(true);
    // The write has committed but its callback is still outstanding. Observe
    // authoritative external deletion before releasing that older callback.
    expect((await page.request.post(`/api/remove/${id}`)).ok()).toBe(true);
    await page.evaluate(id => checkTagAvailability(id), id);
    await expect(row).toHaveCount(0);
    releaseFavorite();
    await flush(page);
    await expect(row).toHaveCount(0);
    expect(await page.evaluate(id => tagState.selectDownload(id), id)).toBeNull();
});

test('known access loss fences a pending removal before its late request can execute', async ({ page, request }) => {
    const id = 'remove-access-loss';
    await ready(page, [{ id }]);
    expect((await page.request.post('/api/users', { data: {
        username: 'removal-access-reader', name: 'Removal access reader', password: 'other-password', role: 'normal',
    } })).ok()).toBe(true);
    await request.post('/login', { form: { username: 'admin', password: 'browser-test-password' } });
    await switchAccount(page, 'removal-access-reader', 'other-password');
    await expect.poll(() => page.evaluate(() => tagCapabilities?.entry_removal)).toBe(1);
    const row = card(page, id);
    await expect(row).not.toHaveClass(/item-fade-in/);
    const held = await gate(page, id);
    try {
        await removeThroughMenu(row);
        await expect.poll(() => held.requests.length).toBe(1);
        expect((await request.post(`/api/visibility/${id}`, { data: { visibility: 'private' } })).ok()).toBe(true);
        await page.evaluate(id => checkTagAvailability(id), id);
        await expect(row).toHaveCount(0);
        held.release();
        await flush(page);
        await expect(row).toHaveCount(0);
        expect(await page.evaluate(id => tagState.selectDownload(id), id)).toBeNull();
        expect((await request.get(`/api/file/${id}`)).ok()).toBe(true);
    } finally { held.release(); }
});

test('filtered absence during pending removal retains its status without implying authoritative deletion', async ({ page }) => {
    const id = 'remove-filtered';
    await ready(page, [{ id }, { id: 'remove-filter-neighbor' }]);
    const held = await gate(page, id);
    try {
        await removeThroughMenu(card(page, id));
        await expect.poll(() => held.requests.length).toBe(1);
        await page.locator('#historySearchToggle').click();
        await page.locator('#historySearchInput').fill('remove-filter-neighbor');
        await refresh(page);
        await expect(summary(page)).toContainText('Removing');
        expect(await page.evaluate(id => tagState.selectDownload(id) !== null, id)).toBe(true);
        expect((await page.request.get(`/api/file/${id}`)).ok()).toBe(true);
        await page.locator('#historySearchClear').click();
        await expect(status(card(page, id), id)).toContainText('Removing');
        held.release();
        await expect(card(page, id)).toHaveCount(0);
    } finally { held.release(); }
});

test('a held removal on page two preserves its page position and card identity through refresh', async ({ page }) => {
    await ready(page, []);
    for (let index = 0; index < 14; index++) await seed(page, { id: `remove-page-${String(index).padStart(2, '0')}`, status: 'finished' });
    await refresh(page);
    await page.locator('#pagerNext').click();
    const cards = page.locator('#historyList [data-row-id]');
    await expect(cards).toHaveCount(4);
    await expect(page.locator('#historyList .item-fade-in')).toHaveCount(0);
    const order = await cards.evaluateAll(rows => rows.map(row => row.dataset.rowId));
    const id = order[1];
    const row = card(page, id);
    await row.evaluate(element => { window.removalPageCard = element; });
    const held = await gate(page, id);
    try {
        await removeThroughMenu(row);
        await expect(status(row, id)).toContainText('Removing');
        await refresh(page);
        expect(await cards.evaluateAll(rows => rows.map(row => row.dataset.rowId))).toEqual(order);
        expect(await row.evaluate(element => element === window.removalPageCard)).toBe(true);
        await expect(page.locator('#pagerInfo')).toContainText('Page 2 of 2');
        held.release();
        await expect(row).toHaveCount(0);
        await expect(cards).toHaveCount(3);
    } finally { held.release(); }
});

test('canonical removal updates an already open History attempt without a collection read', async ({ page }) => {
    const id = 'remove-history-open';
    await ready(page, [{ id, title: 'Open attempt removal' }]);
    const held = await gate(page, id);
    try {
        await removeThroughMenu(card(page, id));
        await expect.poll(() => held.requests.length).toBe(1);
        await page.locator('#accountMenuButton').click();
        await page.locator('#attemptHistoryButton').click();
        const attempt = page.locator('.attempt-row', { hasText: 'Open attempt removal' });
        await expect(attempt).not.toContainText('Media removed');
        let reads = 0;
        page.on('request', request => { if (collectionRequest(request)) reads++; });
        held.release();
        await expect(attempt).toContainText('Media removed');
        await expect(attempt).toContainText('Finished');
        await expect(attempt.getByRole('button', { name: 'View in Library' })).toHaveCount(0);
        expect(reads).toBe(0);
    } finally { held.release(); }
});

test('reload adopts authoritative removal without persisting or replaying a browser write queue', async ({ page }) => {
    const id = 'remove-reload';
    await ready(page, [{ id }]);
    const held = await gate(page, id, { committed: true });
    try {
        await removeThroughMenu(card(page, id));
        await expect.poll(() => held.releases.length).toBe(1);
        await expect(status(card(page, id), id)).toContainText('Removing');
        await page.reload();
        held.release();
        await expect(page.locator('#endlessPlaybackButton')).toBeVisible();
        await expect(card(page, id)).toHaveCount(0);
        await expect(summary(page)).toBeEmpty();
        expect(held.requests).toHaveLength(1);
        expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
    } finally { held.release(); }
});

test('a local canonical rename supplies the generation for immediate subsequent removal without collection reads', async ({ page }) => {
    const id = 'remove-after-rename';
    await ready(page, [{ id }]);
    const row = card(page, id);
    const before = await page.evaluate(id => tagState.selectDownload(id).removal_revision, id);
    let reads = 0;
    page.on('request', request => { if (collectionRequest(request)) reads++; });
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Info', exact: true }).click();
    await row.getByRole('button', { name: 'Edit name', exact: true }).click();
    await row.locator('.rename-input').fill('Renamed before removal');
    await row.locator('.rename-input').press('Enter');
    await expect(row.locator('.rename-feedback:not([data-rename-state="confirmed"])')).toHaveCount(0);
    await expect(row.locator('.rename-display')).toHaveText('Renamed before removal.mp4');
    const current = await page.evaluate(id => tagState.selectDownload(id).removal_revision, id);
    expect(BigInt(current)).toBeGreaterThan(BigInt(before));
    await row.getByRole('button', { name: 'Close info', exact: true }).click();
    const held = await gate(page, id);
    try {
        await removeThroughMenu(row);
        await expect.poll(() => held.requests.length).toBe(1);
        expect(held.requests[0].expected_revision).toBe(current);
        held.release();
        await expect(row).toHaveCount(0);
        expect(reads).toBe(0);
        expect((await page.request.get(`/api/file/${id}`)).status()).toBe(404);
    } finally { held.release(); }
});

test('serialized expired absence checks current authorized state before explicit resolution and never invents removal', async ({ page }) => {
    const id = 'remove-expired-resolution';
    await ready(page, [{ id }]);
    const order = [];
    let writes = 0;
    await page.route(`**/api/remove/${id}`, route => {
        writes++;
        return route.fulfill({ status: 503, json: {} });
    });
    await page.route('**/api/mutations/*', route => {
        order.push('serialized-receipt');
        return route.fulfill({ status: 404, json: { error: 'Mutation unavailable', final: true } });
    });
    await page.route(`**/api/downloads/${id}/editable-state`, route => {
        order.push('current-authorized-state');
        return route.continue();
    });
    const row = card(page, id);
    await removeThroughMenu(row);
    await expect(status(row, id)).toContainText('current authorized entry');
    expect(order).toEqual(['serialized-receipt', 'current-authorized-state']);
    await expect(row).toBeVisible();
    expect((await page.request.get(`/api/file/${id}`)).ok()).toBe(true);
    await recovery(row, 'resolve').click();
    await expect(status(row, id)).toBeEmpty();
    await expect(summary(page)).toBeEmpty();
    await expect(row.locator('.favorite-toggle').first()).toBeEnabled();
    expect(writes).toBe(1);
    expect(await page.evaluate(id => tagState.selectDownload(id) !== null, id)).toBe(true);
});

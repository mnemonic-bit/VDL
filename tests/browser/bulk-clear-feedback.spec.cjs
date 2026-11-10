const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openSettings, switchAccount } = require('./support.cjs');

const summary = page => page.locator('#bulk-clear-summary');
const status = (page, scope) => page.locator(`[data-bulk-clear-status="${scope}"]`).first();
const action = (page, scope, name) => summary(page).locator(`[data-bulk-clear-action="${name}"][data-bulk-clear-scope="${scope}"]`).first();
const card = (page, id) => page.locator(`#historyList [data-row-id="${id}"]`);
const pathFor = scope => scope === 'history' ? '/api/clear' : '/api/library/clear';
const collectionRequest = request => /\/api\/(library|history|current-downloads)(\?|$)/.test(request.url());

async function ready(page, rows = []) {
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    await expect.poll(() => page.evaluate(() => tagCapabilities?.bulk_clear)).toBe(1);
    for (const row of rows) await seed(page, { status: 'finished', title: row.id, ...row });
    await refresh(page);
    await expect(page.locator('#historyList .item-fade-in')).toHaveCount(0);
}

async function openHistory(page) {
    await page.locator('#accountMenuButton').click();
    await page.locator('#attemptHistoryButton').click();
    await expect(page.locator('#attemptHistoryPage')).toBeVisible();
}

async function clear(page, scope, accept = true) {
    const dialog = page.waitForEvent('dialog');
    const invoked = page.evaluate(scope => { if (scope === 'history') clearHistory(); else clearLibrary(); }, scope);
    const confirmation = await dialog;
    expect(confirmation.message()).toContain(scope === 'history'
        ? 'Library videos and files will be kept' : 'Attempt records will be kept');
    if (accept) await confirmation.accept();
    else await confirmation.dismiss();
    await invoked;
}

async function gate(page, scope, { committed = false } = {}) {
    const requests = [];
    const releases = [];
    await page.route(`**${pathFor(scope)}`, async route => {
        requests.push(route.request().postDataJSON());
        const response = committed ? await route.fetch() : null;
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

async function historyItems(page) {
    const response = await page.request.get('/api/history');
    expect(response.ok()).toBe(true);
    return (await response.json()).items;
}

test.beforeEach(async ({ page }) => reset(page));
test.setTimeout(25_000);

for (const scope of ['history', 'library']) {
    test(`${scope} preview cancellation deletes nothing and permits a later explicit confirmation`, async ({ page }) => {
        const id = `bulk-cancel-${scope}`;
        await ready(page, [{ id }]);
        let writes = 0;
        page.on('request', request => { if (new URL(request.url()).pathname === pathFor(scope) && request.method() === 'POST') writes++; });
        const before = await historyItems(page);
        await clear(page, scope, false);
        expect(writes).toBe(0);
        expect((await historyItems(page)).map(item => item.id)).toEqual(before.map(item => item.id));
        expect((await page.request.get(`/api/file/${id}`)).ok()).toBe(true);
        await expect(card(page, id)).toBeVisible();
        await clear(page, scope);
        await expect(status(page, scope)).toContainText(/removed/i);
        expect(writes).toBe(1);
    });

    test(`${scope} clear renders within 50 ms, retains identity while pending, and confirms without SSE or collection reads`, async ({ page }, testInfo) => {
        const id = `bulk-local-${scope}`;
        await ready(page, [{ id }, { id: `bulk-neighbor-${scope}` }, { id: `bulk-active-${scope}`, status: 'downloading' }]);
        await openHistory(page);
        await expect(page.locator('.attempt-row')).toHaveCount(3);
        await page.evaluate(() => {
            window.bulkOriginalCards = [...document.querySelectorAll('#historyList [data-row-id]')];
            window.bulkOriginalAttempts = [...document.querySelectorAll('.attempt-row')];
            const nativeConfirm = window.confirm;
            window.confirm = message => {
                const answer = nativeConfirm(message);
                const started = performance.now();
                queueMicrotask(() => { window.bulkLocalFeedback = { elapsed: performance.now() - started,
                    text: document.getElementById('bulk-clear-summary').textContent }; });
                return answer;
            };
        });
        const held = await gate(page, scope);
        try {
            await clear(page, scope);
            await expect(status(page, scope)).toContainText(scope === 'history' ? 'Clearing history' : 'Clearing library');
            const local = await page.evaluate(() => window.bulkLocalFeedback);
            expect(local.elapsed).toBeLessThan(50);
            expect(local.text).toContain(scope === 'history' ? 'Clearing history' : 'Clearing library');
            await testInfo.attach(`${scope}-clear-local-feedback`, { body: JSON.stringify({ local_feedback_ms: local.elapsed }), contentType: 'application/json' });
            expect(await page.evaluate(() => window.bulkOriginalCards.every(card => card.isConnected))).toBe(true);
            expect(await page.evaluate(() => window.bulkOriginalAttempts.every(row => row.isConnected))).toBe(true);
            await expect.poll(() => held.requests.length).toBe(1);
            expect(held.requests[0].expected_revision).toMatch(/^\d+$/);
            expect(held.requests[0].scope_id).toBeTruthy();
            let reads = 0;
            page.on('request', request => { if (collectionRequest(request)) reads++; });
            held.release();
            await expect(status(page, scope)).toContainText(/removed/i);
            if (scope === 'history') {
                await expect(page.locator('.attempt-row')).toHaveCount(1);
                await expect(page.locator('#attemptHistoryStatus')).toContainText('terminal attempt records removed');
                await expect(page.locator('#attemptPageInfo')).toContainText('totals need refresh after clear');
                expect((await page.request.get(`/api/file/${id}`)).ok()).toBe(true);
                expect(await card(page, id).count()).toBe(1);
            } else {
                await expect(card(page, id)).toHaveCount(0);
                await expect(page.locator('.attempt-row')).toHaveCount(3);
                await expect(page.locator('.attempt-row').filter({ hasText: id })).toContainText('Media removed');
                expect((await page.request.get(`/api/file/${id}`)).status()).toBe(404);
            }
            expect(reads).toBe(0);
            const metrics = await page.evaluate(() => VDL.bulkClearMetrics());
            expect(metrics.submissions).toBe(1);
            expect(metrics.acknowledgements).toBe(1);
            expect(metrics.pending).toBe(0);
            expect(JSON.stringify(metrics)).not.toContain(id);
            expect(await page.evaluate(() => Object.isFrozen(VDL.bulkClearMetrics()))).toBe(true);
        } finally { held.release(); }
    });

    test(`${scope} guards duplicate preview and submission and retains summary when Settings closes`, async ({ page }) => {
        await ready(page, [{ id: `bulk-duplicate-${scope}` }]);
        await openSettings(page);
        const button = page.locator(`[data-bulk-clear="${scope}"]`);
        let previewRelease;
        let previews = 0;
        await page.route(`**${pathFor(scope)}/preview*`, async route => {
            previews++;
            const response = await route.fetch();
            await new Promise(resolve => { previewRelease = resolve; });
            await route.fulfill({ response });
        });
        const held = await gate(page, scope);
        try {
            await button.click();
            await expect.poll(() => Boolean(previewRelease)).toBe(true);
            await expect(button).toBeDisabled();
            await page.evaluate(scope => { if (scope === 'history') clearHistory(); else clearLibrary(); }, scope);
            expect(previews).toBe(1);
            const dialog = page.waitForEvent('dialog');
            previewRelease();
            await (await dialog).accept();
            await expect.poll(() => held.requests.length).toBe(1);
            await page.evaluate(scope => { if (scope === 'history') clearHistory(); else clearLibrary(); }, scope);
            expect(held.requests).toHaveLength(1);
            await page.locator('#settingsBackButton').click();
            await expect(summary(page)).toBeVisible();
            await expect(status(page, scope)).toContainText(scope === 'history' ? 'Clearing history' : 'Clearing library');
            held.release();
            await expect(status(page, scope)).toContainText(/removed/i);
            await expect(page.locator('#settingsPage')).toBeHidden();
        } finally { if (previewRelease) previewRelease(); held.release(); }
    });

    test(`${scope} frozen preview excludes eligible arrivals before execution and same-attempt recovery`, async ({ page }) => {
        const original = `bulk-frozen-${scope}`;
        const later = `bulk-later-${scope}`;
        await ready(page, [{ id: original }]);
        const held = await gate(page, scope);
        try {
            await clear(page, scope);
            await expect.poll(() => held.requests.length).toBe(1);
            await seed(page, { id: later, status: 'finished' });
            held.release();
            await expect(status(page, scope)).toContainText(/removed/i);
            const replay = await page.request.post(pathFor(scope), { data: held.requests[0] });
            expect(replay.ok()).toBe(true);
            const result = await replay.json();
            expect(result.removed).toBe(1);
            expect(result.removed_ids).toHaveLength(1);
            expect((await page.request.get(`/api/file/${later}`)).ok()).toBe(true);
            const attempts = await historyItems(page);
            expect(attempts.some(item => item.download_id === later)).toBe(true);
            if (scope === 'library') expect(attempts.some(item => item.title === original)).toBe(true);
        } finally { held.release(); }
    });

    test(`${scope} lost committed response resolves through receipt checking without a second destructive write`, async ({ page }) => {
        await ready(page, [{ id: `bulk-lost-${scope}` }]);
        await missingReceipts(page);
        let writes = 0;
        await page.route(`**${pathFor(scope)}`, async route => {
            writes++;
            await route.fetch();
            await route.abort('failed');
        });
        await clear(page, scope);
        await expect(status(page, scope)).toContainText('Clear request not confirmed');
        await page.unroute('**/api/mutations/*');
        await action(page, scope, 'check').click();
        await expect(status(page, scope)).toContainText(/removed/i);
        expect(writes).toBe(1);
    });

    test(`${scope} deliberate recovery reuses the frozen request while newer eligible items survive`, async ({ page }) => {
        await ready(page, [{ id: `bulk-replay-${scope}` }]);
        await missingReceipts(page);
        const requests = [];
        await page.route(`**${pathFor(scope)}`, route => {
            requests.push(route.request().postDataJSON());
            if (requests.length === 1) return route.fulfill({ status: 503, json: {} });
            return route.continue();
        });
        await clear(page, scope);
        await expect(status(page, scope)).toContainText('Clear request not confirmed');
        await seed(page, { id: `bulk-replay-later-${scope}`, status: 'finished' });
        await page.unroute('**/api/mutations/*');
        await action(page, scope, 'replay').click();
        await expect(status(page, scope)).toContainText(/removed/i);
        expect(requests).toHaveLength(2);
        expect(requests[1]).toEqual(requests[0]);
        expect((await page.request.get(`/api/file/bulk-replay-later-${scope}`)).ok()).toBe(true);
    });
}

for (const failure of ['generic server error', 'malformed success', 'network loss']) {
    test(`${failure} preserves Library and reports an unknown clear without automatic replay`, async ({ page }) => {
        const id = `bulk-unknown-${failure.replaceAll(' ', '-')}`;
        await ready(page, [{ id }]);
        await missingReceipts(page);
        let writes = 0;
        await page.route('**/api/library/clear', route => {
            writes++;
            if (failure === 'network loss') return route.abort('failed');
            return route.fulfill({ status: failure === 'malformed success' ? 200 : 500, json: { removed: 1 } });
        });
        await clear(page, 'library');
        await expect(status(page, 'library')).toContainText('Clear request not confirmed');
        await refresh(page);
        await expect(card(page, id)).toBeVisible();
        await expect(status(page, 'library')).toContainText('Clear request not confirmed');
        await flush(page);
        expect(writes).toBe(1);
        expect((await page.request.get(`/api/file/${id}`)).ok()).toBe(true);
    });
}

test('a held clear receives explanatory text after five seconds without retrying', async ({ page }) => {
    await ready(page, [{ id: 'bulk-slow' }]);
    await page.clock.install();
    const held = await gate(page, 'library');
    try {
        await clear(page, 'library');
        await expect.poll(() => held.requests.length).toBe(1);
        await page.clock.fastForward(5100);
        await expect(status(page, 'library')).toContainText(/longer|waiting|still/i);
        expect(held.requests).toHaveLength(1);
    } finally { held.release(); }
});

test('an older Library collection response cannot revive canonical bulk removals', async ({ page }) => {
    const id = 'bulk-old-library';
    await ready(page, [{ id }]);
    let releaseRead;
    await page.route('**/api/library?*', async route => {
        const response = await route.fetch();
        await new Promise(resolve => { releaseRead = resolve; });
        await route.fulfill({ response });
    });
    const reading = page.evaluate(() => fetchHistory());
    try {
        await expect.poll(() => Boolean(releaseRead)).toBe(true);
        await clear(page, 'library');
        await expect(card(page, id)).toHaveCount(0);
        releaseRead();
        await reading;
        await flush(page);
        await expect(card(page, id)).toHaveCount(0);
        expect(await page.evaluate(id => tagState.selectDownload(id), id)).toBeNull();
    } finally { if (releaseRead) releaseRead(); }
});

test('an older attempt response cannot revive canonical history clear removals', async ({ page }) => {
    await ready(page, [{ id: 'bulk-old-attempt' }, { id: 'bulk-old-active', status: 'downloading' }]);
    await openHistory(page);
    await expect(page.locator('.attempt-row')).toHaveCount(2);
    let releaseRead;
    await page.route('**/api/history?*', async route => {
        const response = await route.fetch();
        await new Promise(resolve => { releaseRead = resolve; });
        await route.fulfill({ response });
    });
    const reading = page.evaluate(() => fetchAttemptHistory());
    try {
        await expect.poll(() => Boolean(releaseRead)).toBe(true);
        await clear(page, 'history');
        await expect(page.locator('.attempt-row')).toHaveCount(1);
        releaseRead();
        await reading;
        await flush(page);
        await expect(page.locator('.attempt-row')).toHaveCount(1);
        await expect(page.locator('.attempt-row')).toContainText('bulk-old-active');
    } finally { if (releaseRead) releaseRead(); }
});

test('bulk Library pending preserves active playback until canonical confirmation', async ({ page }) => {
    const id = 'bulk-playing';
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
    await card(page, id).getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    const source = await page.locator('#playerVideo source').getAttribute('src');
    const held = await gate(page, 'library');
    try {
        await clear(page, 'library');
        await expect(status(page, 'library')).toContainText('Clearing library');
        await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
        expect(await page.locator('#playerVideo source').getAttribute('src')).toBe(source);
        held.release();
        await expect(card(page, id)).toHaveCount(0);
        await expect(page.locator('#playerBackdrop')).not.toHaveClass(/open/);
        await expect(page.locator('#playerVideo source')).toHaveCount(0);
    } finally { held.release(); }
});

test('real account switching clears held bulk recovery and fences its private callback', async ({ page }) => {
    const id = 'bulk-account-private';
    await ready(page, [{ id, visibility: 'private' }]);
    expect((await page.request.post('/api/users', { data: {
        username: 'bulk-next-account', name: 'Bulk next account', password: 'next-password', role: 'normal',
    } })).ok()).toBe(true);
    const held = await gate(page, 'library', { committed: true });
    try {
        await clear(page, 'library');
        await expect.poll(() => held.releases.length).toBe(1);
        await switchAccount(page, 'bulk-next-account', 'next-password');
        held.release();
        await expect(summary(page)).toBeEmpty();
        await expect(card(page, id)).toHaveCount(0);
        expect(await page.evaluate(id => tagState.selectDownload(id), id)).toBeNull();
    } finally { held.release(); }
});

for (const theme of ['light', 'dark']) {
    test(`${theme} keyboard clear retains readable status under reduced motion and a narrow layout`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.setViewportSize({ width: 390, height: 850 });
        await ready(page, [{ id: `bulk-keyboard-${theme}` }]);
        await openSettings(page);
        await page.locator('#prefTheme').selectOption(theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const held = await gate(page, 'history');
        try {
            const button = page.locator('[data-bulk-clear="history"]');
            await button.focus();
            const dialog = page.waitForEvent('dialog');
            const pressed = button.press('Enter');
            await (await dialog).accept();
            await pressed;
            await expect(status(page, 'history')).toContainText('Clearing history');
            await page.locator('#settingsBackButton').click();
            await expect(summary(page)).toBeVisible();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            held.release();
            await expect(status(page, 'history')).toContainText(/removed/i);
            await expect(summary(page)).toBeVisible();
        } finally { held.release(); }
    });
}

test('changed eligibility is retained and cannot broaden the frozen Library scope', async ({ page }) => {
    await ready(page, [{ id: 'bulk-eligible' }, { id: 'bulk-became-active' }]);
    const held = await gate(page, 'library');
    try {
        await clear(page, 'library');
        await expect.poll(() => held.requests.length).toBe(1);
        await seed(page, { id: 'bulk-became-active', status: 'downloading', progress: '50%' });
        await seed(page, { id: 'bulk-not-previewed', status: 'finished' });
        held.release();
        await expect(status(page, 'library')).toContainText(/1.*removed|removed.*1/i);
        await expect(status(page, 'library')).toContainText(/1.*retained|retained.*1/i);
        expect((await page.request.get('/api/file/bulk-eligible')).status()).toBe(404);
        expect((await page.request.get('/api/file/bulk-not-previewed')).ok()).toBe(true);
        const current = await (await page.request.get('/api/current-downloads')).json();
        expect(current.some(item => item.id === 'bulk-became-active')).toBe(true);
        expect((await historyItems(page)).some(item => item.title === 'bulk-eligible')).toBe(true);
    } finally { held.release(); }
});

test('a correlated definite refusal retains records and permits explicit review', async ({ page }) => {
    const id = 'bulk-refused';
    await ready(page, [{ id }]);
    await page.route('**/api/library/clear', route => {
        const payload = route.request().postDataJSON();
        return route.fulfill({ status: 400, json: {
            scope: 'library', scope_id: payload.scope_id, operation_id: payload.scope_id, revision: payload.expected_revision,
            error: 'Review the selected clear scope before continuing',
            mutation: { id: payload.client_mutation_id, action: 'library.clear', domain: 'bulk-clear',
                entity_id: 'library', revision: payload.expected_revision, outcome: 'rejected' },
        } });
    });
    await clear(page, 'library');
    await expect(status(page, 'library')).toContainText('Review the selected clear scope before continuing');
    await expect(card(page, id)).toBeVisible();
    expect((await page.request.get(`/api/file/${id}`)).ok()).toBe(true);
    await expect(action(page, 'library', 'replay')).toHaveCount(0);
});

test('authentication reset clears private bulk state and fences a held acknowledgement', async ({ page }) => {
    const id = 'bulk-reset-private';
    await ready(page, [{ id, visibility: 'private' }]);
    const held = await gate(page, 'library', { committed: true });
    try {
        await clear(page, 'library');
        await expect.poll(() => held.releases.length).toBe(1);
        await page.evaluate(() => resetTagSession());
        held.release();
        await flush(page);
        await expect(summary(page)).toBeEmpty();
        expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
        expect(await page.evaluate(id => tagState.selectDownload(id), id)).toBeNull();
    } finally { held.release(); }
});

test('unsupported bulk endpoints show truthful unknown status without receipt checks or replay', async ({ page }) => {
    await page.route('**/api/client-capabilities', async route => {
        const response = await route.fetch();
        const capabilities = await response.json();
        capabilities.actions = capabilities.actions.filter(action => !['history.clear', 'library.clear'].includes(action));
        delete capabilities.bulk_clear;
        await route.fulfill({ response, json: capabilities });
    });
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    await seed(page, { id: 'bulk-legacy', status: 'finished' });
    await refresh(page);
    await expect(page.locator('#historyList .item-fade-in')).toHaveCount(0);
    let release;
    let writes = 0;
    let receipts = 0;
    page.on('request', request => { if (/\/api\/mutations\//.test(request.url())) receipts++; });
    await page.route('**/api/library/clear', async route => {
        writes++;
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ status: 503, json: {} });
    });
    try {
        await clear(page, 'library');
        await expect(status(page, 'library')).toContainText('Clearing library');
        await expect.poll(() => Boolean(release)).toBe(true);
        release();
        await expect(status(page, 'library')).toContainText('Clear request not confirmed');
        await expect(action(page, 'library', 'replay')).toHaveCount(0);
        await expect(action(page, 'library', 'check')).toHaveText('Check current state');
        await action(page, 'library', 'check').click();
        await expect(status(page, 'library')).toContainText('Clear request not confirmed');
        await expect(card(page, 'bulk-legacy')).toBeVisible();
        expect(writes).toBe(1);
        expect(receipts).toBe(0);
    } finally { if (release) release(); }
});

test('reload reads authoritative state without replaying an unresolved bulk request', async ({ page }) => {
    await ready(page, [{ id: 'bulk-reload' }]);
    await missingReceipts(page);
    let writes = 0;
    await page.route('**/api/library/clear', route => {
        writes++;
        return route.fulfill({ status: 503, json: {} });
    });
    await clear(page, 'library');
    await expect(status(page, 'library')).toContainText('Clear request not confirmed');
    await page.reload();
    await expect(page.locator('#prefDir')).not.toHaveValue('');
    await expect(summary(page)).toBeEmpty();
    await expect(card(page, 'bulk-reload')).toBeVisible();
    expect(writes).toBe(1);
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => /bulk|mutation|receipt/i.test(key)))).toBe(false);
});

test('actual partial cleanup remains accepted and visible until explicit journal recovery finishes its fixed set', async ({ page }) => {
    await ready(page, [{ id: 'bulk-partial-good' }, { id: 'bulk-partial-blocked' }]);
    expect((await page.request.post('/__test__/bulk-clear-failure', { data: { id: 'bulk-partial-blocked', enabled: true } })).ok()).toBe(true);
    let writes = 0;
    let receipts = 0;
    page.on('request', request => {
        if (new URL(request.url()).pathname === '/api/library/clear' && request.method() === 'POST') writes++;
        if (/\/api\/mutations\//.test(request.url())) receipts++;
    });
    await clear(page, 'library');
    await expect(status(page, 'library')).toContainText(/accepted/i);
    await expect(status(page, 'library')).toContainText('1 items removed');
    await expect(status(page, 'library')).toContainText('1 pending');
    await expect(status(page, 'library')).not.toContainText(/complete:/i);
    await expect(card(page, 'bulk-partial-good')).toHaveCount(0);
    await expect(card(page, 'bulk-partial-blocked')).toBeVisible();
    expect((await page.request.get('/api/file/bulk-partial-good')).status()).toBe(404);
    await seed(page, { id: 'bulk-partial-later', status: 'finished' });
    expect(receipts).toBe(0);
    expect((await page.request.post('/__test__/bulk-clear-failure', { data: { id: 'bulk-partial-blocked', enabled: false } })).ok()).toBe(true);
    await action(page, 'library', 'check').click();
    await expect(status(page, 'library')).toContainText(/2.*removed|removed.*2/i);
    await expect(status(page, 'library')).toContainText(/complete/i);
    await expect(card(page, 'bulk-partial-blocked')).toHaveCount(0);
    expect((await page.request.get('/api/file/bulk-partial-later')).ok()).toBe(true);
    expect((await historyItems(page)).length).toBe(3);
    expect(writes).toBe(1);
    expect(receipts).toBe(1);
});

test('current access denial fences bulk recovery without claiming deletion or retrying', async ({ page }) => {
    const id = 'bulk-access-denied';
    await ready(page, [{ id }]);
    let writes = 0;
    await page.route('**/api/library/clear', route => {
        writes++;
        return route.fulfill({ status: 403, json: { error: 'Administrator access required' } });
    });
    await clear(page, 'library');
    await expect(status(page, 'library')).toContainText('Access to this clear is no longer available');
    await expect(summary(page)).not.toContainText(id);
    await expect(action(page, 'library', 'check')).toHaveCount(0);
    await expect(action(page, 'library', 'replay')).toHaveCount(0);
    await expect(card(page, id)).toBeVisible();
    expect((await page.request.get(`/api/file/${id}`)).ok()).toBe(true);
    expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
    expect(writes).toBe(1);
    await page.unroute('**/api/library/clear');
    await clear(page, 'library');
    await expect(status(page, 'library')).toContainText('Library clear complete');
    await expect(card(page, id)).toHaveCount(0);
});

test('a correlated scope conflict requires explicit review before any fresh destructive request', async ({ page }) => {
    await ready(page, [{ id: 'bulk-conflict' }]);
    let writes = 0;
    await page.route('**/api/library/clear', route => {
        writes++;
        const payload = route.request().postDataJSON();
        return route.fulfill({ status: 409, json: {
            scope: 'library', scope_id: payload.scope_id, operation_id: payload.scope_id, revision: '0',
            mutation: { id: payload.client_mutation_id, action: 'library.clear', domain: 'bulk-clear',
                entity_id: 'library', revision: '0', outcome: 'conflicted' },
        } });
    });
    await clear(page, 'library');
    await expect(status(page, 'library')).toContainText('Review a new preview');
    await expect(action(page, 'library', 'replay')).toHaveCount(0);
    await action(page, 'library', 'resolve').click();
    await expect(summary(page)).toBeEmpty();
    await expect(card(page, 'bulk-conflict')).toBeVisible();
    expect(writes).toBe(1);
});

test('meaningful bulk status changes are announced once across repeated rendering', async ({ page }) => {
    await ready(page, [{ id: 'bulk-announcements' }]);
    await page.evaluate(() => {
        window.bulkAnnouncements = [];
        const region = document.getElementById('tagMutationStatus');
        new MutationObserver(() => { window.bulkAnnouncements.push(region.textContent); })
            .observe(region, { childList: true, characterData: true, subtree: true });
    });
    const held = await gate(page, 'library');
    try {
        await clear(page, 'library');
        await expect(status(page, 'library')).toContainText('Clearing library');
        await page.evaluate(() => { refreshBulkClearPresentations(); refreshBulkClearPresentations(); });
        await flush(page);
        expect(await page.evaluate(() => window.bulkAnnouncements.filter(message => message === 'Clearing library…').length)).toBe(1);
        held.release();
        await expect(status(page, 'library')).toContainText('Library clear complete');
        await page.evaluate(() => { refreshBulkClearPresentations(); refreshBulkClearPresentations(); });
        await flush(page);
        expect(await page.evaluate(() => window.bulkAnnouncements.filter(message => message.startsWith('Library clear complete:')).length)).toBe(1);
        await expect(page.locator('#tagMutationStatus')).toHaveAttribute('aria-live', 'polite');
        await expect(summary(page)).toHaveAttribute('aria-live', 'off');
    } finally { held.release(); }
});

async function expiredUnknownClear(page, scope) {
    await page.clock.install();
    let final = false;
    let writes = 0;
    const order = [];
    await page.route(`**${pathFor(scope)}`, route => {
        writes++;
        return route.fulfill({ status: 503, json: {} });
    });
    await page.route('**/api/mutations/*', route => {
        order.push(final ? 'serialized-final-absence' : 'receipt-unavailable');
        return route.fulfill({ status: 404, json: { error: 'Mutation unavailable', final } });
    });
    await clear(page, scope);
    await expect(status(page, scope)).toContainText('Clear request not confirmed');
    await expect.poll(() => order.length).toBe(1);
    await page.clock.fastForward(86_401_000);
    final = true;
    return { order, writes: () => writes };
}

const currentScopeRead = scope => scope === 'history' ? '**/api/history?*' : '**/api/library?*';

for (const scope of ['history', 'library']) {
    test(`${scope} expired absence checks authorized current state before explicit resolution without another clear`, async ({ page }) => {
        const id = `bulk-expired-${scope}`;
        const later = `bulk-expired-later-${scope}`;
        await ready(page, [{ id }]);
        if (scope === 'history') { await openHistory(page); await expect(page.locator('.attempt-row')).toHaveCount(1); }
        const unknown = await expiredUnknownClear(page, scope);
        await seed(page, { id: later, title: later, status: 'finished' });
        let release;
        await page.route(currentScopeRead(scope), async route => {
            unknown.order.push('current-authorized-state');
            const response = await route.fetch();
            await new Promise(resolve => { release = resolve; });
            await route.fulfill({ response }).catch(() => {});
        });
        try {
            await action(page, scope, 'check').click();
            await expect.poll(() => Boolean(release)).toBe(true);
            expect(unknown.order).toEqual(['receipt-unavailable', 'serialized-final-absence', 'current-authorized-state']);
            await expect(action(page, scope, 'resolve')).toHaveCount(0);
            await expect(action(page, scope, 'replay')).toHaveCount(0);
            await expect(status(page, scope)).not.toContainText('clear complete');
            if (scope === 'history') await expect(page.locator('.attempt-row')).toHaveCount(1);
            else await expect(card(page, id)).toBeVisible();
            release();
            await expect(action(page, scope, 'resolve')).toHaveText('Use current state');
            await expect(status(page, scope)).toContainText(/current.*checked|checked.*current/i);
            await expect(status(page, scope)).not.toContainText('clear complete');
            expect(unknown.writes()).toBe(1);
            await action(page, scope, 'resolve').click();
            await expect(summary(page)).toBeEmpty();
            if (scope === 'history') await expect(page.locator('.attempt-row')).toHaveCount(2);
            else { await expect(card(page, id)).toBeVisible(); await expect(card(page, later)).toBeVisible(); }
            expect((await page.request.get(`/api/file/${id}`)).ok()).toBe(true);
            expect(unknown.writes()).toBe(1);
            expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
        } finally { if (release) release(); }
    });

    test(`${scope} failed current-state read cannot release an expired unknown clear`, async ({ page }) => {
        const id = `bulk-expired-read-failure-${scope}`;
        await ready(page, [{ id }]);
        if (scope === 'history') { await openHistory(page); await expect(page.locator('.attempt-row')).toHaveCount(1); }
        const unknown = await expiredUnknownClear(page, scope);
        let reads = 0;
        let failed = true;
        await page.route(currentScopeRead(scope), route => {
            reads++;
            if (failed) return route.fulfill({ status: 503, json: {} });
            return route.continue();
        });
        await action(page, scope, 'check').click();
        await expect.poll(() => reads).toBe(1);
        await flush(page);
        await expect(action(page, scope, 'resolve')).toHaveCount(0);
        await expect(status(page, scope)).not.toContainText('clear complete');
        expect(await page.evaluate(() => tagMutations.hasPending())).toBe(true);
        expect(unknown.writes()).toBe(1);
        failed = false;
        await action(page, scope, 'check').click();
        await expect(action(page, scope, 'resolve')).toHaveText('Use current state');
        await action(page, scope, 'resolve').click();
        await expect(summary(page)).toBeEmpty();
        expect(reads).toBe(2);
        expect(unknown.writes()).toBe(1);
        expect((await page.request.get(`/api/file/${id}`)).ok()).toBe(true);
    });

    test(`${scope} authentication epoch fences an expired-recovery state read and its private snapshot`, async ({ page }) => {
        const id = `bulk-expired-private-${scope}`;
        const later = `bulk-expired-private-later-${scope}`;
        await ready(page, [{ id, visibility: 'private' }]);
        if (scope === 'history') { await openHistory(page); await expect(page.locator('.attempt-row')).toHaveCount(1); }
        const unknown = await expiredUnknownClear(page, scope);
        await seed(page, { id: later, status: 'finished', visibility: 'private' });
        let release;
        await page.route(currentScopeRead(scope), async route => {
            const response = await route.fetch();
            await new Promise(resolve => { release = resolve; });
            await route.fulfill({ response }).catch(() => {});
        });
        try {
            await action(page, scope, 'check').click();
            await expect.poll(() => Boolean(release)).toBe(true);
            await page.evaluate(() => resetTagSession());
            release();
            await flush(page);
            await expect(summary(page)).toBeEmpty();
            expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
            expect(await page.evaluate(scope => tagState.selectDownload(`bulk:${scope}`), scope)).toBeNull();
            expect(await page.evaluate(id => tagState.selectDownload(id), later)).toBeNull();
            expect(unknown.writes()).toBe(1);
        } finally { if (release) release(); }
    });
}

test('history resolve rechecks a filter changed after its authorized expired-state snapshot', async ({ page }) => {
    await ready(page, [{ id: 'bulk-expired-old-history-view' }]);
    await openHistory(page);
    await expect(page.locator('.attempt-row')).toHaveCount(1);
    const unknown = await expiredUnknownClear(page, 'history');
    await action(page, 'history', 'check').click();
    await expect(action(page, 'history', 'resolve')).toHaveText('Use current state');
    await seed(page, { id: 'bulk-expired-new-history-view', title: 'Newly failed attempt', status: 'error', progress: 'Fixture error' });
    await page.locator('#attemptSearchToggle').click();
    await page.locator('#attemptSearchInput').fill('status:error');
    await expect(page.locator('.attempt-row')).toHaveCount(1);
    await expect(page.locator('.attempt-row')).toContainText('Newly failed attempt');
    await action(page, 'history', 'resolve').click();
    await expect(status(page, 'history')).toContainText('current view changed after the authorized check');
    await expect(action(page, 'history', 'resolve')).toHaveCount(0);
    await expect(page.locator('#attemptSearchInput')).toHaveValue('status:error');
    await expect(page.locator('.attempt-row')).toHaveCount(1);
    await expect(page.locator('.attempt-row')).toContainText('Newly failed attempt');
    expect(await page.evaluate(() => tagMutations.hasPending())).toBe(true);
    expect(unknown.writes()).toBe(1);
    await action(page, 'history', 'check').click();
    await expect(action(page, 'history', 'resolve')).toHaveText('Use current state');
    await action(page, 'history', 'resolve').click();
    await expect(summary(page)).toBeEmpty();
    await expect(page.locator('#attemptSearchInput')).toHaveValue('status:error');
    await expect(page.locator('.attempt-row')).toHaveCount(1);
    await expect(page.locator('.attempt-row')).toContainText('Newly failed attempt');
    expect(unknown.writes()).toBe(1);
});

test('library resolve preserves a newer collection read and requires another authorized expired-state check', async ({ page }) => {
    await ready(page, [{ id: 'bulk-expired-old-library-view' }]);
    const unknown = await expiredUnknownClear(page, 'library');
    await action(page, 'library', 'check').click();
    await expect(action(page, 'library', 'resolve')).toHaveText('Use current state');
    await seed(page, { id: 'bulk-expired-new-library-view', status: 'finished', title: 'Newly arrived Library media' });
    await refresh(page);
    await expect(card(page, 'bulk-expired-new-library-view')).toBeVisible();
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(2);
    await action(page, 'library', 'resolve').click();
    await expect(status(page, 'library')).toContainText('current view changed after the authorized check');
    await expect(action(page, 'library', 'resolve')).toHaveCount(0);
    await expect(card(page, 'bulk-expired-new-library-view')).toBeVisible();
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(2);
    expect(await page.evaluate(() => tagMutations.hasPending())).toBe(true);
    expect(unknown.writes()).toBe(1);
    await action(page, 'library', 'check').click();
    await expect(action(page, 'library', 'resolve')).toHaveText('Use current state');
    await action(page, 'library', 'resolve').click();
    await expect(summary(page)).toBeEmpty();
    await expect(card(page, 'bulk-expired-new-library-view')).toBeVisible();
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(2);
    expect(unknown.writes()).toBe(1);
});

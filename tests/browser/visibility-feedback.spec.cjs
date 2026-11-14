const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, switchAccount } = require('./support.cjs');

const card = (page, id) => page.locator(`[data-row-id="${id}"]`);
const select = row => row.locator('[data-visibility-select]');
const feedback = row => row.locator('[data-visibility-feedback]');
const recovery = (surface, action) => surface.locator(`[data-visibility-recovery="${action}"]`).first();
const summary = page => page.locator('#visibilityMutationSummary');
const collectionRequest = request => /\/api\/(library|history|current-downloads)(\?|$)/.test(request.url());

async function ready(page, rows) {
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    await expect.poll(() => page.evaluate(() => hasVisibilityProtocol())).toBe(true);
    for (const row of rows) await seed(page, { status: 'finished', ...row });
    await refresh(page);
    for (const row of rows) await expect(card(page, row.id)).not.toHaveClass(/item-fade-in/);
}

async function openInfo(row) {
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Info', exact: true }).click();
    await expect(row.locator('.history-info-popover')).toBeVisible();
}

async function gate(page, id, { committed = false } = {}) {
    const requests = [];
    const releases = [];
    let released = false;
    await page.route(`**/api/visibility/${id}`, async route => {
        requests.push(route.request().postDataJSON());
        const response = committed ? await route.fetch() : null;
        if (!released) await new Promise(resolve => releases.push(resolve));
        if (response) await route.fulfill({ response }).catch(() => {});
        else await route.continue().catch(() => {});
    });
    return { requests, releases, release: () => { released = true; releases.splice(0).forEach(release => release()); } };
}

async function missingReceipts(page) {
    await page.route('**/api/mutations/*', route => route.fulfill({
        status: 404, json: { error: 'Mutation unavailable', final: false },
    }));
}

async function security(page, id) {
    const response = await page.request.get(`/api/downloads/${id}/editable-state`);
    expect(response.ok()).toBe(true);
    return response.json();
}

async function createReader(page, username) {
    expect((await page.request.post('/api/users', { data: {
        username, name: username, password: 'reader-password', role: 'normal',
    } })).ok()).toBe(true);
}

test.beforeEach(async ({ page }) => reset(page));
test.setTimeout(25_000);

test('visibility feedback is synchronous and canonical confirmation needs no SSE or collection read', async ({ page }, testInfo) => {
    const id = 'visibility-immediate';
    await ready(page, [{ id }, { id: 'visibility-neighbor' }]);
    const row = card(page, id);
    await openInfo(row);
    const held = await gate(page, id);
    let reads = 0;
    page.on('request', request => { if (collectionRequest(request)) reads++; });
    try {
        const observed = await select(row).evaluate(element => {
            window.visibilityOriginalSelect = element;
            window.visibilityOriginalCard = element.closest('[data-row-id]');
            const start = performance.now();
            element.value = 'private';
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return { elapsed: performance.now() - start, text: element.closest('.history-visibility-section').textContent };
        });
        expect(observed.elapsed).toBeLessThan(50);
        expect(observed.text).toContain('Changing to private');
        expect(observed.text).toContain('Public');
        await testInfo.attach('visibility-local-feedback', {
            body: JSON.stringify({ local_feedback_ms: observed.elapsed }), contentType: 'application/json',
        });
        await expect(select(row)).toHaveValue('public');
        await expect(select(row)).toBeDisabled();
        await expect(feedback(row)).toContainText('Public');
        await expect(feedback(row)).toContainText('Changing to private');
        await expect(row.locator('.history-visibility-help')).toHaveText('Visible to all users');
        await expect(page.locator('#tagMutationStatus')).toContainText('Changing visibility');
        await expect.poll(() => held.requests.length).toBe(1);
        expect(held.requests[0].visibility).toBe('private');
        expect(held.requests[0].expected_revision).toMatch(/^\d+$/);
        expect((await security(page, id)).visibility).toBe('public');
        held.release();
        await expect(select(row)).toHaveValue('private');
        await expect(select(row)).toBeEnabled();
        await expect(row.locator('.history-visibility-help')).toHaveText('Visible only to you and administrators');
        expect(reads).toBe(0);
        expect(await row.evaluate(element => element === window.visibilityOriginalCard)).toBe(true);
        expect(await select(row).evaluate(element => element === window.visibilityOriginalSelect)).toBe(true);
        expect((await security(page, id)).visibility).toBe('private');
    } finally { held.release(); }
});

test('pending publication retains private state and guards contradictory local requests', async ({ page }) => {
    const id = 'visibility-pending-public';
    await ready(page, [{ id, visibility: 'private' }]);
    const row = card(page, id);
    await openInfo(row);
    const held = await gate(page, id);
    try {
        await select(row).selectOption('public');
        await expect(select(row)).toHaveValue('private');
        await expect(feedback(row)).toContainText('Private');
        await expect(feedback(row)).toContainText('Changing to public');
        await expect(row.locator('.history-visibility-help')).toHaveText('Visible only to you and administrators');
        await select(row).evaluate(element => {
            element.value = 'private';
            element.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await expect.poll(() => held.requests.length).toBe(1);
        expect((await security(page, id)).visibility).toBe('private');
        held.release();
        await expect(select(row)).toHaveValue('public');
        await expect(select(row)).toBeEnabled();
        expect(held.requests).toHaveLength(1);
    } finally { held.release(); }
});

test('pending visibility leaves independent favorite and tag edits usable', async ({ page }) => {
    const id = 'visibility-independent';
    await ready(page, [{ id }]);
    const row = card(page, id);
    await openInfo(row);
    const held = await gate(page, id);
    try {
        await select(row).selectOption('private');
        await row.locator('.favorite-toggle-inline').click();
        await expect(row.locator('.favorite-toggle-inline')).toHaveAttribute('aria-pressed', 'true');
        await row.getByText('Add tags', { exact: true }).click();
        await row.locator('.tag-entry-input').fill('Independent visibility metadata');
        await row.locator('.tag-entry-input').press('Enter');
        await expect(row.locator('[data-remove-tag="Independent visibility metadata"]')).toBeVisible();
        await row.locator('.tag-entry-input').press('Escape');
        held.release();
        await expect(select(row)).toHaveValue('private');
        await expect(select(row)).toBeEnabled();
        const state = await security(page, id);
        expect(state.visibility).toBe('private');
        expect(state.favorite).toBe(true);
    } finally { held.release(); }
});

test('a delayed visibility response explains the wait and announces the pending change once', async ({ page }) => {
    const id = 'visibility-delayed';
    await ready(page, [{ id }]);
    const row = card(page, id);
    await openInfo(row);
    await page.clock.install();
    await page.evaluate(() => {
        window.visibilityAnnouncements = [];
        new MutationObserver(() => window.visibilityAnnouncements.push(document.getElementById('tagMutationStatus').textContent))
            .observe(document.getElementById('tagMutationStatus'), { subtree: true, childList: true, characterData: true });
    });
    const held = await gate(page, id);
    try {
        await select(row).selectOption('private');
        await expect.poll(() => held.requests.length).toBe(1);
        await page.clock.fastForward(5100);
        await expect(feedback(row)).toContainText(/still waiting|taking longer/i);
        await expect(select(row)).toHaveValue('public');
        await refresh(page);
        expect(await page.evaluate(() => window.visibilityAnnouncements.filter(message => message === 'Changing visibility…').length)).toBe(1);
        expect(held.requests).toHaveLength(1);
        held.release();
        await expect(select(row)).toHaveValue('private');
        await expect(select(row)).toBeEnabled();
    } finally { held.release(); }
});

test('an older collection response cannot overwrite canonical visibility', async ({ page }) => {
    const id = 'visibility-old-read';
    await ready(page, [{ id }]);
    const row = card(page, id);
    await openInfo(row);
    let release;
    await page.route('**/api/library?*', async route => {
        const response = await route.fetch();
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ response }).catch(() => {});
    });
    const oldRead = page.evaluate(() => fetchHistory());
    try {
        await expect.poll(() => Boolean(release)).toBe(true);
        await select(row).selectOption('private');
        await expect(select(row)).toHaveValue('private');
        await expect(select(row)).toBeEnabled();
        release();
        await oldRead;
        await expect(select(row)).toHaveValue('private');
        await expect(row.locator('.history-visibility-help')).toHaveText('Visible only to you and administrators');
    } finally { release?.(); }
});

test('an older acknowledgement cannot replace a newer authorized security snapshot', async ({ page }) => {
    const id = 'visibility-old-ack';
    await ready(page, [{ id }]);
    const row = card(page, id);
    await openInfo(row);
    const held = await gate(page, id, { committed: true });
    try {
        await select(row).selectOption('private');
        await expect.poll(() => held.releases.length).toBe(1);
        expect((await page.request.post(`/api/visibility/${id}`, { data: { visibility: 'public' } })).ok()).toBe(true);
        await refresh(page);
        held.release();
        await expect(select(row)).toBeEnabled();
        await expect(select(row)).toHaveValue('public');
        expect((await security(page, id)).visibility).toBe('public');
    } finally { held.release(); }
});

test('a lost committed response recovers its canonical result by explicit receipt check', async ({ page }) => {
    const id = 'visibility-lost-ack';
    await ready(page, [{ id }]);
    const row = card(page, id);
    await openInfo(row);
    const attempts = [];
    await page.route(`**/api/visibility/${id}`, async route => {
        attempts.push(route.request().postDataJSON());
        await route.fetch();
        await route.abort('failed');
    });
    await missingReceipts(page);
    await select(row).selectOption('private');
    await expect(feedback(row)).toContainText('Visibility change not confirmed');
    await expect(feedback(row)).toContainText(/public/i);
    await expect(feedback(row)).toContainText(/private/i);
    await expect(select(row)).toHaveValue('public');
    await expect(select(row)).toBeDisabled();
    await page.unroute('**/api/mutations/*');
    const readsBeforeRecovery = await page.evaluate(() => VDL.visibilityMutationMetrics().reconciliationReads);
    await recovery(row, 'check').click();
    await expect(select(row)).toHaveValue('private');
    await expect(select(row)).toBeEnabled();
    expect(await page.evaluate(() => VDL.visibilityMutationMetrics().reconciliationReads)).toBeGreaterThan(readsBeforeRecovery);
    expect(attempts).toHaveLength(1);
});

test('unknown visibility survives closing Info and deliberate replay uses the identical attempt', async ({ page }) => {
    const id = 'visibility-replay';
    await ready(page, [{ id }]);
    const row = card(page, id);
    await openInfo(row);
    await missingReceipts(page);
    const attempts = [];
    await page.route(`**/api/visibility/${id}`, async route => {
        attempts.push(route.request().postDataJSON());
        if (attempts.length === 1) return route.fulfill({ status: 500, json: {} });
        await route.continue();
    });
    await select(row).selectOption('private');
    await expect(feedback(row)).toContainText('Visibility change not confirmed');
    await row.getByRole('button', { name: 'Close info', exact: true }).click();
    await expect(summary(page)).toContainText('Visibility change not confirmed');
    expect(attempts).toHaveLength(1);
    await recovery(summary(page), 'replay').click();
    await expect.poll(() => attempts.length).toBe(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await openInfo(row);
    await expect(select(row)).toHaveValue('private');
    await expect(select(row)).toBeEnabled();
});

test('malformed success retains both values and never announces privacy', async ({ page }) => {
    const id = 'visibility-malformed';
    await ready(page, [{ id }]);
    const row = card(page, id);
    await openInfo(row);
    await missingReceipts(page);
    await page.route(`**/api/visibility/${id}`, route => route.fulfill({ status: 200, json: { visibility: 'private', ok: true } }));
    await select(row).selectOption('private');
    await expect(feedback(row)).toContainText('Visibility change not confirmed');
    await expect(select(row)).toHaveValue('public');
    await expect(select(row)).toBeDisabled();
    await expect(row.locator('.history-visibility-help')).toHaveText('Last confirmed access: Visible to all users');
    expect((await security(page, id)).visibility).toBe('public');
});

test('a definite rejection preserves confirmed visibility and explains the failure', async ({ page }) => {
    const id = 'visibility-rejected';
    await ready(page, [{ id }]);
    const row = card(page, id);
    await openInfo(row);
    const current = await security(page, id);
    await page.route(`**/api/visibility/${id}`, route => route.fulfill({ status: 400, json: {
        ...current, changed: false, error: 'Visibility was declined',
        mutation: { id: route.request().postDataJSON().client_mutation_id, domain: 'visibility', revision: current.visibility_revision, outcome: 'rejected' },
    } }));
    await select(row).selectOption('private');
    await expect(feedback(row)).toContainText(/declined|could not/i);
    await expect(select(row)).toHaveValue('public');
    await expect(row.locator('.history-visibility-help')).toHaveText('Visible to all users');
    expect((await security(page, id)).visibility).toBe('public');
});

test('a quota refusal retains requested and confirmed visibility without receipt recovery', async ({ page }) => {
    const id = 'visibility-quota-refusal';
    await ready(page, [{ id }]);
    const row = card(page, id);
    await openInfo(row);
    let writes = 0;
    let receiptReads = 0;
    page.on('request', request => { if (/\/api\/mutations\//.test(request.url())) receiptReads++; });
    await page.route(`**/api/visibility/${id}`, route => {
        writes++;
        return route.fulfill({ status: 429, json: {
            error: 'Too many mutations; wait before submitting more', code: 'mutation_limit',
        } });
    });
    await select(row).selectOption('private');
    await expect(feedback(row)).toContainText('Too many mutations');
    await expect(feedback(row)).toContainText('Requested: Private');
    await expect(feedback(row)).toContainText('Last confirmed: Public');
    await expect(select(row)).toHaveValue('public');
    await expect(recovery(row, 'check')).toHaveCount(0);
    await expect(recovery(row, 'replay')).toHaveCount(0);
    await recovery(row, 'dismiss').click();
    await expect(select(row)).toBeEnabled();
    expect((await security(page, id)).visibility).toBe('public');
    expect(writes).toBe(1);
    expect(receiptReads).toBe(0);
});

test('a concurrent change requires explicit review before a new visibility attempt', async ({ page }) => {
    const id = 'visibility-conflict';
    await ready(page, [{ id }]);
    const row = card(page, id);
    await openInfo(row);
    expect((await page.request.post(`/api/visibility/${id}`, { data: { visibility: 'private' } })).ok()).toBe(true);
    const attempts = [];
    page.on('request', request => {
        if (new URL(request.url()).pathname === `/api/visibility/${id}`) attempts.push(request.postDataJSON());
    });
    await select(row).selectOption('private');
    await expect(recovery(row, 'review')).toBeVisible();
    await expect(select(row)).toBeDisabled();
    expect(attempts).toHaveLength(1);
    await recovery(row, 'review').click();
    await expect(select(row)).toBeEnabled();
    await expect(select(row)).toHaveValue('private');
    await select(row).selectOption('public');
    await expect(select(row)).toHaveValue('public');
    await expect(select(row)).toBeEnabled();
    expect(attempts).toHaveLength(2);
    expect(attempts[1].client_mutation_id).not.toBe(attempts[0].client_mutation_id);
    expect(BigInt(attempts[1].expected_revision)).toBeGreaterThan(BigInt(attempts[0].expected_revision));
});

test('filtered absence does not resolve an unknown visibility change', async ({ page }) => {
    const id = 'visibility-filtered';
    await ready(page, [{ id }, { id: 'visibility-filter-neighbor' }]);
    const row = card(page, id);
    await openInfo(row);
    await missingReceipts(page);
    await page.route(`**/api/visibility/${id}`, route => route.fulfill({ status: 500, json: {} }));
    await select(row).selectOption('private');
    await expect(feedback(row)).toContainText('Visibility change not confirmed');
    await row.getByRole('button', { name: 'Close info', exact: true }).click();
    await page.locator('#historySearchToggle').click();
    await page.locator('#historySearchInput').fill('visibility-filter-neighbor');
    await refresh(page);
    await expect(summary(page)).toContainText('Visibility change not confirmed');
    expect(await page.evaluate(id => tagMutations.pending().some(intent => intent.targetId === id && intent.kind === 'visibility.set'), id)).toBe(true);
});

test('a known access fence clears pending private metadata and ignores a late acknowledgement', async ({ page }) => {
    const id = 'visibility-access-fence';
    await ready(page, [{ id, visibility: 'private', title: 'Private visibility metadata' }]);
    const row = card(page, id);
    await openInfo(row);
    const held = await gate(page, id, { committed: true });
    try {
        await select(row).selectOption('public');
        await expect.poll(() => held.releases.length).toBe(1);
        await page.evaluate(id => tagMutations.fence(id), id);
        await expect(row).toHaveCount(0);
        await expect(summary(page)).not.toContainText('Private visibility metadata');
        held.release();
        await expect.poll(() => page.evaluate(id => tagState.selectDownload(id), id)).toBeNull();
        await expect(row).toHaveCount(0);
    } finally { held.release(); }
});

test('revoked administrator access fences unknown visibility and receipt lookup discloses no private state', async ({ page, request }) => {
    const id = 'visibility-revoked-receipt';
    await ready(page, []);
    await createReader(page, 'visibility-revocation-owner');
    expect((await page.request.post('/api/users', { data: {
        username: 'visibility-backup-admin', name: 'Visibility Backup', password: 'backup-password', role: 'admin',
    } })).ok()).toBe(true);
    await seed(page, { id, status: 'finished', downloaded_by: 'visibility-revocation-owner', title: 'Private revoked title' });
    await refresh(page);
    const row = card(page, id);
    await expect(row).not.toHaveClass(/item-fade-in/);
    await openInfo(row);
    await missingReceipts(page);
    let attempt;
    await page.route(`**/api/visibility/${id}`, async route => {
        attempt = route.request().postDataJSON();
        await route.fetch();
        await route.abort('failed');
    });
    await select(row).selectOption('private');
    await expect(feedback(row)).toContainText('Visibility change not confirmed');
    expect((await request.post('/login', { form: { username: 'visibility-backup-admin', password: 'backup-password' } })).ok()).toBe(true);
    const users = await (await request.get('/api/users')).json();
    const admin = users.users.find(user => user.username === 'admin');
    try {
        expect((await request.patch(`/api/users/${admin.id}`, { data: { role: 'normal' } })).ok()).toBe(true);
        await page.unroute('**/api/mutations/*');
        await recovery(row, 'check').click();
        await expect(row).toHaveCount(0);
        await expect(summary(page)).not.toContainText('Private revoked title');
        expect(await page.evaluate(id => tagState.selectDownload(id), id)).toBeNull();
        const denied = await page.request.get(`/api/mutations/${attempt.client_mutation_id}`);
        expect(denied.status()).toBe(404);
        expect(await denied.json()).not.toHaveProperty('visibility');
        const replay = await page.request.post(`/api/visibility/${id}`, { data: attempt });
        expect(replay.status()).toBe(404);
        expect(await replay.json()).not.toHaveProperty('visibility');
    } finally {
        expect((await request.patch(`/api/users/${admin.id}`, { data: { role: 'admin' } })).ok()).toBe(true);
    }
});

test('account switching discards private visibility intent and late callbacks', async ({ page }) => {
    const id = 'visibility-account';
    await ready(page, [{ id, visibility: 'private' }]);
    await createReader(page, 'visibility-next-account');
    const row = card(page, id);
    await openInfo(row);
    const held = await gate(page, id);
    try {
        await select(row).selectOption('public');
        await expect.poll(() => held.requests.length).toBe(1);
        await switchAccount(page, 'visibility-next-account', 'reader-password');
        held.release();
        await expect(row).toHaveCount(0);
        await expect(summary(page)).toBeHidden();
        expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
        expect(await page.evaluate(id => tagState.selectDownload(id), id)).toBeNull();
        expect((await page.request.get(`/api/file/${id}`)).status()).toBe(404);
    } finally { held.release(); }
});

test('two users retain playback access until privacy commits and reconcile authorized storage afterward', async ({ page, browser }) => {
    const id = 'visibility-two-users';
    await ready(page, [{ id, title: 'Shared visibility video' }]);
    await createReader(page, 'visibility-viewer');
    const viewerContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    const viewer = await viewerContext.newPage();
    const held = await gate(page, id);
    try {
        expect((await viewer.request.post('/login', { form: { username: 'visibility-viewer', password: 'reader-password' } })).status()).toBe(200);
        await viewer.route('**/api/events', route => route.abort());
        await viewer.goto('/');
        const viewerRow = card(viewer, id);
        await expect(viewerRow).toBeVisible();
        await expect(viewerRow).not.toHaveClass(/item-fade-in/);
        await openInfo(viewerRow);
        await expect(select(viewerRow)).toBeDisabled();
        expect((await viewer.request.get(`/api/file/${id}`)).status()).toBe(200);
        const row = card(page, id);
        await openInfo(row);
        await select(row).selectOption('private');
        await expect(feedback(row)).toContainText('Changing to private');
        expect((await viewer.request.get(`/api/file/${id}`)).status()).toBe(200);
        held.release();
        await expect(select(row)).toHaveValue('private');
        await expect(select(row)).toBeEnabled();
        expect((await viewer.request.get(`/api/file/${id}`)).status()).toBe(404);
        expect((await viewer.request.get(`/api/downloads/${id}/editable-state`)).status()).toBe(404);
        await refresh(viewer);
        await expect(viewerRow).toHaveCount(0);
        const library = await (await viewer.request.get('/api/library')).json();
        expect(library.some(item => item.id === id)).toBe(false);
        const storage = await (await viewer.request.get('/api/library-storage')).json();
        expect(storage.total_bytes === null || storage.total_bytes === 0).toBe(true);
        const publishing = await gate(page, id);
        try {
            await select(row).selectOption('public');
            await expect(feedback(row)).toContainText('Changing to public');
            await expect(select(row)).toHaveValue('private');
            expect((await viewer.request.get(`/api/file/${id}`)).status()).toBe(404);
            publishing.release();
            await expect(select(row)).toHaveValue('public');
            await expect(select(row)).toBeEnabled();
            expect((await viewer.request.get(`/api/file/${id}`)).status()).toBe(200);
            await refresh(viewer);
            await expect(viewerRow).toBeVisible();
        } finally { publishing.release(); }
    } finally { held.release(); await viewerContext.close(); }
});

for (const theme of ['light', 'dark']) {
    test(`keyboard visibility feedback remains readable in ${theme} theme with reduced motion`, async ({ page }) => {
        const id = `visibility-keyboard-${theme}`;
        await ready(page, [{ id }]);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.evaluate(theme => applyTheme(theme), theme);
        const row = card(page, id);
        await openInfo(row);
        const held = await gate(page, id);
        try {
            await select(row).focus();
            await page.keyboard.press('End');
            await page.keyboard.press('Enter');
            await expect(feedback(row)).toContainText('Changing to private');
            await expect(select(row)).toHaveValue('public');
            await expect(page.locator('#tagMutationStatus')).toContainText('Changing visibility');
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
            held.release();
            await expect(select(row)).toHaveValue('private');
            await expect(select(row)).toBeEnabled();
        } finally { held.release(); }
    });
}

test('unsupported servers retain conservative pending feedback without revision or receipt claims', async ({ page }) => {
    await page.route('**/api/client-capabilities', async route => {
        const response = await route.fetch();
        const body = await response.json();
        body.actions = body.actions.filter(action => action !== 'visibility.set');
        await route.fulfill({ response, json: body });
    });
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    await expect.poll(() => page.evaluate(() => hasVisibilityProtocol())).toBe(false);
    const id = 'visibility-legacy';
    await seed(page, { id, status: 'finished' });
    await refresh(page);
    const row = card(page, id);
    await expect(row).not.toHaveClass(/item-fade-in/);
    await openInfo(row);
    const held = await gate(page, id);
    try {
        await select(row).selectOption('private');
        await expect(feedback(row)).toContainText('Changing to private');
        await expect(select(row)).toHaveValue('public');
        await expect.poll(() => held.requests.length).toBe(1);
        expect(held.requests[0]).toEqual({ visibility: 'private' });
        held.release();
        await expect(select(row)).toHaveValue('private');
        await expect(select(row)).toBeEnabled();
        await expect(recovery(row, 'replay')).toHaveCount(0);
    } finally { held.release(); }
});

test('visibility diagnostics contain bounded aggregates without entry identities or values', async ({ page }) => {
    const id = 'visibility-metrics-private';
    await ready(page, [{ id }]);
    const row = card(page, id);
    await openInfo(row);
    await select(row).selectOption('private');
    await expect(select(row)).toHaveValue('private');
    await expect(select(row)).toBeEnabled();
    const metrics = await page.evaluate(() => VDL.visibilityMutationMetrics());
    expect(metrics.submissions).toBe(1);
    expect(metrics.acknowledgements).toBe(1);
    expect(metrics.pending).toBe(0);
    expect(JSON.stringify(metrics)).not.toContain(id);
    expect(await page.evaluate(() => Object.isFrozen(VDL.visibilityMutationMetrics()))).toBe(true);
});

test('a true legacy server confirms bare acknowledgements and fences older unversioned reads', async ({ page }) => {
    const id = 'visibility-true-legacy';
    await page.route('**/api/client-capabilities', async route => {
        const response = await route.fetch();
        const body = await response.json();
        body.actions = body.actions.filter(action => action !== 'visibility.set');
        await route.fulfill({ response, json: body });
    });
    let holdRead = false;
    let releaseRead;
    await page.route(/\/api\/(?:library(?:\?.*)?|current-downloads|downloads\/[^/]+\/editable-state)$/, async route => {
        const response = await route.fetch();
        const body = await response.json();
        const strip = value => {
            if (!value || typeof value !== 'object') return;
            delete value.visibility_revision;
            delete value.permissions;
            for (const child of Object.values(value)) strip(child);
        };
        strip(body);
        if (holdRead && new URL(route.request().url()).pathname === '/api/library') {
            holdRead = false;
            await new Promise(resolve => { releaseRead = resolve; });
        }
        await route.fulfill({ response, json: body }).catch(() => {});
    });
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    await expect.poll(() => page.evaluate(() => hasVisibilityProtocol())).toBe(false);
    await seed(page, { id, status: 'finished' });
    await refresh(page);
    const row = card(page, id);
    await expect(row).not.toHaveClass(/item-fade-in/);
    await openInfo(row);
    expect(await page.evaluate(id => tagState.selectDownload(id).visibility_revision, id)).toBeUndefined();
    holdRead = true;
    const oldRead = page.evaluate(() => fetchHistory());
    let releaseWrite;
    const attempts = [];
    await page.route(`**/api/visibility/${id}`, async route => {
        attempts.push(route.request().postDataJSON());
        await new Promise(resolve => { releaseWrite = resolve; });
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ response, json: { id: body.id, visibility: body.visibility, changed: body.changed } }).catch(() => {});
    });
    try {
        await expect.poll(() => Boolean(releaseRead)).toBe(true);
        await select(row).selectOption('private');
        await expect(feedback(row)).toContainText('Changing to private');
        await expect(select(row)).toHaveValue('public');
        await expect(select(row)).toBeDisabled();
        await expect.poll(() => Boolean(releaseWrite)).toBe(true);
        expect(attempts).toEqual([{ visibility: 'private' }]);
        releaseWrite();
        await expect(select(row)).toHaveValue('private');
        await expect(select(row)).toBeEnabled();
        releaseRead();
        await oldRead;
        await expect(select(row)).toHaveValue('private');
        await expect(row.locator('.history-visibility-help')).toHaveText('Visible only to you and administrators');
        await expect(recovery(row, 'replay')).toHaveCount(0);
        expect(await page.evaluate(id => tagState.selectDownload(id).visibility_revision, id)).toBeUndefined();
    } finally { releaseWrite?.(); releaseRead?.(); }
});

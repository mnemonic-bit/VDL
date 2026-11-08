const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, switchAccount } = require('./support.cjs');

const card = (page, id) => page.locator(`[data-row-id="${id}"]`);
const feedback = row => row.locator('.rename-feedback').first();
const input = row => row.locator('.rename-input');
const recovery = (row, action) => row.locator(`[data-rename-recovery="${action}"]`).first();
const ids = page => page.locator('#historyList [data-row-id]').evaluateAll(rows => rows.map(row => row.dataset.rowId));

async function ready(page, rows) {
    // The canonical HTTP response must suffice with the event channel unavailable.
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    for (const row of rows) await seed(page, { status: 'finished', ...row });
    await refresh(page);
    await expect.poll(() => page.evaluate(() => hasRenameProtocol())).toBe(true);
    for (const row of rows) await expect(card(page, row.id)).not.toHaveClass(/item-fade-in/);
}

async function openInfo(row) {
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Info', exact: true }).click();
    await expect(row.locator('.history-info-popover')).toBeVisible();
}

async function edit(row, name) {
    if (!(await input(row).count())) await row.getByRole('button', { name: 'Edit name', exact: true }).click();
    await input(row).fill(name);
}

function gateRename(page, id, { afterCommit = false } = {}) {
    const requests = [];
    const releases = [];
    const installed = page.route(`**/api/rename/${id}`, async route => {
        requests.push(route.request().postDataJSON());
        const response = afterCommit ? await route.fetch() : null;
        await new Promise(resolve => releases.push(resolve));
        if (response) await route.fulfill({ response });
        else await route.continue();
    });
    return { requests, releases, installed };
}

async function releaseNext(gate) {
    await expect.poll(() => gate.releases.length).toBeGreaterThan(0);
    gate.releases.shift()();
}

async function snapshot(page, id) {
    return page.evaluate(id => tagState.selectDownload(id), id);
}

async function confirmed(row, name) {
    await expect(row.locator('.rename-feedback:not([data-rename-state="confirmed"])')).toHaveCount(0);
    await expect(row.locator('.rename-display')).toHaveText(name);
}

test.beforeEach(async ({ page }) => reset(page));
test.setTimeout(25_000);

test('rename editor opens and cancels locally with keyboard focus and no collection reads', async ({ page }) => {
    await ready(page, [{ id: 'rename-local' }]);
    const row = card(page, 'rename-local');
    await openInfo(row);
    let reads = 0;
    page.on('request', request => {
        if (/\/api\/(library|history|current-downloads)(\?|$)/.test(request.url())) reads++;
    });
    await row.getByRole('button', { name: 'Edit name', exact: true }).focus();
    await row.getByRole('button', { name: 'Edit name', exact: true }).press('Enter');
    await expect(input(row)).toBeFocused();
    await input(row).fill('Discard this draft');
    await input(row).press('Escape');
    await expect(row.locator('.rename-display')).toHaveText('rename-local.mp4');
    await expect(row.locator('.history-info-popover')).toBeVisible();
    expect(reads).toBe(0);
});

test('mouse Cancel and Save keep Info open across local editor replacement', async ({ page }) => {
    await ready(page, [{ id: 'rename-mouse-lifecycle' }]);
    const row = card(page, 'rename-mouse-lifecycle');
    await openInfo(row);
    await edit(row, 'Discarded mouse draft');
    await row.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(row.locator('.history-info-popover')).toBeVisible();
    await expect(row.locator('.rename-display')).toHaveText('rename-mouse-lifecycle.mp4');
    await row.getByRole('button', { name: 'Edit name', exact: true }).click();
    await input(row).fill('Mouse saved.webm');
    const gate = gateRename(page, 'rename-mouse-lifecycle');
    await gate.installed;
    await row.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row.locator('.history-info-popover')).toBeVisible();
    await expect(feedback(row)).toContainText('Renaming');
    await expect.poll(() => gate.requests.length).toBe(1);
    await releaseNext(gate);
    await confirmed(row, 'Mouse saved.mp4');
    await expect(row.locator('.history-info-popover')).toBeVisible();
});

test('rename projects within 50 ms while the request waits and confirms canonical identity without a GET', async ({ page }, testInfo) => {
    await ready(page, [{ id: 'rename-immediate' }, { id: 'rename-neighbor' }]);
    const row = card(page, 'rename-immediate');
    await openInfo(row);
    await edit(row, 'Requested.webm');
    const before = await snapshot(page, 'rename-immediate');
    const order = await ids(page);
    await input(row).evaluate(element => {
        window.originalRenameCard = element.closest('[data-row-id]');
        window.originalRenameInput = element;
        element.addEventListener('keydown', event => {
            if (event.key === 'Enter') window.renameFeedbackStarted = performance.now();
        }, true);
        window.addEventListener('keydown', event => {
            if (event.key === 'Enter' && document.querySelector('.rename-feedback[data-rename-state="sending"]')) {
                window.renameFeedbackMs = performance.now() - window.renameFeedbackStarted;
            }
        });
    });
    const gate = gateRename(page, 'rename-immediate');
    await gate.installed;
    let reads = 0;
    page.on('request', request => {
        if (/\/api\/(library|history|current-downloads)(\?|$)/.test(request.url())) reads++;
    });
    await input(row).press('Enter');
    await expect(feedback(row)).toContainText('Renaming');
    await expect(feedback(row)).toContainText('Requested');
    await expect(input(row)).toBeEnabled();
    await expect(input(row)).toBeFocused();
    await expect.poll(() => gate.requests.length).toBe(1);
    expect(gate.requests[0].expected_revision).toMatch(/^\d+$/);
    const pending = await snapshot(page, 'rename-immediate');
    expect(pending.filename).toBe(before.filename);
    expect(pending.requested_filename).toContain('Requested');
    expect(await ids(page)).toEqual(order);
    const elapsed = await page.evaluate(() => window.renameFeedbackMs);
    expect(elapsed).toBeLessThan(50);
    await testInfo.attach('rename-local-feedback-latency', {
        body: JSON.stringify({ local_feedback_ms: elapsed }), contentType: 'application/json',
    });
    await releaseNext(gate);
    await confirmed(row, 'Requested.mp4');
    const after = await snapshot(page, 'rename-immediate');
    expect(after.filename).toMatch(/Requested\.mp4$/);
    expect(BigInt(after.rename_revision)).toBe(BigInt(before.rename_revision) + 1n);
    expect(reads).toBe(0);
    expect(await ids(page)).toEqual(order);
    expect(await row.evaluate(element => element === window.originalRenameCard)).toBe(true);
    expect((await page.request.get('/api/file/rename-immediate')).ok()).toBeTruthy();
    const metrics = await page.evaluate(() => VDL.renameMutationMetrics());
    expect(metrics.submissions).toBe(1);
    expect(metrics.acknowledgements).toBe(1);
    expect(metrics.pending).toBe(0);
    expect(JSON.stringify(metrics)).not.toContain('Requested');
    expect(JSON.stringify(metrics)).not.toContain('rename-immediate');
    expect(await page.evaluate(() => Object.isFrozen(VDL.renameMutationMetrics()))).toBe(true);
});

test('duplicate submission waits while a newer draft retains text, input identity, and focus', async ({ page }) => {
    await ready(page, [{ id: 'rename-newer-draft' }]);
    const row = card(page, 'rename-newer-draft');
    await openInfo(row);
    await edit(row, 'First request');
    const gate = gateRename(page, 'rename-newer-draft');
    await gate.installed;
    await input(row).press('Enter');
    await expect.poll(() => gate.requests.length).toBe(1);
    await input(row).press('Enter');
    await input(row).fill('Newer unsent draft');
    await input(row).press('Enter');
    await refresh(page);
    await expect(input(row)).toHaveValue('Newer unsent draft');
    await expect(input(row)).toBeFocused();
    expect(gate.requests).toHaveLength(1);
    await input(row).evaluate(element => { window.newerRenameInput = element; });
    await releaseNext(gate);
    await expect(row.locator('.rename-feedback:not([data-rename-state="confirmed"])')).toHaveCount(0);
    await expect(input(row)).toHaveValue('Newer unsent draft');
    await expect(input(row)).toBeFocused();
    expect(await input(row).evaluate(element => element === window.newerRenameInput)).toBe(true);
    expect(gate.requests).toHaveLength(1);
    await input(row).press('Escape');
    await expect(row.locator('.rename-display')).toHaveText('First request.mp4');
});

test('a filesystem collision preserves the requested text and leaves other metadata usable', async ({ page }) => {
    await ready(page, [{ id: 'rename-collision' }, { id: 'rename-taken', name: 'Taken.mp4' }]);
    const row = card(page, 'rename-collision');
    const before = await snapshot(page, 'rename-collision');
    await openInfo(row);
    await edit(row, 'Taken');
    await input(row).press('Enter');
    await expect(feedback(row)).toContainText(/already exists/i);
    await expect(feedback(row)).toContainText('Taken');
    expect((await snapshot(page, 'rename-collision')).filename).toBe(before.filename);
    await row.locator('.favorite-toggle-inline').click();
    await expect(row.locator('.favorite-toggle-inline')).toHaveAttribute('aria-pressed', 'true');
    await edit(row, 'Corrected');
    await input(row).press('Enter');
    await confirmed(row, 'Corrected.mp4');
    expect((await page.request.get('/api/file/rename-taken')).ok()).toBeTruthy();
});

test('a definite rejection retains submitted text without replacing a newer draft or taking focus', async ({ page }) => {
    await ready(page, [{ id: 'rename-rejected' }]);
    const row = card(page, 'rename-rejected');
    await openInfo(row);
    await edit(row, 'Rejected request');
    let release;
    await page.route('**/api/rename/rename-rejected', async route => {
        const payload = route.request().postDataJSON();
        await new Promise(resolve => { release = resolve; });
        const state = await snapshot(page, 'rename-rejected');
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({
            id: 'rename-rejected', filename: state.filename, display_filename: null,
            rename_revision: state.rename_revision, error: 'This name was declined',
            mutation: { id: payload.client_mutation_id, domain: 'rename', revision: state.rename_revision, outcome: 'rejected' },
        }) });
    });
    await input(row).press('Enter');
    await expect.poll(() => Boolean(release)).toBe(true);
    await input(row).fill('Newer typing');
    release();
    await expect(feedback(row)).toContainText(/declined/i);
    await expect(feedback(row)).toContainText('Rejected request');
    await expect(input(row)).toHaveValue('Newer typing');
    await expect(input(row)).toBeFocused();
    await recovery(row, 'edit').click();
    await expect(input(row)).toHaveValue('Newer typing');
    await expect(feedback(row)).toContainText('Rejected request');
});

test('old reads and an older rename acknowledgement cannot restore an earlier name or path', async ({ page }) => {
    await ready(page, [{ id: 'rename-stale' }]);
    const row = card(page, 'rename-stale');
    await openInfo(row);
    await edit(row, 'First canonical');
    let releaseRead;
    let held = false;
    await page.route('**/api/library?*', async route => {
        if (held) return route.continue();
        held = true;
        const response = await route.fetch();
        await new Promise(resolve => { releaseRead = resolve; });
        await route.fulfill({ response });
    });
    const oldRead = page.evaluate(() => fetchHistory());
    await expect.poll(() => Boolean(releaseRead)).toBe(true);
    const gate = gateRename(page, 'rename-stale', { afterCommit: true });
    await gate.installed;
    await input(row).press('Enter');
    await expect.poll(() => gate.releases.length).toBe(1);
    releaseRead();
    await oldRead;
    await expect(feedback(row)).toContainText('Renaming');
    expect((await snapshot(page, 'rename-stale')).requested_filename).toContain('First canonical');
    expect((await page.request.post('/api/rename/rename-stale', { data: { filename: 'Newer remote' } })).ok()).toBeTruthy();
    await refresh(page);
    await releaseNext(gate);
    await confirmed(row, 'Newer remote.mp4');
    expect((await snapshot(page, 'rename-stale')).filename).toMatch(/Newer remote\.mp4$/);
    expect((await page.request.get('/api/file/rename-stale')).ok()).toBeTruthy();
});

test('unknown rename survives close/reopen and deliberate replay uses the same frozen attempt', async ({ page }) => {
    await ready(page, [{ id: 'rename-unknown' }]);
    const row = card(page, 'rename-unknown');
    const requests = [];
    await page.route('**/api/rename/rename-unknown', async route => {
        requests.push(route.request().postDataJSON());
        if (requests.length === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        await route.continue();
    });
    await openInfo(row);
    await edit(row, 'Unknown rename');
    await input(row).press('Enter');
    await expect(feedback(row)).toContainText('Rename not confirmed');
    await row.getByRole('button', { name: 'Close info', exact: true }).click();
    await expect(page.locator('#renameMutationSummary')).toContainText(/not confirmed/i);
    await openInfo(row);
    await expect(feedback(row)).toContainText('Rename not confirmed');
    expect(requests).toHaveLength(1);
    await recovery(row, 'recover').click();
    await expect(row.locator('.rename-feedback:not([data-rename-state="confirmed"])')).toHaveCount(0);
    await expect(input(row)).toBeVisible();
    await input(row).press('Escape');
    await confirmed(row, 'Unknown rename.mp4');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    await expect(row.locator('.history-info-popover')).toBeVisible();
});

test('a committed rename with a lost response confirms through the receipt with one filesystem mutation', async ({ page }) => {
    await ready(page, [{ id: 'rename-lost-response' }]);
    const row = card(page, 'rename-lost-response');
    let writes = 0;
    await page.route('**/api/rename/rename-lost-response', async route => {
        writes++;
        await route.fetch();
        await route.abort('failed');
    });
    await openInfo(row);
    await edit(row, 'Receipt confirmed');
    await input(row).press('Enter');
    await confirmed(row, 'Receipt confirmed.mp4');
    expect(writes).toBe(1);
    expect((await snapshot(page, 'rename-lost-response')).filename).toMatch(/Receipt confirmed\.mp4$/);
    expect((await page.request.get('/api/file/rename-lost-response')).ok()).toBeTruthy();
});

test('a revision conflict offers deliberate retry and preserves unrelated edits', async ({ page }) => {
    await ready(page, [{ id: 'rename-conflict' }, { id: 'rename-conflict-other' }]);
    const row = card(page, 'rename-conflict');
    await openInfo(row);
    await edit(row, 'Local requested');
    const gate = gateRename(page, 'rename-conflict');
    await gate.installed;
    await input(row).press('Enter');
    await expect.poll(() => gate.requests.length).toBe(1);
    expect((await page.request.post('/api/rename/rename-conflict', { data: { filename: 'Remote requested' } })).ok()).toBeTruthy();
    await releaseNext(gate);
    await expect(feedback(row)).toContainText(/changed elsewhere/i);
    expect(gate.requests).toHaveLength(1);
    await row.locator('.favorite-toggle-inline').click();
    await expect(row.locator('.favorite-toggle-inline')).toHaveAttribute('aria-pressed', 'true');
    await recovery(row, 'retry').click();
    await expect.poll(() => gate.requests.length).toBe(2);
    expect(gate.requests[1].client_mutation_id).not.toBe(gate.requests[0].client_mutation_id);
    expect(gate.requests[1].expected_revision).not.toBe(gate.requests[0].expected_revision);
    await releaseNext(gate);
    await confirmed(row, 'Local requested.mp4');
});

for (const theme of ['light', 'dark']) {
    test(`rename keyboard feedback supports ${theme} theme and reduced motion`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await ready(page, [{ id: `rename-keyboard-${theme}` }]);
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        const row = card(page, `rename-keyboard-${theme}`);
        await openInfo(row);
        await edit(row, `Keyboard ${theme}`);
        const gate = gateRename(page, `rename-keyboard-${theme}`);
        await gate.installed;
        await input(row).press('Enter');
        await expect(feedback(row)).toContainText('Renaming');
        await expect(page.locator('#tagMutationStatus')).toContainText(/Renaming/i);
        await expect(input(row)).toBeFocused();
        const spinner = feedback(row).locator('.options-spinner');
        if (await spinner.count()) {
            await expect(spinner).toHaveAttribute('aria-hidden', 'true');
            await expect(spinner).toHaveCSS('animation-name', 'none');
        }
        await input(row).press('Escape');
        await expect(row.locator('.history-info-popover')).toBeVisible();
        await expect(feedback(row)).toContainText('Renaming');
        await releaseNext(gate);
        await confirmed(row, `Keyboard ${theme}.mp4`);
    });
}

test('a delayed response gives explanatory feedback after five seconds without repeating the mutation', async ({ page }) => {
    await page.clock.install();
    await ready(page, [{ id: 'rename-slow' }]);
    const row = card(page, 'rename-slow');
    await openInfo(row);
    await edit(row, 'Slow request');
    const gate = gateRename(page, 'rename-slow');
    await gate.installed;
    await input(row).press('Enter');
    await expect.poll(() => gate.requests.length).toBe(1);
    await page.clock.fastForward(5_100);
    await expect(feedback(row)).toContainText(/waiting|taking|not confirmed/i);
    expect(gate.requests).toHaveLength(1);
    await releaseNext(gate);
    await confirmed(row, 'Slow request.mp4');
});

test('deletion and authentication reset fence late rename callbacks', async ({ page }) => {
    await ready(page, [{ id: 'rename-deleted' }, { id: 'rename-old-account' }]);
    const row = card(page, 'rename-deleted');
    await openInfo(row);
    await edit(row, 'Never revive');
    const gate = gateRename(page, 'rename-deleted', { afterCommit: true });
    await gate.installed;
    await input(row).press('Enter');
    await expect.poll(() => gate.releases.length).toBe(1);
    expect((await page.request.post('/api/remove/rename-deleted')).ok()).toBeTruthy();
    await page.evaluate(() => checkTagAvailability('rename-deleted'));
    await expect(row).toHaveCount(0);
    await releaseNext(gate);
    await expect(row).toHaveCount(0);
    expect(await snapshot(page, 'rename-deleted')).toBeNull();
    const other = card(page, 'rename-old-account');
    await openInfo(other);
    await edit(other, 'Old account name');
    const otherGate = gateRename(page, 'rename-old-account');
    await otherGate.installed;
    await input(other).press('Enter');
    await expect.poll(() => otherGate.requests.length).toBe(1);
    await page.evaluate(() => resetTagSession());
    await releaseNext(otherGate);
    await expect.poll(() => page.evaluate(() => tagMutations.hasPending())).toBe(false);
    expect(await snapshot(page, 'rename-old-account')).toBeNull();
});

test('switching accounts clears private rename drafts and ignores their old acknowledgements', async ({ page }) => {
    await ready(page, [{ id: 'rename-private-account', visibility: 'private' }]);
    expect((await page.request.post('/api/users', { data: {
        username: 'rename-next-account', name: 'Next Rename Account', password: 'next-password', role: 'normal',
    } })).ok()).toBeTruthy();
    const row = card(page, 'rename-private-account');
    await openInfo(row);
    await edit(row, 'Private old draft');
    let release;
    await page.route('**/api/rename/rename-private-account', async route => {
        const response = await route.fetch();
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ response }).catch(() => {});
    });
    await input(row).press('Enter');
    await expect.poll(() => Boolean(release)).toBe(true);
    await switchAccount(page, 'rename-next-account', 'next-password');
    release();
    await expect(page.locator('#currentUsername')).toHaveText('rename-next-account');
    await expect(row).toHaveCount(0);
    expect(await snapshot(page, 'rename-private-account')).toBeNull();
    expect(await page.evaluate(() => renameDrafts.size)).toBe(0);
    await expect(page.locator('#renameMutationSummary')).toBeEmpty();
});

test('receipt recovery after access loss cannot disclose or restore the renamed entry', async ({ page, request }) => {
    await ready(page, [{ id: 'rename-revoked' }]);
    expect((await page.request.post('/api/users', { data: {
        username: 'rename-reader', name: 'Rename Reader', password: 'reader-password', role: 'normal',
    } })).ok()).toBeTruthy();
    await request.post('/login', { form: { username: 'admin', password: 'browser-test-password' } });
    await switchAccount(page, 'rename-reader', 'reader-password');
    await expect.poll(() => page.evaluate(() => hasRenameProtocol())).toBe(true);
    const row = card(page, 'rename-revoked');
    await expect(row).not.toHaveClass(/item-fade-in/);
    await openInfo(row);
    await edit(row, 'Revoked name');
    let mutationId;
    await page.route('**/api/rename/rename-revoked', async route => {
        mutationId = route.request().postDataJSON().client_mutation_id;
        await route.fetch();
        await route.abort('failed');
    });
    const releases = [];
    await page.route('**/api/mutations/*', async route => {
        await new Promise(resolve => releases.push(resolve));
        await route.continue();
    });
    await input(row).press('Enter');
    await expect.poll(() => releases.length).toBe(1);
    expect((await request.post('/api/visibility/rename-revoked', { data: { visibility: 'private' } })).ok()).toBeTruthy();
    releases.shift()();
    // A missing receipt is indistinguishable from lost access. The targeted
    // check then establishes the availability fence without exposing content.
    await expect(feedback(row)).toContainText(/not confirmed/i);
    await recovery(row, 'check').click();
    await expect.poll(() => releases.length).toBe(1);
    releases.shift()();
    await expect(row).toHaveCount(0);
    expect(await snapshot(page, 'rename-revoked')).toBeNull();
    const denied = await page.request.get(`/api/mutations/${mutationId}`);
    expect(denied.status()).toBe(404);
    expect(await denied.json()).not.toHaveProperty('filename');
});

test('invalid basenames retain their text and never dispatch a mutation', async ({ page }) => {
    await ready(page, [{ id: 'rename-validation' }]);
    const row = card(page, 'rename-validation');
    await openInfo(row);
    let writes = 0;
    page.on('request', request => {
        if (new URL(request.url()).pathname === '/api/rename/rename-validation') writes++;
    });
    for (const name of ['../escape', 'a\\b', '.', '..']) {
        await edit(row, name);
        await input(row).press('Enter');
        await expect(input(row)).toHaveValue(name);
        await expect(input(row)).toBeFocused();
        await expect(feedback(row)).toContainText(/filename|name|basename|separator/i);
    }
    expect(writes).toBe(0);
    await edit(row, 'Safe correction');
    await input(row).press('Enter');
    await confirmed(row, 'Safe correction.mp4');
});

test('canonical rename acknowledgement preserves active playback, its source, and fullscreen', async ({ page }) => {
    await ready(page, [{ id: 'rename-playback' }]);
    await page.route('**/api/file/**', () => {});
    await page.evaluate(() => {
        Object.defineProperty(document, 'fullscreenElement', {
            configurable: true, get: () => window.renameFullscreenElement || null,
        });
        Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
        Element.prototype.requestFullscreen = function () {
            window.renameFullscreenRequests = (window.renameFullscreenRequests || 0) + 1;
            window.renameFullscreenElement = this;
            document.dispatchEvent(new Event('fullscreenchange'));
            return Promise.resolve();
        };
        HTMLMediaElement.prototype.load = function () {};
        HTMLMediaElement.prototype.pause = function () {};
        HTMLMediaElement.prototype.play = function () {
            queueMicrotask(() => this.dispatchEvent(new Event('playing')));
            return Promise.resolve();
        };
    });
    const row = card(page, 'rename-playback');
    await openInfo(row);
    await edit(row, 'Playing renamed.webm');
    const gate = gateRename(page, 'rename-playback');
    await gate.installed;
    await input(row).press('Enter');
    await expect.poll(() => gate.requests.length).toBe(1);
    await row.getByRole('button', { name: 'Close info', exact: true }).click();
    await row.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    await expect(page.locator('#playerTitle')).toContainText('Playing renamed.webm');
    await expect(page.locator('#playerTitle')).toContainText('Renaming');
    await page.locator('#playerFullscreen').click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('playerContainer');
    const source = await page.locator('#playerVideo source').getAttribute('src');
    await page.locator('#playerVideo').evaluate(element => { window.renamePlayingVideo = element; });
    await releaseNext(gate);
    await expect.poll(async () => (await snapshot(page, 'rename-playback')).filename).toMatch(/Playing renamed\.mp4$/);
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    expect(await page.locator('#playerVideo').evaluate(element => element === window.renamePlayingVideo)).toBe(true);
    expect(await page.locator('#playerVideo source').getAttribute('src')).toBe(source);
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe('playerContainer');
    expect(await page.evaluate(() => window.renameFullscreenRequests)).toBe(1);
    await expect(page.locator('#playerTitle')).toHaveText('Playing renamed.mp4');
    await expect(row.locator('.history-info-popover')).toBeHidden();
});

test('an older server gets pending rename presentation without advertising receipt replay', async ({ page }) => {
    await page.route('**/api/events', route => route.abort());
    await page.route('**/api/client-capabilities', async route => {
        const response = await route.fetch();
        const capabilities = await response.json();
        capabilities.actions = capabilities.actions.filter(action => action !== 'rename.set');
        await route.fulfill({ response, json: capabilities });
    });
    await page.reload();
    await seed(page, { id: 'rename-compatibility', status: 'finished' });
    await refresh(page);
    await expect.poll(() => page.evaluate(() => hasRenameProtocol())).toBe(false);
    const row = card(page, 'rename-compatibility');
    await expect(row).not.toHaveClass(/item-fade-in/);
    await openInfo(row);
    await edit(row, 'Legacy accepted');
    const before = await snapshot(page, 'rename-compatibility');
    const gate = gateRename(page, 'rename-compatibility');
    await gate.installed;
    await input(row).press('Enter');
    await expect(feedback(row)).toContainText('Renaming');
    await expect.poll(() => gate.requests.length).toBe(1);
    expect(gate.requests[0]).toEqual({ filename: 'Legacy accepted' });
    expect((await snapshot(page, 'rename-compatibility')).filename).toBe(before.filename);
    await expect(recovery(row, 'recover')).toHaveCount(0);
    await releaseNext(gate);
    await confirmed(row, 'Legacy accepted.mp4');
    await page.unroute('**/api/rename/rename-compatibility');
    let writes = 0;
    let receiptReads = 0;
    await page.route('**/api/rename/rename-compatibility', async route => {
        writes++;
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    });
    page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/mutations/')) receiptReads++;
    });
    await edit(row, 'Legacy unknown');
    await input(row).press('Enter');
    await expect(feedback(row)).toContainText(/not confirmed/i);
    await expect(recovery(row, 'recover')).toHaveCount(0);
    const checked = page.waitForResponse(response => response.url().includes('/api/downloads/rename-compatibility/editable-state'));
    await recovery(row, 'check').click();
    await checked;
    await expect(feedback(row)).toContainText(/not confirmed/i);
    await input(row).press('Enter');
    expect(writes).toBe(1);
    expect(receiptReads).toBe(0);
});

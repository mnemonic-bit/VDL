const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, switchAccount, holdNativeMedia } = require('./support.cjs');

const chooser = page => page.locator('#playlistChooserDialog');
const shelfCard = (page, id) => page.locator(`[data-playlist-id="${id}"]`);
const actions = page => page.locator('#playlistActionSummary');
const routes = /\/api\/playlists\/[^/?]+(?:\/items)?(?:\?.*)?$/;

async function ready(page) {
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    await expect.poll(() => page.evaluate(() => hasPlaylistProtocol('playlist.add') && hasPlaylistProtocol('playlist.delete'))).toBe(true);
    for (const [id, title] of [['actions-one', 'First video'], ['actions-two', 'Second video'], ['actions-three', 'Third video']]) {
        await seed(page, { id, title, status: 'finished', duration_seconds: 100 });
    }
    await refresh(page);
}
async function create(page, name = 'Action playlist', ids = ['actions-one']) {
    const response = await page.request.post('/api/playlists', { data: { name, download_ids: ids } });
    expect(response.status()).toBe(201);
    const playlist = await response.json();
    await page.evaluate(() => fetchPlaylists());
    return playlist;
}
async function settleCard(card) {
    await card.evaluate(async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
}
async function openAdd(page, id = 'actions-two') {
    const card = page.locator(`[data-row-id="${id}"]`);
    await settleCard(card);
    await card.locator('.kebab-btn').click();
    await card.getByRole('button', { name: 'Add to playlist…', exact: true }).click();
    await expect(chooser(page)).toBeVisible();
}
function choice(page, name = 'Action playlist') {
    return chooser(page).getByRole('button', { name: new RegExp(name) });
}
async function closeChooser(page) {
    await chooser(page).getByRole('button', { name: 'Close playlist chooser' }).click();
    await expect(chooser(page)).toBeHidden();
}
async function deleteFromCard(page, playlist, accept = true) {
    const card = shelfCard(page, playlist.id);
    await settleCard(card);
    await card.locator('.kebab-btn').click();
    await card.getByRole('button', { name: 'Delete playlist', exact: true }).click();
    await expect(page.locator('#playlistDeleteDialog')).toBeVisible();
    if (accept) await page.locator('#playlistDeleteConfirm').click();
    else await page.locator('#playlistDeleteClose').click();
}
function gate(page, { committed = false, operation = 'add' } = {}) {
    const requests = [], releases = [];
    const installed = page.route(routes, async route => {
        const request = route.request();
        const matched = operation === 'add' ? request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/items') : request.method() === 'DELETE';
        if (!matched) return route.continue();
        requests.push({ method: request.method(), url: request.url(), body: request.postData() ? request.postDataJSON() : null });
        const response = committed ? await route.fetch() : null;
        await new Promise(resolve => releases.push(resolve));
        if (response) await route.fulfill({ response }).catch(() => {});
        else await route.continue();
    });
    return { requests, releases, installed };
}
async function release(held) {
    await expect.poll(() => held.releases.length).toBeGreaterThan(0);
    held.releases.shift()();
}
async function openRecovery(page) {
    if (!(await page.locator('#playlistDeleteDialog').isVisible())) {
        await actions(page).getByRole('button', { name: 'Review request' }).click();
    }
    await expect(page.locator('#playlistDeleteDialog')).toBeVisible();
}
async function detail(page, id) {
    const response = await page.request.get(`/api/playlists/${id}`);
    return response.status() === 200 ? response.json() : null;
}
function unknownReceipts(page) {
    return page.route('**/api/mutations/**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Mutation unavailable","final":false}' }));
}

// Hold production requests or their committed responses. No delay substitutes
// for observing the actual pending, canonical, or recovery state.
test.beforeEach(async ({ page }) => reset(page));
test.setTimeout(30_000);

test('quick-add renders within 50ms, rejects duplicates, and confirms without SSE or collection GETs', async ({ page }) => {
    await ready(page);
    const playlist = await create(page);
    await openAdd(page);
    const held = gate(page); await held.installed;
    let reads = 0;
    page.on('request', request => {
        if (request.method() === 'GET' && /\/api\/(playlists|library|history|current-downloads)(?:\?|$)/.test(request.url())) reads++;
    });
    await choice(page).evaluate(button => {
        button.addEventListener('click', () => { window.actionStarted = performance.now(); }, true);
        window.addEventListener('click', () => {
            window.actionFeedbackMs = performance.now() - window.actionStarted;
            window.actionFeedbackText = document.getElementById('playlistChooserDialog').textContent;
        }, { once: true });
    });
    await choice(page).click();
    await expect(chooser(page)).toContainText('Adding to playlist');
    expect(await page.evaluate(() => window.actionFeedbackMs)).toBeLessThan(50);
    expect(await page.evaluate(() => window.actionFeedbackText)).toContain('Adding to playlist');
    await expect(choice(page)).toBeDisabled();
    await expect(shelfCard(page, playlist.id)).toContainText('1 video');
    await page.evaluate(id => { quickAddToPlaylist(id); quickAddToPlaylist(id); }, playlist.id);
    await expect.poll(() => held.requests.length).toBe(1);
    expect(typeof held.requests[0].body.expected_revision).toBe('number');
    expect(held.requests[0].body.download_id).toBe('actions-two');
    await release(held);
    await expect(shelfCard(page, playlist.id)).toContainText('2 videos');
    expect(reads).toBe(0);
    expect((await detail(page, playlist.id)).member_ids).toEqual(['actions-one', 'actions-two']);
    const metrics = await page.evaluate(() => VDL.playlistMutationMetrics());
    expect(metrics.acknowledgements).toBe(1);
    expect(metrics.latestLocalFeedbackMs).toBeLessThan(50);
    expect(JSON.stringify(metrics)).not.toContain('actions-two');
});

test('pending add survives close/reopen and leaves unrelated playlists and newer editor drafts usable', async ({ page }) => {
    await ready(page);
    const playlist = await create(page);
    const other = await create(page, 'Unrelated playlist');
    await openAdd(page);
    const held = gate(page); await held.installed;
    await choice(page).click();
    await expect(choice(page)).toBeDisabled();
    await expect(choice(page, 'Unrelated playlist')).toBeEnabled();
    await closeChooser(page);
    await expect(actions(page)).toContainText('Adding to playlist');
    await openAdd(page, 'actions-three');
    await expect(page.locator('#playlistChooserEntry')).toContainText('Third video');
    await expect(choice(page)).toBeDisabled();
    await expect(choice(page)).toContainText('Second video');
    await expect(chooser(page)).toContainText('Adding to playlist');
    await closeChooser(page);
    await shelfCard(page, other.id).locator('.kebab-btn').click();
    await shelfCard(page, other.id).getByRole('button', { name: 'Edit playlist', exact: true }).click();
    await page.locator('#playlistName').fill('Newer unrelated private draft');
    await page.locator('#playlistName').focus();
    await release(held);
    await expect(shelfCard(page, playlist.id)).toContainText('2 videos');
    await expect(page.locator('#playlistEditorDialog')).toBeVisible();
    await expect(page.locator('#playlistName')).toHaveValue('Newer unrelated private draft');
    await expect(page.locator('#playlistName')).toBeFocused();
});

test('delete cancellation sends no command and retains playlist and media', async ({ page }) => {
    await ready(page); const playlist = await create(page);
    let writes = 0;
    page.on('request', request => { if (request.method() === 'DELETE' && request.url().includes(`/api/playlists/${playlist.id}`)) writes++; });
    await deleteFromCard(page, playlist, false);
    await expect(shelfCard(page, playlist.id)).toBeVisible();
    expect(writes).toBe(0);
    expect(await detail(page, playlist.id)).not.toBeNull();
    await expect(page.locator('[data-row-id="actions-one"]')).toBeVisible();
});

test('delete retains shelf identity and position pending and removes exactly once from its acknowledgement', async ({ page }) => {
    await ready(page); const playlist = await create(page); await create(page, 'Other playlist');
    const card = shelfCard(page, playlist.id);
    const before = await page.locator('.playlist-card').evaluateAll(cards => cards.map(card => card.dataset.playlistId));
    await card.evaluate(card => { window.pendingDeleteCard = card; });
    const held = gate(page, { operation: 'delete' }); await held.installed;
    let reads = 0;
    page.on('request', request => { if (request.method() === 'GET' && /\/api\/(playlists|library|history|current-downloads)(?:\?|$)/.test(request.url())) reads++; });
    await card.locator('.kebab-btn').click();
    await card.getByRole('button', { name: 'Delete playlist', exact: true }).click();
    await page.locator('#playlistDeleteConfirm').evaluate(button => {
        button.addEventListener('click', () => { window.actionStarted = performance.now(); }, true);
        window.addEventListener('click', () => {
            window.deleteFeedbackMs = performance.now() - window.actionStarted;
            window.deleteFeedbackText = document.getElementById('playlistDeleteStatus').textContent;
        }, { once: true });
    });
    await page.locator('#playlistDeleteConfirm').click();
    await expect(card).toContainText('Deleting playlist');
    expect(await page.evaluate(() => window.deleteFeedbackMs)).toBeLessThan(50);
    expect(await page.evaluate(() => window.deleteFeedbackText)).toContain('Deleting playlist');
    await expect(actions(page)).toContainText('Deleting playlist');
    expect(await card.evaluate(card => card === window.pendingDeleteCard)).toBe(true);
    expect(await page.locator('.playlist-card').evaluateAll(cards => cards.map(card => card.dataset.playlistId))).toEqual(before);
    await page.evaluate(id => { deletePlaylist(id); deletePlaylist(id); }, playlist.id);
    await expect.poll(() => held.requests.length).toBe(1);
    await release(held);
    await expect(card).toHaveCount(0);
    expect(reads).toBe(0);
    expect(await detail(page, playlist.id)).toBeNull();
    await expect(page.locator('[data-row-id="actions-one"]')).toBeVisible();
    expect((await page.request.get('/api/file/actions-one')).ok()).toBeTruthy();
});

for (const operation of ['add', 'delete']) {
    test(`lost ${operation} response uses actor receipt without issuing another command`, async ({ page }) => {
        await ready(page); const playlist = await create(page);
        let writes = 0;
        await page.route(routes, async route => {
            const request = route.request();
            if (operation === 'add' ? request.method() !== 'POST' : request.method() !== 'DELETE') return route.continue();
            writes++; await route.fetch(); await route.abort();
        });
        if (operation === 'add') { await openAdd(page); await choice(page).click(); }
        else await deleteFromCard(page, playlist);
        if (operation === 'add') await expect(shelfCard(page, playlist.id)).toContainText('2 videos');
        else await expect(shelfCard(page, playlist.id)).toHaveCount(0);
        expect(writes).toBe(1);
    });

    test(`unknown ${operation} retains recovery on close and deliberately replays the identical attempt`, async ({ page }) => {
        await ready(page); const playlist = await create(page);
        await unknownReceipts(page);
        const attempts = [];
        await page.route(routes, async route => {
            const request = route.request();
            if (operation === 'add' ? request.method() !== 'POST' : request.method() !== 'DELETE') return route.continue();
            attempts.push({ method: request.method(), url: request.url(), body: request.postData() ? request.postDataJSON() : null });
            if (attempts.length === 1) { await route.fetch(); return route.abort(); }
            return route.continue();
        });
        if (operation === 'add') { await openAdd(page); await choice(page).click(); await closeChooser(page); }
        else await deleteFromCard(page, playlist);
        await expect(actions(page)).toContainText(`${operation === 'add' ? 'Add' : 'Delete'} not confirmed`);
        await openRecovery(page);
        await page.locator('#playlistActionReplay').click();
        if (operation === 'add') await expect(shelfCard(page, playlist.id)).toContainText('2 videos');
        else await expect(shelfCard(page, playlist.id)).toHaveCount(0);
        expect(attempts).toHaveLength(2);
        expect(attempts[1]).toEqual(attempts[0]);
        if (operation === 'add') expect((await detail(page, playlist.id)).member_ids).toEqual(['actions-one', 'actions-two']);
    });

    for (const reply of [{ status: 500, body: { error: 'Temporary gateway failure' } }, { status: 200, body: { ok: true } }]) {
        test(`${operation} ${reply.status === 500 ? 'server error' : 'malformed success'} stays unknown and blocks contradictory local writes`, async ({ page }) => {
            await ready(page); const playlist = await create(page);
            await unknownReceipts(page);
            let writes = 0;
            await page.route(routes, route => {
                const request = route.request();
                if (operation === 'add' ? request.method() !== 'POST' : request.method() !== 'DELETE') return route.continue();
                writes++;
                return route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) });
            });
            if (operation === 'add') { await openAdd(page); await choice(page).click(); await closeChooser(page); }
            else await deleteFromCard(page, playlist);
            await expect(actions(page)).toContainText(`${operation === 'add' ? 'Add' : 'Delete'} not confirmed`);
            await page.evaluate(id => { playlistChooserDownloadId = 'actions-three'; quickAddToPlaylist(id); deletePlaylist(id); }, playlist.id);
            expect(writes).toBe(1);
            await expect(shelfCard(page, playlist.id)).toContainText('1 video');
            await openRecovery(page);
            await expect(page.locator('#playlistActionCheck')).toBeVisible();
        });
    }
}

test('add conflict retains canonical ordered membership and requires explicit current-state review', async ({ page }) => {
    await ready(page); const playlist = await create(page);
    await openAdd(page);
    const held = gate(page); await held.installed;
    await choice(page).click(); await expect.poll(() => held.requests.length).toBe(1);
    expect((await page.request.put(`/api/playlists/${playlist.id}`, { data: { name: 'Remote ordered playlist', download_ids: ['actions-three', 'actions-one'], expected_revision: playlist.revision } })).ok()).toBeTruthy();
    await release(held);
    await expect(actions(page)).toContainText(/changed|conflict/i);
    expect((await detail(page, playlist.id)).member_ids).toEqual(['actions-three', 'actions-one']);
    expect(held.requests).toHaveLength(1);
    await closeChooser(page);
    await openRecovery(page);
    await page.locator('#playlistActionReview').click();
    expect(held.requests).toHaveLength(1);
});

test('pending add blocks replacement transport while its editor draft remains editable', async ({ page }) => {
    await ready(page); const playlist = await create(page);
    await page.evaluate(id => openPlaylistEditor(id), playlist.id);
    await page.locator('#playlistName').fill('Editable retained draft');
    await page.evaluate(() => openPlaylistChooser('actions-two'));
    const held = gate(page); await held.installed;
    await choice(page).click(); await closeChooser(page);
    let replacements = 0;
    page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === `/api/playlists/${playlist.id}`) replacements++; });
    await page.evaluate(() => savePlaylistEditor({ preventDefault() {} }));
    expect(replacements).toBe(0);
    await expect(page.locator('#playlistName')).toHaveValue('Editable retained draft');
    await release(held);
    await expect(page.locator('#playlistName')).toHaveValue('Editable retained draft');
    await expect(page.locator('#playlistEditorDialog')).toBeVisible();
});

test('confirmed deletion fences an older shelf response and targeted member read', async ({ page }) => {
    await ready(page); const playlist = await create(page);
    const heldReads = [];
    await page.route('**/api/playlists', async route => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch(); await new Promise(resolve => heldReads.push(resolve)); await route.fulfill({ response });
    });
    await page.evaluate(() => { window.staleShelf = fetchPlaylists(); });
    await expect.poll(() => heldReads.length).toBe(1);
    let releaseMember;
    await page.route(`**/api/playlists/${playlist.id}`, async route => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch(); await new Promise(resolve => { releaseMember = resolve; }); await route.fulfill({ response });
    });
    await page.evaluate(id => { window.staleMember = openPlaylistEditor(id); }, playlist.id);
    await expect.poll(() => !!releaseMember).toBe(true);
    await deleteFromCard(page, playlist);
    await expect(shelfCard(page, playlist.id)).toHaveCount(0);
    heldReads.shift()(); releaseMember();
    await page.evaluate(() => Promise.all([window.staleShelf, window.staleMember]));
    await expect(shelfCard(page, playlist.id)).toHaveCount(0);
    await expect(page.locator('#playlistEditorDialog')).toBeHidden();
});

test('a matching shelf read and an absent receipt do not confirm the unknown add', async ({ page }) => {
    await ready(page); const playlist = await create(page);
    await unknownReceipts(page);
    await page.route(routes, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        await route.fetch(); await route.abort();
    });
    await openAdd(page); await choice(page).click(); await closeChooser(page);
    await expect(actions(page)).toContainText('Add not confirmed');
    await page.evaluate(() => fetchPlaylists());
    await expect(shelfCard(page, playlist.id)).toContainText('2 videos');
    await expect(actions(page)).toContainText('Add not confirmed');
});

for (const operation of ['add', 'delete']) {
    test(`${operation} auth reset discards private recovery and fences an older response`, async ({ page }) => {
        await ready(page); const playlist = await create(page);
        const held = gate(page, { operation, committed: true }); await held.installed;
        if (operation === 'add') { await openAdd(page); await choice(page).click(); }
        else await deleteFromCard(page, playlist);
        await expect.poll(() => held.releases.length).toBe(1);
        await page.evaluate(() => resetTagSession());
        await release(held);
        await expect(actions(page)).toBeHidden();
        await expect(chooser(page)).toBeHidden();
        await expect(page.locator('.playlist-card')).toHaveCount(0);
        expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
    });
}

test('real account switching prevents an older add callback from reviving a private playlist', async ({ page }) => {
    await ready(page); const playlist = await create(page);
    expect((await page.request.post('/api/users', { data: { username: 'actions-next', password: 'next-password', role: 'normal' } })).ok()).toBeTruthy();
    await openAdd(page);
    const held = gate(page, { committed: true }); await held.installed;
    await choice(page).click(); await expect.poll(() => held.releases.length).toBe(1);
    await closeChooser(page);
    await switchAccount(page, 'actions-next', 'next-password');
    await release(held);
    await expect(actions(page)).toBeHidden();
    await expect(page.locator('.playlist-card')).toHaveCount(0);
});

for (const theme of ['light', 'dark']) {
    test(`keyboard pending status remains readable in ${theme}, narrow layout, and reduced motion`, async ({ page }) => {
        await ready(page); await create(page);
        await page.setViewportSize({ width: 390, height: 700 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.evaluate(value => applyTheme(value), theme);
        await openAdd(page);
        const held = gate(page); await held.installed;
        await choice(page).focus(); await page.keyboard.press('Enter');
        await expect(chooser(page)).toContainText('Adding to playlist');
        await expect(chooser(page).locator('[role="status"]')).toContainText('Adding to playlist');
        const fits = await chooser(page).evaluate(dialog => { const box = dialog.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 1; });
        expect(fits).toBe(true);
        await release(held);
        await expect(page.locator('.playlist-card')).toContainText('2 videos');
    });
}

test('after five seconds a pending add explains that confirmation is still awaited', async ({ page }) => {
    await ready(page); await create(page); await openAdd(page); await page.clock.install();
    const held = gate(page); await held.installed;
    await choice(page).click();
    await page.clock.fastForward(5100);
    await expect(chooser(page)).toContainText('Still waiting');
    await release(held);
    await expect(page.locator('.playlist-card')).toContainText('2 videos');
});

for (const operation of ['add', 'delete']) {
    test(`${operation} current authorization loss fences the target and clears private recovery`, async ({ page }) => {
        await ready(page); const playlist = await create(page, 'Private action target');
        const held = gate(page, { operation }); await held.installed;
        if (operation === 'add') { await openAdd(page); await choice(page, 'Private action target').click(); await closeChooser(page); }
        else await deleteFromCard(page, playlist);
        await expect.poll(() => held.requests.length).toBe(1);
        expect((await page.request.delete(`/api/playlists/${playlist.id}`)).ok()).toBeTruthy();
        await release(held);
        await expect(shelfCard(page, playlist.id)).toHaveCount(0);
        await expect(actions(page)).toBeHidden();
        await expect(page.locator('#playlistDeleteDialog')).toBeHidden();
        expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
    });

    test(`${operation} legacy fallback retains pending controls and never offers replay for an unknown request`, async ({ page }) => {
        await ready(page); const playlist = await create(page);
        await page.route('**/api/client-capabilities', async route => {
            const response = await route.fetch(); const body = await response.json();
            body.actions = body.actions.filter(action => !['playlist.add', 'playlist.delete'].includes(action));
            await route.fulfill({ response, json: body });
        });
        await page.reload();
        await expect.poll(() => page.evaluate(kind => hasPlaylistProtocol(kind), `playlist.${operation}`)).toBe(false);
        const held = gate(page, { operation }); await held.installed;
        if (operation === 'add') { await openAdd(page); await choice(page).click(); await expect(choice(page)).toBeDisabled(); await closeChooser(page); }
        else await deleteFromCard(page, playlist);
        await expect(actions(page)).toContainText(operation === 'add' ? 'Adding to playlist' : 'Deleting playlist');
        expect(held.requests[0].body || {}).not.toHaveProperty('client_mutation_id');
        await release(held);
        if (operation === 'add') await expect(shelfCard(page, playlist.id)).toContainText('2 videos');
        else await expect(shelfCard(page, playlist.id)).toHaveCount(0);
        const next = operation === 'delete' ? await create(page, 'Unknown legacy delete') : playlist;
        await page.unroute(routes);
        await page.route(routes, route => {
            if (operation === 'add' ? route.request().method() !== 'POST' : route.request().method() !== 'DELETE') return route.continue();
            return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Temporary failure"}' });
        });
        if (operation === 'add') { await openAdd(page, 'actions-three'); await choice(page).click(); await closeChooser(page); }
        else await deleteFromCard(page, next);
        await expect(actions(page)).toContainText(/not confirmed/i);
        await openRecovery(page);
        await expect(page.locator('#playlistDeleteStatus')).toContainText(/no receipt recovery/i);
        await expect(page.locator('#playlistActionReplay')).toBeHidden();
        await expect(page.locator('#playlistActionCheck')).toBeHidden();
    });
}

for (const corruption of ['reordered', 'unrelated']) {
    test(`an add acknowledgement with ${corruption} membership stays unknown without altering the shelf`, async ({ page }) => {
        await ready(page); const playlist = await create(page);
        await unknownReceipts(page);
        await page.route(routes, async route => {
            if (route.request().method() !== 'POST') return route.continue();
            const response = await route.fetch(); const body = await response.json();
            if (corruption === 'reordered') {
                body.items.reverse(); body.items.forEach((item, index) => { item.position = index; }); body.member_ids.reverse();
            } else {
                const extra = { ...body.items[1], id: 'actions-three', title: 'Third video', position: body.items.length };
                body.items.push(extra); body.member_ids.push(extra.id); body.item_count++;
            }
            await route.fulfill({ response, json: body });
        });
        await openAdd(page); await choice(page).click(); await closeChooser(page);
        await expect(actions(page)).toContainText('Add not confirmed');
        await expect(shelfCard(page, playlist.id)).toContainText('1 video');
    });
}

async function installMediaHarness(page) {
    await holdNativeMedia(page);
    await page.evaluate(() => {
        Object.defineProperty(HTMLMediaElement.prototype, 'duration', { configurable: true, get() { return 100; } });
        Object.defineProperty(HTMLMediaElement.prototype, 'paused', { configurable: true, get() { return false; } });
        HTMLMediaElement.prototype.load = function () {
            if (this.id !== 'playerVideo') return;
            queueMicrotask(() => { this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('canplay')); });
        };
        HTMLMediaElement.prototype.pause = function () {};
        HTMLMediaElement.prototype.play = function () {
            queueMicrotask(() => this.dispatchEvent(new Event('playing'))); return Promise.resolve();
        };
    });
}

test('deleting the active playlist preserves the current media and existing playback-session behavior', async ({ page }) => {
    await ready(page); const playlist = await create(page, 'Playing playlist', ['actions-one', 'actions-two']);
    await installMediaHarness(page);
    await shelfCard(page, playlist.id).getByRole('button', { name: 'Resume playlist: Playing playlist' }).click();
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    await expect(page.locator('.playlist-queue-row')).toHaveCount(2);
    await page.locator('#playerVideo').evaluate(video => { window.actionPlayingVideo = video; window.actionPlayingSource = video.querySelector('source').src; });
    // Playback overlays the shelf, so use the same public action handler that
    // the retained card control invokes without closing the player first.
    await page.evaluate(id => deletePlaylist(id), playlist.id);
    await expect(page.locator('#playlistDeleteDialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#playlistDeleteDialog')).toBeHidden();
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    expect(await detail(page, playlist.id)).not.toBeNull();
    await page.evaluate(id => deletePlaylist(id), playlist.id);
    await expect(page.locator('#playlistDeleteDialog')).toBeVisible();
    const held = gate(page, { operation: 'delete' }); await held.installed;
    await page.locator('#playlistDeleteConfirm').click();
    await expect(page.locator('#playlistDeleteStatus')).toContainText('Deleting playlist');
    expect(await page.locator('#playerVideo').evaluate(video => video === window.actionPlayingVideo && video.querySelector('source').src === window.actionPlayingSource)).toBe(true);
    await release(held);
    await expect(shelfCard(page, playlist.id)).toHaveCount(0);
    expect(await page.locator('#playerVideo').evaluate(video => video === window.actionPlayingVideo && video.querySelector('source').src === window.actionPlayingSource)).toBe(true);
    await expect(page.locator('#playerBackdrop')).toHaveClass(/open/);
    await expect(page.locator('[data-row-id="actions-one"]')).toBeVisible();
});

for (const corruption of ['identity', 'membership invalidation']) {
    test(`a delete acknowledgement with invalid ${corruption} stays unknown and retains its shelf item`, async ({ page }) => {
        await ready(page); const playlist = await create(page);
        await unknownReceipts(page);
        await page.route(routes, async route => {
            if (route.request().method() !== 'DELETE') return route.continue();
            const response = await route.fetch(); const body = await response.json();
            if (corruption === 'identity') body.id = 'some-other-playlist';
            else body.membership_invalidated = false;
            await route.fulfill({ response, json: body });
        });
        await deleteFromCard(page, playlist);
        await expect(actions(page)).toContainText('Delete not confirmed');
        await expect(shelfCard(page, playlist.id)).toBeVisible();
        await expect(page.locator('#playlistDeleteStatus')).toContainText('Delete not confirmed');
    });
}

test('pending deletion survives closing and reopening its confirmation surface without a second command', async ({ page }) => {
    await ready(page); const playlist = await create(page);
    const held = gate(page, { operation: 'delete' }); await held.installed;
    await deleteFromCard(page, playlist);
    await page.locator('#playlistDeleteClose').click();
    await expect(actions(page)).toContainText('Deleting playlist');
    await expect(shelfCard(page, playlist.id)).toBeVisible();
    await openRecovery(page);
    await expect(page.locator('#playlistDeleteStatus')).toContainText('Deleting playlist');
    await expect(page.locator('#playlistDeleteConfirm')).toBeHidden();
    expect(held.requests).toHaveLength(1);
    await release(held);
    await expect(shelfCard(page, playlist.id)).toHaveCount(0);
    await expect(page.locator('#playlistDeleteDialog')).toBeHidden();
});

test('definite quick-add rejection retains current membership and restores ordinary controls', async ({ page }) => {
    await ready(page); const playlist = await create(page);
    await openAdd(page);
    const held = gate(page); await held.installed;
    await choice(page).click(); await expect.poll(() => held.requests.length).toBe(1);
    expect((await page.request.post('/api/remove/actions-two')).ok()).toBeTruthy();
    await release(held);
    await expect(chooser(page)).toContainText(/could not|not playable|unknown|unavailable|save playlist/i);
    await expect(choice(page)).toBeEnabled();
    await expect(shelfCard(page, playlist.id)).toContainText('1 video');
    expect((await detail(page, playlist.id)).member_ids).toEqual(['actions-one']);
});

test('an older add acknowledgement retains newer playback progress at the same playlist revision', async ({ page }) => {
    await ready(page); const playlist = await create(page);
    await openAdd(page);
    const held = gate(page, { committed: true }); await held.installed;
    await choice(page).click();
    await expect.poll(() => held.releases.length).toBe(1);
    const progressed = await page.request.put(`/api/playlists/${playlist.id}/progress`, {
        data: { download_id: 'actions-two', position_seconds: 34, completed: false, write_sequence: 7 },
    });
    expect(progressed.ok()).toBeTruthy();
    await page.evaluate(() => fetchPlaylists());
    const card = shelfCard(page, playlist.id);
    await expect(card.locator('.playlist-resume')).toHaveText('Episode 2 of 2 · 0:34');
    expect(await page.evaluate(id => tagState.selectPlaylist(id).progress.write_sequence, playlist.id)).toBe(7);
    await release(held);
    await expect(actions(page)).toBeHidden();
    await expect(card.locator('.playlist-resume')).toHaveText('Episode 2 of 2 · 0:34');
    expect(await page.evaluate(id => tagState.selectPlaylist(id).progress.write_sequence, playlist.id)).toBe(7);
    expect((await detail(page, playlist.id)).member_ids).toEqual(['actions-one', 'actions-two']);
});

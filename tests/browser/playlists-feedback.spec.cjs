const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, switchAccount } = require('./support.cjs');

const editor = page => page.locator('#playlistEditorDialog');
const status = page => page.locator('#playlistSaveStatus');
const save = page => page.locator('#playlistSaveButton');
const playlistRoutes = /\/api\/playlists(?:\/[^/?]+)?(?:\?.*)?$/;

async function ready(page) {
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    await expect.poll(() => page.evaluate(() => hasPlaylistProtocol())).toBe(true);
    await seed(page, { id: 'playlist-feedback-one', status: 'finished', title: 'First video', duration_seconds: 100 });
    await seed(page, { id: 'playlist-feedback-two', status: 'finished', title: 'Second video', duration_seconds: 200 });
    await seed(page, { id: 'playlist-feedback-three', status: 'finished', title: 'Third video', duration_seconds: 300 });
    await refresh(page);
}
async function create(page, name = 'Confirmed playlist', ids = ['playlist-feedback-one', 'playlist-feedback-two']) {
    const response = await page.request.post('/api/playlists', { data: { name, download_ids: ids } });
    expect(response.status()).toBe(201);
    const result = await response.json();
    await page.evaluate(() => fetchPlaylists());
    return result;
}
async function openNew(page, name = 'New playlist') {
    await expect.poll(() => page.evaluate(() => playableLibraryEntries().some(item => item.id === 'playlist-feedback-one'))).toBe(true);
    await page.getByRole('button', { name: 'Create playlist', exact: true }).click();
    await page.locator('#playlistName').fill(name);
    await page.locator('#playlistAvailable').getByRole('button', { name: /First video/ }).click();
}
async function openExisting(page, playlist) {
    const card = page.locator(`[data-playlist-id="${playlist.id}"]`);
    await card.locator('.kebab-btn').click();
    await card.getByRole('button', { name: 'Edit playlist', exact: true }).click();
    await expect(editor(page)).toBeVisible();
}
function saveGate(page, { committed = false } = {}) {
    const requests = [];
    const releases = [];
    const installed = page.route(playlistRoutes, async route => {
        if (!['POST', 'PUT'].includes(route.request().method())) return route.continue();
        requests.push(route.request().postDataJSON());
        const response = committed ? await route.fetch() : null;
        await new Promise(resolve => releases.push(resolve));
        if (response) await route.fulfill({ response }).catch(() => {});
        else await route.continue();
    });
    return { installed, requests, releases };
}
async function release(gate) {
    await expect.poll(() => gate.releases.length).toBeGreaterThan(0);
    gate.releases.shift()();
}
async function close(page) {
    const accept = dialog => dialog.accept();
    page.on('dialog', accept);
    try { await editor(page).getByRole('button', { name: 'Close playlist editor' }).click(); }
    finally { page.off('dialog', accept); }
    await expect(editor(page)).toBeHidden();
}

// Transport gates hold actual requests or committed responses. Assertions do
// not depend on network delays, SSE timing, or synthetic copies of UI logic.
test.beforeEach(async ({ page }) => reset(page));
test.setTimeout(25_000);

for (const operation of ['create', 'replace']) {
    test(`${operation} gives feedback within 50ms and confirms canonically without SSE or collection reads`, async ({ page }) => {
        await ready(page);
        let playlist;
        if (operation === 'replace') {
            playlist = await create(page);
            await openExisting(page, playlist);
            await page.locator('#playlistName').fill('Canonical updated');
        } else await openNew(page, 'Canonical created');
        const gate = saveGate(page); await gate.installed;
        let reads = 0;
        page.on('request', request => {
            if (request.method() === 'GET' && /\/api\/(playlists|library|history|current-downloads)(?:\?|$)/.test(request.url())) reads++;
        });
        await save(page).evaluate(button => {
            button.form.addEventListener('submit', () => { window.playlistStarted = performance.now(); }, true);
            window.addEventListener('submit', () => {
                window.playlistFeedbackMs = performance.now() - window.playlistStarted;
                window.playlistFeedbackText = document.getElementById('playlistSaveStatus').textContent;
            }, { once: true });
        });
        await save(page).click();
        const pending = operation === 'create' ? 'Creating playlist' : 'Saving playlist';
        await expect(status(page)).toContainText(pending);
        expect(await page.evaluate(() => window.playlistFeedbackText)).toContain(pending);
        expect(await page.evaluate(() => window.playlistFeedbackMs)).toBeLessThan(50);
        await expect(page.locator('#playlistSavingSpinner')).toBeVisible();
        await expect(save(page)).toBeDisabled();
        await expect(page.locator('#playlistName')).toBeEnabled();
        if (playlist) await expect(page.locator(`[data-playlist-id="${playlist.id}"] strong`)).toHaveText('Confirmed playlist');
        else await expect(page.locator('.playlist-card')).toHaveCount(0);
        await expect.poll(() => gate.requests.length).toBe(1);
        if (operation === 'replace') expect(typeof gate.requests[0].expected_revision).toBe('number');
        await release(gate);
        await expect(editor(page)).toBeHidden();
        await expect(page.locator('.playlist-card strong')).toHaveText(operation === 'create' ? 'Canonical created' : 'Canonical updated');
        expect(reads).toBe(0);
        const metrics = await page.evaluate(() => VDL.playlistMutationMetrics());
        expect(metrics.acknowledgements).toBe(1);
        expect(metrics.latestLocalFeedbackMs).toBeLessThan(50);
        expect(JSON.stringify(metrics)).not.toContain('playlist-feedback');
    });
}

test('newer title and reordered members retain focus and remain an unsaved draft after creation acknowledgement', async ({ page }) => {
    await ready(page); await openNew(page, 'Submitted name');
    await page.locator('#playlistAvailable').getByRole('button', { name: /Second video/ }).click();
    const gate = saveGate(page); await gate.installed;
    await save(page).click();
    await page.locator('#playlistName').fill('Newer private draft');
    await page.locator('#playlistSelected').getByRole('button', { name: 'Move Second video up' }).click();
    await page.locator('#playlistName').focus();
    await release(gate);
    await expect(status(page)).toContainText('Newer edits remain unsaved');
    await expect(page.locator('#playlistName')).toHaveValue('Newer private draft');
    await expect(page.locator('#playlistName')).toBeFocused();
    await expect(page.locator('.playlist-selected-row').first()).toContainText('Second video');
    await expect(page.locator('#playlistEditorDirty')).toBeVisible();
    await expect(save(page)).toBeEnabled();
    await expect(page.locator('.playlist-card strong')).toHaveText('Submitted name');
    const detail = await (await page.request.get('/api/playlists')).json();
    expect(detail).toHaveLength(1);
    expect(detail[0].member_ids).toEqual(['playlist-feedback-one', 'playlist-feedback-two']);
    await save(page).click();
    await expect.poll(() => gate.requests.length).toBe(2);
    await release(gate);
    await expect(editor(page)).toBeHidden();
    const final = await (await page.request.get('/api/playlists')).json();
    expect(final).toHaveLength(1);
    expect(final[0].id).toBe(detail[0].id);
    expect(final[0].member_ids).toEqual(['playlist-feedback-two', 'playlist-feedback-one']);
});

test('duplicate submission never queues a whole-list replacement while edits stay usable', async ({ page }) => {
    await ready(page); await openNew(page);
    const gate = saveGate(page); await gate.installed;
    await page.evaluate(() => { savePlaylistEditor({ preventDefault() {} }); savePlaylistEditor({ preventDefault() {} }); });
    await expect.poll(() => gate.requests.length).toBe(1);
    await page.locator('#playlistName').fill('Changed while pending');
    await page.evaluate(() => savePlaylistEditor({ preventDefault() {} }));
    expect(gate.requests).toHaveLength(1);
    await release(gate);
    await expect(status(page)).toContainText('Newer edits remain unsaved');
    expect(gate.requests).toHaveLength(1);
});

test('closing retains a recovery summary and a late acknowledgement cannot close another editor', async ({ page }) => {
    await ready(page);
    const other = await create(page, 'Other playlist');
    await openNew(page, 'Pending creation');
    const gate = saveGate(page); await gate.installed;
    await save(page).click();
    await expect.poll(() => gate.requests.length).toBe(1);
    await close(page);
    await expect(page.locator('#playlistMutationSummary')).toContainText('Creating playlist');
    await openExisting(page, other);
    await page.locator('#playlistName').fill('Unrelated newer editor');
    await release(gate);
    await expect(page.locator('.playlist-card strong', { hasText: 'Pending creation' })).toBeVisible();
    await expect(editor(page)).toBeVisible();
    await expect(page.locator('#playlistName')).toHaveValue('Unrelated newer editor');
    await expect(page.locator('#playlistName')).toBeFocused();
});

test('reopened recovery draft is protected from the originating view callback', async ({ page }) => {
    await ready(page); await openNew(page, 'Pending recovery draft');
    const gate = saveGate(page); await gate.installed;
    await save(page).click(); await expect.poll(() => gate.requests.length).toBe(1);
    await close(page);
    await page.locator('#playlistRecoveryOpen').click();
    await expect(page.locator('#playlistName')).toHaveValue('Pending recovery draft');
    await page.locator('#playlistName').fill('Reopened newer draft');
    await release(gate);
    await expect(editor(page)).toBeVisible();
    await expect(page.locator('#playlistName')).toHaveValue('Reopened newer draft');
    await expect(status(page)).toContainText('Newer edits remain unsaved');
});

test('an old shelf read cannot regress an acknowledged playlist or lose its canonical creation identity', async ({ page }) => {
    await ready(page);
    let releaseRead;
    await page.route('**/api/playlists', async route => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        await new Promise(resolve => { releaseRead = resolve; });
        await route.fulfill({ response });
    });
    await page.evaluate(() => { window.oldPlaylistRead = fetchPlaylists(); });
    await expect.poll(() => !!releaseRead).toBe(true);
    await openNew(page, 'Saved after old read');
    await save(page).click();
    await expect(editor(page)).toBeHidden();
    const id = await page.locator('.playlist-card').getAttribute('data-playlist-id');
    releaseRead();
    await page.evaluate(() => window.oldPlaylistRead);
    await expect(page.locator('.playlist-card')).toHaveCount(1);
    await expect(page.locator('.playlist-card')).toHaveAttribute('data-playlist-id', id);
    await expect(page.locator('.playlist-card strong')).toHaveText('Saved after old read');
});

test('quick-add competes at the existing integer revision boundary and conflict review never overwrites automatically', async ({ page }) => {
    await ready(page);
    const playlist = await create(page);
    await openExisting(page, playlist);
    await page.locator('#playlistName').fill('My retained draft');
    const gate = saveGate(page); await gate.installed;
    await save(page).click(); await expect.poll(() => gate.requests.length).toBe(1);
    expect((await page.request.post(`/api/playlists/${playlist.id}/items`, { data: { download_id: 'playlist-feedback-three' } })).ok()).toBeTruthy();
    await release(gate);
    await expect(status(page)).toContainText('changed elsewhere');
    await expect(page.locator('#playlistName')).toHaveValue('My retained draft');
    await expect(save(page)).toBeDisabled();
    await page.locator('#playlistReview').click();
    await expect(page.locator('#playlistCurrentVersion')).toContainText('Confirmed playlist');
    await expect(page.locator('#playlistCurrentVersion')).toContainText('Third video');
    const current = await (await page.request.get(`/api/playlists/${playlist.id}`)).json();
    expect(current.items).toHaveLength(3);
    await page.locator('#playlistResubmit').click();
    await expect.poll(() => gate.requests.length).toBe(2);
    expect(typeof gate.requests[1].expected_revision).toBe('number');
    expect(gate.requests[1].expected_revision).toBe(current.revision);
    expect(gate.requests[1].client_mutation_id).not.toBe(gate.requests[0].client_mutation_id);
    await release(gate);
    await expect(editor(page)).toBeHidden();
    const result = await (await page.request.get(`/api/playlists/${playlist.id}`)).json();
    expect(result.name).toBe('My retained draft');
    expect(result.items.map(item => item.id)).toEqual(['playlist-feedback-one', 'playlist-feedback-two']);
});

test('Use current version explicitly replaces the retained conflict draft', async ({ page }) => {
    await ready(page);
    const playlist = await create(page);
    await openExisting(page, playlist);
    await page.locator('#playlistName').fill('My conflict draft');
    const gate = saveGate(page); await gate.installed;
    await save(page).click(); await expect.poll(() => gate.requests.length).toBe(1);
    await page.request.put(`/api/playlists/${playlist.id}`, { data: { name: 'Current canonical', download_ids: ['playlist-feedback-two'], expected_revision: playlist.revision } });
    await release(gate);
    await expect(status(page)).toContainText('changed elsewhere');
    await page.locator('#playlistReview').click();
    await page.locator('#playlistUseCurrent').click();
    await expect(page.locator('#playlistName')).toHaveValue('Current canonical');
    await expect(page.locator('.playlist-selected-row')).toHaveCount(1);
    await expect(page.locator('.playlist-selected-row')).toContainText('Second video');
    await expect(page.locator('#playlistEditorDirty')).toBeHidden();
    expect(gate.requests).toHaveLength(1);
});

for (const operation of ['create', 'replace']) {
    test(`lost ${operation} acknowledgement deliberately replays its frozen receipt attempt once`, async ({ page }) => {
        await ready(page);
        const existing = operation === 'replace' ? await create(page) : null;
        if (existing) { await openExisting(page, existing); await page.locator('#playlistName').fill('Saved via recovery'); }
        else await openNew(page, 'Saved via recovery');
        const attempts = [];
        let first = true;
        await page.route('**/api/mutations/**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Mutation unavailable","final":false}' }));
        await page.route(playlistRoutes, async route => {
            if (!['POST', 'PUT'].includes(route.request().method())) return route.continue();
            attempts.push(route.request().postDataJSON());
            if (first) { first = false; await route.fetch(); return route.abort(); }
            return route.continue();
        });
        await save(page).click();
        await expect(status(page)).toContainText('Save not confirmed');
        await expect(save(page)).toBeDisabled();
        await page.locator('#playlistName').fill('Newer recovery draft');
        const committed = await (await page.request.get('/api/playlists')).json();
        expect(committed).toHaveLength(1);
        await page.locator('#playlistReplay').click();
        await expect(status(page)).toContainText('Newer edits remain unsaved');
        expect(attempts).toHaveLength(2);
        expect(attempts[1]).toEqual(attempts[0]);
        await expect(page.locator('#playlistName')).toHaveValue('Newer recovery draft');
        const result = await (await page.request.get('/api/playlists')).json();
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe(committed[0].id);
        expect(result[0].revision).toBe(committed[0].revision);
    });
}

test('actor receipt lookup confirms a lost response without repeating the create', async ({ page }) => {
    await ready(page); await openNew(page, 'Receipt-confirmed playlist');
    let writes = 0;
    await page.route(playlistRoutes, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        writes++;
        await route.fetch();
        return route.abort();
    });
    await save(page).click();
    await expect(editor(page)).toBeHidden();
    await expect(page.locator('.playlist-card strong')).toHaveText('Receipt-confirmed playlist');
    expect(writes).toBe(1);
});

for (const response of [{ status: 500, body: { error: 'Temporary failure' } }, { status: 200, body: { name: 'Malformed success' } }]) {
    test(`${response.status === 500 ? 'server error' : 'malformed success'} remains unknown and blocks a second save`, async ({ page }) => {
        await ready(page); await openNew(page);
        let writes = 0;
        await page.route(playlistRoutes, route => {
            if (route.request().method() !== 'POST') return route.continue();
            writes++;
            return route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) });
        });
        await save(page).click();
        await expect(status(page)).toContainText('Save not confirmed');
        await expect(save(page)).toBeDisabled();
        await expect(page.locator('#playlistCheck')).toBeVisible();
        await page.locator('#playlistName').fill('Another desired name');
        await page.evaluate(() => savePlaylistEditor({ preventDefault() {} }));
        expect(writes).toBe(1);
        await expect(page.locator('.playlist-card')).toHaveCount(0);
    });
}

test('definite validation failure retains the draft with a keyboard-accessible field error', async ({ page }) => {
    await ready(page); await openNew(page, '\u200b');
    await save(page).focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#playlistEditorError')).toBeVisible();
    await expect(page.locator('#playlistName')).toHaveValue('\u200b');
    await expect(save(page)).toBeEnabled();
    await expect(page.locator('.playlist-card')).toHaveCount(0);
    await page.locator('#playlistName').fill('Corrected keyboard name');
    await save(page).focus(); await page.keyboard.press('Enter');
    await expect(editor(page)).toBeHidden();
    await expect(page.locator('.playlist-card strong')).toHaveText('Corrected keyboard name');
});

test('five seconds of waiting changes spinner-only feedback to explanatory text', async ({ page }) => {
    await ready(page); await openNew(page); await page.clock.install();
    const gate = saveGate(page); await gate.installed;
    await save(page).click();
    await page.clock.fastForward(5100);
    await expect(status(page)).toContainText('Still waiting');
    await expect(save(page)).toBeDisabled();
    await release(gate);
    await expect(editor(page)).toBeHidden();
});

test('known deletion fences an older successful replacement response', async ({ page }) => {
    await ready(page);
    const playlist = await create(page);
    await openExisting(page, playlist);
    await page.locator('#playlistName').fill('Must not resurrect');
    const gate = saveGate(page, { committed: true }); await gate.installed;
    await save(page).click(); await expect.poll(() => gate.releases.length).toBe(1);
    await close(page);
    const card = page.locator(`[data-playlist-id="${playlist.id}"]`);
    // A remote writer may delete after commit while this client still waits.
    // Local contradictory writes share the unresolved playlist boundary.
    expect((await page.request.delete(`/api/playlists/${playlist.id}`)).ok()).toBeTruthy();
    await page.evaluate(id => tagMutations.fence(`playlist:${id}`), playlist.id);
    await page.evaluate(() => fetchPlaylists());
    await expect(card).toHaveCount(0);
    await release(gate);
    await expect(card).toHaveCount(0);
    await expect(page.locator('#playlistMutationSummary')).toBeHidden();
});

test('authorization reset clears the retained private draft and ignores the previous response', async ({ page }) => {
    await ready(page); await openNew(page, 'Private old-account draft');
    const gate = saveGate(page, { committed: true }); await gate.installed;
    await save(page).click(); await expect.poll(() => gate.releases.length).toBe(1);
    await page.evaluate(() => resetTagSession());
    await expect(editor(page)).toBeHidden();
    await expect(page.locator('#playlistName')).toHaveValue('');
    await release(gate);
    await expect(page.locator('#playlistMutationSummary')).toBeHidden();
    await expect(page.locator('.playlist-card')).toHaveCount(0);
});

test('switching accounts cannot revive private drafts or the previous account playlist', async ({ page }) => {
    await ready(page);
    expect((await page.request.post('/api/users', { data: { username: 'playlist-feedback-next', password: 'next-password', role: 'normal' } })).ok()).toBeTruthy();
    await openNew(page, 'Private first-account playlist');
    const gate = saveGate(page, { committed: true }); await gate.installed;
    await save(page).click(); await expect.poll(() => gate.releases.length).toBe(1);
    await close(page);
    await switchAccount(page, 'playlist-feedback-next', 'next-password');
    await release(gate);
    await expect(page.locator('#playlistName')).toHaveValue('');
    await expect(page.locator('#playlistMutationSummary')).toBeHidden();
    await expect(page.locator('.playlist-card')).toHaveCount(0);
});

test('legacy capability fallback shows pending drafts and never retries an unknown creation', async ({ page }) => {
    await ready(page);
    await page.route('**/api/client-capabilities', async route => {
        const response = await route.fetch(); const body = await response.json();
        body.actions = body.actions.filter(action => !action.startsWith('playlist.'));
        await route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect.poll(() => page.evaluate(() => hasPlaylistProtocol())).toBe(false);
    await openNew(page, 'Legacy submitted name');
    const gate = saveGate(page); await gate.installed;
    await save(page).click();
    await expect(status(page)).toContainText('Creating playlist');
    await page.locator('#playlistName').fill('Legacy newer draft');
    await release(gate);
    await expect(status(page)).toContainText('Newer edits remain unsaved');
    await close(page);
    await openNew(page, 'Legacy unknown creation');
    await page.unroute(playlistRoutes);
    await page.route(playlistRoutes, route => route.request().method() === 'POST'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"temporary"}' }) : route.continue());
    await save(page).click();
    await expect(status(page)).toContainText('no receipt recovery');
    await expect(save(page)).toBeDisabled();
    await expect(page.locator('#playlistReplay')).toBeHidden();
});

for (const theme of ['light', 'dark']) {
    test(`pending feedback is keyboard readable in ${theme} with reduced motion and a narrow viewport`, async ({ page }) => {
        await ready(page);
        await page.setViewportSize({ width: 390, height: 700 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.evaluate(value => applyTheme(value), theme);
        await openNew(page, `Keyboard ${theme}`);
        const gate = saveGate(page); await gate.installed;
        await save(page).focus(); await page.keyboard.press('Enter');
        await expect(status(page)).toContainText('Creating playlist');
        await expect(status(page)).toHaveAttribute('role', 'status');
        const fits = await editor(page).evaluate(dialog => {
            const rect = dialog.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth + 1;
        });
        expect(fits).toBe(true);
        await release(gate);
        await expect(editor(page)).toBeHidden();
        await expect(page.locator('.playlist-card strong')).toHaveText(`Keyboard ${theme}`);
    });
}

test('receipt recovery redacts a shared video made private after commit', async ({ page, request }) => {
    await ready(page);
    expect((await page.request.post('/api/users', { data: {
        username: 'playlist-feedback-reader', password: 'reader-password', role: 'normal',
    } })).ok()).toBeTruthy();
    await request.post('/login', { form: { username: 'admin', password: 'browser-test-password' } });
    await switchAccount(page, 'playlist-feedback-reader', 'reader-password');
    await expect.poll(() => page.evaluate(() => hasPlaylistProtocol())).toBe(true);
    await openNew(page, 'Reader owned playlist');
    let mutationId;
    const receipts = [];
    await page.route('**/api/mutations/**', async route => {
        await new Promise(resolve => receipts.push(resolve));
        await route.continue();
    });
    await page.route(playlistRoutes, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        mutationId = route.request().postDataJSON().client_mutation_id;
        await route.fetch();
        await route.abort();
    });
    await save(page).click();
    await expect.poll(() => receipts.length).toBe(1);
    expect((await request.post('/api/visibility/playlist-feedback-one', { data: { visibility: 'private' } })).ok()).toBeTruthy();
    receipts.shift()();
    await expect(editor(page)).toBeHidden();
    const result = await page.request.get(`/api/mutations/${mutationId}`);
    expect(result.ok()).toBeTruthy();
    const body = await result.json();
    expect(body.items[0].id).toBeNull();
    expect(body.items[0].title).toBe('Unavailable video');
    expect(JSON.stringify(body)).not.toContain('First video');
    expect(JSON.stringify(body)).not.toContain('playlist-feedback-one');
    const playlist = (await (await page.request.get('/api/playlists')).json())[0];
    await page.evaluate(() => fetchHistory());
    await page.evaluate(() => fetchPlaylists());
    // The sole member is now invisible, so the normal search-scoped shelf can
    // hide its card. Targeted authorized opening still exposes a safe placeholder.
    await page.evaluate(id => openPlaylistEditor(id), playlist.id);
    await expect(page.locator('#playlistSelected')).toContainText('Unavailable video');
    await expect(page.locator('#playlistSelected')).not.toContainText('First video');
    await expect(page.locator('#playlistSelected img')).toHaveCount(0);
});

test('a matching collection read cannot settle an unknown creation without its receipt', async ({ page }) => {
    await ready(page); await openNew(page, 'Matching but unconfirmed');
    await page.route('**/api/mutations/**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Mutation unavailable","final":false}' }));
    await page.route(playlistRoutes, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        await route.fetch(); await route.abort();
    });
    await save(page).click();
    await expect(status(page)).toContainText('Save not confirmed');
    await page.evaluate(() => fetchPlaylists());
    await expect(status(page)).toContainText('Save not confirmed');
    await expect(save(page)).toBeDisabled();
    await expect(editor(page)).toBeVisible();
});

test('an older successful save cannot remove a newer quick-add or reorder unrelated shelf cards', async ({ page }) => {
    await ready(page);
    const playlist = await create(page);
    const unrelated = await create(page, 'Unrelated playlist', ['playlist-feedback-three']);
    await page.locator(`[data-playlist-id="${unrelated.id}"]`).evaluate(card => { window.unrelatedPlaylistCard = card; });
    await openExisting(page, playlist);
    await page.locator('#playlistName').fill('Committed before quick-add');
    const gate = saveGate(page, { committed: true }); await gate.installed;
    await save(page).click(); await expect.poll(() => gate.releases.length).toBe(1);
    await close(page);
    expect((await page.request.post(`/api/playlists/${playlist.id}/items`, { data: { download_id: 'playlist-feedback-three' } })).ok()).toBeTruthy();
    await page.evaluate(() => fetchPlaylists());
    await expect(page.locator(`[data-playlist-id="${playlist.id}"]`)).toContainText('3 videos');
    const shelfBefore = await page.locator('.playlist-card').evaluateAll(cards => cards.map(card => card.dataset.playlistId));
    await release(gate);
    await expect(page.locator('#playlistMutationSummary')).toBeHidden();
    await expect(page.locator(`[data-playlist-id="${playlist.id}"]`)).toContainText('3 videos');
    await expect(page.locator(`[data-playlist-id="${playlist.id}"] strong`)).toHaveText('Committed before quick-add');
    expect(await page.locator('.playlist-card').evaluateAll(cards => cards.map(card => card.dataset.playlistId))).toEqual(shelfBefore);
    expect(await page.locator(`[data-playlist-id="${unrelated.id}"]`).evaluate(card => card === window.unrelatedPlaylistCard)).toBe(true);
    const result = await (await page.request.get(`/api/playlists/${playlist.id}`)).json();
    expect(result.items.map(item => item.id)).toEqual(['playlist-feedback-one', 'playlist-feedback-two', 'playlist-feedback-three']);
});

test('legacy replacement conflicts retain ordered drafts for explicit current-version review', async ({ page }) => {
    await ready(page);
    const playlist = await create(page);
    await page.route('**/api/client-capabilities', async route => {
        const response = await route.fetch(); const body = await response.json();
        body.actions = body.actions.filter(action => !action.startsWith('playlist.'));
        await route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect.poll(() => page.evaluate(() => hasPlaylistProtocol())).toBe(false);
    await openExisting(page, playlist);
    await page.locator('#playlistName').fill('Retained legacy draft');
    await page.locator('#playlistSelected').getByRole('button', { name: 'Move Second video up' }).click();
    const gate = saveGate(page); await gate.installed;
    await save(page).click(); await expect.poll(() => gate.requests.length).toBe(1);
    const updated = await page.request.put(`/api/playlists/${playlist.id}`, {
        data: { name: 'Remote legacy update', download_ids: ['playlist-feedback-three'], expected_revision: playlist.revision },
    });
    expect(updated.ok()).toBeTruthy();
    const current = await updated.json();
    await release(gate);
    await expect(status(page)).toContainText('changed elsewhere');
    await expect(page.locator('#playlistName')).toHaveValue('Retained legacy draft');
    await expect(page.locator('.playlist-selected-row').first()).toContainText('Second video');
    await page.locator('#playlistReview').click();
    await expect(page.locator('#playlistCurrentVersion')).toContainText('Remote legacy update');
    await expect(page.locator('#playlistCurrentVersion')).toContainText('Third video');
    await expect(page.locator('#playlistReplay')).toBeHidden();
    await page.locator('#playlistResubmit').click();
    await expect.poll(() => gate.requests.length).toBe(2);
    expect(gate.requests[1].expected_revision).toBe(current.revision);
    expect(gate.requests[1]).not.toHaveProperty('client_mutation_id');
    await release(gate);
    await expect(editor(page)).toBeHidden();
    const result = await (await page.request.get(`/api/playlists/${playlist.id}`)).json();
    expect(result.name).toBe('Retained legacy draft');
    expect(result.items.map(item => item.id)).toEqual(['playlist-feedback-two', 'playlist-feedback-one']);
});

test('a newer draft keeps its acknowledged base revision when a later quick-add precedes acknowledgement', async ({ page }) => {
    await ready(page);
    const playlist = await create(page);
    await openExisting(page, playlist);
    await page.locator('#playlistName').fill('Submitted before remote add');
    const gate = saveGate(page, { committed: true }); await gate.installed;
    await save(page).click(); await expect.poll(() => gate.releases.length).toBe(1);
    await page.locator('#playlistName').fill('Newer retained draft');
    expect((await page.request.post(`/api/playlists/${playlist.id}/items`, { data: { download_id: 'playlist-feedback-three' } })).ok()).toBeTruthy();
    await page.evaluate(() => fetchPlaylists());
    const newer = await (await page.request.get(`/api/playlists/${playlist.id}`)).json();
    expect(newer.items).toHaveLength(3);
    await release(gate);
    await expect(status(page)).toContainText('Newer edits remain unsaved');
    await expect(page.locator('#playlistName')).toHaveValue('Newer retained draft');
    await expect(page.locator(`[data-playlist-id="${playlist.id}"]`)).toContainText('3 videos');
    await save(page).click(); await expect.poll(() => gate.requests.length).toBe(2);
    expect(gate.requests[1].expected_revision).toBe(newer.revision - 1);
    await release(gate);
    await expect(status(page)).toContainText('changed elsewhere');
    await expect(page.locator('#playlistName')).toHaveValue('Newer retained draft');
    const retained = await (await page.request.get(`/api/playlists/${playlist.id}`)).json();
    expect(retained.revision).toBe(newer.revision);
    expect(retained.items.map(item => item.id)).toEqual(['playlist-feedback-one', 'playlist-feedback-two', 'playlist-feedback-three']);
});

test('a closed newer draft remains recoverable after its originating save is acknowledged', async ({ page }) => {
    await ready(page); await openNew(page, 'Submitted before close');
    const gate = saveGate(page); await gate.installed;
    await save(page).click(); await expect.poll(() => gate.requests.length).toBe(1);
    await page.locator('#playlistName').fill('Closed newer private draft');
    await page.locator('#playlistAvailable').getByRole('button', { name: /Second video/ }).click();
    await page.locator('#playlistSelected').getByRole('button', { name: 'Move Second video up' }).click();
    await close(page);
    await release(gate);
    await expect(page.locator('.playlist-card strong')).toHaveText('Submitted before close');
    await expect(page.locator('#playlistMutationSummary')).toContainText(/unsaved playlist draft/i);
    expect(gate.requests).toHaveLength(1);
    await page.locator('#playlistRecoveryOpen').click();
    await expect(editor(page)).toBeVisible();
    await expect(page.locator('#playlistName')).toHaveValue('Closed newer private draft');
    await expect(page.locator('.playlist-selected-row').first()).toContainText('Second video');
    await expect(page.locator('#playlistEditorDirty')).toBeVisible();
    await expect(save(page)).toBeEnabled();
    await save(page).click(); await expect.poll(() => gate.requests.length).toBe(2);
    await release(gate);
    await expect(editor(page)).toBeHidden();
    await expect(page.locator('#playlistMutationSummary')).toBeHidden();
    const result = await (await page.request.get('/api/playlists')).json();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Closed newer private draft');
    expect(result[0].member_ids).toEqual(['playlist-feedback-two', 'playlist-feedback-one']);
});

test('deleting a creation discovered by reconciliation fences its later acknowledgement and local recovery draft', async ({ page }) => {
    await ready(page); await openNew(page, 'Created before deletion');
    const gate = saveGate(page, { committed: true }); await gate.installed;
    await save(page).click(); await expect.poll(() => gate.releases.length).toBe(1);
    await page.evaluate(() => fetchPlaylists());
    const card = page.locator('.playlist-card', { hasText: 'Created before deletion' });
    await expect(card).toBeVisible();
    const id = await card.getAttribute('data-playlist-id');
    expect((await page.request.delete(`/api/playlists/${id}`)).ok()).toBeTruthy();
    await page.evaluate(playlistId => tagMutations.fence(`playlist:${playlistId}`), id);
    await page.evaluate(() => fetchPlaylists());
    await expect(card).toHaveCount(0);
    await release(gate);
    await expect(editor(page)).toBeHidden();
    await expect(page.locator('#playlistName')).toHaveValue('');
    await expect(page.locator('#playlistMutationSummary')).toBeHidden();
    await expect(page.locator('.playlist-card')).toHaveCount(0);
    expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
    expect(await (await page.request.get('/api/playlists')).json()).toEqual([]);
});

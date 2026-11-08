const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openCurrent, switchAccount } = require('./support.cjs');

const card = (page, id) => page.locator(`[data-row-id="${id}"]`);
const star = row => row.locator('.favorite-toggle').first();
const feedback = row => row.locator('.favorite-feedback').first();
const ids = page => page.locator('#historyList [data-row-id]').evaluateAll(rows => rows.map(row => row.dataset.rowId));

async function ready(page, rows) {
    // Acknowledgements must establish the visible result even without events.
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    for (const row of rows) await seed(page, { status: 'finished', ...row });
    await refresh(page);
    await expect.poll(() => page.evaluate(() => hasFavoriteProtocol())).toBe(true);
    for (const row of rows) {
        if (row.status !== 'cancelled') await expect(card(page, row.id)).not.toHaveClass(/item-fade-in/);
    }
}

async function openInfo(row) {
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Info', exact: true }).click();
    await expect(row.locator('.history-info-popover')).toBeVisible();
}

function gateFavorite(page, id) {
    const requests = [];
    const releases = [];
    const installed = page.route(`**/api/favorite/${id}`, async route => {
        requests.push(route.request().postDataJSON());
        await new Promise(resolve => releases.push(resolve));
        await route.continue();
    });
    return { requests, releases, installed };
}

async function releaseNext(gate) {
    await expect.poll(() => gate.releases.length).toBeGreaterThan(0);
    gate.releases.shift()();
}

test.beforeEach(async ({ page }) => reset(page));
test.setTimeout(25_000);

test('favorite feedback renders before a held request and confirms without a collection GET', async ({ page }, testInfo) => {
    await ready(page, [{ id: 'favorite-immediate' }, { id: 'favorite-neighbor' }]);
    const row = card(page, 'favorite-immediate');
    const button = star(row);
    const order = await ids(page);
    await button.evaluate(element => {
        window.originalFavoriteButton = element;
        window.originalFavoriteCard = element.closest('[data-row-id]');
        element.addEventListener('click', () => { window.favoriteStartedAt = performance.now(); }, true);
        window.addEventListener('click', () => {
            if (element.getAttribute('aria-pressed') === 'true') window.favoriteFeedbackMs = performance.now() - window.favoriteStartedAt;
        });
    });
    const gate = gateFavorite(page, 'favorite-immediate');
    await gate.installed;
    let collectionReads = 0;
    page.on('request', request => {
        if (/\/api\/(library|history|current-downloads)(\?|$)/.test(request.url())) collectionReads++;
    });
    await button.focus();
    await button.press('Enter');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(button).toBeEnabled();
    await expect(button).toBeFocused();
    await expect(feedback(row)).toContainText('Saving favorite');
    await expect(page.locator('#tagMutationStatus')).toContainText('Saving favorite');
    await expect.poll(() => gate.requests.length).toBe(1);
    expect(gate.requests[0].favorite).toBe(true);
    expect(gate.requests[0].expected_revision).toMatch(/^\d+$/);
    const elapsed = await page.evaluate(() => window.favoriteFeedbackMs);
    expect(elapsed).toBeLessThan(50);
    await testInfo.attach('favorite-local-feedback-latency', {
        body: JSON.stringify({ local_feedback_ms: elapsed }), contentType: 'application/json',
    });
    await releaseNext(gate);
    await expect(feedback(row)).toBeEmpty();
    await expect(page.locator('#tagMutationStatus')).toContainText('Favorite saved');
    expect(collectionReads).toBe(0);
    expect(await ids(page)).toEqual(order);
    expect(await button.evaluate(element => element === window.originalFavoriteButton && element.closest('[data-row-id]') === window.originalFavoriteCard)).toBe(true);
    await expect(button).toBeFocused();
    expect((await (await page.request.get('/api/library?include_order=true')).json()).items.find(item => item.id === 'favorite-immediate').favorite).toBe(true);
});

test('favorite intents retain explicit FIFO booleans and stars while tags save independently', async ({ page }) => {
    await ready(page, [{ id: 'favorite-fifo' }, { id: 'favorite-independent' }]);
    const row = card(page, 'favorite-fifo');
    const button = star(row);
    const gate = gateFavorite(page, 'favorite-fifo');
    await gate.installed;
    await button.click();
    await button.click();
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => gate.requests.length).toBe(1);
    await star(card(page, 'favorite-independent')).click();
    await expect(feedback(card(page, 'favorite-independent'))).toBeEmpty();
    await openInfo(row);
    await row.getByText('Add tags', { exact: true }).click();
    await row.locator('.tag-entry-input').fill('Independent tags');
    await row.locator('.tag-entry-input').press('Enter');
    await expect(row.locator('[data-remove-tag="Independent tags"]')).toBeVisible();
    await releaseNext(gate);
    await expect.poll(() => gate.requests.length).toBe(2);
    expect(gate.requests.map(request => request.favorite)).toEqual([true, false]);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await releaseNext(gate);
    await expect.poll(() => gate.requests.length).toBe(3);
    expect(gate.requests.map(request => request.favorite)).toEqual([true, false, true]);
    expect(gate.requests.map(request => request.expected_revision)).toEqual(['0', '1', '2']);
    await releaseNext(gate);
    await expect(feedback(row)).toBeEmpty();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await row.locator('.tag-entry-input').press('Escape');
});

test('rejecting the first favorite leaves newer intents and another entry intact', async ({ page }) => {
    await ready(page, [{ id: 'favorite-rejection' }, { id: 'favorite-unrelated' }]);
    const row = card(page, 'favorite-rejection');
    await page.evaluate(() => {
        window.favoriteAnnouncements = [];
        const status = document.getElementById('tagMutationStatus');
        new MutationObserver(() => window.favoriteAnnouncements.push(status.textContent))
            .observe(status, { childList: true, subtree: true, characterData: true });
    });
    let release;
    const requests = [];
    await page.route('**/api/favorite/favorite-rejection', async route => {
        const payload = route.request().postDataJSON();
        requests.push(payload);
        if (requests.length !== 1) return route.continue();
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({
            id: 'favorite-rejection', favorite: false, favorite_revision: '0', error: 'Favorite was declined',
            mutation: { id: payload.client_mutation_id, domain: 'favorite', revision: '0', outcome: 'rejected' },
        }) });
    });
    await star(row).click();
    await star(row).click();
    await star(row).click();
    await star(card(page, 'favorite-unrelated')).click();
    await expect(feedback(card(page, 'favorite-unrelated'))).toBeEmpty();
    await expect.poll(() => Boolean(release)).toBe(true);
    release();
    await expect(feedback(row)).toContainText(/Could not save favorite|declined/i);
    await expect(star(row)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => requests.length).toBe(3);
    expect(requests.map(request => request.favorite)).toEqual([true, false, true]);
    await expect.poll(() => page.evaluate(() => window.favoriteAnnouncements.some(message => message.includes('Could not save favorite')))).toBe(true);
    await expect(star(card(page, 'favorite-unrelated'))).toHaveAttribute('aria-pressed', 'true');
    await row.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(feedback(row)).toBeEmpty();
});

test('old collection responses and an older acknowledgement preserve newer favorite state and focus', async ({ page }) => {
    await ready(page, [{ id: 'favorite-stale' }, { id: 'favorite-stale-neighbor' }]);
    const row = card(page, 'favorite-stale');
    const order = await ids(page);
    let releaseRead;
    let heldRead = false;
    await page.route('**/api/library?*', async route => {
        if (heldRead) return route.continue();
        heldRead = true;
        const response = await route.fetch();
        await new Promise(resolve => { releaseRead = resolve; });
        await route.fulfill({ response });
    });
    const oldRead = page.evaluate(() => fetchHistory());
    await expect.poll(() => Boolean(releaseRead)).toBe(true);
    let releaseAck;
    await page.route('**/api/favorite/favorite-stale', async route => {
        const response = await route.fetch();
        await new Promise(resolve => { releaseAck = resolve; });
        await route.fulfill({ response });
    });
    await star(row).click();
    await expect.poll(() => Boolean(releaseAck)).toBe(true);
    releaseRead();
    await oldRead;
    await expect(star(row)).toHaveAttribute('aria-pressed', 'true');
    await expect(feedback(row)).toContainText('Saving favorite');
    // Simulate the same authorized read an SSE invalidation would trigger.
    await page.request.post('/api/favorite/favorite-stale', { data: { favorite: false } });
    await refresh(page);
    await expect(star(row)).toHaveAttribute('aria-pressed', 'true');
    releaseAck();
    await expect(feedback(row)).toBeEmpty();
    await expect(star(row)).toHaveAttribute('aria-pressed', 'false');
    await expect(star(row)).toBeFocused();
    expect(await ids(page)).toEqual(order);
    expect(await card(page, 'favorite-stale').count()).toBe(1);
});

test('unknown favorite recovery survives Info close and deliberately replays the exact attempt', async ({ page }) => {
    await ready(page, [{ id: 'favorite-unknown' }]);
    const row = card(page, 'favorite-unknown');
    const requests = [];
    await page.route('**/api/favorite/favorite-unknown', async route => {
        requests.push(route.request().postDataJSON());
        if (requests.length === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        await route.continue();
    });
    await openInfo(row);
    await row.locator('.favorite-toggle-inline').click();
    await expect(feedback(row)).toContainText(/not confirmed/i);
    await expect(page.locator('#tagMutationStatus')).toContainText(/not confirmed/i);
    for (const button of await row.locator('.favorite-toggle').all()) await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(feedback(row).getByRole('button', { name: 'Check save', exact: true })).toBeVisible();
    await row.getByRole('button', { name: 'Close info', exact: true }).click();
    await expect(page.locator('#favoriteMutationSummary')).toContainText(/not confirmed/i);
    await openInfo(row);
    await expect(feedback(row)).toContainText(/not confirmed/i);
    expect(requests).toHaveLength(1);
    await row.locator('.history-info-popover').getByRole('button', { name: 'Replay', exact: true }).click();
    await expect(feedback(row)).toBeEmpty();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    await expect(page.locator('#tagMutationStatus')).toContainText('Favorite saved');
    await expect(star(row)).toHaveAttribute('aria-pressed', 'true');
    await expect(row.locator('.history-info-popover')).toBeVisible();
});

test('a committed favorite with a lost response confirms through its receipt without replay', async ({ page }) => {
    await ready(page, [{ id: 'favorite-lost-response' }]);
    const row = card(page, 'favorite-lost-response');
    let writes = 0;
    await page.route('**/api/favorite/favorite-lost-response', async route => {
        writes++;
        await route.fetch();
        await route.abort('failed');
    });
    await star(row).click();
    await expect(feedback(row)).toBeEmpty();
    await expect(star(row)).toHaveAttribute('aria-pressed', 'true');
    expect(writes).toBe(1);
    const saved = (await (await page.request.get('/api/library?include_order=true')).json()).items.find(item => item.id === 'favorite-lost-response');
    expect(saved.favorite_revision).toBe('1');
});

test('favorite conflict pauses only its domain and retries as a new attempt after an authorized read', async ({ page }) => {
    await ready(page, [{ id: 'favorite-conflict' }, { id: 'favorite-conflict-other' }]);
    const row = card(page, 'favorite-conflict');
    let release;
    const requests = [];
    await page.route('**/api/favorite/favorite-conflict', async route => {
        requests.push(route.request().postDataJSON());
        if (requests.length === 1) await new Promise(resolve => { release = resolve; });
        await route.continue();
    });
    await star(row).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.request.post('/api/favorite/favorite-conflict', { data: { favorite: true } });
    await page.request.post('/api/favorite/favorite-conflict', { data: { favorite: false } });
    release();
    await expect(feedback(row)).toContainText(/changed elsewhere/i);
    await star(card(page, 'favorite-conflict-other')).click();
    await expect(feedback(card(page, 'favorite-conflict-other'))).toBeEmpty();
    expect(requests).toHaveLength(1);
    await row.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(feedback(row)).toBeEmpty();
    expect(requests).toHaveLength(2);
    expect(requests[1].client_mutation_id).not.toBe(requests[0].client_mutation_id);
    expect(requests[1].expected_revision).toBe('2');
    await expect(star(row)).toHaveAttribute('aria-pressed', 'true');
});

for (const theme of ['light', 'dark']) {
    test(`favorite keyboard feedback honors ${theme} theme and reduced motion`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await ready(page, [{ id: `favorite-accessibility-${theme}` }]);
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        const row = card(page, `favorite-accessibility-${theme}`);
        const gate = gateFavorite(page, `favorite-accessibility-${theme}`);
        await gate.installed;
        await star(row).focus();
        await star(row).press('Space');
        await expect(star(row)).toHaveAttribute('aria-pressed', 'true');
        await expect(star(row)).toBeFocused();
        await expect(feedback(row)).toContainText('Saving favorite');
        await expect(feedback(row)).toHaveCSS('animation-name', 'none');
        await releaseNext(gate);
        await expect(feedback(row)).toBeEmpty();
        await expect(star(row)).toBeFocused();
    });
}

test('an unstarred filtered card stays in place until focus leaves the interaction', async ({ page }) => {
    await ready(page, [{ id: 'favorite-filter-target' }, { id: 'favorite-filter-other' }]);
    for (const id of ['favorite-filter-target', 'favorite-filter-other']) {
        await page.request.post(`/api/favorite/${id}`, { data: { favorite: true } });
    }
    await refresh(page);
    await page.locator('#historySearchToggle').click();
    await page.locator('#historySearchInput').fill('star:yes');
    const row = card(page, 'favorite-filter-target');
    const order = await ids(page);
    const gate = gateFavorite(page, 'favorite-filter-target');
    await gate.installed;
    await star(row).click();
    await expect(star(row)).toHaveAttribute('aria-pressed', 'false');
    expect(await ids(page)).toEqual(order);
    await releaseNext(gate);
    await expect(feedback(row)).toBeEmpty();
    await expect(row).toBeVisible();
    await expect(star(row)).toBeFocused();
    await page.locator('#historySearchInput').hover();
    await page.locator('#historySearchInput').focus();
    await expect(row).toHaveCount(0);
    await expect(card(page, 'favorite-filter-other')).toBeVisible();
});

test('favorite projections preserve rotation membership and Current controls use the same protocol', async ({ page }) => {
    await ready(page, [{ id: 'favorite-rotation-a' }, { id: 'favorite-rotation-b' }, { id: 'favorite-current', status: 'cancelled' }]);
    await page.request.post('/api/preferences', { data: { library_rotation_enabled: true, library_rotation_hours: 24 } });
    await refresh(page);
    const order = await ids(page);
    const membership = await (await page.request.get('/api/library?include_order=true')).json();
    const rotating = card(page, 'favorite-rotation-a');
    const rotationGate = gateFavorite(page, 'favorite-rotation-a');
    await rotationGate.installed;
    await star(rotating).evaluate(element => { window.favoriteRotationCard = element.closest('[data-row-id]'); });
    await star(rotating).click();
    await expect.poll(() => rotationGate.requests.length).toBe(1);
    await seed(page, { id: 'favorite-rotation-new', status: 'finished' });
    // Renewing the duration forces a new authoritative membership generation.
    await page.request.post('/api/preferences', { data: { library_rotation_hours: 2 } });
    const after = await (await page.request.get('/api/library?include_order=true')).json();
    expect(after.items.map(item => item.id)).not.toEqual(membership.items.map(item => item.id));
    await refresh(page);
    expect(await ids(page)).toEqual(order);
    await expect(card(page, 'favorite-rotation-new')).toHaveCount(0);
    await expect(star(rotating)).toBeFocused();
    expect(await rotating.evaluate(element => element === window.favoriteRotationCard)).toBe(true);
    await releaseNext(rotationGate);
    await expect(feedback(rotating)).toBeEmpty();
    expect(await ids(page)).toEqual(order);
    await page.locator('#accountMenuButton').hover();
    await page.locator('#accountMenuButton').focus();
    await expect.poll(() => ids(page)).toEqual(after.items.map(item => item.id));
    await expect(card(page, 'favorite-rotation-new')).toBeVisible();
    await openCurrent(page);
    const current = card(page, 'favorite-current');
    const gate = gateFavorite(page, 'favorite-current');
    await gate.installed;
    await star(current).click();
    await expect(star(current)).toHaveAttribute('aria-pressed', 'true');
    await expect(feedback(current)).toContainText('Saving favorite');
    await releaseNext(gate);
    await expect(feedback(current)).toBeEmpty();
});

test('deletion and authentication reset fence late favorite acknowledgements', async ({ page }) => {
    await ready(page, [{ id: 'favorite-deleted' }, { id: 'favorite-old-account' }]);
    const gate = gateFavorite(page, 'favorite-deleted');
    await gate.installed;
    await star(card(page, 'favorite-deleted')).click();
    await expect.poll(() => gate.requests.length).toBe(1);
    expect((await page.request.post('/api/remove/favorite-deleted')).ok()).toBeTruthy();
    await releaseNext(gate);
    await expect(card(page, 'favorite-deleted')).toHaveCount(0);
    const accountGate = gateFavorite(page, 'favorite-old-account');
    await accountGate.installed;
    await star(card(page, 'favorite-old-account')).click();
    await expect.poll(() => accountGate.requests.length).toBe(1);
    await page.evaluate(() => resetTagSession());
    await releaseNext(accountGate);
    await expect.poll(() => page.evaluate(() => tagMutations.hasPending())).toBe(false);
    expect(await page.evaluate(() => tagState.selectDownload('favorite-old-account'))).toBeNull();
});


test('recovery after access loss fences the favorite and discloses no saved value', async ({ page, request }) => {
    await ready(page, [{ id: 'favorite-revoked' }]);
    const created = await page.request.post('/api/users', { data: {
        username: 'favorite-reader', name: 'Favorite Reader', password: 'reader-password', role: 'normal',
    } });
    expect(created.ok()).toBeTruthy();
    await request.post('/login', { form: { username: 'admin', password: 'browser-test-password' } });
    await switchAccount(page, 'favorite-reader', 'reader-password');
    await expect.poll(() => page.evaluate(() => hasFavoriteProtocol())).toBe(true);
    const row = card(page, 'favorite-revoked');
    await expect(row).not.toHaveClass(/item-fade-in/);
    let mutationId;
    await page.route('**/api/favorite/favorite-revoked', async route => {
        mutationId = route.request().postDataJSON().client_mutation_id;
        await route.fetch();
        await route.abort('failed');
    });
    // Hold the receipt response so revocation happens before recovery authorization.
    const receiptReleases = [];
    await page.route('**/api/mutations/*', async route => {
        await new Promise(resolve => { receiptReleases.push(resolve); });
        await route.continue();
    });
    await star(row).click();
    await expect.poll(() => receiptReleases.length).toBe(1);
    const revoked = await request.post('/api/visibility/favorite-revoked', { data: { visibility: 'private' } });
    expect(revoked.ok()).toBeTruthy();
    receiptReleases.shift()();
    await expect(feedback(row)).toContainText(/not confirmed/i);
    await feedback(row).getByRole('button', { name: 'Check save', exact: true }).click();
    await expect.poll(() => receiptReleases.length).toBe(1);
    receiptReleases.shift()();
    await expect(row).toHaveCount(0);
    expect(await page.evaluate(() => tagState.selectDownload('favorite-revoked'))).toBeNull();
    const denied = await page.request.get(`/api/mutations/${mutationId}`);
    expect(denied.status()).toBe(404);
    expect(await denied.json()).not.toHaveProperty('favorite');
});

test('switching accounts clears an old private favorite and ignores its late acknowledgement', async ({ page }) => {
    await ready(page, [{ id: 'favorite-account-private', visibility: 'private' }]);
    expect((await page.request.post('/api/users', { data: {
        username: 'favorite-next-account', name: 'Next Favorite Account', password: 'next-password', role: 'normal',
    } })).ok()).toBeTruthy();
    let releaseAck;
    await page.route('**/api/favorite/favorite-account-private', async route => {
        const response = await route.fetch();
        await new Promise(resolve => { releaseAck = resolve; });
        await route.fulfill({ response }).catch(() => {});
    });
    await star(card(page, 'favorite-account-private')).click();
    await expect.poll(() => Boolean(releaseAck)).toBe(true);
    await switchAccount(page, 'favorite-next-account', 'next-password');
    releaseAck();
    await expect(page.locator('#currentUsername')).toHaveText('favorite-next-account');
    await expect(card(page, 'favorite-account-private')).toHaveCount(0);
    expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
    expect(await page.evaluate(() => tagState.selectDownload('favorite-account-private'))).toBeNull();
});


test('queued favorites can be discarded while an unknown transmitted save remains recoverable', async ({ page }) => {
    await ready(page, [{ id: 'favorite-discard-queued' }]);
    const row = card(page, 'favorite-discard-queued');
    const requests = [];
    await page.route('**/api/favorite/favorite-discard-queued', async route => {
        requests.push(route.request().postDataJSON());
        if (requests.length === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        await route.continue();
    });
    await star(row).click();
    await expect(feedback(row)).toContainText(/not confirmed/i);
    await star(row).click();
    await star(row).click();
    await expect(feedback(row).getByRole('button', { name: 'Discard queued favorite removal', exact: true })).toBeVisible();
    await expect(feedback(row).getByRole('button', { name: 'Discard queued favorite add', exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
    await feedback(row).getByRole('button', { name: 'Discard queued favorite removal', exact: true }).click();
    await expect(star(row)).toHaveAttribute('aria-pressed', 'true');
    await feedback(row).getByRole('button', { name: 'Discard queued favorite add', exact: true }).click();
    await expect(feedback(row).getByRole('button', { name: /Discard queued favorite/ })).toHaveCount(0);
    await feedback(row).getByRole('button', { name: 'Use current favorite', exact: true }).click();
    await expect(page.locator('#tagMutationStatus')).toContainText('may still complete');
    await expect(feedback(row)).toContainText(/not confirmed/i);
    expect(requests).toHaveLength(1);
    await feedback(row).getByRole('button', { name: 'Replay', exact: true }).click();
    await expect(feedback(row)).toBeEmpty();
    await expect(page.locator('#tagMutationStatus')).toContainText('Favorite saved');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
});

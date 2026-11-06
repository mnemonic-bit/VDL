const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openSettings, holdNativeMedia } = require('./support.cjs');

test.beforeEach(async ({ page }) => reset(page));

async function enableRotation(page, hours = 24) {
    const response = await page.request.post('/api/preferences', {
        data: { library_rotation_enabled: true, library_rotation_hours: hours },
    });
    expect(response.ok()).toBeTruthy();
    await refresh(page);
    await expect(page.locator('#libraryRotationStatus')).toBeVisible();
    return (await (await page.request.get('/api/library?include_order=true')).json());
}

async function cardIds(page) {
    return page.locator('#historyList [data-row-id]').evaluateAll(cards => cards.map(card => card.dataset.rowId));
}

test('rotation Settings save hours, retain disabled duration, and appear in search', async ({ page }) => {
    await seed(page, { id: 'rotation-settings', status: 'finished' });
    await openSettings(page);
    await page.locator('#settingsSearchInput').fill('daily');
    await expect(page.locator('#prefLibraryRotation')).toBeVisible();
    await expect(page.locator('#prefLibraryRotationHours')).toBeDisabled();
    await page.locator('#prefLibraryRotation').check();
    await expect(page.locator('#prefLibraryRotationHours')).toBeEnabled();
    await page.locator('#prefLibraryRotationHours').fill('3');
    await page.locator('#saveBtn').click();
    await expect(page.locator('#saveBtn')).toContainText('Saved');
    await expect.poll(async () => (await (await page.request.get('/api/preferences')).json()).library_rotation_hours).toBe('3');
    await page.evaluate(() => closeSettings());
    await expect(page.locator('#libraryRotationStatus')).toContainText('Library rotation · renews');
    await expect(page.locator('#libraryRotationExpiry')).toHaveAttribute('datetime', /T/);
    await openSettings(page);
    await page.locator('#prefLibraryRotation').uncheck();
    await expect(page.locator('#prefLibraryRotationHours')).toBeDisabled();
    await expect(page.locator('#prefLibraryRotationHours')).toHaveValue('3');
    await expect(page.locator('#saveBtn')).toBeEnabled();
    await page.locator('#saveBtn').click();
    await expect.poll(async () => (await (await page.request.get('/api/preferences')).json()).library_rotation_enabled).toBe('false');
    await page.evaluate(() => closeSettings());
    await expect(page.locator('#libraryRotationStatus')).toBeHidden();
});

test('rotation retains server order across favorites, search, reload, and waiting arrivals', async ({ page }) => {
    for (let index = 0; index < 7; index += 1) {
        await seed(page, { id: `rotation-${index}`, status: 'finished', title: index % 2 ? 'Other video' : 'Matching video' });
    }
    const snapshot = await enableRotation(page);
    const expected = snapshot.items.map(item => item.id);
    await expect.poll(() => cardIds(page)).toEqual(expected);
    const first = page.locator(`#historyList [data-row-id="${expected[0]}"]`);
    await first.locator('[data-favorite-action]').click();
    await refresh(page);
    await expect.poll(() => cardIds(page)).toEqual(expected);
    await page.evaluate(() => {
        historySearchInput.value = 'Matching';
        historySearchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const matches = snapshot.items.filter(item => item.title === 'Matching video').map(item => item.id);
    await expect.poll(() => cardIds(page)).toEqual(matches);
    await page.evaluate(() => {
        historySearchInput.value = '';
        historySearchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await seed(page, { id: 'rotation-new-arrival', status: 'finished' });
    await refresh(page);
    await expect.poll(() => cardIds(page)).toEqual(expected);
    await page.reload();
    await expect.poll(() => cardIds(page)).toEqual(expected);
});

test('empty rotation has its own message and new videos wait until renewal', async ({ page }) => {
    await enableRotation(page);
    await expect(page.locator('#historyEmptyTitle')).toHaveText('No videos in the current rotation.');
    await expect(page.locator('#historyEmptyMessage')).toHaveText('New videos join the next rotation.');
    await seed(page, { id: 'rotation-waiting', status: 'finished' });
    await refresh(page);
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(0);
    await page.request.post('/api/preferences', { data: { library_rotation_hours: 2 } });
    await expect(page.locator('#historyList [data-row-id="rotation-waiting"]')).toBeVisible();
});

test('a stale launch refreshes and offers retry without loading media or counting a view', async ({ page }) => {
    await seed(page, { id: 'rotation-stale-launch', status: 'finished' });
    await enableRotation(page);
    await holdNativeMedia(page);
    await page.route('**/api/playback-sessions', async route => {
        expect(route.request().postDataJSON().generation_id).toBeTruthy();
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
            code: 'rotation_generation_changed', error: 'The Library rotation changed.',
        }) });
    });
    await page.locator('#endlessPlaybackButton').click();
    await expect(page.locator('#playerBackdrop')).toContainText('The Library rotation changed. Retry');
    await expect(page.locator('#playerVideo source')).toHaveCount(0);
    const rows = await (await page.request.get('/api/library')).json();
    expect(rows[0].view_count).toBe(0);
    await expect(page.locator('#playerBackdrop').getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
});

test('renewal resets video pagination once, keeps search, and preserves nodes during the same generation', async ({ page }) => {
    for (let index = 0; index < 12; index += 1) {
        await seed(page, { id: `rotation-page-${index}`, status: 'finished', title: 'Matching video' });
    }
    await page.request.post('/__test__/preferences', { data: { history_page_size: '5' } });
    await page.evaluate(() => loadPreferences());
    await enableRotation(page);
    await page.evaluate(() => {
        historySearchInput.value = 'Matching';
        historySearchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('#pagerNext').click();
    await expect(page.locator('#pagerInfo')).toContainText('Page 2 of 3');
    await page.evaluate(() => { window.__rotationCard = document.querySelector('#historyList [data-row-id]'); });
    await refresh(page);
    expect(await page.evaluate(() => document.querySelector('#historyList [data-row-id]') === window.__rotationCard)).toBe(true);
    await expect(page.locator('#pagerInfo')).toContainText('Page 2 of 3');
    await page.request.post('/api/preferences', { data: { library_rotation_hours: 2 } });
    await expect(page.locator('#pagerInfo')).toContainText('Page 1 of 3');
    expect(await page.evaluate(() => historySearchInput.value)).toBe('Matching');
    const next = await (await page.request.get('/api/library?include_order=true')).json();
    await expect.poll(() => cardIds(page)).toEqual(next.items.slice(0, 5).map(item => item.id));
    await page.locator('#pagerNext').click();
    await refresh(page);
    await expect(page.locator('#pagerInfo')).toContainText('Page 2 of 3');
});

test('a generation change waits for inline rename to finish', async ({ page }) => {
    await seed(page, { id: 'rotation-edit', status: 'finished' });
    const before = await enableRotation(page);
    const row = page.locator('[data-row-id="rotation-edit"]');
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Info', exact: true }).click();
    await row.getByRole('button', { name: 'Edit name', exact: true }).click();
    const input = page.locator('[data-rename-id="rotation-edit"] .rename-input');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await input.fill('An unfinished name');
    const epoch = await page.evaluate(() => libraryRequestEpoch);
    await page.request.post('/api/preferences', { data: { library_rotation_hours: 2 } });
    await expect.poll(() => page.evaluate(() => libraryRequestEpoch)).toBeGreaterThan(epoch);
    await refresh(page);
    expect(await page.evaluate(() => libraryOrder.generation_id)).toBe(before.order.generation_id);
    await expect(input).toHaveValue('An unfinished name');
    await input.press('Escape');
    await expect(input).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => libraryOrder.generation_id)).not.toBe(before.order.generation_id);
});

test('an old in-flight Library response cannot restore a superseded generation', async ({ page }) => {
    await seed(page, { id: 'rotation-inflight', status: 'finished' });
    const before = await enableRotation(page);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let captured = false;
    await page.route('**/api/library?include_order=true', async route => {
        if (captured) { await route.continue(); return; }
        captured = true;
        await gate;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(before) });
    });
    try {
        await page.evaluate(() => { void fetchHistory(); });
        await expect.poll(() => captured).toBe(true);
        const epoch = await page.evaluate(() => libraryRequestEpoch);
        await page.request.post('/api/preferences', { data: { library_rotation_hours: 2 } });
        await expect.poll(() => page.evaluate(() => libraryRequestEpoch)).toBeGreaterThan(epoch);
    } finally { release(); }
    await expect.poll(() => page.evaluate(() => libraryOrder.generation_id)).not.toBe(before.order.generation_id);
    const current = await (await page.request.get('/api/library?include_order=true')).json();
    expect(await page.evaluate(() => libraryOrder.generation_id)).toBe(current.order.generation_id);
});

async function installRotationPlayerHarness(page) {
    await holdNativeMedia(page);
    await page.evaluate(() => {
        Object.defineProperty(document, 'fullscreenElement', {
            configurable: true, get: () => window.__rotationFullscreen || null,
        });
        Element.prototype.requestFullscreen = function requestFullscreen() {
            window.__rotationFullscreen = this;
            document.dispatchEvent(new Event('fullscreenchange'));
            return Promise.resolve();
        };
        HTMLMediaElement.prototype.load = function load() {};
        HTMLMediaElement.prototype.pause = function pause() {};
        HTMLMediaElement.prototype.play = function play() {
            queueMicrotask(() => this.dispatchEvent(new Event('playing')));
            return Promise.resolve();
        };
    });
}

test('real renewal and disabling change the next handoff while current video and fullscreen remain intact', async ({ page }) => {
    for (let index = 0; index < 3; index += 1) {
        await seed(page, { id: `rotation-handoff-${index}`, status: 'finished' });
    }
    await enableRotation(page);
    await installRotationPlayerHarness(page);
    await page.evaluate(() => { startVideosFullscreen = true; });
    await page.locator('#endlessPlaybackButton').click();
    await expect.poll(() => page.evaluate(() => endlessPlayback.sessionId)).not.toBeNull();
    const current = await page.evaluate(() => endlessPlayback.currentDownloadId);
    await page.evaluate(() => { window.__rotationPlayerNode = document.getElementById('playerVideo'); });
    const oldGeneration = await page.evaluate(() => libraryOrder.generation_id);
    await page.request.post('/api/preferences', { data: { library_rotation_hours: 2 } });
    await expect.poll(() => page.evaluate(() => libraryOrder.generation_id)).not.toBe(oldGeneration);
    expect(await page.evaluate(() => endlessPlayback.currentDownloadId)).toBe(current);
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', `/api/file/${current}`);
    expect(await page.evaluate(() => document.fullscreenElement.id)).toBe('playerContainer');
    expect(await page.evaluate(() => document.getElementById('playerVideo') === window.__rotationPlayerNode)).toBe(true);
    const renewed = await (await page.request.get('/api/library?include_order=true')).json();
    const renewedIds = renewed.items.map(item => item.id);
    const next = renewedIds[(renewedIds.indexOf(current) + 1) % renewedIds.length];
    await page.evaluate(() => advanceEndlessPlayback());
    await expect.poll(() => page.evaluate(() => endlessPlayback.currentDownloadId)).toBe(next);
    await page.request.post('/api/preferences', { data: { library_rotation_enabled: false } });
    await expect(page.locator('#libraryRotationStatus')).toBeHidden();
    expect(await page.evaluate(() => endlessPlayback.currentDownloadId)).toBe(next);
    const ordinary = await (await page.request.get('/api/library')).json();
    const ordinaryIds = ordinary.map(item => item.id);
    const following = ordinaryIds[(ordinaryIds.indexOf(next) + 1) % ordinaryIds.length];
    await page.evaluate(() => advanceEndlessPlayback());
    await expect.poll(() => page.evaluate(() => endlessPlayback.currentDownloadId)).toBe(following);
    expect(await page.evaluate(() => document.fullscreenElement.id)).toBe('playerContainer');
    expect(await page.evaluate(() => document.getElementById('playerVideo') === window.__rotationPlayerNode)).toBe(true);
});

test('a real disabled-to-enabled stale launch waits for acceptance before media and views', async ({ page }) => {
    await seed(page, { id: 'rotation-disabled-stale', status: 'finished' });
    await page.addInitScript(() => { window.EventSource = class extends EventTarget {}; });
    await page.reload();
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(1);
    expect(await page.evaluate(() => libraryOrder.kind)).toBe('library');
    const saved = await page.request.post('/api/preferences', { data: { library_rotation_enabled: true } });
    expect(saved.ok()).toBeTruthy();
    await holdNativeMedia(page);
    const conflict = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/playback-sessions' && response.request().method() === 'POST');
    await page.locator('#endlessPlaybackButton').click();
    expect((await conflict).status()).toBe(409);
    await expect(page.locator('#playerBackdrop')).toContainText('The Library rotation changed. Retry');
    await expect(page.locator('#playerVideo source')).toHaveCount(0);
    const rows = await (await page.request.get('/api/library')).json();
    expect(rows[0].view_count).toBe(0);
    await expect(page.locator('#libraryRotationStatus')).toBeVisible();
});

test('rotation controls fit a narrow dark Settings view and keyboard editing', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSettings(page);
    await page.evaluate(() => applyTheme('dark'));
    await page.locator('#settingsSearchInput').fill('rotation');
    const checkbox = page.locator('#prefLibraryRotation');
    await checkbox.focus();
    await page.keyboard.press('Space');
    await expect(checkbox).toBeChecked();
    const hours = page.locator('#prefLibraryRotationHours');
    await hours.focus();
    await hours.fill('48');
    await expect(hours).toHaveValue('48');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('renewal discards provisional standby media even when the successor ID stays the same', async ({ page }) => {
    await seed(page, { id: 'rotation-one-standby', status: 'finished' });
    await enableRotation(page);
    await installRotationPlayerHarness(page);
    await page.locator('#endlessPlaybackButton').click();
    await expect.poll(() => page.evaluate(() => endlessPlayback.sessionId)).not.toBeNull();
    await page.evaluate(async () => {
        const response = await apiFetch(`/api/playback-sessions/${endlessPlayback.sessionId}/prepare`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expected_download_id: endlessPlayback.currentDownloadId, sequence: 1 }),
        });
        const prepared = await response.json();
        playerPreparation = {
            epoch: endlessPlayback.epoch, generation: endlessPlayback.loadGeneration,
            sessionId: endlessPlayback.sessionId, expectedId: endlessPlayback.currentDownloadId,
            sequence: 1, order: prepared.order, item: prepared.item,
            outgoing: document.getElementById('playerVideo'), incoming: document.getElementById('playerStandby'),
            controller: new AbortController(), outgoingItem: endlessPlayback.currentItem,
        };
        loadPreparedPlayer(playerPreparation, prepared.item);
    });
    await expect(page.locator('#playerStandby source')).toHaveCount(1);
    await page.request.post('/api/preferences', { data: { library_rotation_hours: 2 } });
    await page.evaluate(() => commitPlayerFade(playerPreparation));
    expect(await page.evaluate(() => playerPreparation.disabled)).toBe(true);
    expect(await page.evaluate(() => Boolean(playerPreparation.fade))).toBe(false);
    await expect(page.locator('#playerStandby source')).toHaveCount(0);
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', '/api/file/rotation-one-standby');
    await page.evaluate(() => usePreparedPlayerHandoff());
    await expect.poll(() => page.evaluate(() => endlessPlayback.sequence)).toBe(1);
    expect(await page.evaluate(() => endlessPlayback.currentDownloadId)).toBe('rotation-one-standby');
});

test('an empty rotation still explains waiting videos alongside a personal playlist shelf', async ({ page }) => {
    await enableRotation(page);
    await seed(page, { id: 'rotation-playlist-waiting', status: 'finished', title: 'Waiting member' });
    const created = await page.request.post('/api/playlists', {
        data: { name: 'Waiting playlist', download_ids: ['rotation-playlist-waiting'] },
    });
    expect(created.status()).toBe(201);
    await refresh(page);
    await page.evaluate(() => fetchPlaylists());
    await expect(page.locator('#playlistShelf')).toBeVisible();
    await expect(page.locator('#historyEmptyTitle')).toBeVisible();
    await expect(page.locator('#historyEmptyTitle')).toHaveText('No videos in the current rotation.');
    await page.evaluate(() => {
        historySearchInput.value = 'Waiting';
        historySearchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('.playlist-card', { hasText: 'Waiting playlist' })).toBeVisible();
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(0);
});

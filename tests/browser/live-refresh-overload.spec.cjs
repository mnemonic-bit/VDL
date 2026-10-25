const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openCurrent, openNewDownload } = require('./support.cjs');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test.beforeEach(async ({ page }) => reset(page));

test('progress bursts and manual refreshes share one outstanding request per collection', async ({ page }) => {
    await seed(page, { id: 'bounded-progress', status: 'downloading', progress: '1%', downloaded_bytes: 1, total_bytes: 100 });
    await page.evaluate(() => Promise.all([fetchHistory(), fetchPlaylists()]));
    const gate = deferred();
    const counts = { library: 0, 'current-downloads': 0, playlists: 0 };
    for (const collection of Object.keys(counts)) {
        await page.route(`**/api/${collection}`, async route => {
            counts[collection]++;
            await gate.promise;
            await route.continue();
        });
    }
    try {
        await page.evaluate(() => { void fetchHistory(); void fetchPlaylists(); });
        await expect.poll(() => Object.values(counts).every(count => count > 0)).toBe(true);
        for (let progress = 2; progress <= 5; progress++) {
            await seed(page, { id: 'bounded-progress', status: 'downloading', progress: `${progress}%`, downloaded_bytes: progress, total_bytes: 100 });
            await page.evaluate(() => { void fetchHistory(); void fetchPlaylists(); });
            // Separate events by more than the progress coalescing interval.
            await page.waitForTimeout(180);
        }
        expect(counts).toEqual({ library: 1, 'current-downloads': 1, playlists: 1 });
    } finally {
        gate.resolve();
    }
    await refresh(page);
    await openCurrent(page);
    await expect(page.locator('#activeList [data-row-id="bounded-progress"]')).toContainText('5%');
});

test('a queued download accepted through the form appears while Library is delayed', async ({ page }) => {
    const gate = deferred();
    await page.request.post('/__test__/preferences', { data: { max_concurrent: '1' } });
    await page.request.post('/__test__/hold-downloads');
    const first = await page.request.post('/api/download', { data: { url: 'https://fixture.invalid/running-first' } });
    expect(first.ok()).toBe(true);
    await refresh(page);
    await page.route('**/api/library', async route => {
        await gate.promise;
        await route.continue();
    });
    try {
        await page.evaluate(() => { void fetchHistory(); });
        await openNewDownload(page);
        await page.locator('#urlInput').fill('https://fixture.invalid/accepted-queued');
        await expect(page.locator('#downloadSubmit')).toBeEnabled();
        const acceptedResponse = page.waitForResponse(response =>
            response.url().endsWith('/api/download') && response.request().method() === 'POST');
        await page.locator('#downloadSubmit').click();
        const response = await acceptedResponse;
        expect(response.ok()).toBe(true);
        const accepted = await response.json();
        const current = await page.request.get('/api/current-downloads');
        const queued = (await current.json()).find(row => row.id === accepted.id);
        expect(queued).toMatchObject({ status: 'starting', progress: 'Waiting for a download slot' });
        await expect(page.locator('#newDownloadDialog')).toBeHidden();
        await expect(page.locator('#currentDownloadsButton')).toBeVisible();
        await expect(page.locator('#currentBadge')).toHaveText('2');
        await openCurrent(page);
        await expect(page.locator(`#activeList [data-row-id="${accepted.id}"]`)).toBeVisible();
    } finally {
        gate.resolve();
        await page.request.post('/__test__/release-downloads');
    }
});

test('progress refresh preserves an unchanged Library thumbnail and its active hover preview', async ({ page }) => {
    await page.evaluate(() => {
        HTMLMediaElement.prototype.load = function () {};
        HTMLMediaElement.prototype.pause = function () {};
        HTMLMediaElement.prototype.play = function () {
            this.dispatchEvent(new Event('playing'));
            return Promise.resolve();
        };
    });
    await page.route('**/api/thumbnail/stable-preview*', route => route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="green"/></svg>',
    }));
    await seed(page, { id: 'other-library-card', status: 'finished', title: 'Other Library card' });
    await seed(page, { id: 'stable-preview', status: 'finished', thumbnail: true, montage: true, title: 'Stable Library card' });
    await seed(page, { id: 'changing-progress', status: 'downloading', progress: '1%' });
    await refresh(page);
    const preview = page.locator('#historyList [data-row-id="stable-preview"] .history-preview');
    await preview.hover();
    await expect(preview).toHaveClass(/preview-playing/);
    await preview.evaluate(element => {
        window.__retainedPreview = element;
        window.__retainedThumbnail = element.querySelector('img');
        window.__retainedVideo = element.querySelector('video');
        window.__retainedPreviewSource = window.__retainedVideo.getAttribute('src');
    });
    await seed(page, { id: 'changing-progress', status: 'downloading', progress: '35%' });
    await refresh(page);
    await seed(page, { id: 'other-library-card', status: 'finished', title: 'Updated other card' });
    await seed(page, { id: 'stable-preview', status: 'finished', thumbnail: true, montage: true, title: 'Updated active preview title' });
    await refresh(page);
    await expect(page.locator('#historyList [data-row-id="other-library-card"]')).toContainText('Updated other card');
    await expect(page.locator('#historyList [data-row-id="stable-preview"]')).toContainText('Updated active preview title');
    expect(await preview.evaluate(element => ({
        samePreview: element === window.__retainedPreview,
        sameImage: element.querySelector('img') === window.__retainedThumbnail,
        sameVideo: element.querySelector('video') === window.__retainedVideo,
        sameSource: element.querySelector('video').getAttribute('src') === window.__retainedPreviewSource,
    }))).toEqual({ samePreview: true, sameImage: true, sameVideo: true, sameSource: true });
    await expect(preview).toHaveClass(/preview-playing/);
});

test('a pending refresh performs one follow-up and finishes with the latest Current snapshot', async ({ page }) => {
    await page.addInitScript(() => { window.EventSource = class extends EventTarget {}; });
    await page.reload();
    await refresh(page);
    const gate = deferred();
    let requests = 0;
    await page.route('**/api/current-downloads', async route => {
        const requestNumber = ++requests;
        if (requestNumber === 1) {
            await gate.promise;
            await route.fulfill({ contentType: 'application/json', body: '[]' });
        } else await route.continue();
    });
    try {
        await page.evaluate(() => { void fetchHistory(); });
        await expect.poll(() => requests).toBe(1);
        await seed(page, { id: 'latest-current', status: 'downloading', progress: '42%', downloaded_bytes: 42, total_bytes: 100 });
        await page.evaluate(() => { void fetchHistory(); void fetchHistory(); });
        await page.waitForTimeout(100);
        expect(requests).toBe(1);
    } finally {
        // The second request must wait for this release; awaiting it earlier
        // would deadlock the serialized refresh behavior this test requires.
        gate.resolve();
    }
    await expect.poll(() => requests).toBe(2);
    await expect(page.locator('#currentDownloadsButton')).toBeVisible();
    await openCurrent(page);
    await expect(page.locator('#activeList [data-row-id="latest-current"]')).toContainText('42%');
    expect(requests).toBe(2);
});

test('initial Library failures show loading then error, preserve Current, and recover', async ({ page }) => {
    await seed(page, { id: 'failed-library-item', status: 'finished' });
    await seed(page, { id: 'independent-current', status: 'downloading' });
    await page.addInitScript(() => { window.EventSource = class extends EventTarget {}; });
    await page.clock.install();
    const gate = deferred();
    let requests = 0;
    await page.route('**/api/library', async route => {
        requests++;
        await gate.promise;
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Library unavailable"}' });
    });
    try {
        await page.reload();
        await expect.poll(() => requests).toBeGreaterThan(0);
        await expect(page.locator('#historyEmptyTitle')).toContainText(/loading/i);
        await expect(page.locator('#historyEmptyAction')).toBeHidden();
        await expect(page.locator('#currentBadge')).toHaveText('1');
    } finally {
        gate.resolve();
    }
    await expect(page.locator('#historyEmptyTitle')).toContainText(/could not|failed|unavailable/i);
    await expect(page.locator('#actionError')).toBeVisible();
    await page.evaluate(() => checkHealth());
    await expect(page.locator('#actionError')).toBeVisible();
    for (let attempt = 2; attempt <= 3; attempt++) {
        await page.clock.fastForward(2000);
        await expect.poll(() => requests).toBeGreaterThanOrEqual(attempt);
    }
    await page.clock.fastForward(60_000);
    expect(requests).toBe(3);
    await page.unroute('**/api/library');
    await refresh(page);
    await expect(page.locator('#historyList [data-row-id="failed-library-item"]')).toBeVisible();
    await expect(page.locator('#actionError')).toBeHidden();
});

test('a transient initial collection failure retries without requiring a new change event', async ({ page }) => {
    test.setTimeout(20_000);
    await seed(page, { id: 'retry-library-item', status: 'finished' });
    await page.addInitScript(() => { window.EventSource = class extends EventTarget {}; });
    let requests = 0;
    await page.route('**/api/library', async route => {
        if (++requests === 1) {
            await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Temporary Library failure"}' });
        } else await route.continue();
    });
    await page.reload();
    await expect(page.locator('#historyList [data-row-id="retry-library-item"]')).toBeVisible({ timeout: 10_000 });
    expect(requests).toBeGreaterThanOrEqual(2);
    expect(requests).toBeLessThanOrEqual(4);
    await expect(page.locator('#actionError')).toBeHidden();
});

test('retained Library controls remain usable after successful actions', async ({ page }) => {
    await seed(page, { id: 'retained-controls', status: 'finished' });
    await refresh(page);
    const row = page.locator('#historyList [data-row-id="retained-controls"]');
    const favorite = row.locator('.favorite-toggle');
    await favorite.click();
    await expect(favorite).toBeEnabled();
    await expect(favorite).toHaveAttribute('aria-pressed', 'true');
    await favorite.click();
    await expect(favorite).toBeEnabled();
    await expect(favorite).toHaveAttribute('aria-pressed', 'false');

    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Info', exact: true }).click();
    const visibility = row.getByLabel('Visibility');
    await visibility.selectOption('private');
    await expect(visibility).toBeEnabled();
    await expect(visibility).toHaveValue('private');
    await visibility.selectOption('public');
    await expect(visibility).toBeEnabled();
    await expect(visibility).toHaveValue('public');
});

test('delayed History refreshes retain a newer page and filter intent', async ({ page }) => {
    await page.addInitScript(() => { window.EventSource = class extends EventTarget {}; });
    await page.reload();
    for (let index = 0; index < 22; index++) {
        await seed(page, { id: `refresh-attempt-${index}`, status: 'error', title: `Refresh attempt ${index}` });
    }
    await page.locator('#accountMenuButton').click();
    await page.locator('#attemptHistoryButton').click();
    await expect(page.locator('#attemptHistoryStatus')).toHaveText('22 attempts');
    const first = deferred();
    const second = deferred();
    const requests = [];
    await page.route('**/api/history?*', async route => {
        const number = requests.push(new URL(route.request().url()).searchParams);
        const response = await route.fetch();
        if (number === 1) await first.promise;
        if (number === 2) await second.promise;
        await route.fulfill({ response });
    });
    try {
        await page.evaluate(() => { void fetchAttemptHistory(); });
        await expect.poll(() => requests.length).toBe(1);
        await page.locator('#attemptPageNext').click();
        expect(requests.length).toBe(1);
        first.resolve();
        await expect.poll(() => requests.length).toBe(2);
        expect(requests[1].get('page')).toBe('2');
        await page.locator('#attemptSearchToggle').click();
        await page.locator('#attemptSearchInput').fill('never-matches-this-fixture');
        expect(requests.length).toBe(2);
        second.resolve();
        await expect.poll(() => requests.length).toBe(3);
        expect(requests[2].get('page')).toBe('1');
        expect(requests[2].get('filter')).toBe('never-matches-this-fixture');
        await expect(page.locator('#attemptHistoryStatus')).toHaveText('No attempts match this filter.');
        await expect(page.locator('.attempt-row')).toHaveCount(0);
    } finally {
        first.resolve();
        second.resolve();
    }
});

test('undecodable ready thumbnails stop after bounded transport recovery without HEAD probes', async ({ page }) => {
    await page.clock.install();
    let gets = 0;
    let heads = 0;
    await page.route('**/api/thumbnail/corrupt-thumbnail*', async route => {
        if (route.request().method() === 'HEAD') heads++;
        else gets++;
        await route.fulfill({ status: 200, contentType: 'image/jpeg', body: 'not a decodable image' });
    });
    await seed(page, { id: 'corrupt-thumbnail', status: 'finished', thumbnail: true });
    await refresh(page);
    const preview = page.locator('#historyList [data-row-id="corrupt-thumbnail"] .history-preview');
    await expect(preview).toHaveClass(/thumbnail-unavailable/);
    for (let attempt = 1; attempt <= 3; attempt++) {
        await page.clock.fastForward(6000);
        await expect.poll(() => gets).toBeGreaterThanOrEqual(attempt + 1);
    }
    await page.clock.fastForward(60_000);
    expect(heads).toBe(0);
    expect(gets).toBe(4);
    await refresh(page);
    await page.clock.fastForward(60_000);
    expect(heads).toBe(0);
    expect(gets).toBe(4);
    await expect(preview).toHaveClass(/thumbnail-unavailable/);
});

const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, holdNativeMedia } = require('./support.cjs');
const durationCases = require('../fixtures/duration-filter-cases.json');

test.beforeEach(async ({ page }) => reset(page));

async function search(page, query) {
    const input = page.locator('#historySearchInput');
    if (!(await input.isVisible())) await page.locator('#historySearchToggle').click();
    await input.fill(query);
    return input;
}

async function expectVideoIds(page, ids) {
    await expect.poll(() => page.locator('#historyList [data-row-id]').evaluateAll(
        cards => cards.map(card => card.dataset.rowId).sort(),
    )).toEqual(ids.slice().sort());
}

async function seedVideo(page, id, duration, extra = {}) {
    return seed(page, {
        id, title: id, status: 'finished', duration_seconds: duration,
        resolution: '720p', media_metadata_probed: true, ...extra,
    });
}

async function createPlaylist(page, name, downloadIds) {
    const response = await page.request.post('/api/playlists', {
        data: { name, download_ids: downloadIds },
    });
    expect(response.status()).toBe(201);
    return response.json();
}

async function installMediaHarness(page) {
    await holdNativeMedia(page);
    await page.evaluate(() => {
        HTMLMediaElement.prototype.load = function load() {};
        HTMLMediaElement.prototype.pause = function pause() {};
        HTMLMediaElement.prototype.play = function play() {
            queueMicrotask(() => this.dispatchEvent(new Event('playing')));
            return Promise.resolve();
        };
    });
}

test('duration syntax and ranges match the shared server selection cases', async ({ page }) => {
    test.setTimeout(45_000);
    await page.request.post('/__test__/preferences', { data: { history_page_size: '20' } });
    for (const entry of durationCases.entries) {
        await seed(page, { ...entry, status: 'finished', media_metadata_probed: true });
    }
    await page.reload();
    await expect(page.locator('#prefPageSize')).toHaveValue('20');
    await expectVideoIds(page, durationCases.entries.map(entry => entry.id));

    for (const example of durationCases.cases) {
        await test.step(example.query, async () => {
            const input = await search(page, example.query);
            await expectVideoIds(page, example.expected_ids);
            await expect(input).toHaveAttribute('aria-invalid', String(!example.valid));
            if (example.valid) await expect(page.locator('#historySearchError')).toBeHidden();
            else await expect(page.locator('#historySearchError')).toBeVisible();
        });
    }
});

test('invalid duration input keeps focus and shows accessible feedback until corrected or cleared', async ({ page }) => {
    await seedVideo(page, 'feedback-middle', 450);
    await refresh(page);
    const input = await search(page, 'duration:>5m3s duration:<10m');
    await expectVideoIds(page, ['feedback-middle']);
    await expect(page.locator('#historySearchHint')).toContainText('duration:>5m3s');
    await expect(page.locator('#historySearchHint')).toContainText('duration:<10m');

    await input.fill('duration:>');
    await expect(input).toHaveValue('duration:>');
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveAttribute('aria-describedby', /\bhistorySearchError\b/);
    await expect(page.locator('#historySearchError')).toBeVisible();
    await expect(page.locator('#historySearchError')).toContainText('duration:');
    await expectVideoIds(page, []);
    await expect(page.locator('#endlessPlaybackButton')).toBeDisabled();
    await expect(page.locator('#actionError')).toBeHidden();

    await input.fill('duration:>=5m3s duration:<=10m0s');
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('aria-invalid', 'false');
    await expect(page.locator('#historySearchError')).toBeHidden();
    await expectVideoIds(page, ['feedback-middle']);
    await expect(page.locator('#endlessPlaybackButton')).toBeEnabled();

    await input.fill('duration:bad');
    await expect(page.locator('#historySearchError')).toBeVisible();
    await page.locator('#historySearchClear').click();
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('aria-invalid', 'false');
    await expect(page.locator('#historySearchError')).toBeHidden();
    await expectVideoIds(page, ['feedback-middle']);
});

test('duration filtering finds videos beyond the visible page and clears back to the first page', async ({ page }) => {
    await seedVideo(page, 'older-in-range', 450);
    for (let index = 0; index < 12; index += 1) {
        await seedVideo(page, `newer-short-${index}`, 120);
    }
    await refresh(page);
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(10);
    await expect(page.locator('[data-row-id="older-in-range"]')).toHaveCount(0);
    await page.locator('#pagerNext').click();
    await expect(page.locator('#pagerInfo')).toHaveText('Page 2 of 2 · 13 items');

    await search(page, 'duration:>5m3s duration:<10m');
    await expectVideoIds(page, ['older-in-range']);
    await expect(page.locator('#historyPager')).toBeHidden();
    await page.locator('#historySearchClear').click();
    await expect(page.locator('#historyList [data-row-id]')).toHaveCount(10);
    await expect(page.locator('#pagerInfo')).toHaveText('Page 1 of 2 · 13 items');
});

test('playlist duration matching requires one member satisfying the complete range', async ({ page }) => {
    await seedVideo(page, 'playlist-short', 200, { title: 'Tutorial short' });
    await seedVideo(page, 'playlist-also-short', 200, { title: 'Tutorial other short' });
    await seedVideo(page, 'playlist-long', 900, { title: 'Tutorial long' });
    await seedVideo(page, 'playlist-middle', 450, { title: 'Tutorial middle' });
    const selected = await createPlaylist(page, 'Matching member', ['playlist-middle', 'playlist-long']);
    await createPlaylist(page, 'Different bounds on different members', ['playlist-short', 'playlist-long']);
    await createPlaylist(page, 'Only the combined length matches', ['playlist-short', 'playlist-also-short']);
    await page.evaluate(() => Promise.all([fetchHistory(), fetchPlaylists()]));

    await search(page, 'tutorial duration:>5m3s duration:<10m');
    await expectVideoIds(page, ['playlist-middle']);
    await expect(page.locator('.playlist-card')).toHaveCount(1);
    await expect(page.locator(`.playlist-card[data-playlist-id="${selected.id}"]`)).toBeVisible();

    await search(page, 'playlist:yes duration:>5m3s duration:<10m');
    await expectVideoIds(page, []);
    await expect(page.locator('.playlist-card')).toHaveCount(1);
    const detail = await page.request.get(`/api/playlists/${selected.id}`);
    expect((await detail.json()).items.map(item => item.download_id || item.id))
        .toEqual(['playlist-middle', 'playlist-long']);

    await search(page, 'playlists:no duration:>5m3s duration:<10m');
    await expectVideoIds(page, ['playlist-middle']);
    await expect(page.locator('.playlist-card')).toHaveCount(0);
});

test('duration search reevaluates media metadata arriving in an ordinary refresh', async ({ page }) => {
    await seedVideo(page, 'late-duration', null);
    await refresh(page);
    await expectVideoIds(page, ['late-duration']);
    await search(page, 'duration:>5m3s duration:<10m');
    await expectVideoIds(page, []);

    await seedVideo(page, 'late-duration', 450);
    await refresh(page);
    await expectVideoIds(page, ['late-duration']);
    await seedVideo(page, 'late-duration', 900);
    await refresh(page);
    await expectVideoIds(page, []);
    await page.locator('#historySearchClear').click();
    await expectVideoIds(page, ['late-duration']);
});

test('Play All starts and hands off only between videos in the duration range', async ({ page }) => {
    await installMediaHarness(page);
    for (const [id, duration] of [
        ['range-low-bound', 303], ['range-inside-one', 350],
        ['range-inside-two', 450], ['range-high-bound', 600],
    ]) await seedVideo(page, id, duration);
    await refresh(page);
    const query = 'duration:>5m3s duration:<10m';
    await search(page, query);
    await expectVideoIds(page, ['range-inside-one', 'range-inside-two']);
    const createResponse = page.waitForResponse(response => (
        response.url().endsWith('/api/playback-sessions')
        && response.request().method() === 'POST'
    ));
    await page.locator('#endlessPlaybackButton').click();
    const response = await createResponse;
    expect(response.ok()).toBeTruthy();
    expect(response.request().postDataJSON()).toMatchObject({ mode: 'sequential', filter: query });
    const first = (await response.json()).item.id;
    expect(['range-inside-one', 'range-inside-two']).toContain(first);
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', `/api/file/${first}`);

    await page.locator('#playerVideo').evaluate(video => video.dispatchEvent(new Event('ended')));
    const second = first === 'range-inside-one' ? 'range-inside-two' : 'range-inside-one';
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', `/api/file/${second}`);
});

test('invalid duration search disables Play All while Shuffle modes keep their independent pool', async ({ page }) => {
    await installMediaHarness(page);
    await seedVideo(page, 'shuffle-independent', 450);
    await refresh(page);
    await search(page, 'duration:>');
    await expectVideoIds(page, []);
    await page.getByRole('button', { name: 'Choose playback mode' }).click();
    await expect(page.locator('#playbackMenuPlayAll')).toBeDisabled();
    await expect(page.locator('#playbackMenuShuffle')).toBeEnabled();
    await expect(page.locator('#playbackMenuShuffleClips')).toBeEnabled();
    const createResponse = page.waitForResponse(response => (
        response.url().endsWith('/api/playback-sessions')
        && response.request().method() === 'POST'
    ));
    await page.locator('#playbackMenuShuffle').click();
    const response = await createResponse;
    expect(response.ok()).toBeTruthy();
    expect(response.request().postDataJSON()).toEqual({ mode: 'shuffle' });
    expect((await response.json()).item.id).toBe('shuffle-independent');
    await expect(page.locator('#playerVideo source')).toHaveAttribute('src', '/api/file/shuffle-independent');
});

test('returning from a keyboard-opened row menu applies invalid search without stale cards', async ({ page }) => {
    await seedVideo(page, 'menu-duration', 450);
    await refresh(page);
    const input = await search(page, 'duration:>0');
    await expectVideoIds(page, ['menu-duration']);
    await expect(page.locator('#endlessPlaybackButton')).toBeEnabled();

    const button = page.locator('[data-row-id="menu-duration"] .kebab-btn');
    await button.focus();
    await button.press('Enter');
    await expect(page.locator('#menu-menu-duration')).toBeVisible();
    // Focus alone does not emit the outside click that normally dismisses menus.
    await input.focus();
    await expect(page.locator('#menu-menu-duration')).toBeVisible();
    await input.fill('duration:>');

    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#historySearchError')).toBeVisible();
    await expectVideoIds(page, []);
    await expect(page.locator('.kebab-menu.open')).toHaveCount(0);
    await expect(page.locator('#endlessPlaybackButton')).toBeDisabled();
    await expect(page.locator('#playbackMenuPlayAll')).toBeDisabled();
});

test.describe('duration search in Turkish browser locale', () => {
    test.use({ locale: 'tr-TR' });

    test('uppercase duration qualifiers retain their meaning and combine into a range', async ({ page }) => {
        await page.addInitScript(() => {
            const nativeLowerCase = String.prototype.toLocaleLowerCase;
            // Chromium's context locale does not set String's default locale.
            // Use native Turkish folding for no-argument calls in this harness.
            String.prototype.toLocaleLowerCase = function toLocaleLowerCase(...locales) {
                return nativeLowerCase.apply(this, locales.length ? locales : ['tr-TR']);
            };
        });
        await page.reload();
        expect(await page.evaluate(() => navigator.language)).toBe('tr-TR');
        expect(await page.evaluate(() => 'DURATION'.toLocaleLowerCase())).toBe('duratıon');
        await seedVideo(page, 'turkish-low', 303);
        await seedVideo(page, 'turkish-middle', 450);
        await seedVideo(page, 'turkish-high', 600);
        await refresh(page);

        const input = await search(page, 'DURATION:>5m3s');
        await expect(input).toHaveAttribute('aria-invalid', 'false');
        await expectVideoIds(page, ['turkish-middle', 'turkish-high']);

        await input.fill('DURATION:>5M3S DURATION:<10M');
        await expectVideoIds(page, ['turkish-middle']);
        await expect(input).toHaveAttribute('aria-invalid', 'false');
        await expect(page.locator('#historySearchError')).toBeHidden();
        await expect(page.locator('#endlessPlaybackButton')).toBeEnabled();
    });
});

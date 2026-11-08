const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openCurrent } = require('./support.cjs');

async function ready(page, id, { finished = false } = {}) {
    await seed(page, { id, status: finished ? 'finished' : 'cancelled' });
    await refresh(page);
    await expect.poll(() => page.evaluate(() => hasTagProtocol())).toBe(true);
    const row = page.locator(`[data-row-id="${id}"]`);
    if (finished) {
        // Firefox can scroll a clipped card during its entrance animation,
        // moving the button between pointerdown and pointerup.
        await expect(row).not.toHaveClass(/item-fade-in/);
        await row.locator('.kebab-btn').click();
        await row.getByRole('button', { name: 'Info', exact: true }).click();
    } else await openCurrent(page);
    await row.getByText('Add tags', { exact: true }).click();
    return row;
}

test.beforeEach(async ({ page }) => reset(page));
test.setTimeout(20_000);

test('tags render immediately, queue and acknowledge with SSE blocked while retaining the input', async ({ page }, testInfo) => {
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    const row = await ready(page, 'immediate-tags', { finished: true });
    const releases = [];
    const requests = [];
    await page.route('**/api/tags/immediate-tags', async route => {
        requests.push(route.request().postDataJSON());
        await new Promise(resolve => releases.push(resolve));
        await route.continue();
    });
    const input = row.locator('.tag-entry-input');
    await input.evaluate(element => {
        window.originalTagInput = element;
        element.addEventListener('keydown', event => {
            if (event.key === 'Enter') window.tagFeedbackStarted = performance.now();
        }, true);
        window.addEventListener('keydown', event => {
            if (event.key === 'Enter' && document.querySelector('.tag-spinner')) {
                window.tagFeedbackMs = performance.now() - window.tagFeedbackStarted;
            }
        });
    });
    await input.fill('Music');
    await input.press('Enter');
    await expect(row.locator('.tag-chip[data-tag-state="sending"]')).toContainText('Music');
    await expect(row.locator('.tag-spinner')).toHaveCount(1);
    const feedbackMs = await page.evaluate(() => window.tagFeedbackMs);
    expect(feedbackMs).toBeLessThan(50);
    await testInfo.attach('local-feedback-latency', {
        body: JSON.stringify({ local_feedback_ms: feedbackMs }), contentType: 'application/json',
    });
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await input.fill('Tutorial');
    await input.press('Enter');
    await expect(row.locator('.tag-chip')).toHaveCount(2);
    await expect(row.locator('.tag-chip[data-tag-state="queued"]')).toContainText('Tutorial');
    expect(requests).toHaveLength(1);
    await input.fill('new draft');
    await refresh(page);
    await expect(input).toHaveValue('new draft');
    await expect(input).toBeFocused();
    expect(await input.evaluate(element => element === window.originalTagInput)).toBe(true);
    const spinnerWidth = await row.locator('.tag-status-slot').first().evaluate(element => element.getBoundingClientRect().width);
    releases.shift()();
    await expect.poll(() => requests.length).toBe(2);
    await expect(row.locator('[data-remove-tag="Music"]')).toBeVisible();
    expect(await row.locator('[data-remove-tag="Music"]').evaluate(element => element.getBoundingClientRect().width)).toBe(spinnerWidth);
    await expect(input).toHaveValue('new draft');
    await expect(input).toBeFocused();
    releases.shift()();
    await expect(row.locator('[data-remove-tag="Tutorial"]')).toBeVisible();
    await expect(row.locator('.tag-spinner')).toHaveCount(0);
    await expect(input).toHaveValue('new draft');
    await input.press('Escape');
});

test('a pending predecessor blocks Backspace and removal remains visible until acknowledged', async ({ page }) => {
    const row = await ready(page, 'tag-removal');
    let release;
    await page.route('**/api/tags/tag-removal', async route => {
        await new Promise(resolve => { release = resolve; });
        await route.continue();
    });
    const input = row.locator('.tag-entry-input');
    await input.fill('Pending');
    await input.press('Enter');
    await input.press('Backspace');
    await expect(row.locator('.tag-chip')).toHaveCount(1);
    await expect(page.locator('#tagMutationStatus')).toContainText('is pending');
    release();
    await expect(row.locator('[data-remove-tag="Pending"]')).toBeVisible();
    await row.locator('[data-remove-tag="Pending"]').click();
    await expect(row.locator('.tag-chip-removing')).toContainText('Pending');
    await expect(row.locator('.tag-spinner')).toHaveCount(1);
    release();
    await expect(row.locator('.tag-chip')).toHaveCount(0);
    await expect(input).toBeFocused();
});

test('a lost acknowledgement recovers its receipt without losing the next draft', async ({ page }) => {
    const row = await ready(page, 'lost-tag');
    let writes = 0;
    await page.route('**/api/tags/lost-tag', async route => {
        writes++;
        await route.fetch();
        await route.abort('failed');
    });
    const input = row.locator('.tag-entry-input');
    await input.fill('Recovered');
    await input.press('Enter');
    await input.fill('next draft');
    await expect(row.locator('[data-remove-tag="Recovered"]')).toBeVisible();
    await expect(input).toHaveValue('next draft');
    await expect(input).toBeFocused();
    expect(writes).toBe(1);
    await input.press('Escape');
});

test('unknown save survives leaving Info and never replaces newer typing', async ({ page }, testInfo) => {
    const id = `unknown-tag-${testInfo.repeatEachIndex}`;
    const row = await ready(page, id, { finished: true });
    await page.route(`**/api/tags/${id}`, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    const input = row.locator('.tag-entry-input');
    await input.fill('Uncertain');
    await input.press('Enter');
    await input.fill('newer draft');
    await expect(row.locator('.tag-chip[data-tag-state="unconfirmed"]')).toContainText('Uncertain');
    await expect(input).toHaveValue('newer draft');
    await input.press('Escape');
    await expect(row.locator('.tag-chip[data-tag-state="unconfirmed"]')).toContainText('Uncertain');
    await expect(row.getByRole('button', { name: 'Check save', exact: true })).toBeVisible();
    await row.getByRole('button', { name: 'Close info', exact: true }).click();
    await expect(row.locator('.history-info-popover')).toBeHidden();
    await expect(page.locator('#tagMutationSummary')).toBeVisible();
    await expect(page.locator('#tagMutationSummary')).toContainText('1 tag edit not confirmed');
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Info', exact: true }).click();
    await expect(row.locator('.tag-chip[data-tag-state="unconfirmed"]')).toContainText('Uncertain');
    await row.locator('.tag-display-row').click();
    await expect(input).toHaveValue('');
    await expect(row.locator('.tag-chip')).toHaveCount(1);
    await input.press('Escape');
});

test('a definite rejection keeps failed text and permits the next tag without replacing a newer draft', async ({ page }) => {
    const row = await ready(page, 'rejected-tag');
    const identityVersion = await page.evaluate(() => VDL.tagIdentity.version);
    let release;
    let count = 0;
    await page.route('**/api/tags/rejected-tag', async route => {
        count++;
        if (count !== 1) return route.continue();
        const request = route.request().postDataJSON();
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({
            id: 'rejected-tag', error: 'Tag was declined',
            tags: [], tag_items: [], tag_identity_version: identityVersion,
            mutation: { id: request.client_mutation_id, domain: 'tags', revision: request.expected_revision, outcome: 'rejected' },
        }) });
    });
    const input = row.locator('.tag-entry-input');
    await input.fill('Declined');
    await input.press('Enter');
    await input.fill('Accepted');
    await input.press('Enter');
    await input.fill('newer draft');
    release();
    await expect(row.locator('.tag-chip[data-tag-state="rejected"]')).toContainText('Declined');
    await expect(row.locator('[data-remove-tag="Accepted"]')).toBeVisible();
    await expect(input).toHaveValue('newer draft');
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(input).toHaveValue('newer draft');
    await expect(page.locator('#tagMutationStatus')).toContainText('Finish or clear');
    await input.fill('');
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(input).toHaveValue('Declined');
    await expect(input).toBeFocused();
    await expect(row.locator('.tag-chip[data-tag-state="rejected"]')).toHaveCount(0);
    await input.press('Escape');
});

test('a revision conflict pauses the queue until an explicit retry', async ({ page }) => {
    const row = await ready(page, 'conflicted-tag');
    let release;
    let count = 0;
    await page.route('**/api/tags/conflicted-tag', async route => {
        count++;
        if (count !== 1) return route.continue();
        await new Promise(resolve => { release = resolve; });
        await route.continue();
    });
    const input = row.locator('.tag-entry-input');
    await input.fill('Local');
    await input.press('Enter');
    await input.fill('Queued');
    await input.press('Enter');
    const remote = await page.request.post('/api/tags/conflicted-tag', { data: { tag: 'Remote' } });
    expect(remote.ok()).toBeTruthy();
    release();
    await expect(row.locator('.tag-chip[data-tag-state="conflicted"]')).toContainText('Local');
    await expect(row.locator('.tag-chip[data-tag-state="queued"]')).toContainText('Queued');
    expect(count).toBe(1);
    await row.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(row.locator('[data-remove-tag="Local"]')).toBeVisible();
    await expect(row.locator('[data-remove-tag="Queued"]')).toBeVisible();
    await expect(row.locator('[data-remove-tag="Remote"]')).toBeVisible();
    await input.press('Escape');
});

test('pending chips keep a fixed status slot in dark theme with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const row = await ready(page, 'tag-accessibility');
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    let release;
    await page.route('**/api/tags/tag-accessibility', async route => {
        await new Promise(resolve => { release = resolve; });
        await route.continue();
    });
    const input = row.locator('.tag-entry-input');
    await input.fill('<img src=x onerror=alert(1)>');
    await input.press('Enter');
    await expect(row.locator('.tag-chip img')).toHaveCount(0);
    await expect(row.locator('.tag-chip')).toContainText('<img src=x onerror=alert(1)>');
    await expect(row.locator('.tag-spinner')).toHaveAttribute('aria-hidden', 'true');
    await expect(row.locator('.tag-spinner')).toHaveCSS('animation-name', 'none');
    await expect(page.locator('#tagMutationStatus')).toContainText('Saving tag');
    expect(await row.locator('.tag-status-slot').evaluate(element => element.getBoundingClientRect().width)).toBe(18);
    release();
    await expect(row.locator('.tag-remove')).toBeVisible();
    await input.press('Escape');
});

test('deletion fences pending tags and a pre-deletion collection response cannot restore the row', async ({ page }) => {
    const row = await ready(page, 'deleted-pending-tag');
    let releaseWrite;
    await page.route('**/api/tags/deleted-pending-tag', async route => {
        await new Promise(resolve => { releaseWrite = resolve; });
        await route.continue();
    });
    await row.locator('.tag-entry-input').fill('Private draft');
    await row.locator('.tag-entry-input').press('Enter');
    await expect.poll(() => Boolean(releaseWrite)).toBe(true);
    let releaseRead;
    let intercepted = false;
    await page.route('**/api/current-downloads', async route => {
        if (intercepted) return route.continue();
        intercepted = true;
        const response = await route.fetch();
        await new Promise(resolve => { releaseRead = resolve; });
        await route.fulfill({ response });
    });
    const refreshing = page.evaluate(() => fetchHistory());
    await expect.poll(() => Boolean(releaseRead)).toBe(true);
    const deleted = await page.request.post('/api/remove/deleted-pending-tag');
    expect(deleted.ok()).toBeTruthy();
    releaseWrite();
    await expect(row).toHaveCount(0);
    releaseRead();
    await refreshing;
    await expect(row).toHaveCount(0);
    expect(await page.evaluate(() => tagState.selectDownload('deleted-pending-tag'))).toBeNull();
    expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
});

test('a tag edit pins its filtered card until the editor closes', async ({ page }) => {
    for (const id of ['pin-target', 'pin-other']) {
        await seed(page, { id, status: 'finished' });
        expect((await page.request.post(`/api/tags/${id}`, { data: { tag: 'OnlyTag' } })).ok()).toBeTruthy();
    }
    await refresh(page);
    await page.locator('#historySearchToggle').click();
    await page.locator('#historySearchInput').fill('OnlyTag');
    const row = page.locator('[data-row-id="pin-target"]');
    const orderBefore = await page.locator('#historyList [data-row-id]').evaluateAll(rows => rows.map(row => row.dataset.rowId));
    await row.locator('.kebab-btn').click();
    await row.getByRole('button', { name: 'Info', exact: true }).click();
    await row.locator('.tag-display-row').click();
    let release;
    await page.route('**/api/tags/pin-target', async route => {
        await new Promise(resolve => { release = resolve; });
        await route.continue();
    });
    await row.locator('[data-remove-tag="OnlyTag"]').click();
    await expect(row.locator('.tag-chip-removing')).toBeVisible();
    expect(await page.locator('#historyList [data-row-id]').evaluateAll(rows => rows.map(row => row.dataset.rowId))).toEqual(orderBefore);
    release();
    await expect(row.locator('.tag-chip')).toHaveCount(0);
    await expect(row).toBeVisible();
    await row.locator('.tag-entry-input').press('Escape');
    await expect(row).toHaveCount(0);
    await expect(page.locator('[data-row-id="pin-other"]')).toBeVisible();
});

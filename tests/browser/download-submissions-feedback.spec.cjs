const { test, expect } = require('@playwright/test');
const { reset, openNewDownload, switchAccount } = require('./support.cjs');
const { downloadAcceptance, downloadRejection } = require('./submission-support.cjs');

const status = page => page.locator('#downloadSubmissionStatus');
const summary = page => page.locator('#downloadSubmissionSummary');
const recovery = (surface, action) => surface.locator(`[data-submission-recovery="${action}"]`);

async function ready(page) {
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    await expect.poll(() => page.evaluate(() => tagCapabilities?.actions?.includes('download.submit'))).toBe(true);
    await openNewDownload(page);
    await page.locator('#urlInput').fill('https://fixture.invalid/submission');
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
}

async function gate(page, result = downloadAcceptance) {
    const requests = [];
    const releases = [];
    await page.route('**/api/download', async route => {
        const payload = route.request().postDataJSON();
        requests.push(payload);
        await new Promise(resolve => releases.push(resolve));
        return route.fulfill({ status: 202, json: result(payload, `accepted-${requests.length}`) });
    });
    return { requests, releases };
}

async function releaseNext(pending) {
    await expect.poll(() => pending.releases.length).toBeGreaterThan(0);
    pending.releases.shift()();
}

function collectionReads(page) {
    const reads = [];
    page.on('request', request => {
        if (/\/api\/(library|history|current-downloads)(\?|$)/.test(request.url())) reads.push(request.url());
    });
    return reads;
}

async function noReceipts(page, final = false) {
    await page.route('**/api/mutations/*', route => route.fulfill({ status: 404, json: { error: 'Mutation unavailable', final } }));
}

async function drainCallbacks(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test.beforeEach(async ({ page }) => reset(page));
test.setTimeout(25_000);
test.afterEach(async ({ page }) => {
    const response = await page.request.get('/api/current-downloads');
    if (response.ok()) for (const row of await response.json()) {
        if (['starting', 'downloading', 'paused'].includes(row.status)) await page.request.post(`/api/stop/${row.id}`);
    }
    await page.request.post('/__test__/release-downloads');
});

test('held submission renders within 50 ms, suppresses duplicates, and confirms without SSE or collection reads', async ({ page }, testInfo) => {
    await ready(page);
    await page.locator('#optionsFilename').fill('submitted-name');
    const pending = await gate(page);
    const reads = collectionReads(page);
    const local = await page.evaluate(() => {
        const before = performance.now();
        startDownload();
        return { elapsed: performance.now() - before, text: document.getElementById('downloadReadinessStatus').textContent };
    });
    expect(local.elapsed).toBeLessThan(50);
    expect(local.text).toContain('Starting download');
    await testInfo.attach('local-feedback', { body: JSON.stringify({ local_feedback_ms: local.elapsed }), contentType: 'application/json' });
    await expect(page.locator('#downloadSubmit')).toBeDisabled();
    await page.locator('#urlInput').press('Enter');
    await page.evaluate(() => startDownload());
    await expect.poll(() => pending.requests.length).toBe(1);
    expect(pending.requests[0].client_mutation_id).toMatch(/^\d+-[a-f0-9]{32}$/);
    expect(pending.requests[0].filename).toBe('submitted-name');
    expect(pending.requests[0].expected_revision).toBeUndefined();
    await expect(page.locator('[data-row-id="accepted-1"]')).toHaveCount(0);
    await releaseNext(pending);
    await expect(page.locator('#newDownloadDialog')).toBeHidden();
    await expect(summary(page)).toContainText(/accepted/i);
    await expect(summary(page)).toHaveAttribute('data-download-id', 'accepted-1');
    await expect(summary(page)).toHaveAttribute('data-job-id', 'accepted-1-job');
    await expect(summary(page)).toHaveAttribute('data-attempt-id', 'accepted-1-attempt');
    expect(reads).toHaveLength(0);
    await expect(page.locator('[data-row-id="accepted-1"]')).toHaveCount(0);
    await expect(page.locator('#currentDownloadsDrawer')).toBeHidden();
});

test('newer quality, container and filename drafts survive acceptance and retain focus', async ({ page }) => {
    await ready(page);
    await page.locator('#optionsQualitySelect').selectOption('bestvideo[height<=360]+bestaudio/best');
    await page.locator('#optionsFilename').fill('submitted-name');
    const pending = await gate(page);
    await page.locator('#downloadSubmit').click();
    await expect.poll(() => pending.requests.length).toBe(1);
    await expect(page.locator('#optionsFilename')).toBeEditable();
    await page.locator('#optionsQualitySelect').selectOption('');
    await page.locator('#optionsContainerSelect').selectOption('mp4');
    await page.locator('#optionsFilename').fill('newer-name');
    await releaseNext(pending);
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await expect(page.locator('#newDownloadDialog')).toBeVisible();
    await expect(page.locator('#optionsFilename')).toHaveValue('newer-name');
    await expect(page.locator('#optionsFilename')).toBeFocused();
    await expect(page.locator('#optionsQualitySelect')).toHaveValue('');
    await expect(page.locator('#optionsContainerSelect')).toHaveValue('mp4');
    expect(pending.requests[0].filename).toBe('submitted-name');
    expect(pending.requests[0].format).toBe('bestvideo[height<=360]+bestaudio/best');
});

test('a replacement URL and a late old probe cannot be cleared by an older acceptance', async ({ page }) => {
    await ready(page);
    const pending = await gate(page);
    await page.locator('#downloadSubmit').click();
    await expect.poll(() => pending.requests.length).toBe(1);
    let oldProbe;
    await page.route('**/api/probe', route => {
        if (route.request().postDataJSON().url.endsWith('/old-probe')) { oldProbe = route; return; }
        return route.fulfill({ json: { title: 'New draft', resolutions: ['720p'], containers: ['mp4'] } });
    });
    await page.locator('#urlInput').fill('https://fixture.invalid/old-probe');
    await expect.poll(() => Boolean(oldProbe)).toBe(true);
    await page.locator('#urlInput').fill('https://fixture.invalid/new-draft');
    await expect(page.locator('#optionsFilename')).toHaveAttribute('placeholder', /New draft/);
    await page.locator('#optionsFilename').fill('keep-new-options');
    await oldProbe.fulfill({ json: { title: 'Obsolete title', resolutions: ['360p'], containers: ['webm'] } });
    await releaseNext(pending);
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await expect(page.locator('#newDownloadDialog')).toBeVisible();
    await expect(page.locator('#urlInput')).toHaveValue('https://fixture.invalid/new-draft');
    await expect(page.locator('#optionsFilename')).toHaveValue('keep-new-options');
    await expect(page.locator('#optionsFilename')).toHaveAttribute('placeholder', /New draft/);
});

test('close and reopen retains a pending request and an old acceptance cannot close the new dialog', async ({ page }) => {
    await ready(page);
    const pending = await gate(page);
    await page.locator('#downloadSubmit').click();
    await expect.poll(() => pending.requests.length).toBe(1);
    await page.getByRole('button', { name: 'Close new download' }).click();
    await expect(summary(page)).toContainText(/Starting|waiting/i);
    await openNewDownload(page);
    await expect(page.locator('#downloadSubmit')).toBeDisabled();
    await releaseNext(pending);
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await expect(page.locator('#newDownloadDialog')).toBeVisible();
    await expect(page.locator('#urlInput')).toHaveValue('https://fixture.invalid/submission');
    await expect(page.locator('#urlInput')).toBeFocused();
});

test('definite validation rejection preserves input and requires review before a new attempt', async ({ page }) => {
    await ready(page);
    await page.locator('#optionsFilename').fill('recoverable-name');
    await page.route('**/api/download', route => route.fulfill({ status: 400, json: downloadRejection(route.request().postDataJSON(), '<img src=x onerror=alert(1)> invalid filename') }));
    await page.locator('#downloadSubmit').click();
    await expect(status(page)).toContainText('invalid filename');
    await expect(status(page).locator('img')).toHaveCount(0);
    await expect(page.locator('#urlInput')).toHaveValue('https://fixture.invalid/submission');
    await expect(page.locator('#optionsFilename')).toHaveValue('recoverable-name');
    await expect(page.locator('#newDownloadDialog')).toBeVisible();
    await status(page).getByRole('button', { name: 'Review input', exact: true }).click();
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
});

for (const fault of ['malformed success', 'server error', 'transport loss', 'wrong correlation', 'wrong job identity']) {
    test(`${fault} retains unconfirmed status and blocks blind resubmission`, async ({ page }) => {
        await ready(page);
        await noReceipts(page);
        let writes = 0;
        await page.route('**/api/download', route => {
            writes++;
            if (fault === 'transport loss') return route.abort('failed');
            const payload = route.request().postDataJSON();
            const body = downloadAcceptance(payload);
            if (fault === 'wrong correlation') body.mutation.id = 'uncorrelated';
            if (fault === 'wrong job identity') body.job.download_id = 'foreign';
            return route.fulfill({ status: fault === 'server error' ? 500 : 202,
                json: fault === 'malformed success' || fault === 'server error' ? { id: 'ambiguous' } : body });
        });
        await page.locator('#downloadSubmit').click();
        await expect(status(page)).toContainText('Download request not confirmed');
        await expect(page.locator('#downloadSubmit')).toBeDisabled();
        await page.evaluate(() => startDownload());
        expect(writes).toBe(1);
        await expect(recovery(status(page), 'check')).toBeVisible();
        await expect(recovery(status(page), 'replay')).toBeVisible();
        await page.getByRole('button', { name: 'Close new download' }).click();
        await expect(summary(page)).toContainText('Download request not confirmed');
    });
}

test('missing receipts and matching Current reads do not confirm an unknown request or release its duplicate guard', async ({ page }) => {
    await ready(page);
    await noReceipts(page);
    await page.route('**/api/download', async route => {
        const response = await route.fetch();
        expect(response.status()).toBe(202);
        return route.abort('failed');
    });
    await page.request.post('/__test__/hold-downloads');
    await page.locator('#downloadSubmit').click();
    await expect(status(page)).toContainText('Download request not confirmed');
    await page.evaluate(() => fetchHistory());
    await recovery(status(page), 'check').click();
    await expect(status(page)).toContainText('Download request not confirmed');
    await recovery(status(page), 'resolve').click();
    await expect(page.locator('#downloadSubmit')).toBeDisabled();
    await expect(status(page)).toContainText(/not confirmed|cannot|recovery/i);
    expect(await (await page.request.get('/api/current-downloads')).json()).toHaveLength(1);
});

for (const mode of ['check', 'replay']) {
    test(`real post-commit response loss recovers one job and History attempt by ${mode}`, async ({ page }) => {
        await ready(page);
        await page.request.post('/__test__/hold-downloads');
        await noReceipts(page);
        const requests = [];
        const acknowledgements = [];
        await page.route('**/api/download', async route => {
            requests.push(route.request().postDataJSON());
            const response = await route.fetch();
            acknowledgements.push(await response.json());
            expect(response.status()).toBe(202);
            if (requests.length === 1) return route.abort('failed');
            return route.fulfill({ response });
        });
        const automaticCheck = page.waitForResponse(response => response.url().includes('/api/mutations/'));
        await page.locator('#downloadSubmit').click();
        await expect(status(page)).toContainText('Download request not confirmed');
        await (await automaticCheck).finished();
        await drainCallbacks(page);
        if (mode === 'check') await page.unroute('**/api/mutations/*');
        await recovery(status(page), mode).click();
        await expect(summary(page)).toContainText(/accepted/i);
        expect(acknowledgements[0].mutation.outcome).toBe('accepted');
        const first = acknowledgements[0];
        if (mode === 'replay') {
            expect(requests).toHaveLength(2);
            expect(requests[1]).toEqual(requests[0]);
            expect(acknowledgements[1].job.id).toBe(first.job.id);
            expect(acknowledgements[1].current_attempt_id).toBe(first.current_attempt_id);
        }
        const current = await (await page.request.get('/api/current-downloads')).json();
        expect(current).toHaveLength(1);
        expect(current[0].id).toBe(first.id);
        expect(current[0].current_attempt_id).toBe(first.current_attempt_id);
        expect(current[0].job_id).toBe(first.job.id);
        const attempts = await (await page.request.get('/api/history')).json();
        expect(attempts.items.filter(item => item.download_id === first.id)).toHaveLength(1);
        expect(attempts.items.find(item => item.download_id === first.id).id).toBe(first.current_attempt_id);
    });
}

test('two intentional later submissions of the same URL have distinct mutation and job identities', async ({ page }) => {
    await ready(page);
    await page.request.post('/__test__/hold-downloads');
    const accepted = [];
    await page.route('**/api/download', async route => {
        const response = await route.fetch();
        accepted.push(await response.json());
        return route.fulfill({ response });
    });
    for (let index = 0; index < 2; index++) {
        if (index) {
            await openNewDownload(page);
            await page.locator('#urlInput').fill('https://fixture.invalid/submission');
            await expect(page.locator('#downloadSubmit')).toBeEnabled();
        }
        await page.locator('#downloadSubmit').click();
        await expect(page.locator('#newDownloadDialog')).toBeHidden();
    }
    expect(accepted).toHaveLength(2);
    expect(accepted[1].id).not.toBe(accepted[0].id);
    expect(accepted[1].mutation.id).not.toBe(accepted[0].mutation.id);
    expect(accepted[1].job.id).not.toBe(accepted[0].job.id);
    expect(accepted[1].current_attempt_id).not.toBe(accepted[0].current_attempt_id);
});

test('slow acceptance explains waiting after five seconds and late acceptance still confirms', async ({ page }) => {
    await ready(page);
    await page.clock.install();
    const pending = await gate(page);
    await page.locator('#downloadSubmit').click();
    await expect.poll(() => pending.requests.length).toBe(1);
    await page.clock.fastForward(5100);
    await expect(status(page)).toContainText(/Still waiting|taking longer/i);
    await page.clock.fastForward(25100);
    await expect(status(page)).toContainText('Download request not confirmed');
    await releaseNext(pending);
    await expect(summary(page)).toContainText(/accepted/i);
});

test('expired unknown request only releases after the server serializes final absence', async ({ page }) => {
    await ready(page);
    await page.clock.install();
    await noReceipts(page);
    await page.route('**/api/download', route => route.abort('failed'));
    await page.locator('#downloadSubmit').click();
    await expect(status(page)).toContainText('Download request not confirmed');
    await page.clock.fastForward(24 * 60 * 60 * 1000 + 1000);
    await page.unroute('**/api/mutations/*');
    await noReceipts(page, true);
    await recovery(status(page), 'check').click();
    await recovery(status(page), 'resolve').click();
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await expect(page.locator('#urlInput')).toHaveValue('https://fixture.invalid/submission');
});

for (const denial of [401, 403]) {
    test(`${denial} fences pending submission state and does not expose a replay`, async ({ page }) => {
        await ready(page);
        await page.route('**/api/download', async route => {
            // Expire the authenticated session as well as the transport response;
            // a still-valid session legitimately redirects /login back to /.
            if (denial === 401) await page.request.post('/logout');
            return route.fulfill({ status: denial, json: { error: 'Unavailable' } });
        });
        await page.locator('#downloadSubmit').click();
        if (denial === 401) {
            await expect(page).toHaveURL(/\/login$/);
            await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
            await expect(summary(page)).toHaveCount(0);
        } else {
            await expect.poll(() => page.evaluate(() => tagMutations.hasPending())).toBe(false);
            await expect(summary(page)).toBeHidden();
        }
        await expect(recovery(status(page), 'replay')).toHaveCount(0);
    });
}

test('authentication reset fences an old accepted callback and clears submitted private input', async ({ page }) => {
    await ready(page);
    const pending = await gate(page);
    await page.locator('#optionsFilename').fill('private-name');
    await page.locator('#downloadSubmit').click();
    await expect.poll(() => pending.requests.length).toBe(1);
    await page.evaluate(() => resetTagSession());
    await releaseNext(pending);
    await drainCallbacks(page);
    await expect(summary(page)).toBeHidden();
    await expect(page.locator('#urlInput')).toHaveValue('');
    await expect(page.locator('#optionsFilename')).toHaveValue('');
    expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
});

test('sign out and account switch cannot revive a submitted URL or an old response', async ({ page }) => {
    await ready(page);
    expect((await page.request.post('/api/users', { data: {
        username: 'submission-next-account', name: 'Next Submission Account', password: 'next-password', role: 'normal',
    } })).ok()).toBe(true);
    let release;
    let delivered = false;
    await page.route('**/api/download', async route => {
        const payload = route.request().postDataJSON();
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ status: 202, json: downloadAcceptance(payload) }).catch(() => {});
        delivered = true;
    });
    await page.locator('#downloadSubmit').click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.getByRole('button', { name: 'Close new download' }).click();
    await switchAccount(page, 'submission-next-account', 'next-password');
    release();
    await expect.poll(() => delivered).toBe(true);
    await expect(summary(page)).toBeHidden();
    expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
    await openNewDownload(page);
    await expect(page.locator('#urlInput')).toHaveValue('');
});

test('legacy capability keeps immediate pending feedback and never offers receipt replay', async ({ page }) => {
    await page.route('**/api/client-capabilities', async route => {
        const response = await route.fetch();
        const body = await response.json();
        body.actions = body.actions.filter(action => action !== 'download.submit');
        return route.fulfill({ response, json: body });
    });
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    await expect.poll(() => page.evaluate(() => tagCapabilities && !tagCapabilities.actions.includes('download.submit'))).toBe(true);
    await openNewDownload(page);
    await page.locator('#urlInput').fill('https://fixture.invalid/legacy');
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    let release;
    let payload;
    let writes = 0;
    const receipts = [];
    page.on('request', request => { if (request.url().includes('/api/mutations/')) receipts.push(request.url()); });
    await page.route('**/api/download', async route => {
        payload = route.request().postDataJSON();
        writes++;
        await new Promise(resolve => { release = resolve; });
        return route.fulfill({ status: 500, json: {} });
    });
    await page.locator('#downloadSubmit').click();
    await expect(status(page)).toContainText('Starting download');
    await expect.poll(() => Boolean(release)).toBe(true);
    expect(payload.client_mutation_id).toBeUndefined();
    await page.evaluate(() => startDownload());
    expect(writes).toBe(1);
    release();
    await expect(status(page)).toContainText('Download request not confirmed');
    await expect(status(page)).toContainText(/cannot safely (replay|recover)/i);
    await expect(recovery(status(page), 'replay')).toHaveCount(0);
    expect(receipts).toHaveLength(0);
});

for (const theme of ['light', 'dark']) {
    test(`${theme} keyboard submission and recovery remain readable at narrow width with reduced motion`, async ({ page }) => {
        await ready(page);
        await page.setViewportSize({ width: 390, height: 850 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        const pending = await gate(page, () => ({ id: 'malformed' }));
        await noReceipts(page);
        await page.locator('#urlInput').focus();
        await page.locator('#urlInput').press('Enter');
        await expect(status(page)).toContainText('Starting download');
        await expect(status(page)).toHaveAttribute('role', 'status');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await releaseNext(pending);
        await expect(status(page)).toContainText('Download request not confirmed');
        const check = recovery(status(page), 'check');
        await check.focus();
        await check.press('Enter');
        await expect(status(page)).toContainText('Download request not confirmed');
        await expect(check).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
}

test('a discovered committed download deleted before its acknowledgement cannot revive presentation or recovery', async ({ page }) => {
    await ready(page);
    await page.locator('#urlInput').fill('https://fixture.invalid/missing-deleted-submission');
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    let accepted;
    let release;
    await page.route('**/api/download', async route => {
        const response = await route.fetch();
        accepted = await response.json();
        await new Promise(resolve => { release = resolve; });
        return route.fulfill({ response });
    });
    await page.locator('#downloadSubmit').click();
    await expect.poll(() => Boolean(release)).toBe(true);
    expect(accepted.mutation.outcome).toBe('accepted');
    await page.locator('#urlInput').fill('https://fixture.invalid/newer-after-delete');
    await expect(page.locator('#optionsFilename')).toBeEditable();
    await page.locator('#optionsFilename').fill('retain-after-deletion');
    await expect.poll(async () => {
        const history = await (await page.request.get('/api/history')).json();
        return history.items.find(item => item.id === accepted.current_attempt_id)?.status;
    }).toBe('error');
    await page.evaluate(id => checkTagAvailability(id), accepted.id);
    expect(await page.evaluate(id => tagState.selectDownload(id)?.id, accepted.id)).toBe(accepted.id);
    await page.evaluate(id => deleteDownload(id), accepted.id);
    await expect.poll(async () => (await page.request.get(`/api/downloads/${accepted.id}/editable-state`)).status()).toBe(404);
    await expect.poll(() => page.evaluate(id => tagState.isFenced(id), accepted.id)).toBe(true);
    release();
    await drainCallbacks(page);
    await expect(summary(page)).toBeHidden();
    await expect(page.locator(`[data-row-id="${accepted.id}"]`)).toHaveCount(0);
    const receipt = await page.request.get(`/api/mutations/${accepted.mutation.id}`);
    expect(receipt.status()).toBe(404);
    await expect(recovery(status(page), 'replay')).toHaveCount(0);
    await expect(page.locator('#urlInput')).toHaveValue('https://fixture.invalid/newer-after-delete');
    await expect(page.locator('#optionsFilename')).toHaveValue('retain-after-deletion');
    await expect(page.locator('#optionsFilename')).toBeFocused();
});

test('reload clears the in-memory operation and never replays a submitted URL or options', async ({ page }) => {
    await ready(page);
    await noReceipts(page);
    await page.locator('#optionsFilename').fill('private-reload-name');
    let writes = 0;
    await page.route('**/api/download', route => { writes++; return route.abort('failed'); });
    await page.locator('#downloadSubmit').click();
    await expect(status(page)).toContainText('Download request not confirmed');
    page.once('dialog', dialog => dialog.accept());
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(tagCapabilities))).toBe(true);
    await expect(summary(page)).toBeHidden();
    expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
    await openNewDownload(page);
    await expect(page.locator('#urlInput')).toHaveValue('');
    await expect(page.locator('#optionsFilename')).toHaveValue('');
    expect(writes).toBe(1);
    const persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(persisted).not.toContain('https://fixture.invalid/submission');
    expect(persisted).not.toContain('private-reload-name');
});


test('a rejected old request retains submitted options separately and restores them only by explicit choice', async ({ page }) => {
    await ready(page);
    await page.locator('#optionsQualitySelect').selectOption('bestvideo[height<=360]+bestaudio/best');
    await page.locator('#optionsContainerSelect').selectOption('mp4');
    await page.locator('#optionsFilename').fill('failed-original-name');
    let request;
    await page.route('**/api/download', route => { request = route; });
    await page.locator('#downloadSubmit').click();
    await expect.poll(() => Boolean(request)).toBe(true);
    await page.locator('#urlInput').fill('https://fixture.invalid/newer-rejection-draft');
    await expect(page.locator('#optionsFilename')).toBeEditable();
    await page.locator('#optionsFilename').fill('keep-newer-name');
    await request.fulfill({ status: 400, json: downloadRejection(request.request().postDataJSON()) });
    await expect(status(page)).toContainText('invalid');
    await expect(page.locator('#urlInput')).toHaveValue('https://fixture.invalid/newer-rejection-draft');
    await expect(page.locator('#optionsFilename')).toHaveValue('keep-newer-name');
    await status(page).getByRole('button', { name: 'Use submitted input', exact: true }).click();
    await expect(page.locator('#urlInput')).toHaveValue('https://fixture.invalid/submission');
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await expect(page.locator('#optionsQualitySelect')).toHaveValue('bestvideo[height<=360]+bestaudio/best');
    await expect(page.locator('#optionsContainerSelect')).toHaveValue('mp4');
    await expect(page.locator('#optionsFilename')).toHaveValue('failed-original-name');
});

test('canonical quota refusal preserves input without unknown recovery and explicit review creates a fresh operation', async ({ page }) => {
    await ready(page);
    await page.locator('#optionsFilename').fill('quota-preserved-name');
    const requests = [];
    const receipts = [];
    page.on('request', request => { if (request.url().includes('/api/mutations/')) receipts.push(request.url()); });
    await page.route('**/api/download', route => {
        const payload = route.request().postDataJSON();
        requests.push(payload);
        if (requests.length === 1) return route.fulfill({ status: 429, json: downloadRejection(payload, 'Too many mutations; wait before submitting more') });
        return route.fulfill({ status: 202, json: downloadAcceptance(payload, 'quota-next-operation') });
    });
    await page.locator('#downloadSubmit').click();
    await expect(status(page)).toContainText('Too many mutations');
    await expect(status(page)).toHaveAttribute('data-submission-state', 'rejected');
    await expect(status(page)).not.toContainText('not confirmed');
    await expect(recovery(status(page), 'replay')).toHaveCount(0);
    await expect(recovery(status(page), 'check')).toHaveCount(0);
    await expect(page.locator('#urlInput')).toHaveValue('https://fixture.invalid/submission');
    await expect(page.locator('#optionsFilename')).toHaveValue('quota-preserved-name');
    expect(receipts).toHaveLength(0);
    await status(page).getByRole('button', { name: 'Review input', exact: true }).click();
    await expect(page.locator('#downloadSubmit')).toBeEnabled();
    await page.locator('#downloadSubmit').click();
    await expect(page.locator('#newDownloadDialog')).toBeHidden();
    expect(requests).toHaveLength(2);
    expect(requests[1].client_mutation_id).not.toBe(requests[0].client_mutation_id);
    expect(requests[1].url).toBe(requests[0].url);
    expect(requests[1].filename).toBe('quota-preserved-name');
    await expect(summary(page)).toHaveAttribute('data-download-id', 'quota-next-operation');
});

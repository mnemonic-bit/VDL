const { test, expect } = require('@playwright/test');
const { reset, seed, refresh, openCurrent, closeCurrent, switchAccount } = require('./support.cjs');

const card = (page, id) => page.locator(`[data-row-id="${id}"]`);
const feedback = (surface, id) => surface.locator(`[data-download-command-status="${id}"]`).first();
const summary = page => page.locator('#downloadCommandSummary');
const calls = { pause: 'pauseDownload', unpause: 'unpauseDownload', stop: 'stopDownload', resume: 'continueDownload', retry: 'reloadDownload' };
const sending = { pause: 'Pausing', unpause: 'Resuming', stop: 'Stopping', resume: 'Starting', retry: 'Starting' };

async function ready(page, row) {
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    if (row) await seed(page, row);
    await refresh(page);
    await expect.poll(() => page.evaluate(() => tagCapabilities?.actions?.includes('download.pause'))).toBe(true);
}

async function openHistory(page) {
    await page.locator('#accountMenuButton').click();
    await page.locator('#attemptHistoryButton').click();
    await expect(page.locator('#attemptHistoryPage')).toBeVisible();
    await expect(page.locator('.attempt-row')).not.toHaveCount(0);
}

function accepted(id, action, payload, fields = {}) {
    const attemptId = fields.attemptId || payload.expected_attempt_id;
    const revision = String(BigInt(payload.expected_revision) + 1n);
    return {
        id, command_revision: revision, current_attempt_id: attemptId,
        command: {
            id: payload.client_mutation_id, action: `download.${action}`,
            source_attempt_id: payload.expected_attempt_id, attempt_id: attemptId,
            job_id: ['retry', 'resume'].includes(action) ? payload.client_mutation_id : null,
            status: 'dispatched',
        },
        mutation: { id: payload.client_mutation_id, domain: 'download-command', revision, outcome: 'accepted' },
    };
}

function gateCommand(page, id, action, options = {}) {
    const requests = [];
    const releases = [];
    const installed = page.route(`**/api/${action}/${id}`, async route => {
        const payload = route.request().postDataJSON();
        requests.push(payload);
        await new Promise(resolve => releases.push(resolve));
        const body = accepted(id, action, payload, options);
        return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(body) });
    });
    return { requests, releases, installed };
}

async function releaseNext(gate) {
    await expect.poll(() => gate.releases.length).toBeGreaterThan(0);
    gate.releases.shift()();
}

async function invoke(page, id, action) {
    return page.evaluate(({ id, action, calls }) => {
        const started = performance.now();
        window[calls[action]](id);
        const message = document.querySelector(`[data-download-command-status="${id}"]`)?.textContent || '';
        return { elapsed: performance.now() - started, message };
    }, { id, action, calls });
}

function countCollections(page) {
    const reads = [];
    page.on('request', request => {
        if (/\/api\/(library|history|current-downloads)(\?|$)/.test(request.url())) reads.push(request.url());
    });
    return reads;
}

test.beforeEach(async ({ page }) => reset(page));
test.setTimeout(25_000);

test.afterEach(async ({ page }) => {
    // Drain held fake workers before the next isolated reset, including a pause
    // that may only be observed when yt-dlp reaches its next progress hook.
    const response = await page.request.get('/api/current-downloads');
    if (response.ok()) {
        const data = await response.json();
        const items = Array.isArray(data) ? data : data.items || data.downloads || [];
        for (const row of items) if (['starting', 'downloading', 'paused'].includes(row.status)) {
            await page.request.post(`/api/stop/${row.id}`);
        }
    }
    await page.request.post('/__test__/release-downloads');
});

for (const [action, status, confirmed] of [
    ['pause', 'downloading', 'Downloading'],
    ['unpause', 'paused', 'Paused'],
    ['stop', 'downloading', 'Downloading'],
    ['resume', 'cancelled', 'Cancelled'],
]) {
    test(`${action} renders immediate request feedback and acceptance leaves confirmed worker state intact`, async ({ page }, testInfo) => {
        const id = `command-${action}`;
        await ready(page, { id, status, progress: status === 'downloading' ? '42%' : status });
        await openCurrent(page);
        const row = card(page, id);
        const before = await row.locator('.download-summary-row').textContent();
        await expect(row.locator('.download-worker-status')).toContainText(confirmed);
        const gate = gateCommand(page, id, action, { attemptId: action === 'resume' ? 'replacement-attempt' : undefined });
        await gate.installed;
        const reads = countCollections(page);
        const local = await invoke(page, id, action);
        expect(local.message).toContain(sending[action]);
        expect(local.elapsed).toBeLessThan(50);
        await testInfo.attach('local-feedback', { body: JSON.stringify({ action, local_feedback_ms: local.elapsed }), contentType: 'application/json' });
        await expect(feedback(row, id)).toContainText(sending[action]);
        await expect(row.locator('.download-worker-status')).toContainText(confirmed);
        await expect(row.locator('.download-summary-row')).toHaveText(before);
        await invoke(page, id, action);
        await expect.poll(() => gate.requests.length).toBe(1);
        expect(gate.requests[0].expected_revision).toMatch(/^\d+$/);
        expect(gate.requests[0].expected_attempt_id).toBeTruthy();
        await releaseNext(gate);
        await expect(feedback(row, id)).not.toContainText(sending[action]);
        await expect(feedback(row, id)).not.toContainText('Request not confirmed');
        await expect(row.locator('.download-worker-status')).toContainText(confirmed);
        await expect(row.locator('.download-summary-row')).toHaveText(before);
        expect(reads).toHaveLength(0);
        // The request acknowledgement never promotes a row to a new worker
        // status. Only a later authorized reconciliation can do that.
        expect((await (await page.request.get('/api/current-downloads')).json()).find(item => item.id === id).status).toBe(status);
    });
}

test('History Retry preserves clicked attempt identity, duplicate guard, focus and confirmed outcome', async ({ page }, testInfo) => {
    const id = 'command-history-retry';
    await ready(page, { id, status: 'error', title: 'Command retry failure', progress: 'Source unavailable' });
    await openHistory(page);
    const row = page.locator('.attempt-row').filter({ hasText: 'Command retry failure' });
    const button = row.getByRole('button', { name: 'Retry', exact: true });
    const clickedAttempt = await button.getAttribute('data-attempt-id');
    await button.evaluate(element => {
        element.addEventListener('click', () => { window.commandRetryStarted = performance.now(); }, true);
        window.addEventListener('click', () => {
            if (element.closest('.attempt-row').querySelector('[data-download-command-status]').textContent.includes('Starting')) {
                window.commandRetryFeedbackMs = performance.now() - window.commandRetryStarted;
            }
        });
    });
    const gate = gateCommand(page, id, 'retry', { attemptId: 'new-retry-attempt' });
    await gate.installed;
    const reads = countCollections(page);
    await button.focus();
    await button.press('Enter');
    await expect(feedback(row, id)).toContainText('Starting');
    const elapsed = await page.evaluate(() => window.commandRetryFeedbackMs);
    expect(elapsed).toBeLessThan(50);
    await testInfo.attach('local-feedback', { body: JSON.stringify({ action: 'retry', local_feedback_ms: elapsed }), contentType: 'application/json' });
    await expect(row.locator('.attempt-status')).toHaveText('Failed');
    await expect.poll(() => gate.requests.length).toBe(1);
    expect(gate.requests[0].expected_attempt_id).toBe(clickedAttempt);
    await invoke(page, id, 'retry');
    expect(gate.requests).toHaveLength(1);
    await releaseNext(gate);
    await expect(feedback(row, id)).not.toContainText('Starting');
    await expect(row.locator('.attempt-status')).toHaveText('Failed');
    await expect(button).toBeFocused();
    expect(reads).toHaveLength(0);
});

test('Stop queues behind a held Pause and dispatches only after correlated acceptance', async ({ page }) => {
    const id = 'command-pause-stop';
    await ready(page, { id, status: 'downloading', progress: '30%' });
    await openCurrent(page);
    const pause = gateCommand(page, id, 'pause');
    const stop = gateCommand(page, id, 'stop');
    await Promise.all([pause.installed, stop.installed]);
    await invoke(page, id, 'pause');
    await expect.poll(() => pause.requests.length).toBe(1);
    await invoke(page, id, 'stop');
    await expect(feedback(card(page, id), id)).toContainText(/Stopping|queued/i);
    expect(stop.requests).toHaveLength(0);
    await releaseNext(pause);
    await expect.poll(() => stop.requests.length).toBe(1);
    expect(stop.requests[0].expected_revision).toBe(String(BigInt(pause.requests[0].expected_revision) + 1n));
    expect(stop.requests[0].expected_attempt_id).toBe(pause.requests[0].expected_attempt_id);
    await releaseNext(stop);
    await expect(feedback(card(page, id), id)).not.toContainText(/Pausing|Stopping/);
});

test('an unknown Pause keeps queued Stop blocked and replays only its frozen attempt', async ({ page }) => {
    const id = 'command-unknown-pause';
    await ready(page, { id, status: 'downloading', progress: '20%' });
    await openCurrent(page);
    const pauses = [];
    await page.route(`**/api/pause/${id}`, async route => {
        const payload = route.request().postDataJSON();
        pauses.push(payload);
        if (pauses.length === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(accepted(id, 'pause', payload)) });
    });
    const stop = gateCommand(page, id, 'stop');
    await stop.installed;
    await invoke(page, id, 'pause');
    await expect(feedback(card(page, id), id)).toContainText('Request not confirmed');
    await invoke(page, id, 'stop');
    expect(stop.requests).toHaveLength(0);
    await closeCurrent(page);
    await expect(summary(page)).toContainText('Request not confirmed');
    await expect(summary(page).locator('[data-command-recovery="replay"]')).toBeVisible();
    const unresolvedId = await summary(page).locator('[data-command-recovery="replay"]').getAttribute('data-intent-id');
    await summary(page).locator(`[data-command-recovery="dismiss"][data-intent-id="${unresolvedId}"]`).click();
    await expect(summary(page)).toContainText('Request not confirmed');
    expect(stop.requests).toHaveLength(0);
    await summary(page).locator('[data-command-recovery="replay"]').click();
    await expect.poll(() => stop.requests.length).toBe(1);
    expect(pauses).toHaveLength(2);
    expect(pauses[1]).toEqual(pauses[0]);
    await releaseNext(stop);
    await expect(summary(page)).not.toContainText('Request not confirmed');
});

test('malformed success remains unknown and matching worker reconciliation cannot confirm its command', async ({ page }) => {
    const id = 'command-malformed';
    await ready(page, { id, status: 'downloading', progress: '20%' });
    await openCurrent(page);
    const requests = [];
    await page.route(`**/api/pause/${id}`, async route => {
        const payload = route.request().postDataJSON();
        requests.push(payload);
        const body = accepted(id, 'pause', payload);
        body.command.source_attempt_id = 'unrelated-attempt';
        return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await invoke(page, id, 'pause');
    await expect(feedback(card(page, id), id)).toContainText('Request not confirmed');
    await seed(page, { id, status: 'paused', progress: 'Paused' });
    await refresh(page);
    await expect(feedback(card(page, id), id)).toContainText('Request not confirmed');
    expect(requests).toHaveLength(1);
    await feedback(card(page, id), id).locator('[data-command-recovery="check"]').click();
    await expect(summary(page)).toContainText('Request not confirmed');
    expect(requests).toHaveLength(1);
});

test('definite refusal explains eligibility without changing confirmed status or blocking another download', async ({ page }) => {
    const id = 'command-refused';
    await ready(page, { id, status: 'downloading', progress: '20%' });
    await seed(page, { id: 'command-independent', status: 'downloading', progress: '60%' });
    await refresh(page);
    await openCurrent(page);
    const before = await card(page, id).locator('.download-summary-row').textContent();
    await page.route(`**/api/pause/${id}`, route => {
        const payload = route.request().postDataJSON();
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
            id, command_revision: payload.expected_revision, current_attempt_id: payload.expected_attempt_id, command: null,
            mutation: { id: payload.client_mutation_id, domain: 'download-command', revision: payload.expected_revision, outcome: 'rejected' },
            error: 'Worker no longer owns that attempt',
        }) });
    });
    const independent = gateCommand(page, 'command-independent', 'stop');
    await independent.installed;
    await invoke(page, id, 'pause');
    await expect(feedback(card(page, id), id)).toContainText(/Worker no longer|review|eligible|cannot/i);
    await invoke(page, 'command-independent', 'stop');
    await expect.poll(() => independent.requests.length).toBe(1);
    await releaseNext(independent);
    await expect(card(page, id).locator('.download-summary-row')).toHaveText(before);
});

for (const theme of ['light', 'dark']) {
    test(`${theme} keyboard Stop has readable status and stable narrow layout with reduced motion`, async ({ page }) => {
        const id = `command-theme-${theme}`;
        await ready(page, { id, status: 'downloading', progress: '30%' });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.setViewportSize({ width: 390, height: 850 });
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await openCurrent(page);
        const gate = gateCommand(page, id, 'stop');
        await gate.installed;
        const row = card(page, id);
        const button = row.getByRole('button', { name: 'Stop', exact: true }).first();
        await button.focus();
        await button.press('Enter');
        await expect(feedback(row, id)).toContainText('Stopping');
        await expect(feedback(row, id)).toHaveAttribute('role', 'status');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await releaseNext(gate);
        await expect(feedback(row, id)).not.toContainText('Stopping');
    });
}

async function liveWork(page, suffix) {
    await page.request.post('/__test__/hold-downloads');
    const response = await page.request.post('/api/download', { data: { url: `https://fixture.invalid/command-${suffix}` } });
    expect(response.ok()).toBe(true);
    const { id } = await response.json();
    await expect.poll(async () => {
        const rows = await (await page.request.get('/api/current-downloads')).json();
        return rows.find(row => row.id === id)?.progress;
    }).toBe('Waiting for media');
    await refresh(page);
    await openCurrent(page);
    return id;
}

test('a committed pause with a lost response confirms through its real receipt without worker-status projection', async ({ page }) => {
    await ready(page);
    const id = await liveWork(page, 'lost-pause');
    const before = await card(page, id).locator('.download-summary-row').textContent();
    await page.route('**/api/mutations/*', route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Mutation unavailable', final: false }) }));
    let payload;
    let canonical;
    await page.route(`**/api/pause/${id}`, async route => {
        payload = route.request().postDataJSON();
        const response = await route.fetch();
        canonical = await response.json();
        expect(response.status()).toBe(202);
        await route.abort('failed');
    });
    const reads = countCollections(page);
    await invoke(page, id, 'pause');
    await expect(feedback(card(page, id), id)).toContainText('Request not confirmed');
    expect(canonical.mutation.outcome).toBe('accepted');
    expect(canonical.command.source_attempt_id).toBe(payload.expected_attempt_id);
    await page.unroute('**/api/mutations/*');
    await feedback(card(page, id), id).locator('[data-command-recovery="check"]').click();
    await expect(feedback(card(page, id), id)).not.toContainText('Request not confirmed');
    await expect(feedback(card(page, id), id)).not.toContainText('Pausing');
    await expect(card(page, id).locator('.download-summary-row')).toHaveText(before);
    expect(reads).toHaveLength(0);
    const receipt = await (await page.request.get(`/api/mutations/${payload.client_mutation_id}`)).json();
    expect(receipt.command.id).toBe(canonical.command.id);
    expect(receipt.command.attempt_id).toBe(canonical.command.attempt_id);
});

test('real Resume replay returns one durable job and one linked new attempt after response loss', async ({ page }) => {
    const id = 'command-real-resume';
    await ready(page, { id, status: 'cancelled', title: 'Resume once', progress: 'Cancelled' });
    await page.request.post('/__test__/hold-downloads');
    await openCurrent(page);
    const requests = [];
    const acknowledgements = [];
    await page.route('**/api/mutations/*', route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Mutation unavailable', final: false }) }));
    await page.route(`**/api/resume/${id}`, async route => {
        requests.push(route.request().postDataJSON());
        const response = await route.fetch();
        acknowledgements.push(await response.json());
        if (requests.length === 1) return route.abort('failed');
        return route.fulfill({ response });
    });
    await invoke(page, id, 'resume');
    await expect(feedback(card(page, id), id)).toContainText('Request not confirmed');
    await feedback(card(page, id), id).locator('[data-command-recovery="replay"]').click();
    await expect(feedback(card(page, id), id)).toContainText('Request accepted');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(acknowledgements[0].mutation.outcome).toBe('accepted');
    expect(acknowledgements[1].command.id).toBe(acknowledgements[0].command.id);
    expect(acknowledgements[1].command.job_id).toBe(acknowledgements[0].command.job_id);
    expect(acknowledgements[1].command.attempt_id).toBe(acknowledgements[0].command.attempt_id);
    const current = (await (await page.request.get('/api/current-downloads')).json()).find(item => item.id === id);
    expect(current.current_attempt_id).toBe(acknowledgements[0].command.attempt_id);
    expect(current.job_id).toBe(acknowledgements[0].command.job_id);
    const attempts = await (await page.request.get('/api/history')).json();
    expect(attempts.items.filter(item => item.download_id === id)).toHaveLength(2);
    expect(attempts.items.find(item => item.id === current.current_attempt_id).job_id).toBe(current.job_id);
});

test('a held old History Retry cannot start a second execution after another tab takes ownership', async ({ page }) => {
    const id = 'command-history-generation';
    await ready(page, { id, status: 'error', title: 'Generation guarded retry', progress: 'Old failure' });
    await page.request.post('/__test__/hold-downloads');
    await openHistory(page);
    const row = page.locator('.attempt-row').filter({ hasText: 'Generation guarded retry' });
    let release;
    let oldPayload;
    let oldReply;
    await page.route(`**/api/retry/${id}`, async route => {
        oldPayload = route.request().postDataJSON();
        await new Promise(resolve => { release = resolve; });
        const response = await route.fetch();
        oldReply = await response.json();
        return route.fulfill({ response });
    });
    await row.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    // APIRequestContext bypasses the page's transport gate, representing a
    // competing authenticated tab with a distinct deliberate mutation ID.
    const competing = await page.request.post(`/api/retry/${id}`, { data: {
        ...oldPayload,
        client_mutation_id: `${Date.now()}-${'a'.repeat(32)}`,
    } });
    expect(competing.status()).toBe(202);
    const acceptedCommand = await competing.json();
    release();
    await expect(feedback(row, id)).toContainText(/changed|review/i);
    expect(oldReply.mutation.outcome).toBe('conflicted');
    expect(oldReply.current_attempt_id).toBe(acceptedCommand.command.attempt_id);
    const attempts = await (await page.request.get('/api/history')).json();
    expect(attempts.items.filter(item => item.download_id === id)).toHaveLength(2);
});

test('known access loss fences an in-flight acceptance and its recovery summary', async ({ page }) => {
    const id = 'command-access-fence';
    await ready(page, { id, status: 'downloading', progress: '25%' });
    await openCurrent(page);
    const gate = gateCommand(page, id, 'pause');
    await gate.installed;
    await invoke(page, id, 'pause');
    await expect.poll(() => gate.requests.length).toBe(1);
    await page.evaluate(id => tagMutations.fence(id), id);
    await expect(summary(page)).not.toContainText('Pausing');
    await releaseNext(gate);
    await expect(summary(page)).not.toContainText(/Pausing|Request not confirmed/);
    expect(await page.evaluate(id => tagMutations.pending().some(intent => intent.targetId === id), id)).toBe(false);
});

test('authentication reset ignores a held command acceptance and sends no queued Stop', async ({ page }) => {
    const id = 'command-auth-fence';
    await ready(page, { id, status: 'downloading', progress: '25%' });
    await openCurrent(page);
    const pause = gateCommand(page, id, 'pause');
    const stop = gateCommand(page, id, 'stop');
    await Promise.all([pause.installed, stop.installed]);
    await invoke(page, id, 'pause');
    await expect.poll(() => pause.requests.length).toBe(1);
    await invoke(page, id, 'stop');
    await page.evaluate(() => resetTagSession());
    await releaseNext(pause);
    await expect(summary(page)).not.toContainText(/Pausing|Stopping|Request not confirmed/);
    expect(stop.requests).toHaveLength(0);
});

test('slow delivery replaces spinner-only feedback and late acceptance still correlates after timeout', async ({ page }) => {
    const id = 'command-slow';
    await ready(page, { id, status: 'downloading', progress: '25%' });
    await openCurrent(page);
    await page.clock.install();
    const gate = gateCommand(page, id, 'pause');
    await gate.installed;
    await invoke(page, id, 'pause');
    await expect.poll(() => gate.requests.length).toBe(1);
    await page.clock.fastForward(5_100);
    await expect(feedback(card(page, id), id)).toContainText(/Still waiting|taking longer/i);
    await page.clock.fastForward(25_100);
    await expect(feedback(card(page, id), id)).toContainText('Request not confirmed');
    await releaseNext(gate);
    await expect(feedback(card(page, id), id)).toContainText('Request accepted');
});

test('unsupported command capability retains truthful pending feedback without receipt recovery or replay', async ({ page }) => {
    const id = 'command-legacy';
    await page.route('**/api/client-capabilities', async route => {
        const response = await route.fetch();
        const body = await response.json();
        body.actions = body.actions.filter(action => !action.startsWith('download.'));
        return route.fulfill({ response, json: body });
    });
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    await seed(page, { id, status: 'downloading', progress: '25%' });
    await refresh(page);
    await expect.poll(() => page.evaluate(() => tagCapabilities && !hasDownloadCommandProtocol('pause'))).toBe(true);
    await openCurrent(page);
    let release;
    let payload;
    let writes = 0;
    let receiptReads = 0;
    page.on('request', request => { if (request.url().includes('/api/mutations/')) receiptReads++; });
    await page.route(`**/api/pause/${id}`, async route => {
        writes++;
        payload = route.request().postDataJSON();
        await new Promise(resolve => { release = resolve; });
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    });
    await invoke(page, id, 'pause');
    await expect(feedback(card(page, id), id)).toContainText('Pausing');
    await expect.poll(() => Boolean(release)).toBe(true);
    expect(payload.client_mutation_id).toBeUndefined();
    await invoke(page, id, 'pause');
    expect(writes).toBe(1);
    release();
    await expect(feedback(card(page, id), id)).toContainText('Request not confirmed');
    await expect(feedback(card(page, id), id)).toContainText('cannot safely replay');
    await expect(feedback(card(page, id), id).locator('[data-command-recovery="replay"]')).toHaveCount(0);
    expect(receiptReads).toBe(0);
});

test('worker media failure after acceptance remains a separate reconciled History outcome', async ({ page }) => {
    const id = 'command-worker-failure';
    await ready(page, { id, status: 'error', title: 'Unavailable source retry', progress: 'Previous error', url: 'https://fixture.invalid/missing' });
    await openHistory(page);
    const row = page.locator('.attempt-row').filter({ hasText: 'Unavailable source retry' });
    const acceptedResponse = page.waitForResponse(response => response.url().endsWith(`/api/retry/${id}`));
    await row.getByRole('button', { name: 'Retry', exact: true }).click();
    const response = await acceptedResponse;
    expect(response.status()).toBe(202);
    const acknowledgement = await response.json();
    expect(acknowledgement.mutation.outcome).toBe('accepted');
    await expect(feedback(row, id)).toContainText('Request accepted');
    await expect.poll(async () => {
        const data = await (await page.request.get('/api/history')).json();
        return data.items.find(item => item.id === acknowledgement.command.attempt_id)?.status;
    }).toBe('error');
    await page.evaluate(() => fetchAttemptHistory());
    const failed = page.locator(`#attempt-${acknowledgement.command.attempt_id}`);
    await expect(failed.locator('.attempt-status')).toHaveText('Failed');
    await expect(failed).toContainText('404');
    const receipt = await (await page.request.get(`/api/mutations/${acknowledgement.mutation.id}`)).json();
    expect(receipt.mutation.outcome).toBe('accepted');
    expect(receipt.command.id).toBe(acknowledgement.command.id);
    expect(receipt.command.status).toBe('error');
});

test('signing out and switching accounts clears private command recovery and ignores the old response', async ({ page }) => {
    const id = 'command-private-account';
    await ready(page, { id, status: 'downloading', visibility: 'private', progress: '25%' });
    expect((await page.request.post('/api/users', { data: {
        username: 'command-next-account', name: 'Next Command Account', password: 'next-password', role: 'normal',
    } })).ok()).toBe(true);
    await openCurrent(page);
    let release;
    let delivered = false;
    await page.route(`**/api/pause/${id}`, async route => {
        const payload = route.request().postDataJSON();
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(accepted(id, 'pause', payload)) }).catch(() => {});
        delivered = true;
    });
    await invoke(page, id, 'pause');
    await expect.poll(() => Boolean(release)).toBe(true);
    await closeCurrent(page);
    await switchAccount(page, 'command-next-account', 'next-password');
    release();
    await expect.poll(() => delivered).toBe(true);
    await expect(summary(page)).toBeHidden();
    await expect(card(page, id)).toHaveCount(0);
    expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
    await expect(page.locator('#currentUsername')).toHaveText('command-next-account');
});

test('a stale pre-command collection response cannot rewind acknowledged attempt ownership', async ({ page }) => {
    const id = 'command-old-read';
    await ready(page, { id, status: 'cancelled', progress: 'Cancelled' });
    await openCurrent(page);
    let releaseRead;
    let heldRead = false;
    await page.route('**/api/current-downloads', async route => {
        if (heldRead) return route.continue();
        heldRead = true;
        const response = await route.fetch();
        await new Promise(resolve => { releaseRead = resolve; });
        return route.fulfill({ response });
    });
    const staleRead = page.evaluate(() => fetchHistory());
    await expect.poll(() => Boolean(releaseRead)).toBe(true);
    const gate = gateCommand(page, id, 'resume', { attemptId: 'acknowledged-new-attempt' });
    await gate.installed;
    await invoke(page, id, 'resume');
    await releaseNext(gate);
    await expect(feedback(card(page, id), id)).toContainText('Request accepted');
    releaseRead();
    await staleRead;
    expect(await page.evaluate(id => tagState.selectDownload(id).current_attempt_id, id)).toBe('acknowledged-new-attempt');
    const mapped = await page.evaluate(id => {
        const projected = projectTagEntry({ id, command_revision: '0', current_attempt_id: 'obsolete-attempt', job_id: 'obsolete-job' });
        return { job: tagState.selectDownload(id).job_id, projectedJob: projected.job_id, projectedAttempt: projected.current_attempt_id };
    }, id);
    expect(mapped).toEqual({ job: gate.requests[0].client_mutation_id, projectedJob: gate.requests[0].client_mutation_id, projectedAttempt: 'acknowledged-new-attempt' });
    await expect(feedback(card(page, id), id)).not.toContainText('Request not confirmed');
});

test('an older successful command callback cannot replace a newer remotely owned worker attempt', async ({ page }) => {
    const id = 'command-old-ack';
    await ready(page, { id, status: 'downloading', progress: '25%' });
    await openCurrent(page);
    let release;
    let original;
    await page.route(`**/api/pause/${id}`, async route => {
        const response = await route.fetch();
        original = await response.json();
        await new Promise(resolve => { release = resolve; });
        return route.fulfill({ response });
    });
    await invoke(page, id, 'pause');
    await expect.poll(() => Boolean(release)).toBe(true);
    expect(original.mutation.outcome).toBe('accepted');
    await seed(page, { id, status: 'error', progress: 'The earlier worker failed' });
    await page.request.post('/__test__/hold-downloads');
    const response = await page.request.post(`/api/retry/${id}`);
    expect(response.ok()).toBe(true);
    await refresh(page);
    const newerAttempt = await page.evaluate(id => tagState.selectDownload(id).current_attempt_id, id);
    expect(newerAttempt).not.toBe(original.command.attempt_id);
    release();
    await expect(feedback(card(page, id), id)).toContainText('Request accepted');
    expect(await page.evaluate(id => tagState.selectDownload(id).current_attempt_id, id)).toBe(newerAttempt);
    expect(await page.evaluate(id => tagState.selectDownload(id).command_revision, id)).not.toBe(original.command_revision);
});

for (const surface of ['Current', 'History']) {
    test(`${surface} announces each command transition once through its exposed live channel`, async ({ page }) => {
        const id = `command-announcement-${surface.toLowerCase()}`;
        const action = surface === 'Current' ? 'stop' : 'retry';
        await ready(page, { id, status: surface === 'Current' ? 'downloading' : 'error', progress: 'Existing worker state' });
        if (surface === 'Current') await openCurrent(page);
        else await openHistory(page);
        const channel = surface === 'Current' ? '#currentTagMutationStatus' : '#tagMutationStatus';
        await page.evaluate(selector => {
            window.commandAnnouncements = [];
            const status = document.querySelector(selector);
            new MutationObserver(records => {
                records.filter(record => record.target === status).forEach(() => window.commandAnnouncements.push(status.textContent));
            }).observe(status, { childList: true });
        }, channel);
        const gate = gateCommand(page, id, action, { attemptId: action === 'retry' ? 'announced-retry-attempt' : undefined });
        await gate.installed;
        if (surface === 'Current') await invoke(page, id, action);
        else await page.locator('.attempt-row').getByRole('button', { name: 'Retry', exact: true }).click();
        const row = surface === 'Current' ? card(page, id) : page.locator('.attempt-row');
        await expect(feedback(row, id)).toHaveAttribute('aria-live', 'off');
        await expect(summary(page)).toHaveAttribute('aria-live', 'off');
        await expect(page.locator(channel)).toContainText(sending[action]);
        await page.evaluate(() => refreshDownloadCommandPresentations());
        const pending = await page.evaluate(() => window.commandAnnouncements);
        expect(pending.filter(message => message.includes(sending[action]))).toHaveLength(1);
        await releaseNext(gate);
        await expect(page.locator(channel)).toContainText('Request accepted');
        await page.evaluate(() => refreshDownloadCommandPresentations());
        const settled = await page.evaluate(() => window.commandAnnouncements);
        expect(settled.filter(message => message.includes('Request accepted'))).toHaveLength(1);
    });
}

test('an actual stale Current Stop control cannot retarget a newer known worker attempt', async ({ page }) => {
    const id = 'command-stale-current-control';
    await ready(page, { id, status: 'downloading', progress: '25%' });
    await openCurrent(page);
    const button = card(page, id).getByRole('button', { name: 'Stop', exact: true }).first();
    const displayedAttempt = await button.getAttribute('data-command-attempt');
    expect(displayedAttempt).toBeTruthy();
    await button.evaluate(element => { window.originalCommandControl = element; });
    const writes = [];
    await page.route(`**/api/stop/${id}`, route => {
        writes.push(route.request().postDataJSON());
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    });
    await page.evaluate(id => {
        const previous = tagState.writer.confirmed(id);
        // A newer authorized worker snapshot can be accepted while a view is
        // retained. Its rendered control still belongs to the older attempt.
        acceptingTagSnapshots = true;
        try {
            tagState.acceptDownload({ id, command_revision: String(BigInt(previous.command_revision) + 1n), current_attempt_id: 'newer-known-worker', status: 'downloading' });
        } finally { acceptingTagSnapshots = false; }
    }, id);
    expect(await button.evaluate(element => element === window.originalCommandControl)).toBe(true);
    expect(await button.getAttribute('data-command-attempt')).toBe(displayedAttempt);
    await button.click();
    await expect(page.locator('#currentTagMutationStatus')).toContainText(/older attempt|changed|review/i);
    expect(writes).toHaveLength(0);
    expect(await page.evaluate(id => tagState.selectDownload(id).current_attempt_id, id)).toBe('newer-known-worker');
    expect(await page.evaluate(() => tagMutations.hasPending())).toBe(false);
});

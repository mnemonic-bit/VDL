const { test, expect } = require('@playwright/test');
const { reset, openCurrent, closeCurrent, openNewDownload, switchAccount } = require('./support.cjs');

const summary = page => page.locator('#uploadRecoverySummary');
const row = (page, name) => page.locator('#activeList .history-item', { hasText: name.replace(/\.mp4$/, '') });
const check = surface => surface.getByRole('button', { name: 'Check upload status', exact: true });

async function drop(page, names) {
    return page.evaluate(names => {
        const transfer = new DataTransfer();
        for (const name of names) transfer.items.add(new File([new Uint8Array([0, 1, 2, 3])], name, { type: 'video/mp4' }));
        const before = performance.now();
        document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        document.getElementById('uploadDropOverlay').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        return { elapsed: performance.now() - before, text: document.getElementById('uploadRecoverySummary').textContent };
    }, names);
}

async function ready(page) {
    await page.route('**/api/events', route => route.abort());
    await page.reload();
    await expect.poll(() => page.evaluate(() => tagCapabilities?.upload_recovery)).toBe(1);
}

function deferred() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
}

async function gate(page, pattern, { committed = false, method } = {}) {
    const requests = [];
    const waiting = [];
    const handler = async route => {
        if (method && route.request().method() !== method) return route.fallback();
        const response = committed ? await route.fetch() : null;
        const hold = deferred();
        requests.push({ request: route.request(), response });
        waiting.push(hold.release);
        await hold.promise;
        if (response) return route.fulfill({ response }).catch(() => {});
        return route.continue().catch(() => {});
    };
    await page.route(pattern, handler);
    return { requests, waiting, release: () => waiting.splice(0).forEach(release => release()), handler };
}

async function blockedRecovery(page) {
    await page.route('**/api/mutations/*', route => route.fulfill({ status: 404, json: { error: 'Mutation unavailable', final: false } }));
    await page.route('**/api/upload/*/status', route => route.fulfill({ status: 503, json: { error: 'Status check temporarily unavailable' } }));
}

async function allowRecovery(page) {
    await page.unroute('**/api/mutations/*');
    await page.unroute('**/api/upload/*/status');
}

async function flush(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function assertSingleAttempt(page, id) {
    const history = await (await page.request.get('/api/history')).json();
    expect(history.items.filter(item => item.download_id === id)).toHaveLength(1);
}

async function finishCancellation(page, id, surface) {
    await page.request.post('/__test__/release-uploads');
    await expect.poll(async () => {
        const response = await page.request.get(`/api/upload/${id}/status`);
        return (await response.json()).upload?.phase;
    }).toBe('cancelled');
    // An independent collection read may already have observed the terminal
    // phase and retired the transfer's recovery controls.
    if (await check(surface).count()) await check(surface).click();
}

test.beforeEach(async ({ page }) => { await reset(page); await ready(page); });
test.setTimeout(25_000);
test.afterEach(async ({ page }) => {
    await page.request.post('/__test__/release-uploads');
});

test('registration, bytes, processing and publication preserve one identity without playable partials', async ({ page }, testInfo) => {
    await page.request.post('/__test__/hold-uploads');
    const registration = await gate(page, '**/api/upload', { committed: true });
    const transfer = await gate(page, '**/api/upload/*', { method: 'PUT' });
    try {
        const local = await drop(page, ['phases.mp4']);
        expect(local.elapsed).toBeLessThan(50);
        expect(local.text).toContain('Registering upload');
        await testInfo.attach('local-feedback', { body: JSON.stringify({ local_feedback_ms: local.elapsed }), contentType: 'application/json' });
        await openCurrent(page);
        const upload = row(page, 'phases.mp4');
        await expect(upload).toHaveCount(1);
        await expect(upload).toContainText('Registering upload');
        await expect(upload.getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
        await expect.poll(() => registration.requests.length).toBe(1);
        const id = registration.requests[0].request.postDataJSON().id;
        await page.evaluate(id => {
            const upload = droppedUploads.get(id);
            registerDroppedVideo(upload, upload.file);
            registerDroppedVideo(upload, upload.file);
        }, id);
        expect(registration.requests).toHaveLength(1);
        await expect(upload).toHaveAttribute('data-row-id', id);
        await upload.evaluate(element => { window.__uploadRow = element; });
        await page.evaluate(() => fetchHistory());
        expect(await upload.evaluate(element => element === window.__uploadRow)).toBe(true);
        // Publication must render from its canonical PUT acknowledgement even
        // when every subsequent collection reconciliation is still waiting.
        await page.route('**/api/current-downloads', () => {});
        await page.route('**/api/library?include_order=true', () => {});
        registration.release();
        await expect.poll(() => transfer.requests.length).toBe(1);
        await page.evaluate(id => {
            const upload = droppedUploads.get(id);
            beginDroppedTransfer(upload);
            beginDroppedTransfer(upload);
        }, id);
        expect(transfer.requests).toHaveLength(1);
        await expect(upload).toContainText('Uploading');
        expect(await upload.evaluate(element => element === window.__uploadRow)).toBe(true);
        await page.evaluate(id => {
            activeUploadRequests.get(id).upload.dispatchEvent(new ProgressEvent('progress', { loaded: 2, total: 4, lengthComputable: true }));
        }, id);
        await expect(upload).toContainText('Bytes uploaded: 2.0 B');
        await expect(upload).toContainText('Uploaded: 50%');
        await expect(upload.getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
        transfer.release();
        await expect(upload).toContainText('Processing upload');
        await expect(upload).toContainText('Uploaded: 100%');
        await expect(upload).toContainText('Bytes uploaded: 4.0 B');
        await expect(page.locator('#historyList .history-card')).toHaveCount(0);
        await expect(upload.getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
        await page.request.post('/__test__/release-uploads');
        const published = page.locator(`#historyList [data-row-id="${id}"]`);
        await expect(published).toBeVisible();
        await expect(page.locator('#activeList .history-item')).toHaveCount(0);
        expect(transfer.requests).toHaveLength(1);
        await assertSingleAttempt(page, id);
    } finally { registration.release(); transfer.release(); }
});

test('Stop before registration acknowledges remains pending and never starts that file body', async ({ page }) => {
    const registration = await gate(page, '**/api/upload', { committed: true });
    const transfers = [];
    page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/api/upload/')) transfers.push(request); });
    try {
        await drop(page, ['stop-register.mp4']);
        await openCurrent(page);
        const upload = row(page, 'stop-register.mp4');
        await expect.poll(() => registration.requests.length).toBe(1);
        const id = registration.requests[0].request.postDataJSON().id;
        await upload.getByRole('button', { name: 'Stop', exact: true }).click();
        await expect(upload).toContainText('Stopping upload');
        await expect(upload).not.toContainText('Upload stopped');
        await expect(upload).not.toContainText('Status: Cancelled');
        expect(transfers).toHaveLength(0);
        registration.release();
        await expect(upload).toContainText(/Upload stopped|Cancelled/);
        expect(transfers).toHaveLength(0);
        const status = await (await page.request.get(`/api/upload/${id}/status`)).json();
        expect(status.upload.phase).toBe('cancelled');
        await assertSingleAttempt(page, id);
    } finally { registration.release(); }
});

test('Stop during transfer only announces cancellation after the server acknowledgement', async ({ page }) => {
    const transfer = await gate(page, '**/api/upload/*', { method: 'PUT' });
    const cancel = await gate(page, '**/api/upload/*/cancel', { committed: true });
    try {
        await drop(page, ['stop-bytes.mp4']);
        await expect.poll(() => transfer.requests.length).toBe(1);
        await openCurrent(page);
        const upload = row(page, 'stop-bytes.mp4');
        await upload.getByRole('button', { name: 'Stop', exact: true }).click();
        await expect.poll(() => cancel.requests.length).toBe(1);
        await page.evaluate(id => { stopDownload(id); stopDownload(id); }, await upload.getAttribute('data-row-id'));
        expect(cancel.requests).toHaveLength(1);
        await expect(upload).toContainText('Stopping upload');
        await expect(upload).not.toContainText('Upload stopped');
        await expect(upload).not.toContainText('Status: Cancelled');
        await closeCurrent(page);
        await expect(summary(page)).toContainText('Stopping upload');
        await openCurrent(page);
        cancel.release();
        await expect(upload).toContainText(/Upload stopped|Cancelled/);
        expect(cancel.requests).toHaveLength(1);
        expect(transfer.requests).toHaveLength(1);
    } finally { cancel.release(); transfer.release(); }
});

test('Stop during processing cancels only that upload while its sibling publishes', async ({ page }) => {
    await page.request.post('/__test__/hold-uploads');
    await drop(page, ['cancel-processing.mp4', 'sibling-processing.mp4']);
    await openCurrent(page);
    const stopped = row(page, 'cancel-processing.mp4');
    const sibling = row(page, 'sibling-processing.mp4');
    await expect(stopped).toContainText('Processing upload');
    await expect(sibling).toContainText('Processing upload');
    const cancel = await gate(page, '**/api/upload/*/cancel', { committed: true });
    try {
        await stopped.getByRole('button', { name: 'Stop', exact: true }).click();
        await expect(stopped).toContainText('Stopping upload');
        await expect(sibling.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
        await expect.poll(() => cancel.requests.length).toBe(1);
        cancel.release();
        const id = await stopped.getAttribute('data-row-id');
        await finishCancellation(page, id, stopped);
        await expect(stopped).toContainText(/Upload stopped|Cancelled/);
        await expect(page.locator('#historyList .history-card', { hasText: 'sibling-processing' })).toBeVisible();
        await expect(page.locator('#historyList .history-card', { hasText: 'cancel-processing' })).toHaveCount(0);
    } finally { cancel.release(); }
});

test('a Stop racing a committed publication preserves the authoritative finished media', async ({ page }) => {
    const publication = await gate(page, '**/api/upload/*', { committed: true, method: 'PUT' });
    try {
        await drop(page, ['published-race.mp4']);
        await expect.poll(() => publication.requests.length).toBe(1);
        const id = publication.requests[0].request.url().split('/').pop();
        await openCurrent(page);
        const upload = row(page, 'published-race.mp4');
        await upload.getByRole('button', { name: 'Stop', exact: true }).click();
        await expect(page.locator(`#historyList [data-row-id="${id}"]`)).toBeVisible();
        await expect(page.locator('#activeList .history-item')).toHaveCount(0);
        const status = await (await page.request.get(`/api/upload/${id}/status`)).json();
        expect(status.upload.phase).toBe('published');
        publication.release();
        await flush(page);
        await expect(page.locator(`#historyList [data-row-id="${id}"]`)).toHaveCount(1);
        await expect(page.locator(`#historyList [data-row-id="${id}"]`).getByRole('button', { name: 'Play', exact: true })).toBeVisible();
        await assertSingleAttempt(page, id);
    } finally { publication.release(); }
});

test('a definite cancellation refusal retains worker state and dismissal permits an explicit later Stop', async ({ page }) => {
    await page.request.post('/__test__/hold-uploads');
    await drop(page, ['refused-cancel.mp4']);
    await openCurrent(page);
    const upload = row(page, 'refused-cancel.mp4');
    await expect(upload).toContainText('Processing upload');
    const id = await upload.getAttribute('data-row-id');
    const payloads = [];
    await page.route('**/api/upload/*/cancel', async route => {
        const payload = route.request().postDataJSON();
        payloads.push(payload);
        if (payloads.length > 1) return route.continue();
        const current = await (await page.request.get(`/api/upload/${id}/status`)).json();
        return route.fulfill({ status: 429, json: {
            ...current, error: 'Cancellation refused; review and try again',
            mutation: { id: payload.client_mutation_id, domain: 'upload', outcome: 'rejected', revision: current.upload.revision },
        } });
    });
    await upload.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(upload).toContainText('Cancellation refused');
    await expect(upload).toContainText('Status: Downloading');
    await expect(upload).not.toContainText('Upload stopped');
    await upload.getByRole('button', { name: 'Dismiss upload request', exact: true }).click();
    await expect(upload).toHaveCount(1);
    await upload.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => payloads.length).toBe(2);
    expect(payloads[1].client_mutation_id).not.toBe(payloads[0].client_mutation_id);
    await finishCancellation(page, id, upload);
    await expect(upload).toContainText(/Upload stopped|Cancelled/);
    await assertSingleAttempt(page, id);
});

for (const boundary of ['registration', 'publication', 'cancellation']) {
    test(`lost ${boundary} acknowledgement retains explicit recovery without resending media`, async ({ page }) => {
        await blockedRecovery(page);
        // Hold collection reconciliation independently from the dropped
        // acknowledgement so the explicit authorized status check is exercised.
        await page.route('**/api/current-downloads', () => {});
        await page.route('**/api/library?include_order=true', () => {});
        const writes = [];
        let id;
        page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/api/upload/')) writes.push(request.url()); });
        const pattern = boundary === 'registration' ? '**/api/upload' : boundary === 'publication' ? '**/api/upload/*' : '**/api/upload/*/cancel';
        if (boundary === 'cancellation') await page.request.post('/__test__/hold-uploads');
        let dropped = 0;
        await page.route(pattern, async route => {
            if (boundary === 'publication' && route.request().method() !== 'PUT') return route.fallback();
            const response = await route.fetch();
            const payload = await response.json();
            id = payload.id;
            dropped++;
            return route.abort('failed');
        });
        await drop(page, [`lost-${boundary}.mp4`]);
        await openCurrent(page);
        const upload = row(page, `lost-${boundary}.mp4`);
        if (boundary === 'cancellation') {
            await expect(upload).toContainText('Processing upload');
            await upload.getByRole('button', { name: 'Stop', exact: true }).click();
        }
        await expect.poll(() => dropped).toBe(1);
        await expect(summary(page)).toContainText(/not confirmed/i);
        await expect(check(summary(page))).toBeVisible();
        await closeCurrent(page);
        await expect(summary(page)).toContainText(/not confirmed/i);
        const before = writes.length;
        await allowRecovery(page);
        // Hold the first body after recovered registration; no body was sent
        // before the canonical registration outcome became known.
        const pendingBody = boundary === 'registration' ? await gate(page, '**/api/upload/*', { method: 'PUT' }) : null;
        try {
            await check(summary(page)).click();
            if (boundary === 'registration') {
                await expect.poll(() => writes.length).toBe(1);
                expect(before).toBe(0);
            } else {
                await expect(summary(page)).not.toContainText(/not confirmed/i);
                expect(writes).toHaveLength(before);
            }
            expect(dropped).toBe(1);
            await assertSingleAttempt(page, id);
        } finally { pendingBody?.release(); }
    });
}

test('authentication reset fences held registration and prevents its file dispatch', async ({ page }) => {
    const registration = await gate(page, '**/api/upload', { committed: true });
    const writes = [];
    page.on('request', request => { if (request.method() === 'PUT') writes.push(request.url()); });
    try {
        await drop(page, ['private-old-account.mp4']);
        await expect.poll(() => registration.requests.length).toBe(1);
        await page.evaluate(() => resetTagSession());
        registration.release();
        await flush(page);
        await expect(summary(page)).toBeHidden();
        await expect(page.locator('#activeList .history-item')).toHaveCount(0);
        expect(writes).toHaveLength(0);
        expect(await page.evaluate(() => droppedUploads.size)).toBe(0);
    } finally { registration.release(); }
});

test('an absent status while registration is still in flight cannot forget the upload or its late acknowledgement', async ({ page }) => {
    await page.clock.install();
    await page.route('**/api/mutations/*', route => route.fulfill({ status: 404, json: { error: 'Mutation unavailable', final: false } }));
    await page.route('**/api/upload/*/status', route => route.fulfill({ status: 404, json: { error: 'Upload unavailable' } }));
    const registration = await gate(page, '**/api/upload');
    const transfer = await gate(page, '**/api/upload/*', { method: 'PUT' });
    try {
        await drop(page, ['late-registration.mp4']);
        await expect.poll(() => registration.requests.length).toBe(1);
        await page.clock.fastForward(5_100);
        await expect(summary(page)).toContainText(/Still waiting|taking longer/i);
        await page.clock.fastForward(25_900);
        await expect(summary(page)).toContainText(/not confirmed/i);
        await check(summary(page)).click();
        await expect(summary(page)).toContainText(/not confirmed/i);
        expect(await page.evaluate(() => droppedUploads.size)).toBe(1);
        expect(transfer.requests).toHaveLength(0);
        registration.release();
        await expect.poll(() => transfer.requests.length).toBe(1);
        await expect(summary(page)).toContainText(/Uploading|Processing/);
        expect(registration.requests).toHaveLength(1);
    } finally { registration.release(); transfer.release(); }
});

test('deliberate registration replay uses the same frozen request and creates one transfer and History attempt', async ({ page }) => {
    await page.route('**/api/mutations/*', route => route.fulfill({ status: 404, json: { error: 'Mutation unavailable', final: false } }));
    const requests = [];
    let id;
    await page.route('**/api/upload', async route => {
        requests.push(route.request().postDataJSON());
        const response = await route.fetch();
        id = (await response.json()).id;
        if (requests.length === 1) return route.abort('failed');
        return route.fulfill({ response });
    });
    const transfer = await gate(page, '**/api/upload/*', { method: 'PUT' });
    try {
        await drop(page, ['frozen-registration.mp4']);
        await expect(summary(page)).toContainText(/not confirmed/i);
        await summary(page).getByRole('button', { name: 'Recover registration', exact: true }).click();
        await expect.poll(() => transfer.requests.length).toBe(1);
        expect(requests).toHaveLength(2);
        expect(requests[1]).toEqual(requests[0]);
        expect(requests[0].client_mutation_id).toMatch(/^\d+-[a-f0-9]{32}$/);
        await assertSingleAttempt(page, id);
    } finally { transfer.release(); }
});

test('a held old upload status cannot rewind a newer cancellation acknowledgement', async ({ page }) => {
    await page.request.post('/__test__/hold-uploads');
    await drop(page, ['older-status.mp4']);
    await openCurrent(page);
    const upload = row(page, 'older-status.mp4');
    await expect(upload).toContainText('Processing upload');
    const older = await gate(page, '**/api/upload/*/status', { committed: true });
    try {
        await check(upload).click();
        await expect.poll(() => older.requests.length).toBe(1);
        await upload.getByRole('button', { name: 'Stop', exact: true }).click();
        const id = await upload.getAttribute('data-row-id');
        await page.request.post('/__test__/release-uploads');
        await expect.poll(async () => (await (await page.request.get(`/api/upload/${id}/status`)).json()).upload?.phase).toBe('cancelled');
        await page.evaluate(() => fetchHistory());
        await expect(upload).toContainText(/Upload stopped|Cancelled/);
        older.release();
        await flush(page);
        await expect(upload).toContainText(/Upload stopped|Cancelled/);
        await expect(upload).not.toContainText('Processing upload');
        await expect(upload.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    } finally { older.release(); }
});

test('a stale collection read cannot replace cancelled upload state or duplicate its row', async ({ page }) => {
    await page.request.post('/__test__/hold-uploads');
    await drop(page, ['stale-collection.mp4']);
    await openCurrent(page);
    const upload = row(page, 'stale-collection.mp4');
    await expect(upload).toContainText('Processing upload');
    const oldCurrent = await gate(page, '**/api/current-downloads', { committed: true });
    let oldRefresh;
    try {
        oldRefresh = page.evaluate(() => fetchHistory()).catch(() => {});
        await expect.poll(() => oldCurrent.requests.length).toBe(1);
        await upload.getByRole('button', { name: 'Stop', exact: true }).click();
        await finishCancellation(page, await upload.getAttribute('data-row-id'), upload);
        await expect(upload).toContainText(/Upload stopped|Cancelled/);
        oldCurrent.release();
        await page.unroute('**/api/current-downloads', oldCurrent.handler);
        await oldRefresh;
        await flush(page);
        await expect(upload).toHaveCount(1);
        await expect(upload).toContainText(/Upload stopped|Cancelled/);
        await expect(upload.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    } finally { oldCurrent.release(); }
});

test('a held publication callback after authentication reset cannot restore private upload state', async ({ page }) => {
    const published = await gate(page, '**/api/upload/*', { committed: true, method: 'PUT' });
    try {
        await drop(page, ['old-published-account.mp4']);
        await expect.poll(() => published.requests.length).toBe(1);
        await page.evaluate(() => resetTagSession());
        published.release();
        await flush(page);
        await expect(summary(page)).toBeHidden();
        await expect(page.locator('#activeList .history-item')).toHaveCount(0);
        await expect(page.locator('#historyList .history-card')).toHaveCount(0);
        expect(await page.evaluate(() => droppedUploads.size)).toBe(0);
    } finally { published.release(); }
});

for (const fault of ['malformed success', 'server failure']) {
    test(`${fault} during registration stays unknown and does not automatically replay`, async ({ page }) => {
        await blockedRecovery(page);
        let registrations = 0;
        let bodies = 0;
        page.on('request', request => { if (request.method() === 'PUT') bodies++; });
        await page.route('**/api/upload', route => {
            registrations++;
            return route.fulfill({ status: fault === 'server failure' ? 500 : 202, json: { id: route.request().postDataJSON().id } });
        });
        await drop(page, [`unknown-${fault}.mp4`]);
        await expect(summary(page)).toContainText(/not confirmed/i);
        await expect(check(summary(page))).toBeVisible();
        await check(summary(page)).click();
        await flush(page);
        expect(registrations).toBe(1);
        expect(bodies).toBe(0);
        await expect(summary(page)).toContainText(/not confirmed/i);
    });
}

test('permission loss during registration clears private presentation and disables recovery', async ({ page }) => {
    await page.route('**/api/upload', route => route.fulfill({ status: 403, json: { error: 'Upload unavailable' } }));
    await drop(page, ['permission-private.mp4']);
    await flush(page);
    await expect(summary(page)).not.toContainText('permission-private');
    await expect(page.locator('#activeList')).not.toContainText('permission-private');
    await expect(summary(page).getByRole('button', { name: 'Recover registration', exact: true })).toHaveCount(0);
});

test('permission loss on an explicit status check fences an already accepted upload', async ({ page }) => {
    await page.request.post('/__test__/hold-uploads');
    await drop(page, ['status-private.mp4']);
    await openCurrent(page);
    const upload = row(page, 'status-private.mp4');
    await expect(upload).toContainText('Processing upload');
    await page.route('**/api/upload/*/status', route => route.fulfill({ status: 403, json: { error: 'Upload unavailable' } }));
    await check(upload).click();
    await expect(upload).toHaveCount(0);
    await expect(summary(page)).not.toContainText('status-private');
    expect(await page.evaluate(() => droppedUploads.size)).toBe(0);
});

test('reload reconciles an accepted upload without retaining or silently restarting its local File', async ({ page }) => {
    const registration = await gate(page, '**/api/upload', { committed: true });
    let bodies = 0;
    page.on('request', request => { if (request.method() === 'PUT') bodies++; });
    try {
        await drop(page, ['reload-registration.mp4']);
        await expect.poll(() => registration.requests.length).toBe(1);
        const id = registration.requests[0].request.postDataJSON().id;
        page.once('dialog', dialog => dialog.accept());
        await page.reload();
        await expect.poll(() => page.evaluate(() => tagCapabilities?.upload_recovery)).toBe(1);
        registration.release();
        await openCurrent(page);
        const accepted = page.locator(`#activeList [data-row-id="${id}"]`);
        await expect(accepted).toHaveCount(1);
        await flush(page);
        expect(bodies).toBe(0);
        expect(await page.evaluate(id => droppedUploads.get(id)?.file instanceof File, id)).toBe(false);
        const cancelled = page.waitForResponse(response => response.url().endsWith(`/api/upload/${id}/cancel`));
        await accepted.getByRole('button', { name: 'Stop', exact: true }).click();
        expect((await cancelled).status()).toBe(200);
        await expect(accepted).toContainText(/Upload stopped|Cancelled/);
        expect(bodies).toBe(0);
        expect(registration.requests).toHaveLength(1);
        expect((await (await page.request.get(`/api/upload/${id}/status`)).json()).upload.phase).toBe('cancelled');
    } finally { registration.release(); }
});

test('a reloaded legacy eight-character upload identity can be stopped without registering or transferring again', async ({ page }) => {
    const registered = await page.request.post('/api/upload', { data: { filename: 'legacy-eight-upload.mp4', filesize: 4 } });
    expect(registered.status()).toBe(202);
    const id = (await registered.json()).id;
    expect(id).toMatch(/^[a-f0-9]{8}$/);
    const writes = [];
    page.on('request', request => {
        if (request.method() === 'PUT' || request.method() === 'POST' && request.url().endsWith('/api/upload')) writes.push(request.url());
    });
    await page.reload();
    await expect.poll(() => page.evaluate(() => tagCapabilities?.upload_recovery)).toBe(1);
    await openCurrent(page);
    const upload = page.locator(`#activeList [data-row-id="${id}"]`);
    await expect(upload).toHaveCount(1);
    await expect(upload).toContainText(/local file is unavailable/i);
    const cancelled = page.waitForResponse(response => response.url().endsWith(`/api/upload/${id}/cancel`));
    await upload.getByRole('button', { name: 'Stop', exact: true }).click();
    expect((await cancelled).status()).toBe(200);
    await expect(upload).toContainText(/Upload stopped|Cancelled/);
    expect((await (await page.request.get(`/api/upload/${id}/status`)).json()).upload.phase).toBe('cancelled');
    expect(writes).toHaveLength(0);
    await assertSingleAttempt(page, id);
});

test('adopted status checks advance same-revision byte progress and ignore an older byte snapshot', async ({ page }) => {
    const id = 'a'.repeat(32);
    const registered = await page.request.post('/api/upload', { data: { id, filename: 'checked-progress.mp4', filesize: 128 } });
    expect(registered.status()).toBe(202);
    const canonical = (await registered.json()).upload;
    await page.reload();
    await expect.poll(() => page.evaluate(() => tagCapabilities?.upload_recovery)).toBe(1);
    await openCurrent(page);
    const upload = page.locator(`#activeList [data-row-id="${id}"]`);
    await expect(upload).toHaveCount(1);
    const bytes = [32, 64, 16];
    await page.route('**/api/upload/*/status', route => route.fulfill({ json: {
        id, upload: { ...canonical, phase: 'transferring', revision: String(BigInt(canonical.revision) + 1n), download_status: 'downloading', downloaded_bytes: bytes.shift(), total_bytes: 128 },
    } }));
    for (const [count, expected] of [[32, 25], [64, 50], [64, 50]]) {
        const checked = page.waitForResponse(response => response.url().endsWith(`/api/upload/${id}/status`));
        await check(upload).click();
        await (await checked).finished();
        await flush(page);
        await expect(upload).toContainText(`Bytes uploaded: ${count}.0 B`);
        await expect(upload).toContainText(`Uploaded: ${expected}%`);
        expect(await page.evaluate(() => activeUploadRequests.size)).toBe(0);
    }
});

test('upload diagnostic aggregates omit names, resource identities and request payloads', async ({ page }) => {
    const registration = await gate(page, '**/api/upload');
    try {
        await drop(page, ['private-diagnostic-name.mp4']);
        await expect.poll(() => registration.requests.length).toBe(1);
        const body = registration.requests[0].request.postDataJSON();
        const metrics = await page.evaluate(() => VDL.uploadMutationMetrics());
        expect(metrics.pending).toBeGreaterThan(0);
        expect(metrics.latestLocalFeedbackMs).toBeGreaterThanOrEqual(0);
        const serialized = JSON.stringify(metrics);
        expect(serialized).not.toContain('private-diagnostic-name');
        expect(serialized).not.toContain(body.id);
        expect(serialized).not.toContain(body.client_mutation_id);
    } finally { registration.release(); }
});

test('an untrusted local filename renders as text in the row and recovery summary', async ({ page }) => {
    const registration = await gate(page, '**/api/upload');
    const name = '<img src=x onerror=window.__uploadXss=1>.mp4';
    try {
        await drop(page, [name]);
        await openCurrent(page);
        await expect(row(page, name)).toContainText(name);
        await expect(summary(page)).toContainText(name);
        await expect(row(page, name).locator('img')).toHaveCount(0);
        await expect(summary(page).locator('img')).toHaveCount(0);
        expect(await page.evaluate(() => window.__uploadXss)).toBeUndefined();
    } finally { registration.release(); }
});

test('Current announces upload phases once while repeated byte rendering remains silent', async ({ page }) => {
    await page.request.post('/__test__/hold-uploads');
    await drop(page, ['announced-upload.mp4']);
    await openCurrent(page);
    const upload = row(page, 'announced-upload.mp4');
    await expect(upload).toContainText('Processing upload');
    const live = page.locator('#currentTagMutationStatus');
    await expect(live).toContainText('Processing upload');
    await page.evaluate(() => {
        window.__uploadAnnouncements = [];
        const status = document.getElementById('currentTagMutationStatus');
        new MutationObserver(() => window.__uploadAnnouncements.push(status.textContent)).observe(status, { childList: true, subtree: true, characterData: true });
        for (const request of activeUploadRequests.values()) request.upload.dispatchEvent(new ProgressEvent('progress', { loaded: 4, total: 4, lengthComputable: true }));
        renderDroppedUploads();
        renderDroppedUploads();
    });
    await flush(page);
    expect(await page.evaluate(() => window.__uploadAnnouncements)).toEqual([]);
    const cancel = await gate(page, '**/api/upload/*/cancel', { committed: true });
    try {
        await upload.getByRole('button', { name: 'Stop', exact: true }).click();
        await expect(live).toContainText('Stopping upload');
        await page.evaluate(() => { renderDroppedUploads(); renderDroppedUploads(); });
        await flush(page);
        const announcements = await page.evaluate(() => window.__uploadAnnouncements);
        expect(announcements.filter(message => message.includes('Stopping upload'))).toHaveLength(1);
        await expect.poll(() => cancel.requests.length).toBe(1);
    } finally { cancel.release(); }
});

test('legacy upload support retains unknown feedback without inventing replay support', async ({ page }) => {
    await page.route('**/api/client-capabilities', async route => {
        const response = await route.fetch();
        const body = await response.json();
        delete body.upload_recovery;
        body.actions = body.actions.filter(action => !action.startsWith('upload.'));
        return route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect.poll(() => page.evaluate(() => tagCapabilities && !tagCapabilities.upload_recovery)).toBe(true);
    let requests = 0;
    let sent;
    const hold = deferred();
    await page.route('**/api/upload', async route => {
        sent = route.request().postDataJSON();
        requests++;
        await hold.promise;
        return route.fulfill({ status: 500, json: {} });
    });
    try {
        await drop(page, ['legacy-unknown.mp4']);
        await expect(summary(page)).toContainText('Registering upload');
        await expect.poll(() => requests).toBe(1);
        expect(sent.client_mutation_id).toBeUndefined();
        hold.release();
        await expect(summary(page)).toContainText(/not confirmed/i);
        await expect(summary(page).getByRole('button', { name: 'Recover registration', exact: true })).toHaveCount(0);
        expect(requests).toBe(1);
    } finally { hold.release(); }
});

test('sign out and actual account switch cannot restore another account transfer presentation', async ({ page }) => {
    expect((await page.request.post('/api/users', { data: { username: 'upload-next', name: 'Next Upload User', password: 'next-password', role: 'normal' } })).ok()).toBe(true);
    const registration = await gate(page, '**/api/upload');
    try {
        await drop(page, ['private-account-file.mp4']);
        await expect.poll(() => registration.requests.length).toBe(1);
        await switchAccount(page, 'upload-next', 'next-password');
        registration.release();
        await flush(page);
        await expect(summary(page)).toBeHidden();
        expect(await page.evaluate(() => droppedUploads.size)).toBe(0);
        await expect(page.locator('#activeList')).not.toContainText('private-account-file');
    } finally { registration.release(); }
});

test('another account may see public upload progress without receiving transfer or cancellation authority', async ({ page }) => {
    expect((await page.request.post('/api/users', { data: { username: 'upload-viewer', name: 'Upload Viewer', password: 'viewer-password', role: 'normal' } })).ok()).toBe(true);
    await page.request.post('/__test__/hold-uploads');
    await drop(page, ['owner-upload.mp4']);
    await openCurrent(page);
    const ownerRow = row(page, 'owner-upload.mp4');
    await expect(ownerRow).toContainText('Processing upload');
    const id = await ownerRow.getAttribute('data-row-id');
    await closeCurrent(page);
    page.once('dialog', dialog => dialog.accept());
    await switchAccount(page, 'upload-viewer', 'viewer-password');
    await openCurrent(page);
    const visible = page.locator(`#activeList [data-row-id="${id}"]`);
    await expect(visible).toHaveCount(1);
    await expect(visible.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(check(visible)).toHaveCount(0);
    expect((await page.request.get(`/api/upload/${id}/status`)).status()).toBe(404);
    expect((await page.request.put(`/api/upload/${id}`, { data: 'other bytes' })).status()).toBe(404);
    expect((await page.request.post(`/api/upload/${id}/cancel`, { data: {} })).status()).toBe(404);
    expect(await page.evaluate(() => droppedUploads.size)).toBe(0);
});

for (const theme of ['light', 'dark']) {
    test(`${theme} keyboard Stop and recovery remain accessible at narrow width with reduced motion`, async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 850 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.request.post('/__test__/hold-uploads');
        await drop(page, [`keyboard-${theme}.mp4`]);
        await openCurrent(page);
        const upload = row(page, `keyboard-${theme}.mp4`);
        await expect(upload).toContainText('Processing upload');
        await expect(upload).toContainText('Bytes uploaded: 4.0 B');
        await expect(upload.locator('.upload-request-status')).toHaveAttribute('role', 'status');
        const cancel = await gate(page, '**/api/upload/*/cancel', { committed: true });
        try {
            const stop = upload.getByRole('button', { name: 'Stop', exact: true });
            await stop.focus();
            await stop.press('Enter');
            await expect(upload).toContainText('Stopping upload');
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await expect.poll(() => cancel.requests.length).toBe(1);
            cancel.release();
            const id = await upload.getAttribute('data-row-id');
            await page.request.post('/__test__/release-uploads');
            await expect.poll(async () => (await (await page.request.get(`/api/upload/${id}/status`)).json()).upload?.phase).toBe('cancelled');
            const recovery = check(upload);
            await recovery.focus();
            await recovery.press('Enter');
            await expect(upload).toContainText(/Upload stopped|Cancelled/);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        } finally { cancel.release(); }
    });
}

test('invalid local input and definite server validation stay separate from unknown transfer outcomes', async ({ page }) => {
    const posts = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/upload')) posts.push(request); });
    await page.evaluate(() => uploadDroppedVideos([new File([], 'empty.mp4', { type: 'video/mp4' })]));
    await expect(page.locator('#actionError')).toContainText(/empty|size|bytes|invalid/i);
    await expect(page.locator('#historyList .history-card')).toHaveCount(0);
    await expect(summary(page).getByRole('button', { name: 'Recover registration', exact: true })).toHaveCount(0);
    expect(posts.length).toBeLessThanOrEqual(1);
});

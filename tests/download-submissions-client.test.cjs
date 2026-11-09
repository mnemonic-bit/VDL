const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness() {
    const context = vm.createContext({ Uint8Array, crypto: require('node:crypto').webcrypto });
    for (const name of ['tag-identity', 'client-state', 'mutations']) vm.runInContext(fs.readFileSync(path.join(__dirname, `../static/${name}.js`), 'utf8'), context);
    const state = context.VDL.createClientState();
    let now = 1800000000000, random = 0;
    const requests = [], events = [], timers = new Map();
    const mutations = context.VDL.createMutations({ state, now: () => now,
        random: () => (++random).toString(16).padStart(32, '0'),
        capabilities: { mutation_protocol: 1, actions: ['download.submit'], server_time: now },
        setTimeout(callback, delay) { const id = {}; timers.set(id, { callback, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); },
        onEvent: event => events.push(plain(event)),
        transport(request) { return new Promise((resolve, reject) => requests.push({ ...plain(request), resolve, reject })); },
    });
    function submit(id = 'submission:a', value = { url: 'https://fixture.invalid/video', format: 'best', filename: 'My video' }) {
        if (!state.isAvailable(id)) state.acceptDownload({ id, submission_revision: '0', submission: null });
        return mutations.submit({ kind: 'download.submit', targetId: id, value, viewToken: 1 });
    }
    function ack(request, fields = {}) {
        return { status: 202, body: { id: 'work-a', submission_revision: '1', current_attempt_id: 'attempt-a',
            job: { id: 'job-a', download_id: 'work-a', attempt_id: 'attempt-a', status: 'dispatched' },
            mutation: { id: request.body.client_mutation_id, domain: 'download-submission', outcome: 'accepted', revision: '1' }, ...fields } };
    }
    const advance = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } };
    return { state, mutations, requests, events, submit, ack, advance };
}
test('new submission presents a request synchronously and maps one canonical job without collection reads', async () => {
    const h = harness(); const entry = h.submit();
    const local = h.state.selectDownload('submission:a');
    assert.equal(local.submission_intents[0].status, 'sending');
    assert.equal(local.command_intents.length, 0);
    for (const field of ['filename', 'progress', 'status', 'current_attempt_id']) assert.equal(local[field], undefined);
    assert.equal(h.requests.length, 0);
    await tick(); const request = h.requests[0];
    assert.equal(request.url, '/api/download'); assert.equal(request.method, 'POST');
    assert.equal(Object.hasOwn(request.body, 'expected_revision'), false);
    request.resolve(h.ack(request)); await tick();
    assert.equal(h.mutations.status(entry.intentId), null);
    assert.deepEqual(plain(h.state.selectDownload('submission:a').submission), { id: 'work-a', job: { id: 'job-a', download_id: 'work-a', attempt_id: 'attempt-a', status: 'dispatched' } });
    assert.equal(h.requests.length, 1);
    assert.equal(h.events.filter(event => event.outcome === 'confirmed').length, 1);
});
test('duplicate clicks share the operation, while intentional same-URL operations have independent IDs', async () => {
    const h = harness(); const first = h.submit();
    assert.equal(h.submit().intentId, first.intentId);
    const second = h.submit('submission:b'); await tick();
    assert.notEqual(second.intentId, first.intentId);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[0].body.url, h.requests[1].body.url);
    assert.notEqual(h.requests[0].body.client_mutation_id, h.requests[1].body.client_mutation_id);
    h.requests.forEach(request => request.resolve(h.ack(request))); await tick();
    assert.equal(h.submit().accepted, false);
});
test('captured URL/options remain frozen through newer input and exact same-attempt replay', async () => {
    const h = harness(); const value = { url: 'https://fixture.invalid/captured', filename: 'Captured', format: 'best' };
    const entry = h.submit('submission:a', value);
    value.url = 'https://fixture.invalid/new'; value.filename = 'New';
    await tick(); const first = h.requests[0];
    assert.equal(first.body.filename, 'Captured');
    first.reject(new Error('lost acceptance')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    const replay = h.mutations.recover(entry.intentId, { replay: true }); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await replay; await tick();
    assert.deepEqual(h.requests[3].body, first.body);
    assert.equal(h.requests[3].url, first.url);
    h.requests[3].resolve(h.ack(first)); await tick();
    assert.equal(h.mutations.status(entry.intentId), null);
});
test('matching reads and missing receipt never settle unknown acceptance or generate a fresh request', async () => {
    const h = harness(); const entry = h.submit(); await tick();
    h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    h.state.acceptDownload({ id: 'work-a', url: 'https://fixture.invalid/video', job_id: 'job-a', current_attempt_id: 'attempt-a', command_revision: '1', status: 'downloading' });
    assert.equal(h.mutations.resolve(entry.intentId), false);
    const check = h.mutations.recover(entry.intentId); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await check;
    assert.equal(h.requests.length, 3);
    assert.equal(h.mutations.status(entry.intentId).status, 'unconfirmed');
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
});
test('serialized expired absence permits explicit resolution and never replays expired creation', async () => {
    const h = harness(); const entry = h.submit(); await tick();
    h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    h.advance(86401000);
    const check = h.mutations.recover(entry.intentId, { replay: true }); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await check; await tick();
    assert.equal(h.requests.length, 3);
    assert.equal(h.mutations.status(entry.intentId).status, 'unconfirmed');
    assert.equal(h.mutations.resolve(entry.intentId), true);
});
test('strict accepted decoder rejects inconsistent mutation, revision, download, attempt, job and outcome', async () => {
    for (const field of ['mutation-id', 'domain', 'revision', 'outcome', 'download', 'attempt', 'job-id', 'status']) {
        const h = harness(); const entry = h.submit(); await tick(); const reply = h.ack(h.requests[0]);
        if (field === 'mutation-id') reply.body.mutation.id = 'wrong';
        if (field === 'domain') reply.body.mutation.domain = 'download-command';
        if (field === 'revision') reply.body.submission_revision = '2';
        if (field === 'outcome') reply.body.mutation.outcome = 'committed';
        if (field === 'download') reply.body.job.download_id = 'wrong';
        if (field === 'attempt') reply.body.job.attempt_id = 'wrong';
        if (field === 'job-id') reply.body.job.id = '';
        if (field === 'status') reply.body.job.status = 'downloaded';
        h.requests[0].resolve(reply); await tick();
        assert.equal(h.mutations.status(entry.intentId).status, 'unconfirmed', field);
        assert.equal(h.state.selectDownload('submission:a').submission, null, field);
    }
});
test('accepted dispatching and interrupted receipts confirm acceptance without creating another job', async () => {
    for (const status of ['accepted', 'dispatching', 'interrupted', 'finished', 'error']) {
        const h = harness(); const entry = h.submit(); await tick(); const first = h.requests[0];
        first.reject(new Error('response lost after commit')); await tick();
        const receipt = h.ack(first); receipt.body.job.status = status;
        h.requests[1].resolve(receipt); await tick();
        assert.equal(h.mutations.status(entry.intentId), null);
        assert.equal(h.state.selectDownload('submission:a').submission.job.status, status);
        assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
    }
});
test('definite preacceptance rejection retains input, requires review, and never creates worker state', async () => {
    for (const status of [400, 429]) {
        const h = harness(); const entry = h.submit(); await tick(); const request = h.requests[0];
        request.resolve({ status, body: { id: null, job: null, submission_revision: '0', error: status === 429 ? 'Too many mutations' : 'Invalid options', ...(status === 429 ? { code: 'mutation_limit' } : {}), mutation: { id: request.body.client_mutation_id, domain: 'download-submission', revision: '0', outcome: 'rejected' } } }); await tick();
        assert.equal(h.mutations.status(entry.intentId).status, 'rejected', `HTTP ${status}`);
        assert.match(h.mutations.status(entry.intentId).message, /Download request refused/);
        assert.equal(h.mutations.status(entry.intentId).value.filename, 'My video');
        assert.equal(h.events.some(event => event.outcome === 'unconfirmed'), false);
        assert.equal(h.requests.length, 1);
        assert.equal(h.mutations.retry(entry.intentId).accepted, false);
        assert.equal(h.mutations.resolve(entry.intentId), true);
        assert.equal(h.state.selectDownload('submission:a').submission, null);
    }
});

test('generic server failures and malformed successes retain unknown request status', async () => {
    for (const reply of [{ status: 500, body: { error: 'Server error' } }, { status: 200, body: { id: 'work-a' } }]) {
        const h = harness(); const entry = h.submit(); await tick(); h.requests[0].resolve(reply); await tick();
        assert.match(h.mutations.status(entry.intentId).message, /Download request not confirmed/);
        assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
    }
});
test('five-second feedback explains waiting, then timeout retains recoverable acceptance', async () => {
    const h = harness(); const entry = h.submit(); await tick(); h.advance(5000);
    assert.match(h.mutations.status(entry.intentId).message, /Still waiting/);
    h.advance(25000); await tick();
    assert.match(h.mutations.status(entry.intentId).message, /Download request not confirmed/);
    assert.equal(h.requests[1].method, 'GET');
});
test('auth reset, denial and canonical deletion fence old accepted responses and private presentation', async () => {
    for (const mode of ['reset', 'deny', 'canonical-delete', 'local-delete']) {
        const h = harness(); h.submit(); await tick();
        if (mode === 'reset') h.mutations.reset();
        else if (mode === 'canonical-delete') h.mutations.fence('work-a');
        else if (mode === 'local-delete') h.mutations.fence('submission:a');
        if (mode === 'deny') h.requests[0].resolve({ status: 403, body: { error: 'No access' } });
        else h.requests[0].resolve(h.ack(h.requests[0]));
        await tick();
        assert.equal(h.state.selectDownload('submission:a'), null, mode);
        assert.equal(h.mutations.pending().length, 0, mode);
    }
});
test('known canonical deletion purges settled provisional binding and intentional cleanup retains no snapshot', async () => {
    const h = harness(); h.submit(); await tick(); h.requests[0].resolve(h.ack(h.requests[0])); await tick();
    h.mutations.fence('work-a');
    assert.equal(h.state.selectDownload('submission:a'), null);
    const other = h.submit('submission:b'); await tick(); h.requests[1].resolve(h.ack(h.requests[1], { id: 'work-b', job: { id: 'job-b', download_id: 'work-b', attempt_id: 'attempt-a', status: 'accepted' } })); await tick();
    assert.equal(h.mutations.status(other.intentId), null);
    h.state.writer.forgetSubmission('submission:b');
    assert.equal(h.state.writer.confirmed('submission:b'), null);
});
test('capability validation and bounded admission reject unsupported actions and oversized pending queues', () => {
    const h = harness();
    h.mutations.setCapabilities({ mutation_protocol: 1, actions: [] });
    assert.equal(h.submit().reason, 'unsupported');
    h.mutations.setCapabilities({ mutation_protocol: 1, actions: ['download.submit'] });
    assert.equal(h.submit('submission:invalid', { url: 'https://fixture.invalid', filename: 4 }).reason, 'validation');
    for (let i = 0; i < 128; i++) assert.equal(h.submit(`submission:${i}`).accepted, true);
    assert.equal(h.submit('submission:overflow').reason, 'limit');
    assert.equal(h.events.some(event => JSON.stringify(event).includes('fixture.invalid')), false);
});
test('UTF-8 and encoded request limits reject oversized URL/options locally with retained input', () => {
    const h = harness();
    for (const value of [{ url: 'https://fixture.invalid/' + 'x'.repeat(8192) }, { url: 'https://fixture.invalid', format: 'x'.repeat(4097) }, { url: 'https://fixture.invalid', filename: '📺'.repeat(257) }, { url: 'https://fixture.invalid/' + '\\'.repeat(8000), format: '\\'.repeat(4000) }]) {
        const rejected = h.submit('submission:too-large', value);
        assert.equal(rejected.reason, 'validation');
        assert.match(rejected.message, /too long/);
    }
    assert.equal(h.requests.length, 0);
});
test('explicit replay target denial purges submission while unavailable receipt remains ambiguous', async () => {
    const h = harness(); const entry = h.submit(); await tick();
    h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    assert.equal(h.mutations.status(entry.intentId).status, 'unconfirmed');
    const recovery = h.mutations.recover(entry.intentId, { replay: true }); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await recovery; await tick();
    h.requests[3].resolve({ status: 404, body: { error: 'Download request unavailable' } }); await tick();
    assert.equal(h.mutations.status(entry.intentId), null);
    assert.equal(h.state.selectDownload('submission:a'), null);
});

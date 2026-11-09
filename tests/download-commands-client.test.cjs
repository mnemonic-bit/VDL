const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness(attempt = 'attempt-1') {
    const context = vm.createContext({ Uint8Array, crypto: require('node:crypto').webcrypto });
    for (const name of ['tag-identity', 'client-state', 'mutations']) vm.runInContext(fs.readFileSync(path.join(__dirname, `../static/${name}.js`), 'utf8'), context);
    const state = context.VDL.createClientState();
    state.acceptDownload({ id: 'a', status: 'downloading', progress: '20%', current_attempt_id: attempt, command_revision: '0', favorite: false, favorite_revision: '0' });
    let now = 1800000000000, random = 0;
    const requests = [], events = [], timers = new Map();
    const mutations = context.VDL.createMutations({ state, now: () => now,
        random: () => (++random).toString(16).padStart(32, '0'),
        capabilities: { mutation_protocol: 1, actions: ['pause', 'unpause', 'stop', 'retry', 'resume'].map(action => `download.${action}`).concat('favorite.set', 'rename.set'), server_time: now },
        setTimeout(callback, delay) { const id = {}; timers.set(id, { callback, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); },
        onEvent: event => events.push(plain(event)),
        transport(request) { return new Promise((resolve, reject) => requests.push({ ...plain(request), resolve, reject })); },
    });
    const submit = (action, id = 'a', generation = attempt) => mutations.submit({ kind: `download.${action}`, targetId: id, value: { attempt_id: generation } });
    function ack(request, revision = '1', extra = {}) {
        const action = request.url.split('/')[2], source = request.body.expected_attempt_id;
        const starts = ['retry', 'resume'].includes(action);
        return { status: 200, body: { id: request.url.split('/')[3], command_revision: revision, current_attempt_id: starts ? 'new-attempt' : source,
            command: { id: 'job-1', action: `download.${action}`, source_attempt_id: source, attempt_id: starts ? 'new-attempt' : source, job_id: starts ? 'job-1' : null, status: 'dispatched' },
            mutation: { id: request.body.client_mutation_id, domain: 'download-command', outcome: 'accepted', revision }, ...extra } };
    }
    const advance = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } };
    return { state, mutations, requests, events, submit, ack, advance };
}
for (const action of ['pause', 'unpause', 'stop', 'retry', 'resume']) {
    test(`${action}: immediate status-only admission and SSE-free durable acceptance`, async () => {
        const h = harness();
        const entry = h.submit(action);
        assert.equal(entry.accepted, true);
        assert.equal(h.state.selectDownload('a').status, 'downloading');
        assert.equal(h.state.selectDownload('a').command_intents[0].status, 'sending');
        assert.equal(h.requests.length, 0);
        await tick();
        const request = h.requests[0];
        assert.equal(request.body.expected_attempt_id, 'attempt-1');
        assert.equal(request.body.expected_revision, '0');
        request.resolve(h.ack(request));
        await tick();
        assert.equal(h.mutations.status(entry.intentId), null);
        assert.equal(h.state.selectDownload('a').status, 'downloading');
        assert.equal(h.state.selectDownload('a').command_revision, '1');
        assert.equal(h.requests.length, 1);
        assert.equal(h.events.at(-1).outcome, 'confirmed');
    });
}
test('pause then Stop queues; accepted pause releases Stop with current revision', async () => {
    const h = harness();
    const first = h.submit('pause');
    await tick();
    const stop = h.submit('stop');
    assert.equal(h.mutations.status(stop.intentId).status, 'queued');
    assert.equal(h.submit('pause').intentId, first.intentId);
    assert.equal(h.submit('unpause').accepted, false);
    await tick();
    assert.equal(h.requests.length, 1);
    h.requests[0].resolve(h.ack(h.requests[0])); await tick();
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].url, '/api/stop/a');
    assert.equal(h.requests[1].body.expected_revision, '1');
});
test('unknown pause blocks queued Stop even when reads show newer worker state', async () => {
    const h = harness(); const pause = h.submit('pause'); await tick(); const stop = h.submit('stop'); await tick();
    h.requests[0].reject(new Error('lost')); await tick();
    assert.equal(h.mutations.status(pause.intentId).status, 'unconfirmed');
    h.state.acceptDownload({ id: 'a', status: 'paused', command_revision: '9', current_attempt_id: 'attempt-1' });
    assert.equal(h.mutations.resolve(pause.intentId), false);
    assert.equal(h.mutations.status(stop.intentId).status, 'queued');
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
});
test('response loss uses bounded receipt lookup; deliberate replay freezes original identity', async () => {
    const h = harness(); const entry = h.submit('retry'); await tick(); const original = h.requests[0];
    original.reject(new Error('lost')); await tick();
    assert.equal(h.requests[1].method, 'GET');
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    const replay = h.mutations.recover(entry.intentId, { replay: true }); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await replay; await tick();
    assert.deepEqual(h.requests[3].body, original.body);
    assert.equal(h.requests[3].url, original.url);
    h.requests[3].resolve(h.ack(original)); await tick();
    assert.equal(h.state.selectDownload('a').current_attempt_id, 'new-attempt');
    assert.equal(h.mutations.hasPending(), false);
});
test('strict decoder refuses wrong action, generation, job, outcome, or mutation identity', async () => {
    for (const field of ['action', 'source_attempt_id', 'job_id', 'outcome', 'id', 'current_attempt_id']) {
        const h = harness(); const entry = h.submit('resume'); await tick(); const reply = h.ack(h.requests[0]);
        if (field === 'outcome' || field === 'id') reply.body.mutation[field] = 'wrong'; else if (field === 'current_attempt_id') reply.body.current_attempt_id = 'wrong'; else reply.body.command[field] = 'wrong';
        h.requests[0].resolve(reply); await tick();
        assert.equal(h.mutations.status(entry.intentId).status, 'unconfirmed', field);
        assert.equal(h.state.selectDownload('a').current_attempt_id, 'attempt-1', field);
    }
});
test('old History attempt cannot submit against newer execution', () => {
    const h = harness('latest');
    assert.equal(h.submit('retry', 'a', 'older').accepted, false);
    assert.equal(h.requests.length, 0);
});
test('older command acknowledgement retires its intent without replacing newer generation', async () => {
    const h = harness(); const entry = h.submit('resume'); await tick();
    h.state.acceptDownload({ id: 'a', status: 'finished', current_attempt_id: 'later', command_revision: '12' });
    h.requests[0].resolve(h.ack(h.requests[0])); await tick();
    assert.equal(h.mutations.status(entry.intentId), null);
    assert.equal(h.state.selectDownload('a').current_attempt_id, 'later');
    assert.equal(h.state.selectDownload('a').status, 'finished');
});
test('stale prior-generation read cannot restore status or control eligibility after acceptance', async () => {
    const h = harness(); h.submit('resume'); await tick(); h.requests[0].resolve(h.ack(h.requests[0])); await tick();
    h.state.acceptDownload({ id: 'a', current_attempt_id: 'new-attempt', command_revision: '1', status: 'starting', progress: 'Queued' });
    h.state.acceptDownload({ id: 'a', current_attempt_id: 'attempt-1', command_revision: '0', status: 'cancelled', progress: 'Stopped' });
    assert.equal(h.state.selectDownload('a').status, 'starting');
    assert.equal(h.state.selectDownload('a').progress, 'Queued');
    assert.equal(h.state.selectDownload('a').current_attempt_id, 'new-attempt');
});
test('null attempt controls remain supported after attempt-log cleanup', async () => {
    const h = harness(null); const entry = h.submit('pause'); await tick(); h.requests[0].resolve(h.ack(h.requests[0])); await tick();
    assert.equal(h.mutations.status(entry.intentId), null);
    assert.equal(h.state.selectDownload('a').current_attempt_id, null);
});
test('auth reset and deletion fences ignore obsolete accepted callbacks', async () => {
    for (const fence of [false, true]) {
        const h = harness(); h.submit('retry'); await tick();
        if (fence) h.mutations.fence('a'); else h.mutations.reset();
        h.requests[0].resolve(h.ack(h.requests[0])); await tick();
        assert.equal(h.state.selectDownload('a'), null);
        assert.equal(h.mutations.hasPending(), false);
    }
});
test('five-second text and timeout uncertainty preserve confirmed worker status', async () => {
    const h = harness(); const entry = h.submit('stop'); await tick(); h.advance(5000);
    assert.match(h.mutations.status(entry.intentId).message, /Still waiting/);
    h.advance(25000); await tick();
    assert.match(h.mutations.status(entry.intentId).message, /Request not confirmed/);
    assert.equal(h.state.selectDownload('a').status, 'downloading');
});
test('independent metadata remains usable while a command awaits acceptance', async () => {
    const h = harness(); h.submit('pause');
    assert.equal(h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: true }).accepted, true);
    await tick();
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 2);
    assert.equal(h.state.selectDownload('a').favorite, true);
});
test('conflict requires explicit review and cannot blindly generate a new command identity', async () => {
    const h = harness(); const entry = h.submit('retry'); await tick(); const request = h.requests[0];
    request.resolve({ status: 409, body: { id: 'a', command_revision: '2', current_attempt_id: 'later', error: 'Changed', mutation: { id: request.body.client_mutation_id, domain: 'download-command', outcome: 'conflicted', revision: '2' } } }); await tick();
    assert.equal(h.mutations.status(entry.intentId).status, 'conflicted');
    assert.equal(h.mutations.retry(entry.intentId).accepted, false);
    assert.equal(h.submit('retry', 'a', 'later').accepted, false);
    assert.equal(h.mutations.resolve(entry.intentId), true);
});

test('Stop supersedes a pause that has not reached transport', async () => {
    const h = harness(); const pause = h.submit('pause'); const stop = h.submit('stop');
    assert.equal(h.mutations.status(pause.intentId), null);
    await tick();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, '/api/stop/a');
    assert.equal(h.mutations.status(stop.intentId).status, 'sending');
});

test('expired serialized absence plus authorized state check permits explicit resolution and releases queued Stop', async () => {
    const h = harness();
    const pause = h.submit('pause');
    await tick();
    const stop = h.submit('stop');
    h.requests[0].reject(new Error('lost acceptance'));
    await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    assert.equal(h.mutations.resolve(pause.intentId), false);
    assert.equal(h.mutations.status(stop.intentId).status, 'queued');

    h.advance(86401000);
    const checked = h.mutations.recover(pause.intentId);
    await tick();
    assert.match(h.requests[2].url, /^\/api\/mutations\//);
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } });
    await tick();
    assert.equal(h.requests[3].url, '/api/downloads/a/editable-state');
    h.requests[3].resolve({ status: 200, body: { id: 'a', command_revision: '9', current_attempt_id: 'attempt-1', status: 'downloading' } });
    await checked;
    await tick();
    assert.equal(h.mutations.status(pause.intentId).status, 'unconfirmed');
    assert.equal(h.mutations.status(stop.intentId).status, 'queued');
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);

    assert.equal(h.mutations.resolve(pause.intentId), true);
    await tick();
    assert.equal(h.mutations.status(pause.intentId), null);
    assert.equal(h.mutations.status(stop.intentId).status, 'sending');
    assert.equal(h.requests[4].url, '/api/stop/a');
    assert.equal(h.requests[4].body.expected_revision, '9');
    assert.equal(h.requests[4].body.expected_attempt_id, 'attempt-1');
    assert.notEqual(h.requests[4].body.client_mutation_id, h.requests[0].body.client_mutation_id);
});

test('an accepted dispatching receipt confirms lost delivery without projecting worker state or replaying', async () => {
    const h = harness();
    const entry = h.submit('resume');
    await tick();
    const sent = h.requests[0];
    sent.reject(new Error('response lost after worker dispatch'));
    await tick();
    assert.equal(h.mutations.status(entry.intentId).status, 'unconfirmed');
    assert.equal(h.requests[1].method, 'GET');
    const receipt = h.ack(sent);
    receipt.body.command.status = 'dispatching';
    h.requests[1].resolve(receipt);
    await tick();
    assert.equal(h.mutations.status(entry.intentId), null);
    assert.equal(h.state.selectDownload('a').command_intents.length, 0);
    assert.equal(h.state.selectDownload('a').current_attempt_id, 'new-attempt');
    assert.equal(h.state.selectDownload('a').status, 'downloading');
    assert.equal(h.state.selectDownload('a').progress, '20%');
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
    assert.equal(h.events.filter(event => event.outcome === 'confirmed').length, 1);
});

test('rename acknowledgement updates its identity beside an independent command generation without a collection read', async () => {
    const h = harness();
    h.state.acceptDownload({ id: 'a', status: 'finished', filename: '/media/old.mp4', display_filename: 'old.mp4', rename_revision: '0', command_revision: '0', current_attempt_id: 'attempt-1' });
    const entry = h.mutations.submit({ kind: 'rename.set', targetId: 'a', value: 'new' });
    assert.equal(entry.accepted, true);
    await tick();
    const request = h.requests[0];
    assert.equal(request.url, '/api/rename/a');
    request.resolve({ status: 200, body: { id: 'a', filename: '/media/new.mp4', display_filename: 'new.mp4', rename_revision: '1',
        mutation: { id: request.body.client_mutation_id, domain: 'rename', outcome: 'committed', revision: '1' } } });
    await tick();
    const model = h.state.selectDownload('a');
    assert.equal(model.filename, '/media/new.mp4');
    assert.equal(model.display_filename, 'new.mp4');
    assert.equal(model.rename_revision, '1');
    assert.equal(model.command_revision, '0');
    assert.equal(model.current_attempt_id, 'attempt-1');
    assert.equal(h.mutations.status(entry.intentId), null);
    assert.equal(h.requests.length, 1);
});

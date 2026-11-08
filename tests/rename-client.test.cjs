const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const tick = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function harness() {
    const context = vm.createContext({ setTimeout, clearTimeout, Uint8Array });
    for (const name of ['tag-identity', 'client-state', 'mutations']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, `../static/${name}.js`), 'utf8'), context);
    }
    const state = context.VDL.createClientState();
    state.acceptDownload({ id: 'entry', status: 'finished', filename: '/media/original.mp4', display_filename: null, rename_revision: '1', favorite: false, favorite_revision: '0' });
    let clock = 1800000000000;
    let sequence = 0;
    const timers = new Map();
    const requests = [];
    const events = [];
    const mutations = context.VDL.createMutations({
        state,
        capabilities: { mutation_protocol: 1, actions: ['rename.set', 'favorite.set'], server_time: clock },
        now: () => clock,
        random: () => (++sequence).toString(16).padStart(32, '0'),
        setTimeout(callback, delay) { const timer = { callback, at: clock + delay }; timers.set(timer, timer); return timer; },
        clearTimeout(timer) { timers.delete(timer); },
        transport(request) { return new Promise(resolve => requests.push({ ...request, resolve })); },
        onEvent: event => events.push(event),
    });
    function reply(request, outcome = 'committed', revision = '2', filename = '/media/renamed.mp4') {
        return { status: outcome === 'committed' ? 200 : outcome === 'conflicted' ? 409 : 400,
            body: { id: 'entry', filename, display_filename: null, rename_revision: revision,
                mutation: { id: request.body.client_mutation_id, domain: 'rename', outcome, revision } } };
    }
    return { state, mutations, requests, reply, events,
        submit: value => mutations.submit({ kind: 'rename.set', targetId: 'entry', value }),
        advance(ms) { clock += ms; for (const [key, timer] of [...timers]) if (timer.at <= clock) { timers.delete(key); timer.callback(); } },
    };
}

test('rename projects its requested label immediately while retaining authoritative file identity', async () => {
    const h = harness();
    const intent = h.submit('renamed.webm');
    assert.equal(intent.accepted, true);
    const model = h.state.selectDownload('entry');
    assert.equal(model.requested_filename, 'renamed.webm');
    assert.equal(model.filename, '/media/original.mp4');
    assert.equal(model.display_filename, null);
    assert.equal(model.rename_intents[0].status, 'sending');
    assert.equal(h.requests.length, 0);
    await tick();
    assert.equal(h.requests[0].url, '/api/rename/entry');
    assert.equal(h.requests[0].body.expected_revision, '1');
    h.mutations.reset();
});

test('captured duplicate names share an attempt and another name cannot queue before settlement', async () => {
    const h = harness();
    const first = h.submit('renamed');
    assert.equal(h.submit('renamed').intentId, first.intentId);
    assert.equal(h.submit('newer').reason, 'unresolved');
    await tick();
    assert.equal(h.requests.length, 1);
    h.mutations.reset();
});

test('a canonical acknowledgement confirms the actual extension/path without reconciliation', async () => {
    const h = harness();
    const first = h.submit('renamed.webm');
    const frames = [];
    h.state.subscribe(() => frames.push(h.state.selectDownload('entry')));
    await tick();
    h.requests[0].resolve(h.reply(h.requests[0]));
    await tick();
    assert.equal(h.state.selectDownload('entry').filename, '/media/renamed.mp4');
    assert.equal(h.state.selectDownload('entry').requested_filename, null);
    assert.equal(h.mutations.status(first.intentId), null);
    assert.equal(h.requests.length, 1);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].rename_intents.length, 0);
    assert.equal(h.events.at(-1).outcome, 'confirmed');
    h.mutations.reset();
});

test('old reads and an older receipt cannot restore an earlier file identity', async () => {
    const h = harness();
    h.submit('renamed');
    await tick();
    h.state.acceptDownload({ id: 'entry', filename: '/media/newest.mp4', display_filename: 'Newest.mp4', rename_revision: '9' });
    h.requests[0].resolve(h.reply(h.requests[0]));
    await tick();
    assert.equal(h.state.selectDownload('entry').filename, '/media/newest.mp4');
    assert.equal(h.state.selectDownload('entry').rename_revision, '9');
    assert.equal(h.mutations.hasPending(), false);
    h.state.acceptDownload({ id: 'entry', filename: '/media/original.mp4', display_filename: null, rename_revision: '1' });
    h.state.acceptDownload({ id: 'entry', filename: '/media/unversioned.mp4' });
    assert.equal(h.state.selectDownload('entry').filename, '/media/newest.mp4');
    assert.equal(h.state.acceptDownload({ id: 'entry', filename: '/media/wrong.mp4', display_filename: null, rename_revision: '9' }), false);
    h.mutations.reset();
});

test('a definite rejection retains requested text independently from the confirmed name', async () => {
    const h = harness();
    const first = h.submit('taken');
    await tick();
    const rejection = h.reply(h.requests[0], 'rejected', '1', '/media/original.mp4');
    rejection.body.error = 'A file with that name already exists';
    h.requests[0].resolve(rejection);
    await tick();
    assert.equal(h.state.selectDownload('entry').requested_filename, null);
    assert.equal(h.state.selectDownload('entry').rename_intents[0].value, 'taken');
    assert.match(h.mutations.status(first.intentId).message, /already exists/);
    assert.equal(h.mutations.resolve(first.intentId), true);
    assert.equal(h.submit('corrected').accepted, true);
    await tick();
    assert.equal(h.requests[1].body.filename, 'corrected');
    h.mutations.reset();
});

test('malformed success stays unknown and receipt checking never silently retries the write', async () => {
    const h = harness();
    const first = h.submit('renamed');
    await tick();
    h.requests[0].resolve({ status: 200, body: { filename: 'renamed.mp4' } });
    await tick();
    assert.equal(h.mutations.status(first.intentId).status, 'unconfirmed');
    assert.match(h.mutations.status(first.intentId).message, /Rename not confirmed/);
    assert.equal(h.requests[1].method, 'GET');
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    assert.equal(h.requests.length, 2);
    assert.equal(h.state.selectDownload('entry').filename, '/media/original.mp4');
    h.mutations.reset();
});

test('deliberate replay preserves the frozen original attempt and receipt confirmation applies once', async () => {
    const h = harness();
    const first = h.submit('renamed');
    await tick();
    const original = h.requests[0];
    original.resolve({ status: 503, body: {} });
    await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    const recovery = h.mutations.recover(first.intentId, { replay: true });
    await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await recovery;
    await tick();
    assert.equal(JSON.stringify(h.requests[3].body), JSON.stringify(original.body));
    h.requests[3].resolve(h.reply(original));
    await tick();
    assert.equal(h.state.selectDownload('entry').filename, '/media/renamed.mp4');
    assert.equal(h.mutations.hasPending(), false);
    h.mutations.reset();
});

test('a newer rename revision alone cannot release an unknown filesystem operation', async () => {
    const h = harness();
    const first = h.submit('renamed');
    await tick();
    h.requests[0].resolve({ status: 500, body: null });
    await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    h.state.acceptDownload({ id: 'entry', filename: '/media/remote.mp4', display_filename: null, rename_revision: '8' });
    assert.equal(h.mutations.resolve(first.intentId), false);
    assert.equal(h.submit('different').accepted, false);
    h.mutations.reset();
});

test('renaming does not block the independent favorite domain', async () => {
    const h = harness();
    h.submit('renamed');
    assert.equal(h.mutations.submit({ kind: 'favorite.set', targetId: 'entry', value: true }).accepted, true);
    assert.equal(h.state.selectDownload('entry').favorite, true);
    assert.equal(h.state.selectDownload('entry').requested_filename, 'renamed');
    await tick();
    assert.equal(h.requests.length, 2);
    h.mutations.reset();
});

test('five seconds adds explanatory feedback and ambiguous journal status requests intervention', async () => {
    const h = harness();
    const first = h.submit('renamed');
    await tick();
    h.advance(5000);
    assert.match(h.mutations.status(first.intentId).message, /Still waiting/);
    h.requests[0].resolve({ status: 503, body: { code: 'rename_recovery_required' } });
    await tick();
    assert.equal(h.mutations.status(first.intentId).status, 'unconfirmed');
    assert.match(h.mutations.status(first.intentId).message, /intervention/);
    h.mutations.reset();
});

test('authentication reset and known deletion fence late canonical acknowledgements', async () => {
    for (const reset of ['reset', 'fence']) {
        const h = harness();
        h.submit('renamed');
        await tick();
        if (reset === 'reset') h.mutations.reset(); else h.mutations.fence('entry');
        h.requests[0].resolve(h.reply(h.requests[0]));
        await tick();
        assert.equal(h.state.selectDownload('entry'), null);
        assert.equal(h.mutations.hasPending(), false);
        h.mutations.reset();
    }
});

test('active downloads with no file still accept collection snapshots for unrelated domains', () => {
    const h = harness();
    assert.equal(h.state.acceptDownload({ id: 'starting', status: 'starting', filename: null, display_filename: null, rename_revision: '0', favorite: false, favorite_revision: '0' }), true);
    assert.equal(h.state.selectDownload('starting').status, 'starting');
    assert.equal(h.mutations.submit({ kind: 'rename.set', targetId: 'starting', value: 'renamed' }).accepted, false);
    h.mutations.reset();
});

test('basename validation rejects traversal and control names without sending transport', async () => {
    const h = harness();
    for (const value of ['', '.', '..', '../file', 'a/b', 'a\\b', 'a\0b']) assert.equal(h.submit(value).accepted, false);
    await tick();
    assert.equal(h.requests.length, 0);
    h.mutations.reset();
});

test('a rename conflict checks the current canonical file identity before a deliberate new attempt', async () => {
    const h = harness();
    const first = h.submit('renamed');
    await tick();
    const original = h.requests[0];
    original.resolve(h.reply(original, 'conflicted', '4', '/media/remote.mp4'));
    await tick();
    assert.equal(h.state.selectDownload('entry').filename, '/media/remote.mp4');
    assert.equal(h.mutations.status(first.intentId).value, 'renamed');
    assert.equal(h.mutations.retry(first.intentId).accepted, true);
    await tick();
    assert.match(h.requests[1].url, /\/editable-state$/);
    h.requests[1].resolve({ status: 200, body: { id: 'entry', filename: '/media/remote.mp4', display_filename: null, rename_revision: '4' } });
    await tick();
    assert.equal(h.requests[2].body.expected_revision, '4');
    assert.notEqual(h.requests[2].body.client_mutation_id, original.body.client_mutation_id);
    h.requests[2].resolve(h.reply(h.requests[2], 'committed', '5'));
    await tick();
    assert.equal(h.state.selectDownload('entry').rename_revision, '5');
    assert.equal(h.mutations.hasPending(), false);
    h.mutations.reset();
});

test('receipt recovery after access loss fences private rename presentation', async () => {
    const h = harness();
    h.submit('private name');
    await tick();
    h.requests[0].resolve({ status: 500, body: null });
    await tick();
    h.requests[1].resolve({ status: 403, body: { error: 'Forbidden' } });
    await tick();
    assert.equal(h.state.selectDownload('entry'), null);
    assert.equal(h.mutations.hasPending(), false);
    assert.equal(h.mutations.pending().length, 0);
    h.mutations.reset();
});


test('an exact target denial from receipt recovery fences the rename while a missing receipt does not', async () => {
    for (const error of ['Unknown download id', 'Mutation unavailable']) {
        const h = harness();
        const intent = h.submit('private name');
        await tick();
        h.requests[0].resolve({ status: 500, body: null });
        await tick();
        h.requests[1].resolve({ status: 404, body: { error, final: false } });
        await tick();
        if (error === 'Unknown download id') {
            assert.equal(h.state.selectDownload('entry'), null);
            assert.equal(h.mutations.status(intent.intentId), null);
        } else {
            assert.equal(h.state.selectDownload('entry').requested_filename, 'private name');
            assert.equal(h.mutations.status(intent.intentId).status, 'unconfirmed');
        }
        h.mutations.reset();
    }
});


test('a correlated rename rejection with no current file is definite and cannot invent a playback path', async () => {
    const h = harness();
    const intent = h.submit('new name');
    await tick();
    const response = h.reply(h.requests[0], 'rejected', '2', null);
    response.body.error = 'Only finished downloads can be renamed';
    h.requests[0].resolve(response);
    await tick();
    assert.equal(h.mutations.status(intent.intentId).status, 'rejected');
    assert.equal(h.state.selectDownload('entry').filename, null);
    assert.equal(h.state.selectDownload('entry').requested_filename, null);
    assert.equal(h.state.selectDownload('entry').rename_intents[0].value, 'new name');
    assert.equal(h.requests.length, 1);
    h.mutations.resolve(intent.intentId);
    assert.equal(h.submit('another name').accepted, false);
    h.mutations.reset();
});

test('conflict retry accepts a canonical null file read and retains the name without dispatching another rename', async () => {
    const h = harness();
    const intent = h.submit('new name');
    await tick();
    h.requests[0].resolve(h.reply(h.requests[0], 'conflicted', '2', null));
    await tick();
    assert.equal(h.mutations.retry(intent.intentId).accepted, true);
    await tick();
    h.requests[1].resolve({ status: 200, body: { id: 'entry', filename: null, display_filename: null, rename_revision: '2', permissions: { rename: false } } });
    await tick();
    assert.equal(h.mutations.status(intent.intentId).status, 'rejected');
    assert.equal(h.state.selectDownload('entry').filename, null);
    assert.equal(h.requests.length, 2);
    h.mutations.reset();
});

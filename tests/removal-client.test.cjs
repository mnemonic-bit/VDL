const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
function harness(capable = true, publicFilename = false) {
    const context = vm.createContext({ Uint8Array, crypto: require('node:crypto').webcrypto });
    for (const name of ['tag-identity', 'client-state', 'mutations']) vm.runInContext(fs.readFileSync(path.join(__dirname, `../static/${name}.js`), 'utf8'), context);
    const state = context.VDL.createClientState();
    state.acceptDownload({ id: 'a', title: 'Confirmed title', filename: publicFilename ? 'a.mp4' : '/media/a.mp4', display_filename: null, status: 'finished', removal_revision: '7', rename_revision: '0', favorite: false, favorite_revision: '0', command_revision: '0', current_attempt_id: 'attempt-1' });
    state.acceptDownload({ id: 'b', status: 'finished', removal_revision: '2', favorite: false, favorite_revision: '0' });
    let now = 1800000000000, random = 0;
    const requests = [], events = [], timers = new Map();
    const mutations = context.VDL.createMutations({ state, now: () => now,
        random: () => (++random).toString(16).padStart(32, '0'),
        capabilities: { mutation_protocol: 1, entry_removal: capable ? 1 : undefined, actions: ['entry.remove', 'favorite.set', 'rename.set', 'download.retry'], server_time: now },
        setTimeout(callback, delay) { const id = {}; timers.set(id, { callback, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); },
        onEvent: event => events.push(plain(event)),
        transport(request) { return new Promise((resolve, reject) => requests.push({ ...plain(request), resolve, reject })); },
    });
    const submit = (scope = 'entry-and-files', targetId = 'a') => mutations.submit({ kind: 'entry.remove', targetId, value: { scope } });
    function ack(request, outcome = 'committed', revision = '8') {
        return { status: outcome === 'committed' ? 200 : outcome === 'conflicted' ? 409 : 400, body: { id: decodeURIComponent(request.url.split('/').at(-1)), scope: request.body.scope, removed: outcome === 'committed', removal_revision: revision,
            mutation: { id: request.body.client_mutation_id, domain: 'entry-removal', action: 'entry.remove', outcome, revision } } };
    }
    const advance = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } };
    return { state, mutations, requests, events, submit, ack, advance };
}

test('removal immediately retains confirmed fields and presents status before transport; canonical result fences without reads', async () => {
    const h = harness();
    const entry = h.submit();
    assert.equal(entry.accepted, true);
    assert.equal(h.requests.length, 0);
    const pending = h.state.selectDownload('a');
    assert.equal(pending.title, 'Confirmed title'); assert.equal(pending.filename, '/media/a.mp4'); assert.equal(pending.status, 'finished');
    assert.equal(pending.removal_intents[0].status, 'sending');
    assert.equal(pending.tag_chips.length, 0);
    await tick();
    assert.deepEqual(h.requests[0].body, { scope: 'entry-and-files', expected_revision: '7', client_mutation_id: h.requests[0].body.client_mutation_id });
    assert.equal(h.requests[0].url, '/api/remove/a');
    h.requests[0].resolve(h.ack(h.requests[0])); await tick();
    assert.equal(h.state.selectDownload('a'), null);
    assert.equal(h.mutations.status(entry.intentId), null);
    assert.equal(h.mutations.hasPending(), false);
    assert.equal(h.requests.length, 1);
    assert.equal(h.events.at(-1).outcome, 'confirmed');
});

test('captured scope is immutable and duplicate admission never sends another removal', async () => {
    const h = harness(); const value = { scope: 'entry' };
    const first = h.mutations.submit({ kind: 'entry.remove', targetId: 'a', value });
    value.scope = 'entry-and-files';
    assert.equal(h.submit('entry').intentId, first.intentId);
    assert.equal(h.submit().accepted, false);
    await tick(); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].body.scope, 'entry');
});

test('unresolved removal blocks contradictory entry writes while unrelated targets stay usable', async () => {
    const h = harness(); h.submit();
    for (const input of [{ kind: 'favorite.set', value: true }, { kind: 'rename.set', value: 'new.mp4' }, { kind: 'download.retry', value: { attempt_id: 'attempt-1' } }]) {
        const result = h.mutations.submit({ ...input, targetId: 'a' });
        assert.equal(result.accepted, false); assert.equal(result.reason, 'unresolved');
    }
    assert.equal(h.mutations.submit({ kind: 'favorite.set', targetId: 'b', value: true }).accepted, true);
    await tick(); assert.equal(h.requests.length, 2);
});

test('pending metadata must settle before destructive removal can be admitted', async () => {
    const h = harness(); h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: true });
    assert.equal(h.submit().accepted, false);
    await tick(); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, '/api/favorite/a');
});

test('stale collection, even authoritative targeted read, and late metadata cannot resurrect confirmed removal', async () => {
    const h = harness();
    const old = h.state.writer.confirmed('a'); const token = h.state.beginCollection('library');
    h.submit(); await tick(); h.requests[0].resolve(h.ack(h.requests[0])); await tick();
    assert.equal(h.state.acceptCollection(token, [old]), false);
    assert.deepEqual(plain(h.state.collectionIds('library')), []);
    const afterDeletion = h.state.beginCollection('library');
    h.state.acceptCollection(afterDeletion, [old]);
    assert.deepEqual(plain(h.state.collectionIds('library')), []);
    assert.equal(h.state.selectDownload('a'), null);
    assert.equal(h.state.acceptDownload({ ...old, favorite: true, favorite_revision: '20' }), false);
    assert.equal(h.state.acceptDownload(old, { ...h.state.capture(), authoritative: true }), false);
    assert.equal(h.state.selectDownload('a'), null);
    assert.equal(h.submit().accepted, false);
});

test('unknown result retains pending identity despite matching reads and refuses a fresh destructive request', async () => {
    const h = harness(); const entry = h.submit(); await tick(); h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    h.state.acceptDownload({ id: 'a', removal_revision: '19', title: 'Newer title' });
    assert.equal(h.mutations.status(entry.intentId).status, 'unconfirmed');
    assert.equal(h.mutations.resolve(entry.intentId), false);
    assert.equal(h.submit().intentId, entry.intentId);
    assert.equal(h.state.selectDownload('a').title, 'Newer title');
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
});

test('response loss confirms exactly once through actor-scoped receipt without automatic replay', async () => {
    const h = harness(); const entry = h.submit(); await tick(); const original = h.requests[0];
    original.reject(new Error('lost')); await tick();
    assert.match(h.requests[1].url, /^\/api\/mutations\//);
    h.requests[1].resolve(h.ack(original)); await tick();
    assert.equal(h.mutations.status(entry.intentId), null);
    assert.equal(h.state.selectDownload('a'), null);
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
    assert.equal(h.events.filter(event => event.outcome === 'confirmed').length, 1);
});

test('deliberate replay freezes operation ID, expected generation and removal scope', async () => {
    const h = harness(); const entry = h.submit(); await tick(); const original = h.requests[0];
    original.reject(new Error('lost')); await tick(); h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    h.state.acceptDownload({ id: 'a', removal_revision: '12' });
    const replay = h.mutations.recover(entry.intentId, { replay: true }); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await replay; await tick();
    assert.deepEqual(h.requests[3].body, original.body);
    assert.equal(h.requests[3].url, original.url);
    h.requests[3].resolve(h.ack(original)); await tick();
    assert.equal(h.mutations.hasPending(), false); assert.equal(h.state.selectDownload('a'), null);
});

test('partial journal receipt and later absent receipt never perform live-target read or discard recovery', async () => {
    const h = harness(); const entry = h.submit(); await tick(); h.requests[0].resolve({ status: 503, body: { error: 'Recovery required' } }); await tick();
    h.requests[1].resolve({ status: 503, body: { error: 'Recovery required' } }); await tick();
    assert.equal(h.mutations.status(entry.intentId).status, 'unconfirmed');
    const check = h.mutations.recover(entry.intentId); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await check; await tick();
    assert.equal(h.requests.length, 3);
    assert.equal(h.requests.some(request => request.url.includes('editable-state')), false);
    assert.equal(h.state.selectDownload('a').title, 'Confirmed title');
    assert.equal(h.mutations.resolve(entry.intentId), false);
});

test('strict correlation rejects wrong scope, revision, removed flag, action, domain, target, ID and outcome', async () => {
    const corruptions = [
        body => { body.scope = 'entry'; }, body => { body.removal_revision = '9'; body.mutation.revision = '9'; },
        body => { body.removed = false; }, body => { body.mutation.action = 'rename.set'; }, body => { body.mutation.domain = 'rename'; },
        body => { body.id = 'other'; }, body => { body.mutation.id = 'other'; }, body => { body.mutation.outcome = 'accepted'; },
        body => { body.removal_revision = 8; body.mutation.revision = 8; },
    ];
    for (const corrupt of corruptions) {
        const h = harness(); const entry = h.submit(); await tick(); const response = h.ack(h.requests[0]); corrupt(response.body);
        h.requests[0].resolve(response); await tick();
        assert.equal(h.mutations.status(entry.intentId).status, 'unconfirmed');
        assert.equal(h.state.selectDownload('a').filename, '/media/a.mp4');
        assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
    }
});

for (const outcome of ['rejected', 'conflicted']) test(`${outcome} preserves newer confirmed fields and requires explicit review`, async () => {
    const h = harness(); const entry = h.submit(); await tick();
    h.state.acceptDownload({ id: 'a', title: 'Remote title', favorite: true, favorite_revision: '4', removal_revision: '10' });
    h.requests[0].resolve(h.ack(h.requests[0], outcome, '9')); await tick();
    assert.equal(h.mutations.status(entry.intentId).status, outcome);
    assert.equal(h.state.selectDownload('a').title, 'Remote title');
    assert.equal(h.state.selectDownload('a').favorite, true);
    assert.equal(h.state.selectDownload('a').removal_revision, '10');
    assert.equal(h.mutations.retry(entry.intentId).reason, 'review_required');
    assert.equal(h.mutations.resolve(entry.intentId), true);
    assert.equal(h.state.selectDownload('a').removal_intents.length, 0);
});

test('five-second waiting explanation and timeout preserve row and unknown scope', async () => {
    const h = harness(); const entry = h.submit(); await tick(); h.advance(5000);
    assert.match(h.mutations.status(entry.intentId).message, /Still waiting.*removal/);
    h.advance(25000); await tick();
    assert.match(h.mutations.status(entry.intentId).message, /Removal not confirmed/);
    assert.equal(h.state.selectDownload('a').filename, '/media/a.mp4');
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
});

test('expired serialized receipt absence allows explicit release without claiming deletion or replaying', async () => {
    const h = harness(); const entry = h.submit(); await tick(); h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    h.advance(86401000);
    assert.equal(h.mutations.status(entry.intentId).replayExpired, true);
    const check = h.mutations.recover(entry.intentId, { replay: true }); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await tick();
    assert.equal(h.requests[3].url, '/api/downloads/a/editable-state');
    assert.equal(h.mutations.status(entry.intentId).canResolve, false);
    h.requests[3].resolve({ status: 200, body: { id: 'a', title: 'Current authorized title', removal_revision: '11' } }); await check; await tick();
    assert.equal(h.mutations.resolve(entry.intentId), true);
    assert.equal(h.state.selectDownload('a').title, 'Current authorized title');
    assert.equal(h.state.selectDownload('a').removal_revision, '11');
    assert.equal(h.events.some(event => event.outcome === 'confirmed'), false);
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
});

test('authentication reset, access loss, and known deletion fence late removal acknowledgements', async () => {
    for (const mode of ['reset', 'access', 'delete']) {
        const h = harness(); h.submit(); await tick(); const original = h.requests[0];
        if (mode === 'reset') h.mutations.reset();
        else h.mutations.fence('a', mode === 'delete');
        original.resolve(h.ack(original)); await tick();
        assert.equal(h.state.selectDownload('a'), null); assert.equal(h.mutations.hasPending(), false);
        assert.equal(h.events.some(event => event.outcome === 'confirmed'), false);
    }
});

test('capability, explicit scope, and canonical generation are required for recovery adoption', () => {
    const unsupported = harness(false); assert.equal(unsupported.submit().reason, 'unsupported'); assert.equal(unsupported.requests.length, 0);
    const h = harness(); assert.equal(h.submit('all').reason, 'validation');
    h.state.acceptDownload({ id: 'unversioned', status: 'finished' });
    assert.equal(h.submit('entry', 'unversioned').reason, 'unsupported');
});

for (const kind of ['rename.set', 'download.retry']) test(`${kind} acknowledgement advances removal generation without a collection read`, async () => {
    const h = harness();
    const entry = h.mutations.submit({ kind, targetId: 'a', value: kind === 'rename.set' ? 'renamed.mp4' : { attempt_id: 'attempt-1' } });
    await tick();
    const request = h.requests[0];
    const revision = '1';
    const body = kind === 'rename.set'
        ? { id: 'a', filename: '/media/renamed.mp4', display_filename: 'renamed.mp4', rename_revision: revision, removal_revision: '8', mutation: { id: request.body.client_mutation_id, domain: 'rename', outcome: 'committed', revision } }
        : { id: 'a', command_revision: revision, current_attempt_id: 'new-attempt', removal_revision: '8', command: { id: 'job-1', action: kind, source_attempt_id: 'attempt-1', attempt_id: 'new-attempt', job_id: 'job-1', status: 'dispatched' }, mutation: { id: request.body.client_mutation_id, domain: 'download-command', outcome: 'accepted', revision } };
    request.resolve({ status: 200, body }); await tick();
    assert.equal(h.mutations.status(entry.intentId), null);
    assert.equal(h.state.selectDownload('a').removal_revision, '8');
    h.submit(); await tick();
    assert.equal(h.requests[1].url, '/api/remove/a');
    assert.equal(h.requests[1].body.expected_revision, '8');
});


test('upload cancellation acknowledgement makes terminal upload immediately removable without a collection read', async () => {
    const context = vm.createContext({ Uint8Array });
    for (const name of ['tag-identity', 'client-state', 'mutations']) vm.runInContext(fs.readFileSync(path.join(__dirname, `../static/${name}.js`), 'utf8'), context);
    const state = context.VDL.createClientState();
    const upload = { id: 'legacy-upload', revision: '1', phase: 'registered', attempt_id: 'attempt', download_status: 'starting', downloaded_bytes: 0, total_bytes: 20 };
    state.acceptDownload({ id: upload.id, upload, upload_revision: upload.revision, status: 'starting', removal_revision: '1' });
    const requests = [];
    const now = 1800000000000;
    const mutations = context.VDL.createMutations({ state, now: () => now, random: () => 'f'.repeat(32),
        capabilities: { mutation_protocol: 1, entry_removal: 1, upload_recovery: 1, actions: ['entry.remove', 'upload.cancel'], server_time: now },
        setTimeout: () => ({}), clearTimeout() {},
        transport(request) { return new Promise(resolve => requests.push({ ...plain(request), resolve })); },
    });
    const stopped = mutations.submit({ kind: 'upload.cancel', targetId: upload.id, value: {} }); await tick();
    requests[0].resolve({ status: 200, body: { id: upload.id, upload: { ...upload, revision: '2', phase: 'cancelled', download_status: 'cancelled' }, removal_revision: '2', mutation: { id: requests[0].body.client_mutation_id, domain: 'upload', outcome: 'accepted', revision: '2' } } }); await tick();
    assert.equal(mutations.status(stopped.intentId), null);
    assert.equal(state.selectDownload(upload.id).removal_revision, '2');
    assert.equal(mutations.submit({ kind: 'entry.remove', targetId: upload.id, value: { scope: 'entry-and-files' } }).accepted, true); await tick();
    assert.equal(requests[1].url, '/api/remove/legacy-upload');
    assert.equal(requests[1].body.expected_revision, '2');
});


test('serialized expired absence plus authorized live404 fences availability without claiming removal succeeded', async () => {
    const h = harness(); const entry = h.submit(); await tick(); h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    h.advance(86401000);
    const checked = h.mutations.recover(entry.intentId); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await tick();
    assert.equal(h.requests[3].url, '/api/downloads/a/editable-state');
    h.requests[3].resolve({ status: 404, body: { error: 'Unknown download id' } }); await checked; await tick();
    assert.equal(h.state.selectDownload('a'), null);
    assert.equal(h.mutations.status(entry.intentId), null);
    assert.equal(h.mutations.hasPending(), false);
    assert.equal(h.events.some(event => event.outcome === 'confirmed'), false);
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
});

test('failed authorized current-state check after expired absence retains recovery rather than offering stale resolution', async () => {
    const h = harness(); const entry = h.submit(); await tick(); h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    h.advance(86401000);
    const checked = h.mutations.recover(entry.intentId); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await tick();
    h.requests[3].resolve({ status: 503, body: { error: 'Unavailable' } }); await checked; await tick();
    assert.equal(h.mutations.status(entry.intentId).canResolve, false);
    assert.equal(h.mutations.resolve(entry.intentId), false);
    assert.equal(h.state.selectDownload('a').title, 'Confirmed title');
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
});


for (const inconsistent of [false, true]) test(`expired authorized read ${inconsistent ? 'rejects changed identity at equal revision' : 'normalizes public and physical filename representations at equal revision'}`, async () => {
    const h = harness(true, true); const entry = h.submit(); await tick(); h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    h.advance(86401000);
    const check = h.mutations.recover(entry.intentId); await tick();
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await tick();
    h.requests[3].resolve({ status: 200, body: { id: 'a', removal_revision: '7', filename: '/media/a.mp4', display_filename: inconsistent ? 'Changed identity.mp4' : null, rename_revision: '0', favorite: false, favorite_revision: '0', command_revision: '0', current_attempt_id: 'attempt-1' } });
    await check; await tick();
    assert.equal(h.state.selectDownload('a').filename, 'a.mp4');
    assert.equal(h.mutations.status(entry.intentId).canResolve, !inconsistent);
    assert.equal(h.mutations.resolve(entry.intentId), !inconsistent);
    assert.equal(h.events.some(event => event.outcome === 'confirmed'), false);
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
});

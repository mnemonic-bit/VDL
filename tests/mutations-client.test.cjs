const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const plain = value => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
function harness() {
    const context = vm.createContext({ setTimeout, clearTimeout, Uint8Array, crypto: require('node:crypto').webcrypto });
    for (const name of ['tag-identity', 'client-state', 'mutations']) vm.runInContext(fs.readFileSync(path.join(__dirname, `../static/${name}.js`), 'utf8'), context);
    const VDL = context.VDL;
    const state = VDL.createClientState();
    let clock = 1800000000000;
    let random = 0;
    let timerCount = 0;
    const timers = new Map();
    const requests = [];
    const events = [];
    let authLoss = 0;
    const capabilities = { mutation_protocol: 1, actions: ['tag.add', 'tag.remove', 'favorite.set'], tag_identity_version: VDL.tagIdentity.version, server_time: clock };
    const mutations = VDL.createMutations({
        state, capabilities, onEvent: event => events.push(plain(event)), now: () => clock,
        random: () => (++random).toString(16).padStart(32, '0'),
        setTimeout(callback, delay) { const id = ++timerCount; timers.set(id, { callback, at: clock + delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        transport(request) { const pending = deferred(); requests.push({ ...plain(request), ...pending }); return pending.promise; },
        onAuthLoss: () => { authLoss++; },
    });
    function snapshot(id = 'a', names = [], revision = '0', extra = {}) {
        return { id, favorite: false, favorite_revision: '0', tags: names, tag_items: names.map(name => plain(VDL.tagIdentity.normalize(name))), tags_revision: revision, tag_identity_version: VDL.tagIdentity.version, permissions: { tags: true }, ...extra };
    }
    function ack(request, names, revision, extra = {}) {
        return { status: 200, body: { ...snapshot(decodeURIComponent(request.url.split('/').pop()), names, revision), mutation: { id: request.body.client_mutation_id, domain: 'tags', outcome: 'committed', revision }, submitted_tag: plain(VDL.tagIdentity.normalize(request.body.tag)), ...extra } };
    }
    function decline(request, status, revision, names = []) {
        return { status: status === 'conflicted' ? 409 : 400, body: { ...snapshot('a', names, revision), mutation: { id: request.body.client_mutation_id, domain: 'tags', outcome: status, revision } } };
    }
    function advance(ms) {
        clock += ms;
        for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.callback(); }
    }
    state.acceptDownload(snapshot());
    return { VDL, state, mutations, requests, events, snapshot, ack, decline, advance, authLoss: () => authLoss, capabilities };
}

test('identity matches Python normalization, casefold, controls and code-point limits', () => {
    const { VDL } = harness();
    for (const [input, expected] of [[' Straße ', ['Straße', 'strasse']], ['\u2003MUSIC\u00a0 Videos\u3000', ['MUSIC Videos', 'music videos']], ['ΟΣ', ['ΟΣ', 'οσ']], ['İ', ['İ', 'i\u0307']], ['ﬃ', ['ﬃ', 'ffi']]]) {
        const actual = VDL.tagIdentity.normalize(input);
        assert.deepEqual([actual.name, actual.key], expected);
    }
    assert.equal(Array.from(VDL.tagIdentity.normalize('😀'.repeat(64)).name).length, 64);
    for (const input of ['', 'a,b', 'a\t', 'a\u200b', '\ud800', '😀'.repeat(65)]) assert.throws(() => VDL.tagIdentity.normalize(input));
});

test('admission projects immediately; selecting/rerendering never writes; domain queue is FIFO', async () => {
    const h = harness();
    h.state.beginEdit('a');
    const a = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Music' });
    const b = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Tutorial' });
    assert.deepEqual(plain(h.state.selectDownload('a').tags), ['Music', 'Tutorial']);
    assert.equal(h.mutations.status(b.intentId).status, 'queued');
    assert.equal(h.requests.length, 0);
    for (let n = 0; n < 5; n++) h.state.selectDownload('a');
    await tick();
    assert.equal(h.requests.length, 1);
    h.requests[0].resolve(h.ack(h.requests[0], ['Music'], '1'));
    await tick();
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].body.expected_revision, '1');
    assert.deepEqual(plain(h.state.selectDownload('a').tags), ['Music', 'Tutorial']);
    assert.equal(h.mutations.status(a.intentId), null);
});

test('stale GETs and SSE-before-ack cannot erase or duplicate pending tags', async () => {
    const h = harness();
    const admitted = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'STRASSE' });
    h.state.acceptDownload(h.snapshot('a', [], '0'));
    assert.deepEqual(plain(h.state.selectDownload('a').tags), ['STRASSE']);
    await tick();
    h.state.acceptDownload(h.snapshot('a', ['Straße'], '1'));
    assert.equal(h.state.selectDownload('a').tag_chips.length, 1);
    assert.equal(h.mutations.status(admitted.intentId).status, 'sending');
    h.requests[0].resolve(h.ack(h.requests[0], ['Straße'], '1'));
    await tick();
    h.state.acceptDownload(h.snapshot('a', [], '0'));
    assert.deepEqual(plain(h.state.selectDownload('a').tags), ['Straße']);
});

test('older acknowledgement retires intent without replacing a newer remote snapshot', async () => {
    const h = harness();
    h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Music' });
    await tick();
    h.state.acceptDownload(h.snapshot('a', ['Remote'], '10', { favorite: true, favorite_revision: '1' }));
    h.requests[0].resolve(h.ack(h.requests[0], ['Music'], '2'));
    await tick();
    const model = h.state.selectDownload('a');
    assert.deepEqual(plain(model.tags), ['Remote']);
    assert.equal(model.favorite, true);
    assert.equal(h.mutations.hasPending(), false);
});

test('confirmed merging and intent retirement notify atomically', async () => {
    const h = harness();
    const frames = [];
    h.state.subscribe(() => frames.push(plain(h.state.selectDownload('a'))));
    h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Music' });
    await tick();
    frames.length = 0;
    h.requests[0].resolve(h.ack(h.requests[0], ['Music'], '1'));
    await tick();
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0].tags, ['Music']);
    assert.equal(frames[0].tag_chips[0].status, 'confirmed');
});

test('failed A preserves its text and independent queued B; failed removals restore current membership', async () => {
    const h = harness();
    const a = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Music' });
    h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Tutorial' });
    await tick();
    h.requests[0].resolve(h.decline(h.requests[0], 'rejected', '0'));
    await tick();
    assert.deepEqual(plain(h.state.selectDownload('a').tags), ['Tutorial']);
    assert.equal(h.state.selectDownload('a').tag_chips.find(tag => tag.name === 'Music').status, 'rejected');
    assert.equal(h.requests.length, 2);
    assert.equal(h.mutations.status(a.intentId).value, 'Music');
    const r = harness();
    r.state.acceptDownload(r.snapshot('a', ['Music'], '1'));
    r.mutations.submit({ kind: 'tag.remove', targetId: 'a', value: 'Music' });
    assert.deepEqual(plain(r.state.selectDownload('a').tags), []);
    assert.equal(r.state.selectDownload('a').tag_chips[0].operation, 'tag.remove');
    await tick();
    r.requests[0].resolve(r.decline(r.requests[0], 'rejected', '1', ['Music']));
    await tick();
    assert.deepEqual(plain(r.state.selectDownload('a').tags), ['Music']);
});

test('conflicts pause one entry; explicit retry uses a fresh attempt and revision', async () => {
    const h = harness();
    const first = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Music' });
    h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Tutorial' });
    h.state.acceptDownload(h.snapshot('b'));
    h.mutations.submit({ kind: 'tag.add', targetId: 'b', value: 'Independent' });
    await tick();
    const request = h.requests[0];
    request.resolve(h.decline(request, 'conflicted', '1', ['Remote']));
    await tick();
    assert.equal(h.requests.length, 2);
    assert.equal(h.mutations.status(first.intentId).status, 'conflicted');
    h.mutations.retry(first.intentId);
    await tick();
    assert.equal(h.requests.length, 3);
    assert.match(h.requests[2].url, /editable-state$/);
    h.requests[2].resolve({ status: 200, body: h.snapshot('a', ['Remote'], '2') });
    await tick();
    assert.equal(h.requests[3].body.expected_revision, '2');
    assert.equal(h.requests[3].body.tag, 'Music');
    assert.notEqual(h.requests[3].body.client_mutation_id, request.body.client_mutation_id);
});

test('lost response checks receipt once without replay; recovery merges a committed receipt', async () => {
    const h = harness();
    const first = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Music' });
    h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Tutorial' });
    await tick();
    const original = h.requests[0];
    original.reject(new Error('response dropped'));
    await tick();
    assert.equal(h.mutations.status(first.intentId).status, 'unconfirmed');
    assert.equal(h.requests[1].method, 'GET');
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    assert.equal(h.requests.length, 2);
    assert.equal(h.mutations.resolve(first.intentId), false);
    const recovered = h.mutations.recover(first.intentId);
    h.requests[2].resolve(h.ack(original, ['Music'], '1'));
    await recovered;
    await tick();
    assert.equal(h.requests[3].method, 'POST');
    assert.equal(h.requests[3].body.tag, 'Tutorial');
});

test('explicit recovery replays exact immutable attempt; unresolved request cannot be dismissed', async () => {
    const h = harness();
    const submitted = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Music' });
    await tick();
    const original = h.requests[0];
    original.resolve({ status: 502, body: {} });
    await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    const work = h.mutations.recover(submitted.intentId, { replay: true });
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    assert.deepEqual(h.requests[3].body, original.body);
    assert.equal(h.requests[3].method, original.method);
    assert.equal(h.mutations.resolve(submitted.intentId), false);
    h.requests[3].resolve(h.ack(original, ['Music'], '1'));
    await work;
});

test('malformed or miscorrelated success remains unconfirmed and preserves pending projection', async () => {
    const h = harness();
    const submitted = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Music' });
    await tick();
    const reply = h.ack(h.requests[0], ['Music'], '1');
    reply.body.mutation.id = 'foreign';
    h.requests[0].resolve(reply);
    await tick();
    assert.equal(h.mutations.status(submitted.intentId).status, 'unconfirmed');
    assert.deepEqual(plain(h.state.selectDownload('a').tags), ['Music']);
});

test('five-second feedback is explanatory and timeout is unknown, never rollback', async () => {
    const h = harness();
    const submitted = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Music' });
    await tick();
    h.advance(5000);
    assert.equal(h.mutations.status(submitted.intentId).delayed, true);
    assert.match(h.mutations.status(submitted.intentId).message, /waiting/i);
    h.advance(25000);
    assert.equal(h.mutations.status(submitted.intentId).status, 'unconfirmed');
    assert.deepEqual(plain(h.state.selectDownload('a').tags), ['Music']);
});

test('canonical duplicates do not write twice, Unicode identity mismatch declines admission', async () => {
    const h = harness();
    const first = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Straße' });
    const second = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'STRASSE' });
    assert.equal(first.intentId, second.intentId);
    await tick();
    assert.equal(h.requests.length, 1);
    h.mutations.setCapabilities({ ...h.capabilities, tag_identity_version: 'different' });
    assert.equal(h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Other' }).accepted, false);
});

test('domain/page limits reject new input without dropping queued intents', () => {
    const h = harness();
    for (let n = 0; n < 32; n++) assert.equal(h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: `Tag ${n}` }).accepted, true);
    assert.equal(h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Too many' }).reason, 'limit');
    for (const id of ['b', 'c', 'd']) {
        h.state.acceptDownload(h.snapshot(id));
        for (let n = 0; n < 32; n++) h.mutations.submit({ kind: 'tag.add', targetId: id, value: `Tag ${n}` });
    }
    h.state.acceptDownload(h.snapshot('e'));
    assert.equal(h.mutations.submit({ kind: 'tag.add', targetId: 'e', value: 'Too many' }).reason, 'limit');
    assert.equal(h.mutations.pending().length, 128);
});

test('authentication reset and permission fences ignore late callbacks and collection results', async () => {
    const h = harness();
    const token = h.state.capture();
    h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Private' });
    await tick();
    const old = h.requests[0];
    h.mutations.reset();
    assert.equal(h.state.acceptDownload(h.snapshot('a', ['Private'], '1'), token), false);
    old.resolve(h.ack(old, ['Private'], '1'));
    await tick();
    assert.equal(h.state.selectDownload('a'), null);
    assert.equal(h.requests.length, 1);
    h.state.acceptDownload(h.snapshot());
    h.mutations.fence('a');
    assert.equal(h.state.acceptDownload(h.snapshot('a', ['Private'], '9')), false);
    assert.equal(h.state.selectDownload('a'), null);
});

test('401 resets all private work and invokes auth lifecycle callback', async () => {
    const h = harness();
    h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Private' });
    await tick();
    h.requests[0].resolve({ status: 401, body: {} });
    await tick();
    assert.equal(h.authLoss(), 1);
    assert.equal(h.state.selectDownload('a'), null);
    assert.equal(h.mutations.hasPending(), false);
});

test('projected models are immutable, revisions compare numerically, and membership uses separate generations', () => {
    const h = harness();
    h.state.acceptDownload(h.snapshot('a', ['Ten'], '10'));
    h.state.acceptDownload(h.snapshot('a', ['Nine'], '9'));
    assert.deepEqual(plain(h.state.selectDownload('a').tags), ['Ten']);
    assert.throws(() => h.state.selectDownload('a').tags.push('Corruption'));
    assert.equal(h.state.acceptDownload(h.snapshot('a', ['Mismatch'], '10')), false);
    const old = h.state.beginCollection('library');
    const fresh = h.state.beginCollection('library');
    h.state.acceptCollection(fresh, [h.snapshot('b')]);
    assert.equal(h.state.acceptCollection(old, [h.snapshot('a')]), false);
    assert.deepEqual(plain(h.state.collectionIds('library')), ['b']);
    assert.deepEqual(plain(h.state.selectDownload('a').tags), ['Ten']);
});


test('missing revisions or mismatched snapshot identity decline protocol admission', () => {
    const h = harness();
    h.state.acceptDownload({ id: 'legacy', tags: [], permissions: { tags: true } });
    assert.equal(h.mutations.submit({ kind: 'tag.add', targetId: 'legacy', value: 'Music' }).reason, 'unsupported');
    h.state.acceptDownload(h.snapshot('wrong', [], '0', { tag_identity_version: 'wrong' }));
    assert.equal(h.mutations.submit({ kind: 'tag.add', targetId: 'wrong', value: 'Music' }).reason, 'unsupported');
});

test('explicit state check safely resolves unknown only when original expected revision is unusable', async () => {
    const h = harness();
    const admitted = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Music' });
    await tick();
    h.requests[0].reject(new Error('network'));
    await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    assert.equal(h.mutations.resolve(admitted.intentId), false);
    const checking = h.mutations.recover(admitted.intentId);
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    assert.match(h.requests[3].url, /editable-state$/);
    h.requests[3].resolve({ status: 200, body: h.snapshot('a', ['Remote'], '1') });
    await checking;
    assert.equal(h.mutations.resolve(admitted.intentId), true);
    assert.deepEqual(plain(h.state.selectDownload('a').tags), ['Remote']);
});

test('recovery replay has bounded wait feedback and returns to unknown on timeout', async () => {
    const h = harness();
    const admitted = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Music' });
    await tick();
    h.requests[0].reject(new Error('network'));
    await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    h.mutations.recover(admitted.intentId, { replay: true });
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    h.advance(5000);
    assert.equal(h.mutations.status(admitted.intentId).delayed, true);
    h.advance(25000);
    assert.equal(h.mutations.status(admitted.intentId).status, 'unconfirmed');
    assert.deepEqual(plain(h.state.selectDownload('a').tags), ['Music']);
});

test('known removal fence prevents a late successful mutation from restoring private data', async () => {
    const h = harness();
    h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Private' });
    await tick();
    h.requests[0].resolve({ status: 404, body: { error: 'Unknown download id' } });
    await tick();
    assert.equal(h.state.selectDownload('a'), null);
    assert.equal(h.mutations.pending().length, 0);
});


test('observability reports timings and counts without submitted content or request paths', async () => {
    const h = harness();
    h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'private draft text' });
    await tick();
    h.advance(123);
    h.requests[0].resolve(h.ack(h.requests[0], ['private draft text'], '1'));
    await tick();
    assert.equal(h.events[0].outcome, 'presented');
    assert.equal(h.events[0].elapsedMs, 0);
    assert.equal(h.events.at(-1).outcome, 'confirmed');
    assert.equal(h.events.at(-1).elapsedMs, 123);
    const output = JSON.stringify(h.events);
    assert.doesNotMatch(output, /private draft text|api\/tags/);
});

test('unsent work can be discarded; known tags and malicious labels stay data', async () => {
    const h = harness();
    h.state.acceptDownload(h.snapshot('a', ['Existing'], '1'));
    assert.equal(h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'existing' }).settled, true);
    const first = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: '<img src=x onerror=alert(1)>' });
    const queued = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Discard' });
    assert.equal(h.mutations.resolve(queued.intentId), true);
    assert.equal(h.mutations.resolve(first.intentId), false);
    assert.equal(h.state.selectDownload('a').tag_items.some(tag => tag.name === '<img src=x onerror=alert(1)>'), true);
    await tick();
    assert.equal(h.requests.length, 1);
});


test('a timed-out replay releases its recovery check so the user can check again', async () => {
    const h = harness();
    const admitted = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Music' });
    await tick();
    h.requests[0].reject(new Error('network'));
    await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    const replay = h.mutations.recover(admitted.intentId, { replay: true });
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await replay;
    await tick();
    assert.equal(h.requests[3].method, 'POST');
    h.advance(30000);
    assert.equal(h.mutations.status(admitted.intentId).status, 'unconfirmed');
    h.mutations.recover(admitted.intentId);
    assert.equal(h.requests[4].method, 'GET');
});


test('duplicate canonical identities in an acknowledgement are malformed and not confirmed', async () => {
    const h = harness();
    const admitted = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Music' });
    await tick();
    h.requests[0].resolve(h.ack(h.requests[0], ['Music', 'Music'], '1'));
    await tick();
    assert.equal(h.mutations.status(admitted.intentId).status, 'unconfirmed');
    assert.equal(h.state.selectDownload('a').tags_revision, '0');
});


test('retrying rejected A while B is sending never transmits two attempts in one domain', async () => {
    const h = harness();
    const first = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Music' });
    h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Tutorial' });
    await tick();
    h.requests[0].resolve(h.decline(h.requests[0], 'rejected', '0'));
    await tick();
    assert.equal(h.requests.length, 2);
    h.mutations.retry(first.intentId);
    await tick();
    assert.equal(h.requests.length, 2);
    assert.equal(h.mutations.status(first.intentId).status, 'queued');
    h.requests[1].resolve(h.ack(h.requests[1], ['Tutorial'], '1'));
    await tick();
    assert.equal(h.requests.length, 3);
    assert.equal(h.requests[2].body.tag, 'Music');
    assert.equal(h.requests[2].body.expected_revision, '1');
});

test('a committed result must contain the outcome of its own tag operation', async () => {
    for (const kind of ['tag.add', 'tag.remove']) {
        const h = harness();
        if (kind === 'tag.remove') h.state.acceptDownload(h.snapshot('a', ['Music'], '1'));
        const submitted = h.mutations.submit({ kind, targetId: 'a', value: 'Music' });
        await tick();
        h.requests[0].resolve(h.ack(h.requests[0], kind === 'tag.add' ? [] : ['Music'], '2'));
        await tick();
        assert.equal(h.mutations.status(submitted.intentId).status, 'unconfirmed');
    }
});


test('a proxy or malformed receipt 404 cannot fence the target or establish an absent attempt', async () => {
    const h = harness();
    const admitted = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Music' });
    await tick();
    h.requests[0].reject(new Error('response lost'));
    await tick();
    h.requests[1].resolve({ status: 404, body: null });
    await tick();
    assert.equal(h.mutations.status(admitted.intentId).status, 'unconfirmed');
    assert.deepEqual(plain(h.state.selectDownload('a').tags), ['Music']);
    assert.equal(h.mutations.resolve(admitted.intentId), false);
    assert.equal(h.requests.length, 2);
});


test('equal domain revisions compare canonical values regardless of object property insertion order', () => {
    const h = harness();
    h.state.acceptDownload(h.snapshot('a', ['Music'], '1'));
    const reordered = h.snapshot('a', ['Music'], '1');
    reordered.tag_items = [{ name: 'Music', key: 'music' }];
    assert.equal(h.state.acceptDownload(reordered), true);
    assert.deepEqual(plain(h.state.selectDownload('a').tags), ['Music']);
    const wrong = h.snapshot('a', ['Tutorial'], '1');
    assert.equal(h.state.acceptDownload(wrong), false);
    assert.deepEqual(plain(h.state.selectDownload('a').tags), ['Music']);
});

test('contradictory acknowledgement domain revisions leave the immutable attempt unconfirmed', async () => {
    const h = harness();
    const admitted = h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Music' });
    await tick();
    const reply = h.ack(h.requests[0], ['Music'], '1');
    reply.body.tags_revision = '2';
    h.requests[0].resolve(reply);
    await tick();
    assert.equal(h.mutations.status(admitted.intentId).status, 'unconfirmed');
    assert.equal(h.state.selectDownload('a').tags_revision, '0');
    assert.deepEqual(plain(h.state.selectDownload('a').tags), ['Music']);
});


function favoriteReply(request, favorite, revision, outcome = 'committed') {
    return { status: outcome === 'committed' ? 200 : outcome === 'conflicted' ? 409 : 400, body: {
        id: decodeURIComponent(request.url.split('/').pop()), favorite, favorite_revision: revision,
        mutation: { id: request.body.client_mutation_id, domain: 'favorite', outcome, revision },
    } };
}

test('favorite projection is immediate, explicit true false true stays FIFO, and tags use an independent queue', async () => {
    const h = harness();
    const first = h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: true });
    const second = h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: false });
    const third = h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: true });
    h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Independent' });
    assert.equal(h.state.selectDownload('a').favorite, true);
    assert.equal(h.state.selectDownload('a').favorite_intents.length, 3);
    assert.deepEqual(plain(h.state.selectDownload('a').tags), ['Independent']);
    assert.notEqual(first.intentId, third.intentId);
    await tick();
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[0].url, '/api/favorite/a');
    assert.equal(h.requests[1].url, '/api/tags/a');
    h.requests[0].resolve(favoriteReply(h.requests[0], true, '1'));
    await tick();
    assert.equal(h.requests[2].body.favorite, false);
    assert.equal(h.requests[2].body.expected_revision, '1');
    assert.equal(h.state.selectDownload('a').favorite, true);
    h.requests[2].resolve(favoriteReply(h.requests[2], false, '2'));
    await tick();
    assert.equal(h.requests[3].body.favorite, true);
    h.requests[3].resolve(favoriteReply(h.requests[3], true, '3'));
    await tick();
    assert.equal(h.state.selectDownload('a').favorite_revision, '3');
    assert.equal(h.state.selectDownload('a').favorite_intents.length, 0);
    assert.equal(h.mutations.status(second.intentId), null);
});

test('favorite rejects only its own projection while later opposite intents survive', async () => {
    const h = harness();
    const first = h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: true });
    h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: false });
    h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: true });
    await tick();
    h.requests[0].resolve(favoriteReply(h.requests[0], false, '0', 'rejected'));
    await tick();
    assert.equal(h.mutations.status(first.intentId).status, 'rejected');
    assert.equal(h.state.selectDownload('a').favorite, true);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].body.favorite, false);
    assert.deepEqual(plain(h.state.selectDownload('a').tag_chips), []);
});

test('favorite acknowledgement is atomic and older responses and GETs cannot regress confirmed state', async () => {
    const h = harness();
    h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: true });
    await tick();
    h.state.acceptDownload({ id: 'a', favorite: false, favorite_revision: '2' });
    const notifications = [];
    h.state.subscribe(() => notifications.push(plain(h.state.selectDownload('a'))));
    h.requests[0].resolve(favoriteReply(h.requests[0], true, '1'));
    await tick();
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].favorite, false);
    assert.equal(notifications[0].favorite_intents.length, 0);
    h.state.acceptDownload({ id: 'a', favorite: true, favorite_revision: '1' });
    assert.equal(h.state.selectDownload('a').favorite, false);
    assert.equal(h.state.selectDownload('a').favorite_revision, '2');
    assert.equal(h.state.acceptDownload({ id: 'a', favorite: true, favorite_revision: '2' }), false);
});

test('favorite receipt recovery confirms a lost response without automatic replay', async () => {
    const h = harness();
    const intent = h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: true });
    await tick();
    h.requests[0].reject(new Error('response lost'));
    await tick();
    assert.equal(h.requests[1].method, 'GET');
    assert.equal(h.mutations.status(intent.intentId).status, 'unconfirmed');
    assert.equal(h.state.selectDownload('a').favorite, true);
    h.requests[1].resolve(favoriteReply(h.requests[0], true, '1'));
    await tick();
    assert.equal(h.state.selectDownload('a').favorite_revision, '1');
    assert.equal(h.mutations.status(intent.intentId), null);
    assert.equal(h.requests.length, 2);
});

test('favorite recovery deliberately replays the frozen attempt and cannot dismiss ambiguous outcomes', async () => {
    const h = harness();
    const intent = h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: true });
    await tick();
    h.requests[0].reject(new Error('lost'));
    await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await tick();
    assert.equal(h.mutations.resolve(intent.intentId), false);
    const recovery = h.mutations.recover(intent.intentId, { replay: true });
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } });
    await recovery;
    await tick();
    assert.deepEqual(h.requests[3].body, h.requests[0].body);
    h.requests[3].resolve(favoriteReply(h.requests[0], true, '1'));
    await tick();
    assert.equal(h.mutations.status(intent.intentId), null);
});

test('favorite conflict pauses only its own domain and explicit retry uses an authorized fresh revision', async () => {
    const h = harness();
    const intent = h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: true });
    await tick();
    h.requests[0].resolve(favoriteReply(h.requests[0], false, '2', 'conflicted'));
    await tick();
    assert.equal(h.state.selectDownload('a').favorite, false);
    h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Still usable' });
    await tick();
    assert.equal(h.requests[1].url, '/api/tags/a');
    h.mutations.retry(intent.intentId);
    h.requests[2].resolve({ status: 200, body: { id: 'a', favorite: false, favorite_revision: '3' } });
    await tick();
    assert.equal(h.requests[3].body.expected_revision, '3');
    assert.notEqual(h.requests[3].body.client_mutation_id, h.requests[0].body.client_mutation_id);
});

test('malformed favorite acknowledgements stay unknown, and access loss fences both domains', async () => {
    for (const extra of [{ favorite: 'true' }, { favorite: false }, { favorite_revision: '2' }, { mutation: { domain: 'tags' } }]) {
        const h = harness();
        const intent = h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: true });
        await tick();
        const reply = favoriteReply(h.requests[0], true, '1');
        Object.assign(reply.body, extra);
        h.requests[0].resolve(reply);
        await tick();
        assert.equal(h.mutations.status(intent.intentId).status, 'unconfirmed');
        assert.equal(h.state.selectDownload('a').favorite_revision, '0');
    }
    const h = harness();
    h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: true });
    h.mutations.submit({ kind: 'tag.add', targetId: 'a', value: 'Private' });
    await tick();
    h.requests[0].resolve({ status: 403, body: {} });
    await tick();
    h.requests[1].resolve(h.ack(h.requests[1], ['Private'], '1'));
    await tick();
    assert.equal(h.state.selectDownload('a'), null);
    assert.equal(h.mutations.pending().length, 0);
});

test('favorite capability does not depend on tag identity, and duplicate explicit desired values do not write twice', async () => {
    const h = harness();
    h.mutations.setCapabilities({ ...h.capabilities, tag_identity_version: 'unsupported' });
    assert.equal(h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: false }).settled, true);
    assert.equal(h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: 'true' }).reason, 'validation');
    const first = h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: true });
    assert.equal(h.mutations.submit({ kind: 'favorite.set', targetId: 'a', value: true }).intentId, first.intentId);
    await tick();
    assert.equal(h.requests.length, 1);
});

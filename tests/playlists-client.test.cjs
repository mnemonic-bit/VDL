const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); };
function harness(create = false) {
    const context = vm.createContext({ setTimeout, clearTimeout, Uint8Array });
    for (const name of ['tag-identity', 'client-state', 'mutations']) vm.runInContext(fs.readFileSync(path.join(__dirname, `../static/${name}.js`), 'utf8'), context);
    const state = context.VDL.createClientState();
    const key = create ? 'local-editor-1' : 'playlist-1';
    const snapshot = (revision = 1, name = 'Confirmed', ids = ['one', 'two']) => ({ id: 'playlist-1', owner_user_id: 'actor', revision, name,
        items: ids.map((id, position) => ({ id, position, title: `Video ${id}`, unavailable: false })),
        member_ids: ids, mosaic_ids: ids.slice(0, 4), item_count: ids.length, progress: null, duration_seconds: null, resume_position: 0 });
    state.acceptPlaylist(create ? { ...snapshot(0, '', []), id: null } : snapshot(), {}, key);
    let clock = 1800000000000, sequence = 0;
    const timers = new Map(), requests = [], events = [], notices = [];
    const capabilities = { mutation_protocol: 1, actions: ['playlist.create', 'playlist.replace', 'favorite.set'], server_time: clock };
    const mutations = context.VDL.createMutations({ state, capabilities,
        now: () => clock, random: () => (++sequence).toString(16).padStart(32, '0'),
        setTimeout(callback, delay) { const timer = { callback, at: clock + delay }; timers.set(timer, timer); return timer; },
        clearTimeout(timer) { timers.delete(timer); },
        transport(request) { return new Promise((resolve, reject) => requests.push({ ...request, resolve, reject })); },
        onEvent(event) { events.push(event); }, onNotice(notice) { notices.push(notice); },
    });
    const submit = (name = 'Submitted', ids = ['two', 'one']) => mutations.submit({ kind: create ? 'playlist.create' : 'playlist.replace', targetId: `playlist:${key}`, expectedRevision: state.selectPlaylist(key)?.revision, value: { name, download_ids: ids } });
    function reply(request, outcome = 'committed', revision = create ? 1 : 2, name = 'Submitted', ids = ['two', 'one']) {
        const body = snapshot(revision, name, ids);
        return { status: outcome === 'committed' ? 200 : outcome === 'conflicted' ? 409 : 400,
            body: { ...body, mutation: { id: request.body.client_mutation_id, domain: 'playlist', revision, outcome } } };
    }
    return { state, key, snapshot, mutations, requests, events, notices, capabilities, submit, reply,
        advance(ms) { clock += ms; for (const [key, timer] of [...timers]) if (timer.at <= clock) { timers.delete(key); timer.callback(); } },
    };
}

for (const creation of [false, true]) {
    test(`${creation ? 'creation' : 'replacement'} presents status synchronously and confirms canonical ordered members without reads`, async () => {
        const h = harness(creation), first = h.submit();
        assert.equal(first.accepted, true);
        const model = h.state.selectPlaylist(h.key);
        assert.equal(model.name, creation ? '' : 'Confirmed');
        assert.equal(model.playlist_intents[0].status, 'sending');
        assert.equal(h.requests.length, 0);
        assert.equal(h.state.selectDownload(`playlist:${h.key}`).tag_chips.length, 0);
        await tick();
        assert.equal(h.requests[0].url, creation ? '/api/playlists' : '/api/playlists/playlist-1');
        assert.equal(h.requests[0].method, creation ? 'POST' : 'PUT');
        assert.equal(h.requests[0].body.expected_revision, creation ? undefined : 1);
        const frames = [];
        h.state.subscribe(() => frames.push(plain(h.state.selectPlaylist(h.key))));
        h.requests[0].resolve(h.reply(h.requests[0]));
        await tick();
        assert.equal(h.mutations.status(first.intentId), null);
        assert.deepEqual(plain(h.state.selectPlaylist(h.key).items.map(item => item.id)), ['two', 'one']);
        assert.equal(h.state.selectPlaylist(h.key).id, 'playlist-1');
        assert.equal(frames.length, 1);
        assert.equal(frames[0].playlist_intents.length, 0);
        assert.equal(h.requests.length, 1);
        h.mutations.reset();
    });
}

test('duplicate generation is reused and newer whole-list drafts never silently queue', async () => {
    const h = harness(), first = h.submit();
    assert.equal(h.submit().intentId, first.intentId);
    assert.equal(h.submit('Newer', ['one']).reason, 'unresolved');
    await tick(); assert.equal(h.requests.length, 1);
    h.mutations.reset();
});

test('immutable admission preserves every ordered member while deliberate replay uses the identical attempt', async () => {
    const h = harness(true), value = { name: 'Frozen', download_ids: ['two', 'one'] };
    const first = h.mutations.submit({ kind: 'playlist.create', targetId: `playlist:${h.key}`, value });
    value.name = 'New draft'; value.download_ids.reverse();
    await tick();
    const original = plain(h.requests[0].body);
    assert.equal(original.name, 'Frozen'); assert.deepEqual(original.download_ids, ['two', 'one']);
    h.requests[0].reject(new Error('lost response')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    assert.equal(h.mutations.resolve(first.intentId), false);
    const replay = h.mutations.recover(first.intentId, { replay: true });
    h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await replay; await tick();
    assert.deepEqual(plain(h.requests[3].body), original);
    h.mutations.reset();
});

test('conflict retains ordered draft and requires review plus new explicit operation at current integer revision', async () => {
    const h = harness(), first = h.submit(); await tick();
    h.requests[0].resolve(h.reply(h.requests[0], 'conflicted', 7, 'Remote', ['one', 'two', 'three'])); await tick();
    assert.equal(h.mutations.status(first.intentId).status, 'conflicted');
    assert.deepEqual(plain(h.mutations.status(first.intentId).value.download_ids), ['two', 'one']);
    assert.equal(h.state.selectPlaylist(h.key).name, 'Remote');
    assert.equal(h.mutations.retry(first.intentId).reason, 'review_required');
    assert.equal(h.mutations.resolve(first.intentId), true);
    h.submit(); await tick();
    assert.equal(h.requests[1].body.expected_revision, 7);
    assert.notEqual(h.requests[1].body.client_mutation_id, h.requests[0].body.client_mutation_id);
    h.mutations.reset();
});

test('older acknowledgement retires submission while known newer quick-add order stays canonical', async () => {
    const h = harness(); h.submit(); await tick();
    h.state.acceptPlaylist(h.snapshot(8, 'Remote latest', ['one', 'two', 'three']));
    h.requests[0].resolve(h.reply(h.requests[0])); await tick();
    assert.equal(h.state.selectPlaylist(h.key).name, 'Remote latest');
    assert.equal(h.mutations.hasPending(), false); assert.equal(h.notices.length, 1);
    assert.equal(h.events.find(event => event.outcome === 'confirmed').revision, 2);
    h.state.acceptPlaylist(h.snapshot(2, 'Old read'));
    assert.equal(h.state.selectPlaylist(h.key).revision, 8);
    h.mutations.reset();
});

test('lost post-commit response is confirmed once from receipt without automatic mutation replay', async () => {
    const h = harness(true), first = h.submit(); await tick();
    h.requests[0].reject(new Error('lost')); await tick();
    assert.match(h.requests[1].url, /^\/api\/mutations\//);
    h.requests[1].resolve(h.reply(h.requests[0])); await tick();
    assert.equal(h.mutations.status(first.intentId), null);
    assert.equal(h.requests.length, 2);
    assert.equal(h.events.filter(event => event.outcome === 'confirmed').length, 1);
    h.mutations.reset();
});

test('matching or newer creation state cannot establish finality of an unknown unconditional creation', async () => {
    const h = harness(true), first = h.submit(); await tick();
    h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
    h.state.acceptPlaylist(h.snapshot(5, 'Submitted', ['two', 'one']), {}, h.key);
    assert.equal(h.mutations.resolve(first.intentId), false);
    assert.equal(h.submit().accepted, true); // duplicate original status, no new write
    assert.equal(h.submit('Another').reason, 'unresolved');
    assert.equal(h.requests.length, 2);
    h.mutations.reset();
});

test('expired serialized creation receipt absence permits release without claiming success', async () => {
    const h = harness(true), first = h.submit(); await tick();
    h.requests[0].reject(new Error('lost')); await tick();
    h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await tick();
    assert.equal(h.mutations.resolve(first.intentId), true);
    assert.equal(h.state.selectPlaylist(h.key).id, null);
    assert.equal(h.events.some(event => event.outcome === 'confirmed'), false);
    h.mutations.reset();
});

test('malformed canonical responses remain unknown instead of inventing authority or crashing', async () => {
    for (const corrupt of [
        reply => { reply.body.revision = '2'; }, reply => { reply.body.mutation.domain = 'tags'; },
        reply => { reply.body.id = 'another'; }, reply => { reply.body.items.reverse(); },
        reply => { delete reply.body.item_count; }, reply => { reply.body.mosaic_ids = ['private-foreign']; },
        reply => { reply.body.items[0].title = null; }, reply => { reply.status = 500; reply.body = {}; },
        reply => { reply.body.name = 'Unrelated canonical name'; },
        reply => { reply.body.items.reverse().forEach((item, index) => { item.position = index; }); reply.body.member_ids.reverse(); },
        reply => { reply.body.member_ids = ['foreign', 'one']; },
        reply => { reply.body.revision = 1; reply.body.mutation.revision = 1; },
    ]) {
        const h = harness(), first = h.submit(); await tick();
        const response = h.reply(h.requests[0]); corrupt(response); h.requests[0].resolve(response); await tick();
        assert.equal(h.mutations.status(first.intentId).status, 'unconfirmed');
        assert.equal(h.state.selectPlaylist(h.key).name, 'Confirmed');
        assert.equal(h.requests[1].method, 'GET');
        h.mutations.reset();
    }
});

test('equal-revision privacy redaction survives stale snapshots and receipts without retaining private labels', () => {
    const h = harness();
    const redacted = h.snapshot();
    redacted.items[0] = { id: null, position: 0, title: 'Unavailable video', unavailable: true };
    redacted.member_ids = ['two']; redacted.mosaic_ids = ['two'];
    assert.equal(h.state.acceptPlaylist(redacted), true);
    assert.equal(h.state.selectPlaylist(h.key).items[0].id, null);
    h.state.acceptPlaylist(h.snapshot());
    assert.equal(h.state.selectPlaylist(h.key).items[0].title, 'Unavailable video');
    assert.deepEqual(plain(h.state.selectPlaylist(h.key).member_ids), [null, 'two']);
    assert.deepEqual(plain(h.state.selectPlaylist(h.key).mosaic_ids), ['two']);
    const reordered = h.snapshot(1, 'Confirmed', ['two', 'one']);
    assert.equal(h.state.acceptPlaylist(reordered), false);
    h.mutations.reset();
});

test('auth reset and known playlist deletion fence late acknowledgements and stale reads', async () => {
    for (const action of ['reset', 'fence', '401', '403', '404']) {
        const h = harness(), captured = h.state.capture(); h.submit(); await tick();
        if (action === 'reset') h.mutations.reset();
        else if (action === 'fence') h.mutations.fence(`playlist:${h.key}`);
        else { h.requests[0].resolve({ status: Number(action), body: { error: 'Unknown playlist' } }); await tick(); }
        h.requests[0].resolve(h.reply(h.requests[0])); await tick();
        assert.equal(h.state.selectPlaylist(h.key), null);
        assert.equal(h.mutations.hasPending(), false);
        assert.equal(h.state.acceptPlaylist(h.snapshot(), captured), false);
        h.mutations.reset();
    }
});

test('playlist saves preserve independent favorite domain and reject unsupported or invalid adapters', async () => {
    const h = harness(); h.submit();
    h.state.acceptDownload({ id: 'video', favorite: false, favorite_revision: '0' });
    assert.equal(h.mutations.submit({ kind: 'favorite.set', targetId: 'video', value: true }).accepted, true);
    assert.equal(h.mutations.submit({ kind: 'playlist.replace', targetId: `playlist:${h.key}`, value: { name: 'x', download_ids: ['one', 'one'] } }).reason, 'validation');
    h.mutations.setCapabilities({ ...h.capabilities, actions: [] });
    assert.equal(h.submit().reason, 'unsupported');
    await tick(); assert.equal(h.requests.length, 2);
    h.mutations.reset();
});

test('five-second status and bounded timeout retain draft without claiming completion or leaking content', async () => {
    const h = harness(true), first = h.submit('Private draft'); await tick();
    h.advance(5000);
    assert.equal(h.mutations.status(first.intentId).delayed, true);
    assert.match(h.mutations.status(first.intentId).message, /Still waiting/);
    h.advance(25000);
    assert.equal(h.mutations.status(first.intentId).status, 'unconfirmed');
    assert.equal(h.state.selectPlaylist(h.key).id, null);
    assert.doesNotMatch(JSON.stringify(h.events), /Private draft|playlist-1|\/api\//);
    h.mutations.reset();
});


test('replacement freezes the explicitly reviewed editor revision despite a newer quick-add snapshot', async () => {
    const h = harness();
    h.state.acceptPlaylist(h.snapshot(4, 'Quick add', ['one', 'two', 'three']));
    const first = h.mutations.submit({ kind: 'playlist.replace', targetId: `playlist:${h.key}`, expectedRevision: 1, value: { name: 'Old draft', download_ids: ['two', 'one'] } });
    await tick();
    assert.equal(h.requests[0].body.expected_revision, 1);
    h.requests[0].resolve(h.reply(h.requests[0], 'conflicted', 4, 'Quick add', ['one', 'two', 'three']));
    await tick();
    assert.equal(h.mutations.status(first.intentId).status, 'conflicted');
    assert.equal(h.state.selectPlaylist(h.key).revision, 4);
    h.mutations.reset();
});


test('authorized redacted committed receipt validates against submitted positions and confirms safely', async () => {
    const h = harness(); h.submit(); await tick();
    const response = h.reply(h.requests[0]);
    response.body.items[0] = { id: null, position: 0, title: 'Unavailable video', unavailable: true };
    response.body.member_ids[0] = null;
    response.body.mosaic_ids = ['one'];
    h.requests[0].resolve(response); await tick();
    assert.equal(h.mutations.hasPending(), false);
    assert.equal(h.state.selectPlaylist(h.key).items[0].id, null);
    assert.equal(h.events.at(-1).outcome, 'confirmed');
    h.mutations.reset();
});

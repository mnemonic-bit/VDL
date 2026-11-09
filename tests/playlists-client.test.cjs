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

function actionHarness() {
    const h = harness();
    h.mutations.setCapabilities({ ...h.capabilities, actions: [...h.capabilities.actions, 'playlist.add', 'playlist.delete'] });
    h.action = (kind, downloadId = 'three') => h.mutations.submit({ kind: `playlist.${kind}`, targetId: `playlist:${h.key}`, value: kind === 'add' ? { download_id: downloadId } : {} });
    h.addReply = (request, changed = true, revision = changed ? 2 : 1, ids = changed ? ['one', 'two', 'three'] : ['one', 'two']) => ({ status: 200, body: { ...h.snapshot(revision, 'Confirmed', ids), changed, mutation: { id: request.body.client_mutation_id, domain: 'playlist', revision, outcome: 'committed' } } });
    h.deleteReply = request => ({ status: 200, body: { id: h.key, removed: true, membership_invalidated: true, revision: 2, mutation: { id: request.body.client_mutation_id, domain: 'playlist', revision: 2, outcome: 'committed' } } });
    return h;
}

for (const kind of ['add', 'delete']) {
    test(`${kind} shows request state synchronously without projecting membership or removal`, async () => {
        const h = actionHarness(), submitted = h.action(kind);
        assert.equal(submitted.accepted, true);
        assert.equal(h.state.selectPlaylist(h.key).playlist_intents[0].status, 'sending');
        assert.deepEqual(plain(h.state.selectPlaylist(h.key).member_ids), ['one', 'two']);
        assert.equal(h.action(kind).intentId, submitted.intentId);
        assert.equal(h.action(kind === 'add' ? 'delete' : 'add').reason, 'unresolved');
        assert.equal(h.submit().reason, 'unresolved');
        await tick();
        assert.equal(h.requests.length, 1);
        assert.equal(h.requests[0].method, kind === 'add' ? 'POST' : 'DELETE');
        assert.equal(h.requests[0].url, '/api/playlists/playlist-1' + (kind === 'add' ? '/items' : ''));
        assert.equal(h.requests[0].body.expected_revision, 1);
        h.mutations.reset();
    });

    test(`${kind} confirms directly from its canonical response without a collection read`, async () => {
        const h = actionHarness(), captured = h.state.capture(), submission = h.action(kind);
        await tick();
        const frames = [];
        h.state.subscribe(() => frames.push(plain(h.state.selectPlaylist(h.key))));
        h.requests[0].resolve(kind === 'add' ? h.addReply(h.requests[0]) : h.deleteReply(h.requests[0]));
        await tick();
        assert.equal(h.requests.length, 1);
        assert.equal(h.mutations.status(submission.intentId), null);
        assert.equal(frames.length, 1);
        if (kind === 'add') assert.deepEqual(plain(h.state.selectPlaylist(h.key).member_ids), ['one', 'two', 'three']);
        else {
            assert.equal(h.state.selectPlaylist(h.key), null);
            assert.equal(h.state.acceptPlaylist(h.snapshot(), captured), false);
            assert.equal(h.state.acceptPlaylist(h.snapshot(5)), false);
        }
        h.mutations.reset();
    });

    test(`${kind} lost response recovers once through receipt and never automatically replays`, async () => {
        const h = actionHarness(), submitted = h.action(kind); await tick();
        const original = plain(h.requests[0].body);
        h.requests[0].reject(new Error('post-commit response loss')); await tick();
        assert.equal(h.mutations.status(submitted.intentId).status, 'unconfirmed');
        assert.match(h.mutations.status(submitted.intentId).message, new RegExp(kind === 'add' ? 'Add not confirmed' : 'Delete not confirmed'));
        assert.equal(h.requests[1].method, 'GET');
        h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await tick();
        assert.equal(h.mutations.resolve(submitted.intentId), false);
        assert.equal(h.requests.length, 2);
        const replay = h.mutations.recover(submitted.intentId, { replay: true });
        h.requests[2].resolve({ status: 404, body: { error: 'Mutation unavailable', final: false } }); await replay; await tick();
        assert.deepEqual(plain(h.requests[3].body), original);
        h.requests[3].resolve(kind === 'add' ? h.addReply(h.requests[0]) : h.deleteReply(h.requests[0])); await tick();
        assert.equal(h.mutations.status(submitted.intentId), null);
        assert.equal(h.events.filter(event => event.outcome === 'confirmed').length, 1);
        h.mutations.reset();
    });

    test(`${kind} conflict never reapplies the frozen request to a newer ordered list`, async () => {
        const h = actionHarness(), submitted = h.action(kind); await tick();
        h.requests[0].resolve(h.reply(h.requests[0], 'conflicted', 7, 'Remote', ['two', 'one'])); await tick();
        assert.equal(h.mutations.status(submitted.intentId).status, 'conflicted');
        assert.equal(h.action(kind).accepted, false);
        assert.equal(h.mutations.retry(submitted.intentId).reason, 'review_required');
        assert.deepEqual(plain(h.state.selectPlaylist(h.key).member_ids), ['two', 'one']);
        assert.equal(h.mutations.resolve(submitted.intentId), true);
        h.action(kind); await tick();
        assert.equal(h.requests[1].body.expected_revision, 7);
        assert.notEqual(h.requests[1].body.client_mutation_id, h.requests[0].body.client_mutation_id);
        h.mutations.reset();
    });

    test(`${kind} delayed feedback, expired receipt and authentication fences retain truthful finality`, async () => {
        const h = actionHarness(), submitted = h.action(kind); await tick();
        h.advance(5000);
        assert.match(h.mutations.status(submitted.intentId).message, /Still waiting/);
        h.advance(25000);
        h.requests[1].resolve({ status: 404, body: { error: 'Mutation unavailable', final: true } }); await tick();
        assert.equal(h.mutations.resolve(submitted.intentId), true);
        assert.notEqual(h.state.selectPlaylist(h.key), null);
        assert.equal(h.events.some(event => event.outcome === 'confirmed'), false);
        h.mutations.reset();
        h.requests[0].resolve(kind === 'add' ? h.addReply(h.requests[0]) : h.deleteReply(h.requests[0])); await tick();
        assert.equal(h.state.selectPlaylist(h.key), null);
    });
}

test('already-present add is a correlated no-op preserving the integer revision', async () => {
    const h = actionHarness(), submitted = h.action('add', 'one'); await tick();
    h.requests[0].resolve(h.addReply(h.requests[0], false)); await tick();
    assert.equal(h.mutations.status(submitted.intentId), null);
    assert.equal(h.state.selectPlaylist(h.key).revision, 1);
    assert.deepEqual(plain(h.state.selectPlaylist(h.key).member_ids), ['one', 'two']);
    h.mutations.reset();
});

test('add validates canonical order, requested member, changed flag, target and revision before confirmation', async () => {
    for (const corrupt of [
        reply => { reply.body.changed = 'true'; },
        reply => { reply.body.changed = false; },
        reply => { reply.body.id = 'another-playlist'; },
        reply => { reply.body.mutation.id = 'foreign-attempt'; },
        reply => { reply.body.revision = 8; reply.body.mutation.revision = 8; },
        reply => { reply.body.name = 'Other name'; },
        reply => { reply.body.items.reverse().forEach((item, index) => { item.position = index; }); reply.body.member_ids.reverse(); },
        reply => { reply.body.items[2].id = 'foreign-video'; reply.body.member_ids[2] = 'foreign-video'; reply.body.mosaic_ids[2] = 'foreign-video'; },
    ]) {
        const h = actionHarness(), submitted = h.action('add'); await tick();
        const reply = h.addReply(h.requests[0]); corrupt(reply); h.requests[0].resolve(reply); await tick();
        assert.equal(h.mutations.status(submitted.intentId).status, 'unconfirmed');
        assert.deepEqual(plain(h.state.selectPlaylist(h.key).member_ids), ['one', 'two']);
        h.mutations.reset();
    }
});

test('delete requires correlated removed identity and membership invalidation before installing its fence', async () => {
    for (const corrupt of [
        reply => { reply.body.id = 'foreign'; }, reply => { reply.body.removed = false; },
        reply => { delete reply.body.membership_invalidated; }, reply => { reply.body.revision = 1; reply.body.mutation.revision = 1; },
        reply => { reply.body.mutation.id = 'foreign'; }, reply => { reply.body.mutation.domain = 'tags'; },
    ]) {
        const h = actionHarness(), submitted = h.action('delete'); await tick();
        const reply = h.deleteReply(h.requests[0]); corrupt(reply); h.requests[0].resolve(reply); await tick();
        assert.equal(h.mutations.status(submitted.intentId).status, 'unconfirmed');
        assert.notEqual(h.state.selectPlaylist(h.key), null);
        h.mutations.reset();
    }
});

test('known deletion fences an older add response and unrelated playlists remain usable', async () => {
    const h = actionHarness(); h.action('add');
    h.state.acceptPlaylist({ ...h.snapshot(), id: 'independent' });
    assert.equal(h.mutations.submit({ kind: 'playlist.delete', targetId: 'playlist:independent', value: {} }).accepted, true);
    await tick(); assert.equal(h.requests.length, 2);
    h.mutations.fence(`playlist:${h.key}`);
    h.requests[0].resolve(h.addReply(h.requests[0])); await tick();
    assert.equal(h.state.selectPlaylist(h.key), null);
    assert.equal(h.mutations.hasPending(), true);
    assert.doesNotMatch(JSON.stringify(h.events), /playlist-1|three|Confirmed/);
    h.mutations.reset();
});

test('adopted add/delete validation is narrow and capability-specific', () => {
    const h = actionHarness();
    assert.equal(h.mutations.submit({ kind: 'playlist.add', targetId: `playlist:${h.key}`, value: { download_id: 'three', name: 'extra' } }).reason, 'validation');
    assert.equal(h.mutations.submit({ kind: 'playlist.delete', targetId: `playlist:${h.key}`, value: { all: true } }).reason, 'validation');
    h.mutations.setCapabilities(h.capabilities);
    assert.equal(h.action('add').reason, 'unsupported');
    assert.equal(h.action('delete').reason, 'unsupported');
    h.mutations.reset();
});

test('older add acknowledgement cannot rewind independently sequenced playback progress', async () => {
    const h = actionHarness(), submitted = h.action('add'); await tick();
    const acknowledgement = h.addReply(h.requests[0]);
    acknowledgement.body.progress = { download_id: 'one', position_seconds: 12, completed: false, write_sequence: 2 };
    acknowledgement.body.resume_position = 0;
    const laterRead = h.snapshot(2, 'Confirmed', ['one', 'two', 'three']);
    laterRead.progress = { download_id: 'two', position_seconds: 47, completed: true, write_sequence: 3 };
    laterRead.resume_position = 1;
    h.state.acceptPlaylist(laterRead);
    h.requests[0].resolve(acknowledgement); await tick();
    assert.equal(h.mutations.status(submitted.intentId), null);
    assert.deepEqual(plain(h.state.selectPlaylist(h.key).progress), laterRead.progress);
    assert.equal(h.state.selectPlaylist(h.key).resume_position, 1);
    assert.equal(h.requests.length, 1);
    h.mutations.reset();
});

test('newer independent progress follows accepted membership order and cannot restore removed or redacted members', () => {
    const h = actionHarness();
    const original = h.snapshot();
    original.progress = { download_id: 'two', position_seconds: 47, completed: false, write_sequence: 8 };
    original.resume_position = 1;
    h.state.acceptPlaylist(original);
    const reordered = h.snapshot(2, 'Reordered', ['two', 'one']);
    reordered.progress = { download_id: 'one', position_seconds: 0, completed: false, write_sequence: 7 };
    reordered.resume_position = 1;
    h.state.acceptPlaylist(reordered);
    assert.deepEqual(plain(h.state.selectPlaylist(h.key).progress), original.progress);
    assert.equal(h.state.selectPlaylist(h.key).resume_position, 0);
    const removed = h.snapshot(3, 'Removed', ['one']);
    h.state.acceptPlaylist(removed);
    assert.equal(h.state.selectPlaylist(h.key).progress, null);
    assert.equal(h.state.selectPlaylist(h.key).resume_position, 0);
    h.state.acceptPlaylist({ ...original, revision: 4 });
    const redacted = h.snapshot(4, 'Confirmed', ['one', 'two']);
    redacted.items[1] = { id: null, position: 1, title: 'Unavailable video', unavailable: true };
    redacted.member_ids[1] = null; redacted.mosaic_ids = ['one'];
    h.state.acceptPlaylist(redacted);
    assert.equal(h.state.selectPlaylist(h.key).progress, null);
    assert.equal(h.state.selectPlaylist(h.key).resume_position, 0);
    h.mutations.reset();
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const tick = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };

function harness() {
    const context = vm.createContext({ setTimeout, clearTimeout, Uint8Array });
    for (const name of ['tag-identity', 'client-state', 'mutations']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, `../static/${name}.js`), 'utf8'), context);
    }
    const state = context.VDL.createClientState();
    state.acceptDownload({ id: 'entry', favorite: false, favorite_revision: '0' });
    let clock = 1800000000000;
    let sequence = 0;
    const timers = new Map();
    const requests = [];
    const mutations = context.VDL.createMutations({
        state,
        capabilities: { mutation_protocol: 1, actions: ['favorite.set'], server_time: clock },
        now: () => clock,
        random: () => (++sequence).toString(16).padStart(32, '0'),
        setTimeout(callback, delay) {
            const timer = { callback, at: clock + delay };
            timers.set(timer, timer);
            return timer;
        },
        clearTimeout(timer) { timers.delete(timer); },
        transport(request) {
            return new Promise(resolve => requests.push({ ...request, resolve }));
        },
    });
    function reply(request, outcome, favorite, revision) {
        return {
            status: outcome === 'committed' ? 200 : outcome === 'conflicted' ? 409 : 400,
            body: {
                id: 'entry', favorite, favorite_revision: revision,
                mutation: { id: request.body.client_mutation_id, domain: 'favorite', outcome, revision },
            },
        };
    }
    return {
        state, mutations, requests, reply,
        submit: value => mutations.submit({ kind: 'favorite.set', targetId: 'entry', value }),
        advance(ms) {
            clock += ms;
            for (const [key, timer] of [...timers]) {
                if (timer.at <= clock) { timers.delete(key); timer.callback(); }
            }
        },
    };
}

test('an original response cannot alter a fresh attempt after receipt conflict recovery', async () => {
    const h = harness();
    const intent = h.submit(true);
    assert.equal(intent.accepted, true);
    await tick();
    const original = h.requests[0];
    h.advance(30000);
    await tick();
    assert.match(h.requests[1].url, /^\/api\/mutations\//);
    h.requests[1].resolve(h.reply(original, 'conflicted', false, '2'));
    await tick();
    assert.equal(h.mutations.status(intent.intentId).status, 'conflicted');
    assert.equal(h.mutations.retry(intent.intentId).accepted, true);
    await tick();
    assert.match(h.requests[2].url, /\/editable-state$/);
    h.requests[2].resolve({ status: 200, body: { id: 'entry', favorite: false, favorite_revision: '2' } });
    await tick();
    const fresh = h.requests[3];
    assert.notEqual(fresh.body.client_mutation_id, original.body.client_mutation_id);
    assert.equal(h.mutations.status(intent.intentId).status, 'sending');
    original.resolve(h.reply(original, 'conflicted', false, '2'));
    await tick();
    assert.equal(h.mutations.status(intent.intentId).status, 'sending');
    assert.equal(h.requests.length, 4);
    fresh.resolve(h.reply(fresh, 'committed', true, '3'));
    await tick();
    assert.equal(h.mutations.status(intent.intentId), null);
    assert.equal(h.state.selectDownload('entry').favorite, true);
    h.mutations.reset();
});

test('retrying a rejected scalar intent projects after the requests already in its queue', async () => {
    const h = harness();
    const rejected = h.submit(true);
    h.submit(false);
    await tick();
    h.requests[0].resolve(h.reply(h.requests[0], 'rejected', false, '0'));
    await tick();
    assert.equal(h.requests[1].body.favorite, false);
    assert.equal(h.mutations.retry(rejected.intentId).accepted, true);
    assert.equal(h.state.selectDownload('entry').favorite, true);
    assert.equal(h.mutations.status(rejected.intentId).status, 'queued');
    h.requests[1].resolve(h.reply(h.requests[1], 'committed', false, '0'));
    await tick();
    assert.equal(h.requests[2].body.favorite, true);
    assert.equal(h.state.selectDownload('entry').favorite, true);
    h.requests[2].resolve(h.reply(h.requests[2], 'committed', true, '1'));
    await tick();
    assert.equal(h.state.selectDownload('entry').favorite, true);
    assert.equal(h.mutations.hasPending(), false);
    h.mutations.reset();
});

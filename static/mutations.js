(function (root) {
    'use strict';
    const VDL = root.VDL = root.VDL || {};
    const active = new Set(['queued', 'sending', 'unconfirmed', 'conflicted']);
    const validRevision = value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
    const clone = value => JSON.parse(JSON.stringify(value));
    function createMutations(options) {
        const state = options.state;
        const transport = options.transport;
        const now = options.now || (() => Date.now());
        const later = options.setTimeout || ((fn, delay) => root.setTimeout(fn, delay));
        const cancel = options.clearTimeout || (id => root.clearTimeout(id));
        const random = options.random || (() => {
            const data = new Uint8Array(16);
            root.crypto.getRandomValues(data);
            return Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('');
        });
        const intents = new Map();
        const queues = new Map();
        const timers = new Map();
        const recoveries = new Map();
        let sequence = 0;
        let epoch = 0;
        let capabilities = null;
        let timeOffset = 0;
        function setCapabilities(value) {
            capabilities = value;
            if (value && VDL.tagIdentity.useVersion) VDL.tagIdentity.useVersion(value.tag_identity_version);
            timeOffset = value && Number.isFinite(value.server_time) ? value.server_time - now() : 0;
        }
        setCapabilities(options.capabilities || null);
        function supported(kind) {
            return capabilities?.mutation_protocol === 1 && capabilities.tag_identity_version === VDL.tagIdentity.version && capabilities.actions?.includes(kind);
        }
        function emit(action, outcome, intent, startedAt) {
            if (!options.onEvent) return;
            const counts = { pending: 0, unconfirmed: 0, conflicted: 0 };
            for (const entry of intents.values()) {
                if (active.has(entry.status)) counts.pending++;
                if (entry.status === 'unconfirmed') counts.unconfirmed++;
                if (entry.status === 'conflicted') counts.conflicted++;
            }
            try { options.onEvent(Object.freeze({ action, outcome, intentId: intent?.id, elapsedMs: Math.max(0, now() - startedAt), ...counts })); }
            catch (_) { /* Observability must not affect a save's outcome. */ }
        }
        function update(intent, fields) {
            Object.assign(intent, fields);
            state.writer.put(presentation(intent));
        }
        function presentation(intent) {
            return {
                id: intent.id, targetId: intent.targetId, kind: intent.kind, key: intent.key,
                value: intent.value, status: intent.status, message: intent.message || '',
                delayed: !!intent.delayed, viewToken: intent.viewToken || null,
            };
        }
        function clearTimers(intent) {
            const ids = timers.get(intent.id) || [];
            ids.forEach(cancel);
            timers.delete(intent.id);
        }
        function release(intent) {
            clearTimers(intent);
            const queue = queues.get(intent.targetId) || [];
            const index = queue.indexOf(intent.id);
            if (index !== -1) queue.splice(index, 1);
            if (!queue.length) queues.delete(intent.targetId);
        }
        function reset() {
            epoch++;
            for (const ids of timers.values()) ids.forEach(cancel);
            timers.clear(); intents.clear(); queues.clear(); recoveries.clear();
            state.reset();
        }
        function fence(targetId) {
            targetId = String(targetId);
            for (const [id, intent] of intents) {
                if (intent.targetId === targetId) {
                    clearTimers(intent);
                    intents.delete(id);
                }
            }
            queues.delete(targetId);
            state.writer.fence(targetId);
        }
        function authorizedReply(reply, intent, receipt = false) {
            if (reply.status === 401) {
                reset();
                if (options.onAuthLoss) options.onAuthLoss();
                return false;
            }
            if (reply.status === 403 || (!receipt && reply.status === 404 && reply.body?.error === 'Unknown download id')) {
                fence(intent.targetId);
                return false;
            }
            return true;
        }
        function snapshot(body, intent) {
            return {
                id: intent.targetId, tags: body.tags, tag_items: body.tag_items,
                tags_revision: body.mutation?.revision ?? body.tags_revision,
                tag_identity_version: body.tag_identity_version,
            };
        }
        function canonical(body) {
            try {
                return body?.tag_identity_version === VDL.tagIdentity.version && Array.isArray(body.tags) && Array.isArray(body.tag_items) && body.tags.length === body.tag_items.length && new Set(body.tag_items.map(tag => tag?.key)).size === body.tag_items.length && body.tag_items.every((tag, index) => tag && typeof tag.key === 'string' && typeof tag.name === 'string' && body.tags[index] === tag.name && VDL.tagIdentity.normalize(tag.name).key === tag.key);
            } catch (_) { return false; }
        }
        function validResult(body, intent, committed) {
            const mutation = body?.mutation;
            if (!mutation || mutation.id !== intent.attempt.body.client_mutation_id || mutation.domain !== 'tags' || String(body.id) !== intent.targetId || !validRevision(mutation.revision) || (body.tags_revision !== undefined && body.tags_revision !== mutation.revision) || !canonical(body)) return false;
            if (!committed) return ['rejected', 'conflicted'].includes(mutation.outcome);
            try {
                const attached = body.tag_items.some(tag => tag.key === intent.key);
                return mutation.outcome === 'committed' && attached === (intent.kind === 'tag.add') && body.submitted_tag && typeof body.submitted_tag.name === 'string' && body.submitted_tag.key === intent.key && VDL.tagIdentity.normalize(body.submitted_tag.name).key === intent.key;
            } catch (_) { return false; }
        }
        function finishReply(intent, reply, capturedEpoch) {
            if (capturedEpoch !== epoch || !intents.has(intent.id) || !state.isAvailable(intent.targetId)) return;
            if (!reply || typeof reply.status !== 'number') { markUnknown(intent); return; }
            if (!authorizedReply(reply, intent)) return;
            const body = reply.body;
            if (reply.status >= 200 && reply.status < 300 && validResult(body, intent, true)) {
                const before = state.writer.confirmed(intent.targetId);
                const newerRemote = before && BigInt(before.tags_revision) > BigInt(body.mutation.revision);
                state.writer.transaction(() => {
                    const merged = state.acceptDownload(snapshot(body, intent));
                    const confirmed = state.writer.confirmed(intent.targetId);
                    if (!merged && confirmed?.tags_revision === body.mutation.revision) {
                        markUnknown(intent);
                        return;
                    }
                    release(intent);
                    intent.status = 'confirmed';
                    state.writer.remove(intent.id);
                });
                if (intent.status === 'confirmed') {
                    emit(intent.kind, 'confirmed', intent, intent.sentAt);
                    if (newerRemote && options.onNotice) {
                        try { options.onNotice(Object.freeze({ targetId: intent.targetId, message: 'Your save was confirmed. Newer tag changes are now shown.' })); }
                        catch (_) { /* A view notification cannot undo a committed save. */ }
                    }
                    intents.delete(intent.id);
                    dispatch(intent.targetId);
                }
                return;
            }
            if (validResult(body, intent, false)) {
                clearTimers(intent);
                const status = body.mutation.outcome;
                state.writer.transaction(() => {
                    if (Array.isArray(body.tags) && Array.isArray(body.tag_items)) state.acceptDownload(snapshot(body, intent));
                    update(intent, { status, message: status === 'conflicted' ? 'Tags changed elsewhere. Check the current tags, then retry or dismiss.' : 'Could not save tag. Edit, retry, or dismiss it.' });
                });
                emit(intent.kind, status, intent, intent.sentAt);
                if (status === 'rejected') {
                    release(intent);
                    dispatch(intent.targetId);
                }
                return;
            }
            markUnknown(intent);
        }
        function markUnknown(intent) {
            clearTimers(intent);
            update(intent, { status: 'unconfirmed', message: 'Save not confirmed. Check its status before retrying.', delayed: true });
            emit(intent.kind, 'unconfirmed', intent, intent.sentAt);
        }
        async function transmit(intent, capturedEpoch) {
            try {
                const reply = await transport(clone(intent.attempt));
                finishReply(intent, reply, capturedEpoch);
            } catch (_) {
                if (capturedEpoch === epoch && intents.has(intent.id) && state.isAvailable(intent.targetId)) markUnknown(intent);
            }
            if (capturedEpoch === epoch && intent.status === 'unconfirmed' && !intent.autoChecked) {
                intent.autoChecked = true;
                recover(intent.id, { automatic: true });
            }
        }
        function dispatch(targetId) {
            const queue = queues.get(targetId);
            if (!queue?.length || !state.isAvailable(targetId)) return;
            const intent = intents.get(queue[0]);
            if (!intent || intent.status !== 'queued') return;
            const confirmed = state.writer.confirmed(targetId);
            if (!validRevision(confirmed?.tags_revision)) return;
            const mutationId = `${Math.trunc(now() + timeOffset)}-${random()}`;
            if (!/^\d+-[a-f0-9]{32}$/.test(mutationId)) throw new Error('Invalid mutation identifier source');
            intent.attempt = Object.freeze({
                url: `/api/tags/${encodeURIComponent(targetId)}`,
                method: intent.kind === 'tag.add' ? 'POST' : 'DELETE',
                body: Object.freeze({ tag: intent.value, client_mutation_id: mutationId, expected_revision: confirmed.tags_revision }),
            });
            intent.sentAt = now();
            update(intent, { status: 'sending' });
            armWait(intent);
            const capturedEpoch = epoch;
            Promise.resolve().then(() => { if (capturedEpoch === epoch && intents.has(intent.id)) return transmit(intent, capturedEpoch); });
        }
        function armWait(intent) {
            clearTimers(intent);
            const capturedEpoch = epoch;
            const delayedTimer = later(() => {
                if (capturedEpoch === epoch && intent.status === 'sending') update(intent, { delayed: true, message: 'Still waiting for tag confirmation.' });
            }, 5000);
            const timeoutTimer = later(() => {
                if (capturedEpoch !== epoch || intent.status !== 'sending') return;
                markUnknown(intent);
                if (!intent.autoChecked) { intent.autoChecked = true; recover(intent.id, { automatic: true }); }
            }, options.timeoutMs || 30000);
            timers.set(intent.id, [delayedTimer, timeoutTimer]);
        }
        async function read(request) {
            let timer;
            try {
                return await Promise.race([
                    transport(request),
                    new Promise((_, reject) => { timer = later(() => reject(new Error('Recovery check timed out')), options.timeoutMs || 30000); }),
                ]);
            } finally { if (timer !== undefined) cancel(timer); }
        }
        async function checkState(intent, capturedEpoch) {
            const reply = await read({ url: `/api/downloads/${encodeURIComponent(intent.targetId)}/editable-state`, method: 'GET' });
            if (capturedEpoch !== epoch || !intents.has(intent.id) || !state.isAvailable(intent.targetId)) return false;
            if (!authorizedReply(reply, intent)) return false;
            const body = reply.body;
            if (reply.status !== 200 || !body || String(body.id) !== intent.targetId || !validRevision(body.tags_revision) || !canonical(body)) return false;
            state.acceptDownload(body);
            return true;
        }
        function submit(input) {
            if (!input || !['tag.add', 'tag.remove'].includes(input.kind)) return { accepted: false, reason: 'unsupported', message: 'This action is not available.' };
            if (!supported(input.kind)) return { accepted: false, reason: 'unsupported', message: 'Refresh this page to use immediate tag saving.' };
            const startedAt = now();
            const targetId = String(input.targetId);
            const model = state.selectDownload(targetId);
            if (!model || model.permissions?.tags === false) return { accepted: false, reason: 'unavailable', message: 'This entry is unavailable.' };
            if (!validRevision(model.tags_revision) || model.tag_identity_version !== VDL.tagIdentity.version) return { accepted: false, reason: 'unsupported', message: 'Refresh this page before saving tags.' };
            let tag;
            try { tag = VDL.tagIdentity.normalize(input.value); }
            catch (error) { return { accepted: false, reason: 'validation', message: error.message }; }
            const queue = queues.get(targetId) || [];
            if (Array.from(intents.values()).some(intent => intent.targetId === targetId && intent.key === tag.key && intent.status === 'rejected')) return { accepted: false, reason: 'unresolved', message: 'Retry or dismiss the existing failed tag first.' };
            for (let index = queue.length - 1; index >= 0; index--) {
                const other = intents.get(queue[index]);
                if (other.key === tag.key) {
                    if (other.kind === input.kind) return { accepted: true, intentId: other.id, duplicate: true };
                    break;
                }
            }
            const isMember = model.tag_items.some(item => item.key === tag.key);
            if ((input.kind === 'tag.add') === isMember) return { accepted: true, intentId: null, settled: true };
            const unresolved = Array.from(intents.values()).filter(intent => intent.status !== 'confirmed' && intent.status !== 'resolved');
            if (unresolved.filter(intent => intent.targetId === targetId).length >= 32 || unresolved.length >= 128) return { accepted: false, reason: 'limit', message: 'Too many pending edits. Resolve existing edits before adding more.' };
            const intent = { id: `intent-${++sequence}`, kind: input.kind, targetId, key: tag.key, value: tag.name, viewToken: input.viewToken, status: 'queued', epoch };
            intents.set(intent.id, intent);
            queue.push(intent.id);
            queues.set(targetId, queue);
            state.writer.put(presentation(intent));
            emit(intent.kind, 'presented', intent, startedAt);
            dispatch(targetId);
            return { accepted: true, intentId: intent.id };
        }
        async function recover(id, recoveryOptions = {}) {
            const intent = intents.get(id);
            if (!intent || intent.status !== 'unconfirmed' || !intent.attempt) return false;
            if (recoveries.has(id)) return recoveries.get(id);
            if (recoveries.size >= 4) return false;
            const capturedEpoch = epoch;
            const work = (async () => {
                try {
                    const reply = await read({ url: `/api/mutations/${encodeURIComponent(intent.attempt.body.client_mutation_id)}`, method: 'GET' });
                    if (capturedEpoch !== epoch || !intents.has(id) || !state.isAvailable(intent.targetId)) return false;
                    if (!authorizedReply(reply, intent, true)) return false;
                    if (reply.status !== 404) {
                        finishReply(intent, reply, capturedEpoch);
                        return intent.status === 'confirmed' || intent.status === 'rejected' || intent.status === 'conflicted';
                    }
                    if (reply.body?.error !== 'Mutation unavailable' || typeof reply.body.final !== 'boolean') return false;
                    if (reply.body.final === true) intent.safeToResolve = true;
                    if (!recoveryOptions.automatic && !recoveryOptions.replay) await checkState(intent, capturedEpoch);
                    if (capturedEpoch !== epoch || !intents.has(id) || !state.isAvailable(intent.targetId)) return false;
                    const current = state.writer.confirmed(intent.targetId);
                    if (current && BigInt(current.tags_revision) > BigInt(intent.attempt.body.expected_revision)) intent.safeToResolve = true;
                    if (recoveryOptions.replay && !reply.body?.final && now() + timeOffset - Number(intent.attempt.body.client_mutation_id.split('-')[0]) <= 86400000) {
                        update(intent, { status: 'sending', message: 'Checking the original save…', delayed: false });
                        armWait(intent);
                        transmit(intent, capturedEpoch);
                    }
                    return false;
                } catch (_) { return false; }
                finally { recoveries.delete(id); }
            })();
            recoveries.set(id, work);
            return work;
        }
        function resolve(id) {
            const intent = intents.get(id);
            if (!intent || intent.status === 'sending') return false;
            if (intent.status === 'unconfirmed') {
                const current = state.writer.confirmed(intent.targetId);
                if (!intent.safeToResolve && !(current && BigInt(current.tags_revision) > BigInt(intent.attempt.body.expected_revision))) return false;
            }
            release(intent);
            state.writer.remove(id);
            intents.delete(id);
            dispatch(intent.targetId);
            return true;
        }
        function retry(id) {
            const intent = intents.get(id);
            if (!intent || !['rejected', 'conflicted'].includes(intent.status) || intent.checking) return { accepted: false, reason: 'unconfirmed' };
            const wasConflict = intent.status === 'conflicted';
            function enqueue() {
                const queue = queues.get(intent.targetId) || [];
                if (!queue.includes(id)) queue.push(id);
                queues.set(intent.targetId, queue);
                intent.attempt = null;
                intent.autoChecked = false;
                intent.delayed = false;
                update(intent, { status: 'queued', message: '' });
                dispatch(intent.targetId);
            }
            if (wasConflict) {
                intent.checking = true;
                const capturedEpoch = epoch;
                update(intent, { message: 'Checking current tags before retrying…' });
                checkState(intent, capturedEpoch).then(checked => {
                    intent.checking = false;
                    if (checked && capturedEpoch === epoch && intents.has(id)) enqueue();
                }).catch(() => {
                    intent.checking = false;
                    if (capturedEpoch === epoch && intents.has(id)) update(intent, { message: 'Could not check current tags. Try checking again.' });
                });
            } else enqueue();
            return { accepted: true, intentId: id };
        }
        return Object.freeze({
            setCapabilities, submit, recover, resolve, retry, reset, fence,
            status(id) { const intent = intents.get(id); return intent ? Object.freeze(clone(presentation(intent))) : null; },
            hasPending() { return Array.from(intents.values()).some(intent => active.has(intent.status) || intent.status === 'rejected'); },
            pending() { return Object.freeze(Array.from(intents.values(), intent => Object.freeze(clone(presentation(intent))))); },
        });
    }
    VDL.createMutations = createMutations;
})(typeof window === 'undefined' ? globalThis : window);

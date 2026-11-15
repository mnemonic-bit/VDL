(function (root) {
    'use strict';
    const VDL = root.VDL = root.VDL || {};
    const pending = intent => intent && ['queued', 'sending', 'unconfirmed'].includes(intent.status);
    const connectionState = value => value && ({ id: value.id, generation: value.generation, status: value.status, revision: value.revision });
    const display = value => ({ id: value.id, device_label: String(value.device_label || 'VDL Companion'),
        extension_version: String(value.extension_version || ''), created_at: Number(value.created_at) || null,
        last_used_at: Number(value.last_used_at) || null });
    function createExtensionConnections(options) {
        const state = VDL.createClientState();
        const now = options.now || (() => Date.now());
        const later = options.setTimeout || ((fn, delay) => root.setTimeout(fn, delay));
        const cancel = options.clearTimeout || (id => root.clearTimeout(id));
        const rows = new Map(), removed = new Set(), absent = new Set(), legacy = new Map(), checking = new Set();
        let capabilities = null, epoch = 0, listSequence = 0, message = '';
        const metrics = { submissions: 0, acknowledgements: 0, rejectedOutcomes: 0, unconfirmedOutcomes: 0,
            conflicts: 0, reconciliationReads: 0, latestLocalFeedbackMs: 0, latestAcknowledgementMs: 0 };
        const protocol = () => capabilities?.mutation_protocol === 1 && capabilities?.extension_connection_revocation === 1
            && capabilities.actions?.includes('connection.revoke');
        function notify() { options.onChange?.(); }
        function currentIntent(id) { return legacy.get(String(id)) || mutations.pending().find(intent => intent.targetId === String(id)) || null; }
        function record(event) {
            if (event.outcome === 'presented') { metrics.submissions++; metrics.latestLocalFeedbackMs = event.elapsedMs; }
            if (event.outcome === 'confirmed') { metrics.acknowledgements++; metrics.latestAcknowledgementMs = event.elapsedMs; }
            if (event.outcome === 'rejected') metrics.rejectedOutcomes++;
            if (event.outcome === 'unconfirmed') metrics.unconfirmedOutcomes++;
            if (event.outcome === 'conflicted') metrics.conflicts++;
            if (event.outcome === 'reconciliation') metrics.reconciliationReads++;
            options.onEvent?.(event);
        }
        function confirmed(id) {
            removed.add(id); rows.delete(id); ++listSequence;
            message = 'Companion connection revoked. Already accepted downloads follow their existing lifecycle.';
        }
        const mutations = VDL.createMutations({ state, now, setTimeout: later, clearTimeout: cancel,
            additionalPendingCount: options.additionalPendingCount,
            ...(options.random ? { random: options.random } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
            transport: async request => {
                const capturedEpoch = epoch;
                const reply = await options.transport(request);
                if (capturedEpoch !== epoch) return { status: 401, body: null };
                if (reply?.status === 403) { reset(); options.onAuthLoss?.(); return { status: 403, body: null }; }
                // Credentials and former device details never enter mutation records.
                const body = reply?.body;
                const sanitized = body && {
                    ...(body.connection ? { connection: connectionState(body.connection) } : {}),
                    ...(body.mutation ? { mutation: { id: body.mutation.id, domain: body.mutation.domain,
                        revision: body.mutation.revision, outcome: body.mutation.outcome } } : {}),
                    ...(typeof body.error === 'string' ? { error: body.error } : {}),
                    ...(body.code === 'mutation_limit' ? { code: body.code } : {}),
                    ...(typeof body.final === 'boolean' ? { final: body.final } : {}),
                };
                return { status: reply.status, body: sanitized };
            },
            onConnectionCurrentState: value => { if (value.absent) absent.add(value.id); else absent.delete(value.id); },
            onAuthLoss: () => { reset(); options.onAuthLoss?.(); },
            onEvent: event => {
                const intent = mutations.pending().find(value => value.id === event.intentId);
                if (event.outcome === 'confirmed' && intent) confirmed(intent.targetId);
                record(event); notify();
            },
        });
        state.subscribe(notify);
        function beginList() { return Object.freeze({ epoch, sequence: ++listSequence }); }
        function acceptList(token, values) {
            if (!token || token.epoch !== epoch || token.sequence !== listSequence || !Array.isArray(values)
                    || values.some(value => !value || typeof value.id !== 'string' || !value.id)
                    || new Set(values.map(value => value.id)).size !== values.length) return false;
            const present = new Set();
            state.writer.transaction(() => {
                for (const value of values) {
                    if (removed.has(value.id)) continue;
                    const current = connectionState(value);
                    if (protocol() && !VDL.validConnectionState(current)) continue;
                    if (protocol() && !state.acceptDownload({ id: value.id, connection: current, connection_revision: current.revision })) continue;
                    if (state.selectDownload(value.id)?.connection?.status === 'revoked') continue;
                    absent.delete(value.id);
                    rows.set(value.id, display(value)); present.add(value.id);
                }
                for (const id of rows.keys()) if (!present.has(id) && !currentIntent(id)) rows.delete(id);
            });
            notify(); return true;
        }
        function setCapabilities(value) {
            // Reusing an older snapshot must not reset its server-clock calibration.
            if (capabilities === value) return;
            capabilities = value; mutations.setCapabilities(value);
        }
        function snapshot() {
            const connections = Array.from(rows, ([id, value]) => {
                const intent = currentIntent(id);
                const canonical = state.selectDownload(id)?.connection || null;
                return Object.freeze({ ...value, connection: canonical, intent, checking: checking.has(id),
                    supported: !!protocol(), canRevoke: !intent && (!protocol() || canonical?.status === 'connected') });
            }).filter(value => !removed.has(value.id) && value.connection?.status !== 'revoked');
            return Object.freeze({ connections: Object.freeze(connections), message, supported: !!protocol() });
        }
        function revoke(id) {
            id = String(id);
            const row = rows.get(id);
            if (!row || removed.has(id) || currentIntent(id)) return { accepted: false, reason: 'unresolved' };
            message = '';
            if (protocol()) {
                const current = state.selectDownload(id)?.connection;
                const result = mutations.submit({ kind: 'connection.revoke', targetId: id, value: { generation: current?.generation } });
                if (!result.accepted) { message = result.message || 'Review this connection before revoking it.'; notify(); }
                return result;
            }
            if (legacy.size + mutations.pending().length + Math.max(0, options.additionalPendingCount?.() || 0) >= 128) {
                message = 'Too many pending edits. Resolve existing edits before revoking a connection.'; notify();
                return { accepted: false, reason: 'limit', message };
            }
            const started = now(), capturedEpoch = epoch;
            const intent = { id: `legacy-connection:${id}`, kind: 'connection.revoke', targetId: id, status: 'sending', message: '', delayed: false };
            legacy.set(id, intent); notify(); record({ action: intent.kind, outcome: 'presented', elapsedMs: now() - started });
            const current = () => capturedEpoch === epoch && legacy.get(id) === intent;
            const clear = () => (intent.timers || []).forEach(cancel);
            const unknown = () => {
                if (!current()) return;
                clear(); intent.status = 'unconfirmed'; intent.delayed = true;
                intent.message = 'Revocation not confirmed. Check the connection list. This server cannot recover the original request.';
                record({ action: intent.kind, outcome: 'unconfirmed', elapsedMs: now() - started }); notify();
            };
            intent.timers = [later(() => { if (current() && intent.status === 'sending') { intent.delayed = true; notify(); } }, 5000), later(unknown, options.timeoutMs || 30000)];
            Promise.resolve().then(async () => {
                try {
                    const reply = await options.transport({ url: `/api/extension/connections/${encodeURIComponent(id)}`, method: 'DELETE' });
                    if (!current()) return;
                    if (reply.status === 401) { reset(); options.onAuthLoss?.(); return; }
                    if (reply.status === 204) { clear(); legacy.delete(id); confirmed(id); record({ action: intent.kind, outcome: 'confirmed', elapsedMs: now() - started }); notify(); return; }
                    if ([400, 403, 409, 422, 429].includes(reply.status) && typeof reply.body?.error === 'string') {
                        clear(); intent.status = 'rejected'; intent.message = 'Revocation refused. ' + reply.body.error;
                        record({ action: intent.kind, outcome: 'rejected', elapsedMs: now() - started }); notify(); return;
                    }
                    unknown();
                } catch (_) { unknown(); }
            });
            return { accepted: true, intentId: intent.id };
        }
        async function recover(id, replay = false) {
            id = String(id);
            const intent = currentIntent(id);
            if (!intent || checking.has(id)) return false;
            if (legacy.has(id)) {
                if (replay || !options.refresh) return false;
                return options.refresh();
            }
            if (intent.status !== 'unconfirmed') return false;
            const capturedEpoch = epoch;
            checking.add(id); notify();
            try { return await mutations.recover(intent.id, { replay }); }
            finally { if (capturedEpoch === epoch) { checking.delete(id); notify(); } }
        }
        function resolve(id) {
            id = String(id);
            const intent = currentIntent(id);
            if (!intent || checking.has(id)) return false;
            if (legacy.has(id)) {
                if (intent.status !== 'rejected') return false;
                legacy.delete(id); notify(); return true;
            }
            const result = mutations.resolve(intent.id);
            if (result) {
                // A checked absence can retire presentation only after the user
                // resolves the expired attempt; it never confirms revocation.
                if (absent.delete(id)) { rows.delete(id); ++listSequence; }
                message = 'Current connection status selected. This does not confirm the original revocation.'; notify();
            }
            return result;
        }
        function reset() {
            ++epoch; ++listSequence;
            for (const value of legacy.values()) (value.timers || []).forEach(cancel);
            rows.clear(); removed.clear(); absent.clear(); legacy.clear(); checking.clear(); message = '';
            mutations.reset(); notify();
        }
        return Object.freeze({ setCapabilities, beginList, acceptList, snapshot, revoke, recover, resolve, reset,
            pendingCount: () => legacy.size + mutations.pending().length,
            hasPending: () => legacy.size > 0 || mutations.hasPending(),
            metrics() { const intents = [...legacy.values(), ...mutations.pending()]; return Object.freeze({ ...metrics,
                pending: intents.filter(pending).length, unconfirmed: intents.filter(intent => intent.status === 'unconfirmed').length,
                conflicted: intents.filter(intent => intent.status === 'conflicted').length }); },
        });
    }
    VDL.createExtensionConnections = createExtensionConnections;
})(typeof window === 'undefined' ? globalThis : window);

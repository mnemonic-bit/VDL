(function (root) {
    'use strict';
    const VDL = root.VDL = root.VDL || {};
    const codeShape = value => typeof value === 'string' && /^VDL1-[A-Za-z0-9_-]{22}$/.test(value);
    const pending = value => value && ['queued', 'sending', 'unconfirmed'].includes(value.status);
    function createExtensionPairing(options) {
        const state = VDL.createClientState();
        const now = options.now || (() => Date.now());
        const later = options.setTimeout || ((fn, delay) => root.setTimeout(fn, delay));
        const cancel = options.clearTimeout || (id => root.clearTimeout(id));
        let capabilities = null;
        let epoch = 0;
        let view = 0;
        let currentView = null;
        let candidate = null;
        let lastGeneration = null;
        let secretVisible = false;
        let visibleGeneration = null;
        let message = '';
        let legacy = null;
        let checking = false;
        let readSequence = 0;
        let checkWork = null;
        let legacyTimers = [];
        const readTimers = new Set();
        const metrics = { submissions: 0, acknowledgements: 0, rejectedOutcomes: 0,
            unconfirmedOutcomes: 0, conflicts: 0, reconciliationReads: 0,
            latestLocalFeedbackMs: 0, latestAcknowledgementMs: 0, pending: 0, unconfirmed: 0, conflicted: 0 };
        const protocol = () => capabilities?.mutation_protocol === 1 && capabilities?.extension_pairing === 1
            && ['pairing.create', 'pairing.invalidate'].every(action => capabilities.actions?.includes(action));
        function notify() { if (options.onChange) options.onChange(); }
        function clearSecret() {
            candidate = null; secretVisible = false; visibleGeneration = null;
            if (options.onClearSecret) options.onClearSecret();
        }
        function clearLegacyTimers() { legacyTimers.forEach(cancel); legacyTimers = []; }
        function currentIntent() { return legacy || mutations.pending().find(intent => intent.status !== 'confirmed') || null; }
        function snapshot() {
            const intent = currentIntent();
            return Object.freeze({ pairing: state.selectDownload('pairing')?.pairing || null,
                intent, message, checking, supported: protocol(), ready: !protocol() || state.isAvailable('pairing'),
                hasSecret: secretVisible, recoveryGeneration: lastGeneration,
                canCreate: !intent && !checking && !(lastGeneration && !secretVisible) && (!protocol() || state.isAvailable('pairing')),
                canInvalidate: !intent && !checking && (protocol() ? !!(lastGeneration || state.selectDownload('pairing')?.pairing?.generation) : secretVisible),
            });
        }
        function recordMetrics(event) {
            if (event.outcome === 'presented') metrics.submissions++;
            if (event.outcome === 'confirmed') { metrics.acknowledgements++; metrics.latestAcknowledgementMs = event.elapsedMs; }
            if (event.outcome === 'rejected') metrics.rejectedOutcomes++;
            if (event.outcome === 'unconfirmed') metrics.unconfirmedOutcomes++;
            if (event.outcome === 'conflicted') metrics.conflicts++;
            if (event.outcome === 'reconciliation') metrics.reconciliationReads++;
            if (options.onEvent) options.onEvent(event);
        }
        function presentCandidate() {
            const result = candidate;
            candidate = null;
            const pairing = state.selectDownload('pairing')?.pairing;
            if (!result || result.epoch !== epoch || result.view !== currentView || result.view !== view
                    || !codeShape(result.code) || result.expires_at <= now() / 1000
                    || protocol() && (pairing?.status !== 'available' || pairing.generation !== result.generation)) return false;
            secretVisible = true; visibleGeneration = result.generation || null;
            if (options.onSecret) options.onSecret({ code: result.code, expires_at: result.expires_at });
            return true;
        }
        const mutations = VDL.createMutations({
            state, now, additionalPendingCount: options.additionalPendingCount, setTimeout: later, clearTimeout: cancel,
            ...(options.random ? { random: options.random } : {}),
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
            transport: async request => {
                const capturedEpoch = epoch;
                const capturedView = currentView;
                const capturedIntentId = currentIntent()?.id;
                const reply = await options.transport(request);
                if (capturedEpoch !== epoch) return { status: 401, body: null };
                if (reply?.status === 403) { reset(); if (options.onAuthLoss) options.onAuthLoss(); return { status: 403, body: null }; }
                const body = reply?.body;
                if (request.method !== 'GET' && request.url === '/api/extension/pairing-codes'
                        && capturedView !== null && capturedView === currentView && capturedView === view
                        && currentIntent()?.id === capturedIntentId && currentIntent()?.kind === 'pairing.create' && pending(currentIntent())
                        && reply.status >= 200 && reply.status < 300 && body?.mutation?.id === request.body.client_mutation_id
                        && body.mutation.outcome === 'committed' && body.mutation.domain === 'extension-pairing'
                        && typeof body.mutation.revision === 'string' && /^(0|[1-9]\d*)$/.test(body.mutation.revision)
                        && codeShape(body.code)
                        && VDL.validPairingState(body.pairing) && BigInt(body.pairing.revision) >= BigInt(body.mutation.revision)
                        && body.pairing.status === 'available' && body.pairing.generation === body.created_generation) {
                    candidate = { code: body.code, expires_at: body.pairing.expires_at,
                        generation: body.created_generation, epoch: capturedEpoch, view: capturedView };
                }
                // The shared coordinator sees only this allowlisted, non-secret envelope.
                const sanitized = body && {
                    ...(body.pairing ? { pairing: { generation: body.pairing.generation, status: body.pairing.status,
                        expires_at: body.pairing.expires_at, revision: body.pairing.revision } } : {}),
                    ...(body.mutation ? { mutation: { id: body.mutation.id, domain: body.mutation.domain,
                        revision: body.mutation.revision, outcome: body.mutation.outcome } } : {}),
                    ...(typeof body.created_generation === 'string' ? { created_generation: body.created_generation } : {}),
                    ...(typeof body.error === 'string' ? { error: body.error } : {}),
                    ...(body.code === 'mutation_limit' ? { code: 'mutation_limit' } : {}),
                    ...(typeof body.final === 'boolean' ? { final: body.final } : {}),
                };
                if (capturedIntentId && currentIntent()?.id === capturedIntentId && pending(currentIntent())
                        && typeof sanitized?.created_generation === 'string' && VDL.validPairingState(sanitized.pairing)
                        && sanitized.pairing.status === 'available' && sanitized.pairing.generation === sanitized.created_generation
                        && BigInt(sanitized.pairing.revision) >= BigInt(state.selectDownload('pairing')?.pairing_revision || '0')
                        && sanitized.mutation?.domain === 'extension-pairing' && sanitized.mutation.outcome === 'committed'
                        && sanitized.mutation.id === (request.body?.client_mutation_id || decodeURIComponent(request.url.split('/').pop()))) lastGeneration = sanitized.created_generation;
                return { status: reply.status, body: sanitized };
            },
            onAuthLoss: () => { reset(); if (options.onAuthLoss) options.onAuthLoss(); },
            onEvent: event => {
                recordMetrics(event);
                if (event.outcome === 'confirmed') {
                    if (event.action === 'pairing.create') {
                        const shown = presentCandidate();
                        message = shown ? 'Pairing string created. Copy it to continue in VDL Companion.'
                            : 'Pairing creation confirmed. The code cannot be recovered. Invalidate this generation before deliberately creating another.';
                    } else {
                        clearSecret(); lastGeneration = null;
                        const current = state.selectDownload('pairing')?.pairing;
                        message = current?.status === 'available'
                            ? 'Pairing invalidation confirmed. A different pairing remains available.' : 'Pairing string invalidated.';
                    }
                } else if (event.outcome === 'rejected' || event.outcome === 'conflicted' || event.outcome === 'unconfirmed') candidate = null;
                notify();
            },
        });
        state.subscribe(() => {
            const pairing = state.selectDownload('pairing')?.pairing;
            if (secretVisible && (pairing?.status !== 'available' || pairing.generation !== visibleGeneration)) clearSecret();
            if (lastGeneration && pairing && (pairing.generation !== lastGeneration || pairing.status !== 'available')) lastGeneration = null;
            notify();
        });
        function setCapabilities(value) {
            capabilities = value; mutations.setCapabilities(value); notify();
        }
        async function refresh() {
            if (!protocol()) { notify(); return false; }
            if (checkWork) return checkWork;
            const capturedEpoch = epoch;
            const sequence = ++readSequence;
            checking = true; notify(); recordMetrics({ action: 'pairing.status', outcome: 'reconciliation', elapsedMs: 0 });
            checkWork = (async () => {
                let timer;
                try {
                    const reply = await Promise.race([
                        options.transport({ url: '/api/extension/pairing-codes/current', method: 'GET' }),
                        new Promise((_, reject) => { timer = later(() => reject(new Error('Pairing status check timed out')), options.timeoutMs || 30000); readTimers.add(timer); }),
                    ]);
                    if (capturedEpoch !== epoch || sequence !== readSequence) return false;
                    if ([401, 403].includes(reply.status)) { reset(); if (options.onAuthLoss) options.onAuthLoss(); return false; }
                    if (reply.status !== 200 || !VDL.validPairingState(reply.body?.pairing)) return false;
                    const pairing = reply.body.pairing;
                    const result = state.acceptDownload({ id: 'pairing', pairing_revision: pairing.revision, pairing });
                    const accepted = state.selectDownload('pairing')?.pairing;
                    if (secretVisible && (accepted?.status !== 'available' || accepted.generation !== visibleGeneration)) clearSecret();
                    return result;
                } catch (_) {
                    if (capturedEpoch === epoch && sequence === readSequence) message = 'Could not check pairing status. Check again before creating another code.';
                    return false;
                }
                finally {
                    if (timer !== undefined) { cancel(timer); readTimers.delete(timer); }
                    if (capturedEpoch === epoch && sequence === readSequence) { checking = false; checkWork = null; notify(); }
                }
            })();
            return checkWork;
        }
        function beginView() { clearSecret(); currentView = ++view; return currentView; }
        function close() {
            ++view; currentView = null;
            if (secretVisible) message = 'Pairing creation confirmed. The code cannot be recovered. Invalidate this generation before deliberately creating another.';
            clearSecret(); notify();
        }
        function submit(kind, value) {
            if (currentIntent() || checking || kind === 'pairing.create' && lastGeneration && !secretVisible) return { accepted: false, reason: 'unresolved' };
            if ((options.additionalPendingCount?.() || 0) >= 128) {
                message = 'Too many pending edits. Resolve existing edits before creating a pairing request.'; notify();
                return { accepted: false, reason: 'limit', message };
            }
            const started = now();
            message = '';
            if (kind === 'pairing.create') beginView();
            if (protocol()) {
                const result = mutations.submit({ kind, targetId: 'pairing', value, viewToken: currentView });
                if (!result.accepted) message = result.message;
                metrics.latestLocalFeedbackMs = Math.max(0, now() - started); notify();
                return result;
            }
            const record = { kind, status: 'sending', delayed: false, message: '', viewToken: currentView };
            legacy = record; notify(); recordEvent('presented');
            const capturedEpoch = epoch;
            const capturedView = currentView;
            const current = () => epoch === capturedEpoch && legacy === record;
            function recordEvent(outcome) { recordMetrics({ action: kind, outcome, elapsedMs: Math.max(0, now() - started) }); }
            function unknown() {
                if (!current()) return;
                clearLegacyTimers(); record.status = 'unconfirmed'; record.delayed = true;
                record.message = kind === 'pairing.create' ? 'Pairing request not confirmed. This server cannot recover the request. No new code has been requested.'
                    : 'Pairing invalidation not confirmed. The code may still be usable. This server cannot recover the request.';
                recordEvent('unconfirmed'); notify();
            }
            legacyTimers = [later(() => { if (current() && record.status === 'sending') { record.delayed = true; record.message = 'Still waiting for pairing confirmation. Closing this dialog does not cancel the request.'; notify(); } }, 5000),
                later(unknown, options.timeoutMs || 30000)];
            Promise.resolve().then(async () => {
                try {
                    const reply = await options.transport({ url: kind === 'pairing.create' ? '/api/extension/pairing-codes' : '/api/extension/pairing-codes/current', method: kind === 'pairing.create' ? 'POST' : 'DELETE' });
                    if (!current()) return;
                    if ([401, 403].includes(reply.status)) { reset(); if (options.onAuthLoss) options.onAuthLoss(); return; }
                    if (reply.status >= 200 && reply.status < 300 && (kind !== 'pairing.create' || codeShape(reply.body?.code) && Number.isSafeInteger(reply.body.expires_at) && reply.body.expires_at > now() / 1000)) {
                        clearLegacyTimers(); legacy = null;
                        if (kind === 'pairing.create') {
                            candidate = { code: reply.body.code, expires_at: reply.body.expires_at, epoch: capturedEpoch, view: capturedView };
                            message = presentCandidate() ? 'Pairing string created. Copy it to continue in VDL Companion.' : 'Pairing creation confirmed. The code was discarded when the pairing view closed.';
                        } else { clearSecret(); message = 'Pairing string invalidated.'; }
                        recordEvent('confirmed'); notify(); return;
                    }
                    if ([400, 409, 422, 429].includes(reply.status) && typeof reply.body?.error === 'string') {
                        clearLegacyTimers(); record.status = 'rejected'; record.message = 'Pairing request refused. ' + reply.body.error;
                        recordEvent('rejected'); notify(); return;
                    }
                    unknown();
                } catch (_) { unknown(); }
            });
            metrics.latestLocalFeedbackMs = Math.max(0, now() - started);
            return { accepted: true };
        }
        async function recover(replay = false) {
            const intent = currentIntent();
            if (!intent) return refresh();
            if (legacy || intent.status !== 'unconfirmed' || checking) return false;
            const capturedEpoch = epoch;
            checking = true; notify();
            try { return await mutations.recover(intent.id, { replay }); }
            finally { if (capturedEpoch === epoch) { checking = false; notify(); } }
        }
        function resolve() {
            const intent = currentIntent();
            if (!intent || pending(intent) && intent.status !== 'unconfirmed') return false;
            if (legacy) { if (intent.status !== 'rejected') return false; legacy = null; notify(); return true; }
            const resolved = mutations.resolve(intent.id);
            if (resolved) {
                const pairing = state.selectDownload('pairing')?.pairing;
                if (intent.kind === 'pairing.create' && intent.status === 'unconfirmed' && pairing?.status === 'available' && !secretVisible) {
                    lastGeneration = pairing.generation;
                    message = 'Current pairing state selected. The code cannot be recovered. Invalidate this generation before deliberately creating another.';
                } else message = 'Current pairing state selected. Review it before submitting another request.';
                notify();
            }
            return resolved;
        }
        function reset() {
            epoch++; ++view; ++readSequence; currentView = null;
            clearSecret(); clearLegacyTimers(); readTimers.forEach(cancel); readTimers.clear(); legacy = null; lastGeneration = null;
            message = ''; checking = false; checkWork = null; mutations.reset(); notify();
        }
        return Object.freeze({ setCapabilities, refresh, close, reset, snapshot, recover, resolve,
            create() { return submit('pairing.create', {}); },
            invalidate() { const generation = lastGeneration || state.selectDownload('pairing')?.pairing?.generation; return protocol() && !generation ? { accepted: false, reason: 'unavailable' } : submit('pairing.invalidate', protocol() ? { generation } : {}); },
            expire() { close(); message = ''; notify(); return protocol() ? refresh() : Promise.resolve(false); },
            pendingCount() { return currentIntent() ? 1 : 0; },
            hasPending() { return !!currentIntent(); },
            metrics() { const intent = currentIntent(); return Object.freeze({ ...metrics,
                pending: pending(intent) ? 1 : 0, unconfirmed: intent?.status === 'unconfirmed' ? 1 : 0, conflicted: intent?.status === 'conflicted' ? 1 : 0 }); },
        });
    }
    VDL.createExtensionPairing = createExtensionPairing;
})(typeof window === 'undefined' ? globalThis : window);

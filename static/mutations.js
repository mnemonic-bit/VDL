(function (root) {
    'use strict';
    const VDL = root.VDL = root.VDL || {};
    const active = new Set(['queued', 'sending', 'unconfirmed', 'conflicted']);
    const validRevision = value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
    const playlistAction = kind => kind.startsWith('playlist.');
    const submissionAction = kind => kind === 'download.submit';
    const commandAction = kind => kind.startsWith('download.') && !submissionAction(kind);
    const validActionRevision = (intent, value) => playlistAction(intent.kind) ? Number.isSafeInteger(value) && value >= 0 : validRevision(value);
    const playlistValues = value => !!value && typeof value.name === 'string' && Array.isArray(value.download_ids) && value.download_ids.every(id => typeof id === 'string' && !!id) && new Set(value.download_ids).size === value.download_ids.length && Object.keys(value).every(key => ['name', 'download_ids', 'download_id'].includes(key));
    const utf8Bytes = value => Array.from(value).reduce((size, character) => size + (character.codePointAt(0) > 65535 ? 4 : character.codePointAt(0) > 2047 ? 3 : character.codePointAt(0) > 127 ? 2 : 1), 0);
    const clone = value => JSON.parse(JSON.stringify(value));
    function immutable(value) {
        if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); }
        return value;
    }
    const equalPreferences = (left, right) => VDL.preferenceFields.every(key => left[key] === right[key]);
    // Only these descriptors can select a domain or encode a mutation route.
    const actions = Object.freeze({
        'download.submit': Object.freeze({ domain: 'download-submission', revision: 'submission_revision', noun: 'download request', method: 'POST', route: 'download' }),
        ...Object.fromEntries(['pause', 'unpause', 'stop', 'retry', 'resume'].map(action => [`download.${action}`, Object.freeze({ domain: 'download-command', revision: 'command_revision', noun: 'download request', method: 'POST', route: action })])),
        'playlist.create': Object.freeze({ domain: 'playlist', revision: 'playlist_revision', noun: 'playlist', method: 'POST' }),
        'playlist.add': Object.freeze({ domain: 'playlist', revision: 'playlist_revision', noun: 'playlist add', method: 'POST' }),
        'playlist.delete': Object.freeze({ domain: 'playlist', revision: 'playlist_revision', noun: 'playlist deletion', method: 'DELETE' }),
        'playlist.replace': Object.freeze({ domain: 'playlist', revision: 'playlist_revision', noun: 'playlist', method: 'PUT' }),
        'tag.add': Object.freeze({ domain: 'tags', revision: 'tags_revision', noun: 'tags', method: 'POST', route: 'tags', field: 'tag' }),
        'tag.remove': Object.freeze({ domain: 'tags', revision: 'tags_revision', noun: 'tags', method: 'DELETE', route: 'tags', field: 'tag' }),
        'rename.set': Object.freeze({ domain: 'rename', revision: 'rename_revision', noun: 'rename', method: 'POST', route: 'rename', field: 'filename' }),
        'favorite.set': Object.freeze({ domain: 'favorite', revision: 'favorite_revision', noun: 'favorite', method: 'POST', route: 'favorite', field: 'favorite' }),
        'preference.set': Object.freeze({ domain: 'preferences', revision: 'preferences_revision', noun: 'settings', method: 'POST', route: 'preferences', field: 'values' }),
    });
    const descriptor = intent => actions[intent.kind];
    const queueKey = intent => JSON.stringify([intent.targetId, descriptor(intent).domain]);
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
            return !!actions[kind] && capabilities?.mutation_protocol === 1 && (!kind.startsWith('tag.') || capabilities.tag_identity_version === VDL.tagIdentity.version) && capabilities.actions?.includes(kind);
        }
        function emit(action, outcome, intent, startedAt) {
            if (!options.onEvent) return;
            const counts = { pending: 0, unconfirmed: 0, conflicted: 0 };
            for (const entry of intents.values()) {
                if (active.has(entry.status)) counts.pending++;
                if (entry.status === 'unconfirmed') counts.unconfirmed++;
                if (entry.status === 'conflicted') counts.conflicted++;
            }
            try { options.onEvent(Object.freeze({ action, outcome, intentId: intent?.id, elapsedMs: Math.max(0, now() - startedAt), ...(playlistAction(intent?.kind || '') && Number.isSafeInteger(intent.acknowledgedRevision) ? { revision: intent.acknowledgedRevision } : {}), ...counts })); }
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
                ...(intent.acceptedJob ? { acceptedJob: intent.acceptedJob } : {}),
                ...(intent.fieldErrors ? { fieldErrors: intent.fieldErrors } : {}),
            };
        }
        function clearTimers(intent) {
            const ids = timers.get(intent.id) || [];
            ids.forEach(cancel);
            timers.delete(intent.id);
        }
        function release(intent) {
            clearTimers(intent);
            const queue = queues.get(queueKey(intent)) || [];
            const index = queue.indexOf(intent.id);
            if (index !== -1) queue.splice(index, 1);
            if (!queue.length) queues.delete(queueKey(intent));
        }
        function reset() {
            epoch++;
            for (const ids of timers.values()) ids.forEach(cancel);
            timers.clear(); intents.clear(); queues.clear(); recoveries.clear();
            state.reset();
        }
        function fence(targetId) {
            targetId = String(targetId);
            const targets = new Set([targetId]);
            for (const [id, intent] of intents) {
                if (intent.targetId === targetId || intent.acceptedJob?.download_id === targetId || state.writer.confirmed(intent.targetId)?.submission?.id === targetId) {
                    targets.add(intent.targetId);
                    clearTimers(intent);
                    intents.delete(id);
                }
            }
            for (const [key, queue] of queues) if (!queue.some(id => intents.has(id))) queues.delete(key);
            state.writer.transaction(() => targets.forEach(id => state.writer.fence(id)));
        }
        function authorizedReply(reply, intent, receipt = false) {
            if (reply.status === 401) {
                reset();
                if (options.onAuthLoss) options.onAuthLoss();
                return false;
            }
            if (reply.status === 403 || (reply.status === 404 && (['Unknown download id', 'Unknown playlist'].includes(reply.body?.error) || !receipt && submissionAction(intent.kind) && reply.body?.error === 'Download request unavailable'))) {
                fence(intent.targetId);
                return false;
            }
            return true;
        }
        function snapshot(body, intent) {
            if (submissionAction(intent.kind)) return { id: intent.targetId, submission_revision: body.submission_revision, submission: body.job ? { id: body.id, job: body.job } : null };
            if (commandAction(intent.kind)) return { id: intent.targetId, command_revision: body.command_revision, current_attempt_id: body.current_attempt_id,
                ...(Object.hasOwn(body, 'job_id') ? { job_id: body.job_id } : {}),
                ...(['download.retry', 'download.resume'].includes(intent.kind) && body.command ? { job_id: body.command.job_id } : {}) };

            if (playlistAction(intent.kind)) return { id: intent.targetId, playlist: body, playlist_revision: body.revision };
            if (intent.kind === 'preference.set') return { id: intent.targetId, values: body.values, preferences_revision: body.preferences_revision };
            if (intent.kind === 'rename.set') return { id: intent.targetId, filename: body.filename, display_filename: body.display_filename, rename_revision: body.rename_revision };
            if (intent.kind === 'favorite.set') return { id: intent.targetId, favorite: body.favorite, favorite_revision: body.mutation?.revision ?? body.favorite_revision };
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
            if (submissionAction(intent.kind)) {
                const job = body?.job;
                const identity = value => typeof value === 'string' && !!value;
                const known = state.writer.confirmed(intent.targetId)?.submission;
                return !!mutation && mutation.id === intent.attempt.body.client_mutation_id
                    && mutation.domain === 'download-submission' && mutation.revision === body.submission_revision
                    && (committed ? mutation.outcome === 'accepted' && body.submission_revision === '1'
                        && identity(body.id) && identity(body.current_attempt_id) && !!job && identity(job.id)
                        && job.download_id === body.id && job.attempt_id === body.current_attempt_id
                        && ['accepted', 'dispatching', 'dispatched', 'interrupted', 'finished', 'error', 'cancelled', 'superseded'].includes(job.status)
                        && (!known || known.id === body.id && known.job.id === job.id && known.job.attempt_id === job.attempt_id)
                        : mutation.outcome === 'rejected' && body.submission_revision === '0' && body.id === null && job === null);
            }
            if (commandAction(intent.kind)) {
                const attemptId = value => value === null || typeof value === 'string' && !!value;
                const command = body?.command;
                return !!mutation && mutation.id === intent.attempt.body.client_mutation_id
                    && mutation.domain === 'download-command' && body.id === intent.targetId
                    && validRevision(body.command_revision) && mutation.revision === body.command_revision
                    && attemptId(body.current_attempt_id) && (!Object.hasOwn(body, 'job_id') || attemptId(body.job_id))
                    && (committed ? mutation.outcome === 'accepted' && !!command && typeof command.id === 'string' && !!command.id
                        && command.action === intent.kind && command.source_attempt_id === intent.attempt.body.expected_attempt_id
                        && attemptId(command.attempt_id) && body.current_attempt_id === command.attempt_id
                        && (['download.retry', 'download.resume'].includes(intent.kind) ? command.job_id === command.id && typeof command.attempt_id === 'string' && !!command.attempt_id && command.attempt_id !== command.source_attempt_id : command.job_id === null && command.attempt_id === command.source_attempt_id)
                        && ['accepted', 'dispatching', 'dispatched', 'interrupted', 'finished', 'error', 'cancelled', 'superseded'].includes(command.status)
                        && (!['download.retry', 'download.resume'].includes(intent.kind) || !Object.hasOwn(body, 'job_id') || body.job_id === command.job_id)
                        && BigInt(body.command_revision) > BigInt(intent.attempt.body.expected_revision)
                        : ['rejected', 'conflicted'].includes(mutation.outcome));
            }
            if (intent.kind === 'playlist.delete' && committed) {
                return !!mutation && mutation.id === intent.attempt.body.client_mutation_id && mutation.domain === 'playlist'
                    && body.id === intent.targetId.slice(9) && body.removed === true && body.membership_invalidated === true
                    && Number.isSafeInteger(body.revision) && body.revision === intent.attempt.body.expected_revision + 1 && mutation.revision === body.revision && mutation.outcome === 'committed';
            }
            if (playlistAction(intent.kind)) {
                const addMembers = intent.kind === 'playlist.add' && intent.basePlaylist ? intent.basePlaylist.items.map(item => item.id).concat(body?.changed ? [intent.value.download_id] : []) : [];
                return !!mutation && mutation.id === intent.attempt.body.client_mutation_id && mutation.domain === 'playlist'
                    && Number.isSafeInteger(body.revision) && body.revision >= (committed ? 1 : 0) && mutation.revision === body.revision
                    && (intent.kind === 'playlist.create' ? committed ? typeof body.id === 'string' && !!body.id : body.id === null || typeof body.id === 'string' : body.id === intent.targetId.slice(9))
                    && typeof body.name === 'string' && Array.isArray(body.items)
                    && Number.isSafeInteger(body.item_count) && body.item_count === body.items.length
                    && Array.isArray(body.member_ids) && body.member_ids.length === body.items.length && body.member_ids.every((id, index) => id === body.items[index]?.id)
                    && Array.isArray(body.mosaic_ids) && body.mosaic_ids.length <= 4 && body.mosaic_ids.every(id => typeof id === 'string')
                    && body.items.every((item, index) => item && item.position === index && typeof item.title === 'string' && (item.id === null ? item.unavailable === true : typeof item.id === 'string' && !!item.id))
                    && new Set(body.items.filter(item => item.id !== null).map(item => item.id)).size === body.items.filter(item => item.id !== null).length
                    && body.mosaic_ids.every(id => body.items.some(item => item.id === id))
                    && (committed ? mutation.outcome === 'committed'
                        && (intent.kind === 'playlist.add' ? typeof body.changed === 'boolean' && body.revision === intent.attempt.body.expected_revision + (body.changed ? 1 : 0) && body.name === intent.basePlaylist.name && body.items.length === addMembers.length && body.items.every((item, index) => item.id === null || addMembers[index] === null || item.id === addMembers[index]) && (body.changed || addMembers.some(id => id === intent.value.download_id || id === null))
                            : body.name === intent.value.name.normalize('NFC').trim()
                                && body.items.length === intent.value.download_ids.length
                                && body.items.every((item, index) => item.id === null || item.id === intent.value.download_ids[index]))
                        && (intent.kind !== 'playlist.replace' || body.revision > intent.attempt.body.expected_revision)
                        : ['rejected', 'conflicted'].includes(mutation.outcome));
            }
            if (intent.kind === 'preference.set') {
                return !!mutation && mutation.id === intent.attempt.body.client_mutation_id
                    && mutation.domain === 'preferences' && body.id === 'installation'
                    && validRevision(mutation.revision) && body.preferences_revision === mutation.revision
                    && VDL.validPreferenceValues(body.values)
                    && (committed ? mutation.outcome === 'committed' : ['rejected', 'conflicted'].includes(mutation.outcome));
            }
            if (intent.kind === 'rename.set') {
                return !!mutation && mutation.id === intent.attempt.body.client_mutation_id
                    && mutation.domain === 'rename' && String(body.id) === intent.targetId
                    && validRevision(mutation.revision) && body.rename_revision === mutation.revision
                    && (committed ? typeof body.filename === 'string' && !!body.filename : body.filename === null || typeof body.filename === 'string')
                    && (body.display_filename === null || typeof body.display_filename === 'string')
                    && (committed ? mutation.outcome === 'committed' : ['rejected', 'conflicted'].includes(mutation.outcome));
            }
            if (intent.kind === 'favorite.set') {
                return !!mutation && mutation.id === intent.attempt.body.client_mutation_id
                    && mutation.domain === 'favorite' && String(body.id) === intent.targetId
                    && validRevision(mutation.revision) && body.favorite_revision === mutation.revision
                    && typeof body.favorite === 'boolean'
                    && (committed ? mutation.outcome === 'committed' && body.favorite === intent.value : ['rejected', 'conflicted'].includes(mutation.outcome));
            }
            if (!mutation || mutation.id !== intent.attempt.body.client_mutation_id || mutation.domain !== 'tags' || String(body.id) !== intent.targetId || !validRevision(mutation.revision) || (body.tags_revision !== undefined && body.tags_revision !== mutation.revision) || !canonical(body)) return false;
            if (!committed) return ['rejected', 'conflicted'].includes(mutation.outcome);
            try {
                const attached = body.tag_items.some(tag => tag.key === intent.key);
                return mutation.outcome === 'committed' && attached === (intent.kind === 'tag.add') && body.submitted_tag && typeof body.submitted_tag.name === 'string' && body.submitted_tag.key === intent.key && VDL.tagIdentity.normalize(body.submitted_tag.name).key === intent.key;
            } catch (_) { return false; }
        }
        function finishReply(intent, reply, capturedEpoch) {
            if (capturedEpoch !== epoch || !intents.has(intent.id) || !state.isAvailable(intent.targetId) || !['sending', 'unconfirmed'].includes(intent.status)) return;
            if (!reply || typeof reply.status !== 'number') { markUnknown(intent); return; }
            if (!authorizedReply(reply, intent)) return;
            const body = reply.body;
            if (intent.kind === 'rename.set' && reply.status === 503 && body?.code === 'rename_recovery_required') {
                markUnknown(intent);
                update(intent, { message: 'Rename not confirmed. File recovery needs intervention. Check again after the file state is repaired.' });
                return;
            }
            if (reply.status >= 200 && reply.status < 300 && validResult(body, intent, true)) {
                if (submissionAction(intent.kind) && state.isFenced(body.id)) { fence(intent.targetId); return; }
                const before = state.writer.confirmed(intent.targetId);
                const newerRemote = before && BigInt(before[descriptor(intent).revision]) > BigInt(body.mutation.revision);
                if (submissionAction(intent.kind)) intent.acceptedJob = immutable(clone(body.job));
                state.writer.transaction(() => {
                    if (intent.kind === 'playlist.delete') {
                        release(intent);
                        intent.status = 'confirmed';
                        state.writer.fence(intent.targetId);
                        return;
                    }
                    const merged = state.acceptDownload(snapshot(body, intent));
                    const confirmed = state.writer.confirmed(intent.targetId);
                    if (!merged && confirmed?.[descriptor(intent).revision] === body.mutation.revision) {
                        markUnknown(intent);
                        return;
                    }
                    release(intent);
                    intent.status = 'confirmed';
                    state.writer.remove(intent.id);
                });
                if (intent.status === 'confirmed') {
                    if (playlistAction(intent.kind)) intent.acknowledgedRevision = body.revision;
                    emit(intent.kind, 'confirmed', intent, intent.sentAt);
                    if (newerRemote && !commandAction(intent.kind) && options.onNotice) {
                        try { options.onNotice(Object.freeze({ targetId: intent.targetId, message: `Your save was confirmed. Newer ${descriptor(intent).noun} changes are now shown.` })); }
                        catch (_) { /* A view notification cannot undo a committed save. */ }
                    }
                    intents.delete(intent.id);
                    dispatch(queueKey(intent), intent.targetId);
                }
                return;
            }
            if (validResult(body, intent, false)) {
                clearTimers(intent);
                const status = body.mutation.outcome;
                state.writer.transaction(() => {
                    state.acceptDownload(snapshot(body, intent));
                    const fieldErrors = playlistAction(intent.kind) && body.field_errors && typeof body.field_errors === 'object'
                        ? Object.fromEntries(Object.entries(body.field_errors).filter(([key, value]) => ['name', 'download_ids', 'download_id'].includes(key) && typeof value === 'string')) : intent.kind === 'preference.set' && body.field_errors && typeof body.field_errors === 'object'
                        ? Object.fromEntries(Object.entries(body.field_errors).filter(([key, value]) => VDL.preferenceFields.includes(key) && typeof value === 'string')) : undefined;
                    update(intent, { status, fieldErrors, message: submissionAction(intent.kind) ? `Download request refused. ${typeof body.error === 'string' ? body.error : 'Review the retained input before submitting again.'}` : commandAction(intent.kind) ? `${status === 'conflicted' ? 'Download changed. Review its current attempt before submitting another command.' : 'Request refused. ' + (typeof body.error === 'string' ? body.error : 'Review the current eligibility before trying again.')}` : playlistAction(intent.kind) ? status === 'conflicted' ? 'Playlist changed elsewhere. Review the current version before submitting a new request.' : `Could not ${intent.kind === 'playlist.add' ? 'add to' : intent.kind === 'playlist.delete' ? 'delete' : 'save'} playlist. ${typeof body.error === 'string' ? body.error : 'Review the current state before submitting again.'}` : intent.kind === 'preference.set'
                        ? status === 'conflicted' ? 'Settings changed elsewhere. Review the current values, then save your draft explicitly.'
                            : `Could not save settings. ${typeof body.error === 'string' ? body.error : 'Correct the retained draft and save again.'}`
                        : status === 'conflicted' ? `${descriptor(intent).noun} changed elsewhere. Check the current state, then retry or dismiss.` : intent.kind === 'rename.set' ? `Could not rename. ${typeof body.error === 'string' ? body.error : 'Correct the name or retry.'}` : `Could not save ${descriptor(intent).noun}. Retry or dismiss it.` });
                });
                emit(intent.kind, status, intent, intent.sentAt);
                if (status === 'rejected') {
                    release(intent);
                    dispatch(queueKey(intent), intent.targetId);
                }
                return;
            }
            markUnknown(intent);
        }
        function markUnknown(intent) {
            clearTimers(intent);
            update(intent, { status: 'unconfirmed', message: submissionAction(intent.kind) ? 'Download request not confirmed. Check its status before recovering the original request.' : commandAction(intent.kind) ? 'Request not confirmed. Check its status before replaying.' : intent.kind === 'playlist.add' ? 'Add not confirmed. Check its status before replaying.' : intent.kind === 'playlist.delete' ? 'Delete not confirmed. Check its status before replaying.' : intent.kind === 'rename.set' ? 'Rename not confirmed. Check its status before replaying.' : 'Save not confirmed. Check its status before retrying.', delayed: true });
            emit(intent.kind, 'unconfirmed', intent, intent.sentAt);
        }
        async function transmit(intent, capturedEpoch) {
            const attempt = intent.attempt;
            try {
                const reply = await transport(clone(attempt));
                if (intent.attempt !== attempt) return;
                finishReply(intent, reply, capturedEpoch);
            } catch (_) {
                if (capturedEpoch === epoch && intent.attempt === attempt && intents.has(intent.id) && state.isAvailable(intent.targetId) && ['sending', 'unconfirmed'].includes(intent.status)) markUnknown(intent);
            }
            if (capturedEpoch === epoch && intent.status === 'unconfirmed' && !intent.autoChecked) {
                intent.autoChecked = true;
                recover(intent.id, { automatic: true });
            }
        }
        function dispatch(domainKey, targetId) {
            const queue = queues.get(domainKey);
            if (!queue?.length || !state.isAvailable(targetId)) return;
            const intent = intents.get(queue[0]);
            if (!intent || intent.status !== 'queued') return;
            const confirmed = state.writer.confirmed(targetId);
            if (!validActionRevision(intent, confirmed?.[descriptor(intent).revision])) return;
            if (commandAction(intent.kind) && confirmed.current_attempt_id !== intent.value.attempt_id) {
                update(intent, { status: 'conflicted', message: 'Download changed. Review its current attempt before submitting another command.' });
                emit(intent.kind, 'conflicted', intent, now());
                return;
            }
            const mutationId = `${Math.trunc(now() + timeOffset)}-${random()}`;
            if (!/^\d+-[a-f0-9]{32}$/.test(mutationId)) throw new Error('Invalid mutation identifier source');
            if (intent.kind === 'playlist.add') intent.basePlaylist = clone(confirmed.playlist);
            intent.attempt = Object.freeze({
                url: submissionAction(intent.kind) ? '/api/download' : playlistAction(intent.kind) ? intent.kind === 'playlist.create' ? '/api/playlists' : `/api/playlists/${encodeURIComponent(targetId.slice(9))}${intent.kind === 'playlist.add' ? '/items' : ''}` : intent.kind === 'preference.set' ? '/api/preferences' : `/api/${descriptor(intent).route}/${encodeURIComponent(targetId)}`,
                method: descriptor(intent).method,
                body: immutable(submissionAction(intent.kind) ? { ...intent.value, client_mutation_id: mutationId } : commandAction(intent.kind) ? { client_mutation_id: mutationId, expected_revision: confirmed.command_revision, expected_attempt_id: intent.value.attempt_id } : playlistAction(intent.kind) ? { ...intent.value, client_mutation_id: mutationId, ...(intent.kind === 'playlist.create' ? {} : { expected_revision: intent.kind === 'playlist.replace' ? intent.expectedRevision : confirmed.playlist_revision }) } : { [descriptor(intent).field]: intent.value, client_mutation_id: mutationId, expected_revision: confirmed[descriptor(intent).revision] }),
            });
            intent.sentAt = now();
            update(intent, { status: 'sending' });
            armWait(intent);
            const capturedEpoch = epoch;
            Promise.resolve().then(() => { if (capturedEpoch === epoch && intents.has(intent.id)) { intent.transmitted = true; return transmit(intent, capturedEpoch); } });
        }
        function armWait(intent) {
            clearTimers(intent);
            const capturedEpoch = epoch;
            const delayedTimer = later(() => {
                if (capturedEpoch === epoch && intent.status === 'sending') update(intent, { delayed: true, message: `Still waiting for ${descriptor(intent).noun} confirmation.` });
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
            // Collection matches cannot establish whether a creation was accepted.
            if (submissionAction(intent.kind)) return false;
            if (playlistAction(intent.kind)) {
                const id = state.writer.confirmed(intent.targetId)?.playlist?.id;
                if (!id) return false;
                const reply = await read({ url: `/api/playlists/${encodeURIComponent(id)}`, method: 'GET' });
                if (capturedEpoch !== epoch || !intents.has(intent.id) || !state.isAvailable(intent.targetId) || !authorizedReply(reply, intent)) return false;
                return reply.status === 200 && reply.body?.id === id && state.acceptPlaylist(reply.body, {}, intent.targetId.slice(9));
            }
            const reply = await read({ url: intent.kind === 'preference.set' ? '/api/preferences' : `/api/downloads/${encodeURIComponent(intent.targetId)}/editable-state`, method: 'GET' });
            if (capturedEpoch !== epoch || !intents.has(intent.id) || !state.isAvailable(intent.targetId)) return false;
            if (!authorizedReply(reply, intent)) return false;
            const body = reply.body;
            if (commandAction(intent.kind)) return reply.status === 200 && body?.id === intent.targetId && validRevision(body.command_revision) && state.acceptDownload(body);
            if (reply.status !== 200 || !body || String(body.id) !== intent.targetId || !validRevision(body[descriptor(intent).revision]) || (intent.kind === 'preference.set' ? !VDL.validPreferenceValues(body.values) : intent.kind === 'favorite.set' ? typeof body.favorite !== 'boolean' : intent.kind === 'rename.set' ? !(body.filename === null || typeof body.filename === 'string') || !(body.display_filename === null || typeof body.display_filename === 'string') : !canonical(body))) return false;
            state.acceptDownload(body);
            return true;
        }
        function submit(input) {
            if (!input || !Object.hasOwn(actions, input.kind)) return { accepted: false, reason: 'unsupported', message: 'This action is not available.' };
            if (!supported(input.kind)) return { accepted: false, reason: 'unsupported', message: 'Refresh this page to use immediate saving.' };
            const startedAt = now();
            const targetId = String(input.targetId);
            if (input.kind === 'preference.set' && targetId !== 'installation') return { accepted: false, reason: 'unavailable', message: 'This settings scope is unavailable.' };
            const model = state.selectDownload(targetId);
            if (!model || model.permissions?.[actions[input.kind].domain] === false) return { accepted: false, reason: 'unavailable', message: 'This entry is unavailable.' };
            if (input.kind === 'rename.set' && (typeof model.filename !== 'string' || !model.filename || (model.status !== undefined && model.status !== 'finished'))) return { accepted: false, reason: 'unavailable', message: 'Only finished files can be renamed.' };
            if (!validActionRevision(input, model[actions[input.kind].revision]) || (input.kind.startsWith('tag.') && model.tag_identity_version !== VDL.tagIdentity.version)) return { accepted: false, reason: 'unsupported', message: `Refresh this page before saving ${actions[input.kind].noun}.` };
            let tag;
            try {
                if (input.kind === 'favorite.set' && typeof input.value !== 'boolean') throw new Error('Favorite must be true or false.');
                if (submissionAction(input.kind)) {
                    if (!targetId.startsWith('submission:') || !input.value || typeof input.value.url !== 'string' || !input.value.url.trim() || Object.keys(input.value).some(key => !['url', 'format', 'filename'].includes(key)) || ['format', 'filename'].some(key => input.value[key] !== undefined && typeof input.value[key] !== 'string')) throw new Error('Capture a URL and valid download options before submitting.');
                    if (utf8Bytes(input.value.url) > 8192 || ['format', 'filename'].some(key => utf8Bytes(input.value[key] || '') > (key === 'format' ? 4096 : 1024)) || utf8Bytes(JSON.stringify({ ...input.value, client_mutation_id: '0'.repeat(64) })) > 16384) throw new Error('The URL or download options are too long. Shorten the retained input before submitting.');
                    tag = { key: 'download-submission', name: immutable(clone(input.value)) };
                } else if (commandAction(input.kind)) {
                    if (!input.value || Object.keys(input.value).length !== 1 || !(input.value.attempt_id === null || typeof input.value.attempt_id === 'string' && input.value.attempt_id)) throw new Error('Capture the current download attempt before submitting a command.');
                    tag = { key: 'download-command', name: immutable(clone(input.value)) };
                } else if (playlistAction(input.kind)) {
                    if (!(input.kind === 'playlist.add' ? input.value && typeof input.value.download_id === 'string' && !!input.value.download_id && Object.keys(input.value).length === 1 : input.kind === 'playlist.delete' ? input.value && typeof input.value === 'object' && Object.keys(input.value).length === 0 : playlistValues(input.value)) || !targetId.startsWith('playlist:')) throw new Error('Capture the playlist name and ordered videos before saving.');
                    tag = { key: 'playlist', name: immutable(clone(input.value)) };
                } else if (input.kind === 'preference.set') {
                    if (!VDL.validPreferenceValues(input.value)) throw new Error('Capture every editable setting before saving.');
                    tag = { key: 'preferences', name: immutable(clone(input.value)) };
                } else if (input.kind === 'rename.set') {
                    if (typeof input.value !== 'string' || !input.value.trim() || /[/\\\x00]/.test(input.value) || ['.', '..'].includes(input.value.trim())) throw new Error('Enter a filename without path separators.');
                    tag = { key: 'rename', name: input.value.trim() };
                } else tag = input.kind === 'favorite.set' ? { key: 'favorite', name: input.value } : VDL.tagIdentity.normalize(input.value);
            }
            catch (error) { return { accepted: false, reason: 'validation', message: error.message }; }
            const domainKey = queueKey({ kind: input.kind, targetId });
            let queue = queues.get(domainKey) || [];
            if (submissionAction(input.kind)) {
                const existing = Array.from(intents.values()).find(intent => intent.targetId === targetId && intent.kind === input.kind);
                if (existing) return JSON.stringify(existing.value) === JSON.stringify(tag.name) && !['rejected', 'conflicted'].includes(existing.status)
                    ? { accepted: true, intentId: existing.id, duplicate: true }
                    : { accepted: false, reason: 'unresolved', message: 'Resolve the original download request before submitting another one.' };
                if (model.submission_revision !== '0') return { accepted: false, reason: 'unavailable', message: 'Use a new submission identity for a later download.' };
            }
            if (commandAction(input.kind)) {
                if (input.kind === 'download.stop') {
                    for (const prior of Array.from(intents.values()).filter(intent => intent.targetId === targetId && intent.kind === 'download.pause' && !intent.transmitted && ['queued', 'sending'].includes(intent.status))) {
                        release(prior);
                        state.writer.remove(prior.id);
                        intents.delete(prior.id);
                    }
                    queue = queues.get(domainKey) || [];
                }
                const existing = Array.from(intents.values()).filter(intent => intent.targetId === targetId && commandAction(intent.kind));
                const duplicate = existing.find(intent => intent.kind === input.kind && intent.value.attempt_id === tag.name.attempt_id && !['rejected', 'conflicted'].includes(intent.status));
                if (duplicate) return { accepted: true, intentId: duplicate.id, duplicate: true };
                if (existing.length && !(input.kind === 'download.stop' && existing.every(intent => intent.kind === 'download.pause' && ['queued', 'sending', 'unconfirmed'].includes(intent.status)))) return { accepted: false, reason: 'unresolved', message: 'Resolve the current download request before submitting another command.' };
                if (model.current_attempt_id !== tag.name.attempt_id) return { accepted: false, reason: 'unavailable', message: 'This is an older attempt. Review the current download before trying again.' };
            }
            if (playlistAction(input.kind)) {
                const existing = Array.from(intents.values()).find(intent => intent.targetId === targetId && playlistAction(intent.kind));
                if (existing) return existing.kind === input.kind && JSON.stringify(existing.value) === JSON.stringify(tag.name) && !['rejected', 'conflicted'].includes(existing.status)
                    ? { accepted: true, intentId: existing.id, duplicate: true }
                    : { accepted: false, reason: 'unresolved', message: 'Resolve the current playlist request before submitting another change.' };
            }
            if (input.kind === 'preference.set') {
                const existing = Array.from(intents.values()).find(intent => intent.targetId === targetId && intent.kind === input.kind);
                if (existing) return equalPreferences(existing.value, tag.name) && !['rejected', 'conflicted'].includes(existing.status)
                    ? { accepted: true, intentId: existing.id, duplicate: true }
                    : { accepted: false, reason: 'unresolved', message: 'Resolve the current settings save before submitting another draft.' };
            }
            if (input.kind === 'rename.set') {
                const existing = Array.from(intents.values()).find(intent => intent.targetId === targetId && intent.kind === 'rename.set');
                if (existing) return existing.value === tag.name && !['rejected', 'conflicted'].includes(existing.status)
                    ? { accepted: true, intentId: existing.id, duplicate: true }
                    : { accepted: false, reason: 'unresolved', message: 'Resolve the current rename before submitting another name.' };
            }
            if (Array.from(intents.values()).some(intent => input.kind.startsWith('tag.') && intent.targetId === targetId && descriptor(intent).domain === actions[input.kind].domain && intent.key === tag.key && intent.status === 'rejected')) return { accepted: false, reason: 'unresolved', message: 'Retry or dismiss the existing failed tag first.' };
            for (let index = queue.length - 1; index >= 0; index--) {
                const other = intents.get(queue[index]);
                if (other.key === tag.key) {
                    if (other.kind === input.kind && (input.kind !== 'favorite.set' || other.value === input.value)) return { accepted: true, intentId: other.id, duplicate: true };
                    break;
                }
            }
            const satisfied = submissionAction(input.kind) || commandAction(input.kind) || playlistAction(input.kind) ? false : input.kind === 'preference.set' ? equalPreferences(model.values, tag.name) : input.kind === 'rename.set' ? tag.name === String(model.display_filename || model.filename || '').split('/').pop().split('\\').pop() : input.kind === 'favorite.set' ? model.favorite === input.value : (input.kind === 'tag.add') === model.tag_items.some(item => item.key === tag.key);
            if (satisfied) return { accepted: true, intentId: null, settled: true };
            const unresolved = Array.from(intents.values()).filter(intent => intent.status !== 'confirmed' && intent.status !== 'resolved');
            if (unresolved.filter(intent => queueKey(intent) === domainKey).length >= 32 || unresolved.length >= 128) return { accepted: false, reason: 'limit', message: 'Too many pending edits. Resolve existing edits before adding more.' };
            if (input.kind === 'playlist.replace' && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) return { accepted: false, reason: 'validation', message: 'Open the current playlist before saving.' };
            const intent = { expectedRevision: input.expectedRevision, id: `intent-${++sequence}`, kind: input.kind, targetId, key: tag.key, value: tag.name, viewToken: input.viewToken, status: 'queued', epoch };
            intents.set(intent.id, intent);
            queue.push(intent.id);
            queues.set(domainKey, queue);
            state.writer.put(presentation(intent));
            emit(intent.kind, 'presented', intent, startedAt);
            dispatch(domainKey, targetId);
            return { accepted: true, intentId: intent.id };
        }
        async function recover(id, recoveryOptions = {}) {
            const intent = intents.get(id);
            if (!intent || intent.status !== 'unconfirmed' || !intent.attempt) return false;
            if (recoveries.has(id)) return recoveries.get(id);
            if (recoveries.size >= 4) return false;
            const capturedEpoch = epoch;
            const attempt = intent.attempt;
            const work = (async () => {
                try {
                    if (submissionAction(intent.kind) || commandAction(intent.kind)) emit(intent.kind, 'reconciliation', intent, now());
                    const reply = await read({ url: `/api/mutations/${encodeURIComponent(intent.attempt.body.client_mutation_id)}`, method: 'GET' });
                    if (capturedEpoch !== epoch || intent.attempt !== attempt || !intents.has(id) || !state.isAvailable(intent.targetId)) return false;
                    if (!authorizedReply(reply, intent, true)) return false;
                    if (reply.status !== 404) {
                        finishReply(intent, reply, capturedEpoch);
                        return intent.status === 'confirmed' || intent.status === 'rejected' || intent.status === 'conflicted';
                    }
                    if (reply.body?.error !== 'Mutation unavailable' || typeof reply.body.final !== 'boolean') return false;
                    if (reply.body.final === true) intent.safeToResolve = true;
                    if (!recoveryOptions.automatic && !recoveryOptions.replay) await checkState(intent, capturedEpoch);
                    if (capturedEpoch !== epoch || intent.attempt !== attempt || !intents.has(id) || !state.isAvailable(intent.targetId)) return false;
                    const current = state.writer.confirmed(intent.targetId);
                    if (!commandAction(intent.kind) && !['rename.set', 'playlist.create', 'download.submit'].includes(intent.kind) && current && BigInt(current[descriptor(intent).revision]) > BigInt(intent.attempt.body.expected_revision)) intent.safeToResolve = true;
                    if (recoveryOptions.replay && !reply.body?.final && now() + timeOffset - Number(intent.attempt.body.client_mutation_id.split('-')[0]) <= 86400000) {
                        update(intent, { status: 'sending', message: submissionAction(intent.kind) || commandAction(intent.kind) ? 'Checking the original request…' : 'Checking the original save…', delayed: false });
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
                if (!intent.safeToResolve && !(!commandAction(intent.kind) && !['rename.set', 'playlist.create', 'download.submit'].includes(intent.kind) && current && BigInt(current[descriptor(intent).revision]) > BigInt(intent.attempt.body.expected_revision))) return false;
            }
            release(intent);
            state.writer.remove(id);
            intents.delete(id);
            dispatch(queueKey(intent), intent.targetId);
            return true;
        }
        function retry(id) {
            const intent = intents.get(id);
            if (!intent || !['rejected', 'conflicted'].includes(intent.status) || intent.checking) return { accepted: false, reason: 'unconfirmed' };
            if (submissionAction(intent.kind) || commandAction(intent.kind) || intent.kind === 'preference.set' || playlistAction(intent.kind)) return { accepted: false, reason: 'review_required', message: commandAction(intent.kind) ? 'Review the current download attempt before submitting a new command.' : 'Review current settings, then save the draft explicitly.' };
            const wasConflict = intent.status === 'conflicted';
            function enqueue() {
                state.writer.transaction(() => {
                    if (!wasConflict) {
                        // A deliberate retry is a new operation after later queued work.
                        intents.delete(id);
                        intents.set(id, intent);
                        state.writer.remove(id);
                    }
                    const queue = queues.get(queueKey(intent)) || [];
                    if (!queue.includes(id)) queue.push(id);
                    queues.set(queueKey(intent), queue);
                    intent.attempt = null;
                    intent.autoChecked = false;
                    intent.safeToResolve = false;
                    intent.delayed = false;
                    update(intent, { status: 'queued', message: '' });
                });
                dispatch(queueKey(intent), intent.targetId);
            }
            if (wasConflict) {
                intent.checking = true;
                const capturedEpoch = epoch;
                update(intent, { message: `Checking current ${descriptor(intent).noun} before retrying…` });
                checkState(intent, capturedEpoch).then(checked => {
                    intent.checking = false;
                    if (checked && capturedEpoch === epoch && intents.has(id)) {
                        const current = state.writer.confirmed(intent.targetId);
                        if (intent.kind === 'rename.set' && (!current?.filename || current.permissions?.rename === false || (current.status !== undefined && current.status !== 'finished'))) {
                            release(intent);
                            update(intent, { status: 'rejected', message: 'Only finished files can be renamed. The requested name is retained.' });
                        } else enqueue();
                    }
                }).catch(() => {
                    intent.checking = false;
                    if (capturedEpoch === epoch && intents.has(id)) update(intent, { message: `Could not check current ${descriptor(intent).noun}. Try checking again.` });
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

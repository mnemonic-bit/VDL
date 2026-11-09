(function (root) {
    'use strict';
    const VDL = root.VDL = root.VDL || {};
    const copy = value => JSON.parse(JSON.stringify(value));
    function freeze(value) {
        if (value && typeof value === 'object') {
            Object.values(value).forEach(freeze);
            Object.freeze(value);
        }
        return value;
    }
    const revision = value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
    const preferenceFields = Object.freeze([
        'download_dir', 'format', 'history_page_size', 'max_concurrent',
        'max_concurrent_per_host', 'max_total_download_mbps', 'player_mode',
        'start_fullscreen', 'skip_video_edges', 'library_rotation_enabled',
        'library_rotation_hours', 'shuffle_min_height',
        'shuffle_min_duration_minutes', 'theme',
    ]);
    const preferenceValues = value => !!value && typeof value === 'object'
        && !Array.isArray(value) && Object.keys(value).length === preferenceFields.length
        && preferenceFields.every(key => typeof value[key] === 'string');
    const samePreferences = (left, right) => preferenceFields.every(key => left[key] === right[key]);
    function createClientState() {
        const downloads = new Map();
        const intents = new Map();
        const fences = new Map();
        const collections = new Map();
        const editOrders = new Map();
        const listeners = new Set();
        let epoch = 0;
        let generation = 0;
        let depth = 0;
        let changed = new Set();
        function notify(id) {
            changed.add(String(id));
            if (!depth) flush();
        }
        function flush() {
            if (!changed.size) return;
            const ids = Object.freeze(Array.from(changed));
            changed = new Set();
            listeners.forEach(listener => listener(ids));
        }
        function transaction(callback) {
            depth++;
            try { return callback(); }
            finally { if (!--depth) flush(); }
        }
        function acceptDownload(snapshot, context = {}) {
            if (!snapshot || snapshot.id == null || (context.epoch !== undefined && context.epoch !== epoch)) return false;
            if (snapshot.tags_revision !== undefined && (!revision(snapshot.tags_revision) || !Array.isArray(snapshot.tags) || !Array.isArray(snapshot.tag_items) || snapshot.tags.length !== snapshot.tag_items.length || snapshot.tag_items.some((tag, index) => !tag || typeof tag.key !== 'string' || typeof tag.name !== 'string' || tag.name !== snapshot.tags[index]) || new Set(snapshot.tag_items.map(tag => tag.key)).size !== snapshot.tag_items.length)) return false;
            if (snapshot.command_revision !== undefined && (!revision(snapshot.command_revision) || !(snapshot.current_attempt_id === null || typeof snapshot.current_attempt_id === 'string' && snapshot.current_attempt_id))) return false;
            if (Object.hasOwn(snapshot, 'job_id') && !(snapshot.job_id === null || typeof snapshot.job_id === 'string' && snapshot.job_id)) return false;
            if (snapshot.favorite_revision !== undefined && (!revision(snapshot.favorite_revision) || typeof snapshot.favorite !== 'boolean')) return false;
            if (snapshot.rename_revision !== undefined && (!revision(snapshot.rename_revision) || !(snapshot.filename === null || typeof snapshot.filename === 'string') || !(snapshot.display_filename == null || typeof snapshot.display_filename === 'string'))) return false;
            if (snapshot.preferences_revision !== undefined && (String(snapshot.id) !== 'installation' || !revision(snapshot.preferences_revision) || !preferenceValues(snapshot.values))) return false;
            if (snapshot.submission_revision !== undefined && (!revision(snapshot.submission_revision) || !String(snapshot.id).startsWith('submission:') || !(snapshot.submission === null || snapshot.submission && typeof snapshot.submission.id === 'string' && snapshot.submission.job?.download_id === snapshot.submission.id && typeof snapshot.submission.job.id === 'string' && typeof snapshot.submission.job.attempt_id === 'string'))) return false;
            const id = String(snapshot.id);
            const fence = fences.get(id);
            if (fence !== undefined) {
                if (!context.authoritative || context.generation === undefined || context.generation < fence) return false;
                fences.delete(id);
            }
            const old = downloads.get(id);
            if (snapshot.playlist_revision !== undefined && (!Number.isSafeInteger(snapshot.playlist_revision) || snapshot.playlist_revision < 0 || !snapshot.playlist || !Array.isArray(snapshot.playlist.items))) return false;
            const next = { ...(old || {}), ...copy(snapshot), id };
            if (old && revision(old.submission_revision)) {
                if (!revision(snapshot.submission_revision) || BigInt(snapshot.submission_revision) < BigInt(old.submission_revision)) {
                    next.submission_revision = old.submission_revision;
                    next.submission = old.submission;
                } else if (old.submission && (snapshot.submission?.id !== old.submission.id || snapshot.submission?.job.id !== old.submission.job.id || snapshot.submission?.job.attempt_id !== old.submission.job.attempt_id)) return false;
            }
            if (old && revision(old.tags_revision)) {
                if (!revision(snapshot.tags_revision) || BigInt(snapshot.tags_revision) < BigInt(old.tags_revision)) {
                    next.tags = old.tags;
                    next.tag_items = old.tag_items;
                    next.tags_revision = old.tags_revision;
                    next.tag_identity_version = old.tag_identity_version;
                } else if (snapshot.tags_revision === old.tags_revision && (snapshot.tag_items.length !== old.tag_items.length || snapshot.tag_items.some((tag, index) => tag.key !== old.tag_items[index].key || tag.name !== old.tag_items[index].name))) {
                    // Equal revision with different data is a protocol violation, never a new truth.
                    return false;
                }
            }
            if (old && revision(old.command_revision)) {
                if (!revision(snapshot.command_revision) || BigInt(snapshot.command_revision) < BigInt(old.command_revision)) {
                    next.command_revision = old.command_revision;
                    next.current_attempt_id = old.current_attempt_id;
                    if (Object.hasOwn(old, 'job_id')) next.job_id = old.job_id;
                    else delete next.job_id;
                    // Worker fields from an earlier execution cannot re-enable
                    // controls or replace the current generation's progress.
                    if (Object.hasOwn(snapshot, 'current_attempt_id') && snapshot.current_attempt_id !== old.current_attempt_id) {
                        for (const field of ['status', 'progress', 'speed', 'eta', 'downloaded_bytes', 'total_bytes', 'filesize', 'resolution', 'finished_at', 'filename', 'display_filename', 'title']) {
                            if (Object.hasOwn(old, field)) next[field] = old[field];
                            else delete next[field];
                        }
                    }
                } else if (snapshot.command_revision === old.command_revision && snapshot.current_attempt_id !== old.current_attempt_id) return false;
                else if (snapshot.current_attempt_id !== old.current_attempt_id && !Object.hasOwn(snapshot, 'job_id')) delete next.job_id;
            }
            if (old && revision(old.favorite_revision)) {
                if (!revision(snapshot.favorite_revision) || BigInt(snapshot.favorite_revision) < BigInt(old.favorite_revision)) {
                    next.favorite = old.favorite;
                    next.favorite_revision = old.favorite_revision;
                } else if (snapshot.favorite_revision === old.favorite_revision && snapshot.favorite !== old.favorite) {
                    return false;
                }
            }
            if (old && revision(old.rename_revision)) {
                if (!revision(snapshot.rename_revision) || BigInt(snapshot.rename_revision) < BigInt(old.rename_revision)) {
                    for (const field of ['filename', 'display_filename', 'rename_revision']) next[field] = old[field];
                } else if (snapshot.rename_revision === old.rename_revision && (snapshot.filename !== old.filename || snapshot.display_filename !== old.display_filename)) {
                    return false;
                }
            }
            if (old && revision(old.preferences_revision)) {
                if (!revision(snapshot.preferences_revision) || BigInt(snapshot.preferences_revision) < BigInt(old.preferences_revision)) {
                    next.values = old.values;
                    next.preferences_revision = old.preferences_revision;
                } else if (snapshot.preferences_revision === old.preferences_revision && !samePreferences(snapshot.values, old.values)) {
                    return false;
                }
            }
            if (old && Number.isSafeInteger(old.playlist_revision)) {
                if (!Number.isSafeInteger(snapshot.playlist_revision) || snapshot.playlist_revision < old.playlist_revision) {
                    next.playlist = old.playlist;
                    next.playlist_revision = old.playlist_revision;
                } else if (snapshot.playlist_revision === old.playlist_revision) {
                    if (snapshot.playlist.name !== old.playlist.name || snapshot.playlist.items.length !== old.playlist.items.length || snapshot.playlist.items.some((item, index) => item.id !== null && old.playlist.items[index].id !== null && item.id !== old.playlist.items[index].id)) return false;
                    // Visibility can redact a member without advancing playlist
                    // revision. Retain that redaction against older callbacks.
                    next.playlist.items = next.playlist.items.map((item, index) => old.playlist.items[index].id === null ? copy(old.playlist.items[index]) : item);
                    const visible = new Set(next.playlist.items.map(item => item.id).filter(Boolean));
                    next.playlist.member_ids = next.playlist.items.map(item => item.id);
                    next.playlist.mosaic_ids = (next.playlist.mosaic_ids || []).filter(id => visible.has(id));
                    if (next.playlist.progress && !visible.has(next.playlist.progress.download_id)) next.playlist.progress = null;
                }
            }
            if (next.playlist) {
                const knownProgress = old?.playlist?.progress;
                const receivedProgress = next.playlist.progress;
                const knownSequence = knownProgress?.write_sequence;
                const receivedSequence = Number.isSafeInteger(receivedProgress?.write_sequence) ? receivedProgress.write_sequence : -1;
                const knownPosition = next.playlist.items.findIndex(item => item.id !== null && item.id === knownProgress?.download_id);
                // Progress writes have their own sequence and can outlive a
                // metadata response. Keep newer progress only while its member
                // remains visible in the accepted membership and order.
                if (Number.isSafeInteger(knownSequence) && knownSequence >= 0 && knownSequence > receivedSequence && knownPosition !== -1) {
                    next.playlist.progress = copy(knownProgress);
                }
                const position = next.playlist.items.findIndex(item => item.id !== null && item.id === next.playlist.progress?.download_id);
                if (position === -1) next.playlist.progress = null;
                next.playlist.resume_position = Math.max(0, position);
            }
            downloads.set(id, next);
            notify(id);
            return true;
        }
        function selectDownload(value) {
            const id = String(value);
            const download = downloads.get(id);
            if (!download || fences.has(id)) return null;
            let favorite = Boolean(download.favorite);
            const favoriteIntents = [];
            const renameIntents = [];
            const preferenceIntents = [];
            const playlistIntents = [];
            const commandIntents = [];
            const submissionIntents = [];
            let requestedFilename = null;
            const chips = new Map();
            for (const tag of download.tag_items || (download.tags || []).map(name => VDL.tagIdentity.normalize(name))) {
                chips.set(tag.key, { ...tag, status: 'confirmed', intentId: null, operation: null, effective: true });
            }
            for (const intent of intents.values()) {
                if (intent.targetId !== id) continue;
                if (intent.kind === 'download.submit') { submissionIntents.push(copy(intent)); continue; }
                if (intent.kind.startsWith('download.')) { commandIntents.push(copy(intent)); continue; }
                if (intent.kind.startsWith('playlist.')) { playlistIntents.push(copy(intent)); continue; }
                if (intent.kind === 'preference.set') {
                    // Pending settings describe a request; only acknowledged values apply effects.
                    preferenceIntents.push(copy(intent));
                    continue;
                }
                if (intent.kind === 'rename.set') {
                    renameIntents.push(copy(intent));
                    if (!['rejected', 'conflicted'].includes(intent.status)) requestedFilename = intent.value;
                    continue;
                }
                if (intent.kind === 'favorite.set') {
                    favoriteIntents.push(copy(intent));
                    if (!['rejected', 'conflicted'].includes(intent.status)) favorite = intent.value;
                    continue;
                }
                const failed = intent.status === 'rejected' || intent.status === 'conflicted';
                const current = chips.get(intent.key);
                const effective = failed ? !!(current && current.effective) : intent.kind === 'tag.add';
                const chip = {
                    ...(current || { key: intent.key, name: intent.value }),
                    status: intent.status, intentId: intent.id, operation: intent.kind,
                    message: intent.message || '', delayed: !!intent.delayed, effective,
                };
                chips.set(intent.key, chip);
            }
            let rows = Array.from(chips.values());
            const order = editOrders.get(id);
            if (order) {
                rows.forEach(tag => { if (!order.includes(tag.key)) order.push(tag.key); });
                rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
            } else {
                rows.sort((a, b) => a.name.localeCompare(b.name));
            }
            const effective = rows.filter(tag => tag.effective).map(tag => ({ key: tag.key, name: tag.name }));
            return freeze(copy({ ...download, submission_intents: submissionIntents, command_intents: commandIntents, playlist_intents: playlistIntents, requested_filename: requestedFilename, rename_intents: renameIntents, preference_intents: preferenceIntents, favorite, favorite_intents: favoriteIntents, tags: effective.map(tag => tag.name), tag_items: effective, tag_chips: rows }));
        }
        function fence(id) {
            id = String(id);
            for (const [key, value] of downloads) if (key !== id && value.submission?.id === id) fence(key);
            fences.set(id, ++generation);
            downloads.delete(id);
            editOrders.delete(id);
            for (const [key, intent] of intents) if (intent.targetId === id) intents.delete(key);
            notify(id);
        }
        return Object.freeze({
            acceptDownload,
            acceptPlaylist(snapshot, context = {}, localId = null) {
                if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Array.isArray(snapshot.items)) return false;
                const id = localId || snapshot.id;
                if (!id) return false;
                return acceptDownload({ id: `playlist:${id}`, playlist: snapshot, playlist_revision: snapshot.revision }, context);
            },
            selectPlaylist(id) {
                const model = selectDownload(`playlist:${id}`);
                return model ? freeze(copy({ ...model.playlist, playlist_intents: model.playlist_intents })) : null;
            },
            selectDownload,
            acceptPreferences(snapshot, context = {}) {
                if (!snapshot || snapshot.id !== undefined && snapshot.id !== 'installation') return false;
                return acceptDownload({ ...snapshot, id: 'installation' }, context);
            },
            selectPreferences() { return selectDownload('installation'); },
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
            capture() { return Object.freeze({ epoch, generation }); },
            epoch() { return epoch; },
            isFenced(id) { return fences.has(String(id)); },
            isAvailable(id) { return downloads.has(String(id)) && !fences.has(String(id)); },
            beginEdit(id) {
                id = String(id);
                if (!editOrders.has(id)) editOrders.set(id, (selectDownload(id)?.tag_chips || []).map(tag => tag.key));
            },
            endEdit(id) { editOrders.delete(String(id)); notify(id); },
            beginCollection(scope) {
                const token = { ...this.capture(), scope, request: (collections.get(scope)?.request || 0) + 1 };
                collections.set(scope, { ...collections.get(scope), request: token.request });
                return freeze(token);
            },
            acceptCollection(token, snapshots) {
                if (token.epoch !== epoch || collections.get(token.scope)?.request !== token.request) return false;
                transaction(() => snapshots.forEach(snapshot => acceptDownload(snapshot, token)));
                collections.set(token.scope, { request: token.request, ids: snapshots.map(item => String(item.id)) });
                return true;
            },
            collectionIds(scope) { return Object.freeze([...(collections.get(scope)?.ids || [])]); },
            reset() {
                const ids = Array.from(downloads.keys());
                epoch++;
                generation++;
                downloads.clear(); intents.clear(); fences.clear(); collections.clear(); editOrders.clear();
                transaction(() => ids.forEach(notify));
            },
            // Only coordinator and authorized snapshot adapters use this write seam.
            writer: Object.freeze({
                transaction,
                put(intent) { intents.set(intent.id, copy(intent)); notify(intent.targetId); },
                remove(id) { const intent = intents.get(id); intents.delete(id); if (intent) notify(intent.targetId); },
                confirmed(id) { const value = downloads.get(String(id)); return value ? freeze(copy(value)) : null; },
                forgetSubmission(id) {
                    id = String(id);
                    if (!id.startsWith('submission:')) return;
                    downloads.delete(id); fences.delete(id);
                    for (const [key, intent] of intents) if (intent.targetId === id) intents.delete(key);
                    notify(id);
                },
                fence,
            }),
        });
    }
    VDL.createClientState = createClientState;
    VDL.preferenceFields = preferenceFields;
    VDL.validPreferenceValues = preferenceValues;
})(typeof window === 'undefined' ? globalThis : window);

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
            if (snapshot.favorite_revision !== undefined && (!revision(snapshot.favorite_revision) || typeof snapshot.favorite !== 'boolean')) return false;
            if (snapshot.rename_revision !== undefined && (!revision(snapshot.rename_revision) || !(snapshot.filename === null || typeof snapshot.filename === 'string') || !(snapshot.display_filename == null || typeof snapshot.display_filename === 'string'))) return false;
            if (snapshot.preferences_revision !== undefined && (String(snapshot.id) !== 'installation' || !revision(snapshot.preferences_revision) || !preferenceValues(snapshot.values))) return false;
            const id = String(snapshot.id);
            const fence = fences.get(id);
            if (fence !== undefined) {
                if (!context.authoritative || context.generation === undefined || context.generation < fence) return false;
                fences.delete(id);
            }
            const old = downloads.get(id);
            const next = { ...(old || {}), ...copy(snapshot), id };
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
            let requestedFilename = null;
            const chips = new Map();
            for (const tag of download.tag_items || (download.tags || []).map(name => VDL.tagIdentity.normalize(name))) {
                chips.set(tag.key, { ...tag, status: 'confirmed', intentId: null, operation: null, effective: true });
            }
            for (const intent of intents.values()) {
                if (intent.targetId !== id) continue;
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
            return freeze(copy({ ...download, requested_filename: requestedFilename, rename_intents: renameIntents, preference_intents: preferenceIntents, favorite, favorite_intents: favoriteIntents, tags: effective.map(tag => tag.name), tag_items: effective, tag_chips: rows }));
        }
        function fence(id) {
            id = String(id);
            fences.set(id, ++generation);
            downloads.delete(id);
            editOrders.delete(id);
            for (const [key, intent] of intents) if (intent.targetId === id) intents.delete(key);
            notify(id);
        }
        return Object.freeze({
            acceptDownload,
            selectDownload,
            acceptPreferences(snapshot, context = {}) {
                if (!snapshot || snapshot.id !== undefined && snapshot.id !== 'installation') return false;
                return acceptDownload({ ...snapshot, id: 'installation' }, context);
            },
            selectPreferences() { return selectDownload('installation'); },
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
            capture() { return Object.freeze({ epoch, generation }); },
            epoch() { return epoch; },
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
                fence,
            }),
        });
    }
    VDL.createClientState = createClientState;
    VDL.preferenceFields = preferenceFields;
    VDL.validPreferenceValues = preferenceValues;
})(typeof window === 'undefined' ? globalThis : window);

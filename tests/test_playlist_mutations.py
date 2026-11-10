"""Playlist editor writes and actor-authorized recovery through real routes."""
import json
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class PlaylistMutationProtocolTest(AppCase):
    def video(self, identity):
        self.finished_file(identity, identity + '.mp4')
        vdl.db_update_download(identity, title='Video ' + identity, duration_seconds=60)
        return identity

    def attempt(self, name='A playlist', ids=None, revision=None, created=None):
        payload = {
            'name': name, 'download_ids': ids or [],
            'client_mutation_id': f'{int((time.time() if created is None else created) * 1000)}-{secrets.token_hex(16)}',
        }
        if revision is not None:
            payload['expected_revision'] = revision
        return payload

    def mutate(self, payload, target=None, client=None):
        client = client or self.client
        return (client.post('/api/playlists', json=payload) if target is None else
                client.put('/api/playlists/' + target, json=payload))

    def receipt(self, payload, client=None):
        return (client or self.client).get('/api/mutations/' + payload['client_mutation_id'])

    def test_create_canonical_ordered_snapshot_and_integer_revision(self):
        self.video('one')
        self.video('two')
        payload = self.attempt('  Café  ', ['two', 'one'])
        response = self.mutate(payload)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        result = response.json
        self.assertEqual(result['name'], 'Café')
        self.assertEqual(result['revision'], 1)
        self.assertIs(type(result['revision']), int)
        self.assertEqual(result['member_ids'], ['two', 'one'])
        self.assertEqual(result['mosaic_ids'], ['two', 'one'])
        self.assertEqual([item['id'] for item in result['items']], ['two', 'one'])
        self.assertEqual(result['duration_seconds'], 120)
        self.assertEqual(result['mutation'], {'id': payload['client_mutation_id'], 'domain': 'playlist',
                                               'revision': 1, 'outcome': 'committed'})
        self.assertEqual(self.receipt(payload).json, result)
        self.assertEqual(self.client.get('/api/playlists/' + result['id']).json['items'], result['items'])
        self.assertIn('playlist.create', self.client.get('/api/client-capabilities').json['actions'])
        self.assertIn('playlist.replace', self.client.get('/api/client-capabilities').json['actions'])

    def test_lost_create_response_replay_restart_and_receipt_keep_one_identity(self):
        payload = self.attempt()
        first = self.mutate(payload).json
        vdl.init_db()
        self.assertEqual(self.mutate(payload).json, first)
        self.assertEqual(self.receipt(payload).json, first)
        self.assertEqual([item['id'] for item in self.client.get('/api/playlists').json], [first['id']])

    def test_replace_replays_before_old_revision_and_preserves_newer_server_state(self):
        created = self.mutate(self.attempt()).json
        payload = self.attempt('Changed', revision=1)
        committed = self.mutate(payload, created['id'])
        self.assertEqual(committed.status_code, 200)
        self.assertEqual(committed.json['revision'], 2)
        self.assertEqual(self.mutate(payload, created['id']).json, committed.json)
        self.client.put('/api/playlists/' + created['id'], json={
            'name': 'Newer', 'download_ids': [], 'expected_revision': 2,
        })
        vdl.init_db()
        self.assertEqual(self.receipt(payload).json, committed.json)
        self.assertEqual(self.mutate(payload, created['id']).json, committed.json)
        self.assertEqual(self.client.get('/api/playlists/' + created['id']).json['name'], 'Newer')

    def test_concurrent_duplicate_create_and_replace_commit_once(self):
        clients = [self.authenticated_client(), self.authenticated_client()]
        barrier = threading.Barrier(2)
        payload = self.attempt()
        def send(index, target=None):
            barrier.wait()
            return self.mutate(payload, target, clients[index])
        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(send, range(2)))
        self.assertEqual([r.status_code for r in replies], [201, 201])
        self.assertEqual(replies[0].json, replies[1].json)
        target = replies[0].json['id']
        payload = self.attempt('New', revision=1)
        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(lambda index: send(index, target), range(2)))
        self.assertEqual([r.status_code for r in replies], [200, 200])
        self.assertEqual(replies[0].json, replies[1].json)
        self.assertEqual(self.client.get('/api/playlists/' + target).json['revision'], 2)

    def test_competing_replacements_conflict_with_canonical_current_members(self):
        for identity in ('one', 'two'):
            self.video(identity)
        target = self.mutate(self.attempt(ids=['one'])).json['id']
        clients = [self.authenticated_client(), self.authenticated_client()]
        payloads = [self.attempt('First', ['two', 'one'], 1), self.attempt('Second', ['one', 'two'], 1)]
        barrier = threading.Barrier(2)
        def send(index):
            barrier.wait()
            return self.mutate(payloads[index], target, clients[index])
        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(send, range(2)))
        self.assertEqual(sorted(reply.status_code for reply in replies), [200, 409])
        committed = next(reply.json for reply in replies if reply.status_code == 200)
        conflict = next(reply.json for reply in replies if reply.status_code == 409)
        self.assertEqual(conflict['mutation']['outcome'], 'conflicted')
        self.assertEqual(conflict['name'], committed['name'])
        self.assertEqual(conflict['member_ids'], committed['member_ids'])
        self.assertEqual(conflict['revision'], 2)

    def test_fingerprint_binds_order_name_revision_options_and_target(self):
        for identity in ('one', 'two'):
            self.video(identity)
        payload = self.attempt(ids=['one', 'two'])
        first = self.mutate(payload).json
        for changed in (dict(payload, name='Other'), dict(payload, download_ids=['two', 'one']),
                        dict(payload, expected_revision=1), dict(payload, shared=True)):
            self.assertEqual(self.mutate(changed).json['code'], 'mutation_id_conflict')
        replace = self.attempt('Replace', ['one'], 1)
        self.mutate(replace, first['id'])
        other = self.mutate(self.attempt('Other')).json['id']
        self.assertEqual(self.mutate(replace, other).json['code'], 'mutation_id_conflict')
        self.assertEqual(self.mutate(dict(replace, expected_revision=2), first['id']).json['code'], 'mutation_id_conflict')

    def test_shared_namespace_conflicts_in_both_directions(self):
        self.video('video')
        payload = self.attempt()
        self.mutate(payload)
        response = self.client.post('/api/favorite/video', json={
            'favorite': True, 'expected_revision': '0', 'client_mutation_id': payload['client_mutation_id'],
        })
        self.assertEqual(response.json['code'], 'mutation_id_conflict')
        other = self.attempt()
        self.client.post('/api/favorite/video', json={
            'favorite': True, 'expected_revision': '0', 'client_mutation_id': other['client_mutation_id'],
        })
        self.assertEqual(self.mutate(other).json['code'], 'mutation_id_conflict')

    def test_invalid_name_and_members_have_definite_retained_receipts(self):
        for payload, field in ((self.attempt(''), 'name'), (self.attempt(ids=['missing']), 'download_ids'),
                               (self.attempt(ids=['same', 'same']), 'download_ids')):
            response = self.mutate(payload)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json['mutation']['outcome'], 'rejected')
            self.assertIsNone(response.json['id'])
            self.assertEqual(response.json['revision'], 0)
            self.assertIn(field, response.json['field_errors'])
            self.assertEqual(self.receipt(payload).json, response.json)
        self.assertEqual(self.client.get('/api/playlists').json, [])

    def test_invalid_revision_unknown_fields_and_request_limits(self):
        target = self.mutate(self.attempt()).json['id']
        for revision in (True, '1', 0, -1, 1.0):
            payload = dict(self.attempt(), expected_revision=revision)
            response = self.mutate(payload, target)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json['mutation']['outcome'], 'rejected')
        self.assertEqual(self.mutate(dict(self.attempt(), shared=True)).status_code, 400)
        self.assertEqual(self.mutate(dict(self.attempt(), expected_revision=1)).status_code, 400)
        self.assertEqual(self.mutate(dict(self.attempt(), client_mutation_id='bad')).status_code, 400)
        self.assertEqual(self.mutate([]).status_code, 400)
        self.assertEqual(self.client.post('/api/playlists', data='x').status_code, 415)
        self.assertEqual(self.mutate(self.attempt('x' * (2 * 1024 * 1024))).status_code, 413)

    def test_receipt_insert_failure_rolls_back_creation_and_replacement(self):
        target = self.mutate(self.attempt()).json['id']
        before = self.client.get('/api/playlists/' + target).json
        original = vdl.db
        @contextmanager
        def failing_db():
            with original() as conn:
                class Connection:
                    def __getattr__(self, name):
                        return getattr(conn, name)
                    def execute(self, sql, *args):
                        if sql.startswith('INSERT INTO mutation_receipts'):
                            raise RuntimeError('receipt failure')
                        return conn.execute(sql, *args)
                yield Connection()
        for identity, payload in ((None, self.attempt('New')), (target, self.attempt('Changed', revision=1))):
            with mock.patch.object(vdl, 'db', failing_db), self.assertRaises(RuntimeError):
                self.mutate(payload, identity)
            self.assertEqual(self.receipt(payload).status_code, 404)
            self.assertEqual(self.client.get('/api/playlists/' + target).json, before)
            self.assertEqual(len(self.client.get('/api/playlists').json), 1)

    def test_quick_add_and_download_removal_advance_editor_conflict_boundary(self):
        for identity in ('one', 'two'):
            self.video(identity)
        target = self.mutate(self.attempt(ids=['one'])).json['id']
        stale = self.attempt('Stale', ['one'], 1)
        added = self.client.post('/api/playlists/' + target + '/items', json={'download_id': 'two'})
        self.assertEqual(added.json['revision'], 2)
        self.assertEqual(self.mutate(stale, target).status_code, 409)
        after_add = self.attempt('Another stale', ['one', 'two'], 2)
        self.assertEqual(self.client.post('/api/remove/two').status_code, 200)
        self.assertEqual(self.mutate(after_add, target).status_code, 409)
        self.assertEqual(self.client.get('/api/playlists/' + target).json['revision'], 3)

    def test_deletion_fences_receipts_and_replays_without_recreating(self):
        create = self.attempt()
        target = self.mutate(create).json['id']
        replace = self.attempt('Changed', revision=1)
        self.mutate(replace, target)
        self.client.delete('/api/playlists/' + target)
        for payload, identity in ((create, None), (replace, target)):
            self.assertEqual(self.receipt(payload).status_code, 404)
            self.assertEqual(self.mutate(payload, identity).status_code, 404)
        self.assertEqual(self.client.get('/api/playlists').json, [])

    def test_actor_scoped_receipts_and_current_owner_authorization(self):
        user = vdl.db_create_user('editor', 'password', 'normal')
        editor = self.authenticated_client('editor', 'password')
        payload = self.attempt()
        target = self.mutate(payload, client=editor).json['id']
        self.assertEqual(self.receipt(payload).status_code, 404)
        self.assertEqual(self.client.put('/api/playlists/' + target, json=self.attempt(revision=1)).status_code, 404)
        self.assertEqual(self.receipt(payload, editor).status_code, 201)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE playlists SET owner_user_id = ? WHERE id = ?',
                         (vdl.db_get_user_by_username('admin')['id'], target))
        self.assertEqual(self.receipt(payload, editor).status_code, 404)
        self.assertEqual(self.mutate(payload, client=editor).status_code, 404)

    def test_receipts_redact_members_after_current_visibility_is_lost(self):
        self.video('secret')
        vdl.db_create_user('editor', 'password', 'normal')
        editor = self.authenticated_client('editor', 'password')
        payload = self.attempt(ids=['secret'])
        target = self.mutate(payload, client=editor).json['id']
        vdl.db_set_download_visibility('secret', 'private')
        for response in (self.receipt(payload, editor), self.mutate(payload, client=editor)):
            self.assertEqual(response.status_code, 201)
            self.assertEqual(response.json['revision'], 1)
            self.assertIsNone(response.json['items'][0]['id'])
            self.assertEqual(response.json['items'][0]['title'], 'Unavailable video')
            self.assertEqual(response.json['member_ids'], [None])
            self.assertEqual(response.json['mosaic_ids'], [])
            self.assertNotIn('secret', json.dumps(response.json))

    def test_visibility_and_session_races_recheck_inside_write_transaction(self):
        self.video('visible')
        user = vdl.db_create_user('editor', 'password', 'normal')
        client = self.authenticated_client('editor', 'password')
        original = vdl._tag_actor
        def hide(conn):
            conn.execute("UPDATE downloads SET visibility = 'private' WHERE id = 'visible'")
            return original(conn)
        with mock.patch.object(vdl, '_tag_actor', side_effect=hide):
            response = self.mutate(self.attempt(ids=['visible']), client=client)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json['mutation']['outcome'], 'rejected')
        def expire(conn):
            conn.execute('UPDATE users SET session_version = session_version + 1 WHERE id = ?', (user['id'],))
            return original(conn)
        for protocol in (True, False):
            client = self.authenticated_client('editor', 'password')
            payload = self.attempt() if protocol else {'name': 'Legacy', 'download_ids': []}
            with mock.patch.object(vdl, '_tag_actor', side_effect=expire):
                self.assertEqual(self.mutate(payload, client=client).status_code, 401)
        self.assertEqual(self.client.get('/api/playlists').json, [])

    def test_recovery_rechecks_current_session_suspension_and_role(self):
        user = vdl.db_create_user('editor', 'password', 'normal')
        client = self.authenticated_client('editor', 'password')
        payload = self.attempt()
        self.mutate(payload, client=client)
        original = vdl._tag_actor
        def expire(conn):
            conn.execute('UPDATE users SET session_version = session_version + 1 WHERE id = ?', (user['id'],))
            return original(conn)
        with mock.patch.object(vdl, '_tag_actor', side_effect=expire):
            self.assertEqual(self.receipt(payload, client).status_code, 401)
        client = self.authenticated_client('editor', 'password')
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE users SET suspended = 1 WHERE id = ?', (user['id'],))
        self.assertEqual(self.receipt(payload, client).status_code, 401)

    def test_quota_expiry_retention_and_serialized_finality(self):
        payload = self.attempt()
        self.mutate(payload)
        for limit in ('MUTATION_ACTOR_RECEIPT_LIMIT', 'MUTATION_ACTOR_MINUTE_LIMIT'):
            with mock.patch.object(vdl, limit, 1):
                self.assertEqual(self.mutate(self.attempt()).status_code, 429)
                self.assertEqual(self.mutate(payload).status_code, 201)
        for created in (time.time() - 86401, time.time() + 301):
            expired = self.attempt(created=created)
            response = self.mutate(expired)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json['mutation']['outcome'], 'rejected')
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE mutation_receipts SET recorded_at = ?', (time.time() - 172801,))
        self.mutate(self.attempt('Cleanup'))
        self.assertEqual(self.receipt(payload).status_code, 404)
        expired = self.attempt(created=time.time() - 86401)
        self.assertTrue(self.receipt(expired).json['final'])
        self.assertFalse(self.receipt(self.attempt()).json['final'])

    def test_publish_failure_and_request_security_do_not_change_atomic_result(self):
        payload = self.attempt()
        self.assertEqual(self.client.post('/api/playlists', json=payload,
                                         headers={'Origin': 'https://attacker.invalid'}).status_code, 403)
        subscription = vdl.event_bus.subscribe()
        with mock.patch.object(vdl.event_bus, 'publish', side_effect=RuntimeError('lost publication')):
            response = self.mutate(payload)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.receipt(payload).json, response.json)
        self.assertTrue(subscription.empty())
        self.mutate(self.attempt('Second'))
        self.assertEqual(subscription.get_nowait(), ('change', {'reason': 'playlist'}))

    def test_replace_preserves_progress_and_does_not_change_playback_or_rotation(self):
        for identity in ('one', 'two'):
            self.video(identity)
        target = self.mutate(self.attempt(ids=['one', 'two'])).json['id']
        self.client.put('/api/playlists/' + target + '/progress', json={
            'download_id': 'two', 'position_seconds': 12, 'completed': False, 'write_sequence': 1,
        })
        with mock.patch.object(vdl, '_new_rotation_members', side_effect=AssertionError('rotation changed')):
            response = self.mutate(self.attempt('Reordered', ['two', 'one'], 1), target)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['progress']['download_id'], 'two')
        self.assertEqual(response.json['progress']['position_seconds'], 12)
        self.assertEqual(response.json['progress']['write_sequence'], 1)
        self.assertEqual(vdl._playback_sessions, {})

    def test_legacy_create_replace_add_delete_recheck_expired_session(self):
        self.video('one')
        target = self.mutate(self.attempt()).json['id']
        actor_id = vdl.db_get_user_by_username('admin')['id']
        original = vdl._tag_actor
        def expire(conn):
            conn.execute('UPDATE users SET session_version = session_version + 1 WHERE id = ?', (actor_id,))
            return original(conn)
        for action in ('create', 'replace', 'add', 'delete'):
            client = self.authenticated_client()
            with mock.patch.object(vdl, '_tag_actor', side_effect=expire):
                if action == 'create':
                    response = client.post('/api/playlists', json={'name': 'Legacy', 'download_ids': []})
                elif action == 'replace':
                    response = client.put('/api/playlists/' + target, json={'name': 'Legacy', 'download_ids': [], 'expected_revision': 1})
                elif action == 'add':
                    response = client.post('/api/playlists/' + target + '/items', json={'download_id': 'one'})
                else:
                    response = client.delete('/api/playlists/' + target)
            self.assertEqual(response.status_code, 401, action)
        self.client = self.authenticated_client()
        self.assertEqual(self.client.get('/api/playlists/' + target).json['revision'], 1)
        self.assertEqual(len(self.client.get('/api/playlists').json), 1)

    def test_legacy_and_protocol_member_writes_recheck_current_role(self):
        self.video('private')
        owner = vdl.db_create_user('owner', 'password', 'normal')
        admin = vdl.db_get_user_by_username('admin')
        with vdl._db_lock, vdl.db() as conn:
            conn.execute("UPDATE downloads SET visibility = 'private', owner_user_id = ? WHERE id = 'private'", (owner['id'],))
        target = self.mutate(self.attempt()).json['id']
        original = vdl._tag_actor
        def downgrade(conn):
            conn.execute('DELETE FROM user_roles WHERE user_id = ?', (admin['id'],))
            conn.execute("INSERT INTO user_roles(user_id, role_id) SELECT ?, id FROM roles WHERE name = 'normal'", (admin['id'],))
            return original(conn)
        for action in ('create', 'replace', 'add', 'protocol-create', 'protocol-replace'):
            with vdl._db_lock, vdl.db() as conn:
                conn.execute('DELETE FROM user_roles WHERE user_id = ?', (admin['id'],))
                conn.execute("INSERT INTO user_roles(user_id, role_id) SELECT ?, id FROM roles WHERE name = 'admin'", (admin['id'],))
            client = self.authenticated_client()
            with mock.patch.object(vdl, '_tag_actor', side_effect=downgrade):
                if action == 'create':
                    response = client.post('/api/playlists', json={'name': 'Legacy', 'download_ids': ['private']})
                elif action == 'replace':
                    response = client.put('/api/playlists/' + target, json={'name': 'Legacy', 'download_ids': ['private'], 'expected_revision': 1})
                elif action == 'add':
                    response = client.post('/api/playlists/' + target + '/items', json={'download_id': 'private'})
                elif action == 'protocol-create':
                    response = self.mutate(self.attempt(ids=['private']), client=client)
                else:
                    response = self.mutate(self.attempt(ids=['private'], revision=1), target, client)
            self.assertEqual(response.status_code, 400, action)
        self.assertEqual(self.client.get('/api/playlists/' + target).json['revision'], 1)
        self.assertEqual(len(self.client.get('/api/playlists').json), 1)

    def test_collection_detail_and_receipt_redact_inaccessible_member_progress(self):
        self.video('sharedmember')
        vdl.db_create_user('viewer', 'password', 'normal')
        client = self.authenticated_client('viewer', 'password')
        payload = self.attempt(ids=['sharedmember'])
        target = self.mutate(payload, client=client).json['id']
        client.put('/api/playlists/' + target + '/progress', json={
            'download_id': 'sharedmember', 'position_seconds': 10, 'completed': False, 'write_sequence': 1,
        })
        replaced = self.attempt('Progress saved', ['sharedmember'], 1)
        self.mutate(replaced, target, client)
        vdl.db_set_download_visibility('sharedmember', 'private')
        for response in (client.get('/api/playlists'), client.get('/api/playlists/' + target), self.receipt(replaced, client)):
            value = response.json[0] if isinstance(response.json, list) else response.json
            self.assertNotIn('sharedmember', json.dumps(value))
            self.assertEqual(value['member_ids'], [None])
            self.assertEqual(value['mosaic_ids'], [])
            self.assertIsNone(value['progress'])
            self.assertTrue(value['items'][0]['unavailable'])

    def playlist_action(self, target, kind, revision=1, download_id=None, client=None,
                        payload=None):
        if payload is None:
            payload = {'client_mutation_id': self.attempt()['client_mutation_id'],
                       'expected_revision': revision}
            if kind == 'add':
                payload['download_id'] = download_id
        client = client or self.client
        url = '/api/playlists/' + target
        return (client.post(url + '/items', json=payload) if kind == 'add' else
                client.delete(url, json=payload)), payload

    def test_add_returns_ordered_canonical_ack_and_noop_receipt(self):
        for identity in ('one', 'two'):
            self.video(identity)
        target = self.mutate(self.attempt(ids=['one'])).json['id']
        added, attempt = self.playlist_action(target, 'add', download_id='two')
        self.assertEqual(added.status_code, 200)
        self.assertEqual(added.headers['Cache-Control'], 'no-store')
        self.assertEqual(added.json['member_ids'], ['one', 'two'])
        self.assertTrue(added.json['changed'])
        self.assertEqual(added.json['mutation'], {
            'id': attempt['client_mutation_id'], 'domain': 'playlist',
            'revision': 2, 'outcome': 'committed',
        })
        self.assertEqual(self.receipt(attempt).json, added.json)
        no_op, duplicate = self.playlist_action(target, 'add', 2, 'two')
        self.assertEqual(no_op.status_code, 200)
        self.assertFalse(no_op.json['changed'])
        self.assertEqual(no_op.json['revision'], 2)
        self.assertEqual(self.receipt(duplicate).json, no_op.json)

    def test_delete_ack_and_recovery_contain_only_correlated_removal(self):
        self.video('secret-member')
        target = self.mutate(self.attempt('Private title', ['secret-member'])).json['id']
        response, attempt = self.playlist_action(target, 'delete')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(set(response.json), {
            'id', 'removed', 'membership_invalidated', 'revision', 'mutation', 'server_time',
        })
        self.assertEqual(response.json['id'], target)
        self.assertTrue(response.json['removed'])
        self.assertTrue(response.json['membership_invalidated'])
        self.assertEqual(response.json['revision'], 2)
        self.assertEqual(response.json['mutation']['revision'], 2)
        self.assertEqual(self.receipt(attempt).json, response.json)
        self.assertNotIn('secret-member', json.dumps(response.json))
        self.assertNotIn('Private title', json.dumps(response.json))
        self.assertEqual(self.client.get('/api/playlists/' + target).status_code, 404)
        self.assertIsNotNone(vdl.db_get_download('secret-member'))

    def test_add_delete_simultaneous_replay_is_exactly_once(self):
        self.video('one')
        for kind in ('add', 'delete'):
            target = self.mutate(self.attempt()).json['id']
            payload = {'client_mutation_id': self.attempt()['client_mutation_id'], 'expected_revision': 1}
            if kind == 'add':
                payload['download_id'] = 'one'
            clients = [self.authenticated_client(), self.authenticated_client()]
            barrier = threading.Barrier(2)
            def send(index):
                barrier.wait()
                return self.playlist_action(target, kind, client=clients[index], payload=payload)[0]
            with ThreadPoolExecutor(max_workers=2) as pool:
                replies = list(pool.map(send, range(2)))
            self.assertEqual([reply.status_code for reply in replies], [200, 200])
            self.assertEqual(replies[0].json, replies[1].json)
            self.assertEqual(self.receipt(payload).json, replies[0].json)
            current = self.client.get('/api/playlists/' + target)
            if kind == 'add':
                self.assertEqual(current.json['member_ids'], ['one'])
                self.assertEqual(current.json['revision'], 2)
            else:
                self.assertEqual(current.status_code, 404)

    def test_add_delete_and_replace_compete_at_same_revision(self):
        self.video('one')
        for other in ('delete', 'replace', 'add'):
            target = self.mutate(self.attempt()).json['id']
            add, _ = self.playlist_action(target, 'add', download_id='one')
            if other == 'replace':
                stale = self.mutate(self.attempt('Stale', [], 1), target)
            else:
                stale, _ = self.playlist_action(target, other, download_id='one')
            self.assertEqual(add.status_code, 200)
            self.assertEqual(stale.status_code, 409)
            self.assertEqual(stale.json['mutation']['outcome'], 'conflicted')
            self.assertEqual(stale.json['member_ids'], ['one'])
            self.assertEqual(stale.json['revision'], 2)
        target = self.mutate(self.attempt()).json['id']
        self.playlist_action(target, 'delete')
        self.assertEqual(self.playlist_action(target, 'add', download_id='one')[0].status_code, 404)
        self.assertEqual(self.mutate(self.attempt(revision=1), target).status_code, 404)

    def test_delete_fences_earlier_add_receipt_and_replay(self):
        self.video('one')
        target = self.mutate(self.attempt()).json['id']
        _, add = self.playlist_action(target, 'add', download_id='one')
        self.playlist_action(target, 'delete', 2)
        self.assertEqual(self.receipt(add).status_code, 404)
        self.assertEqual(self.playlist_action(target, 'add', payload=add)[0].status_code, 404)

    def test_add_delete_fingerprint_binds_action_payload_target_and_revision(self):
        self.video('one')
        target = self.mutate(self.attempt()).json['id']
        other = self.mutate(self.attempt()).json['id']
        for kind in ('add', 'delete'):
            result, payload = self.playlist_action(target, kind, 1 if kind == 'add' else 2, 'one')
            self.assertEqual(result.status_code, 200)
            changes = [dict(payload, expected_revision=12), dict(payload, unknown=True)]
            if kind == 'add':
                changes.append(dict(payload, download_id='other'))
            for changed in changes:
                reply, _ = self.playlist_action(target, kind, payload=changed)
                self.assertEqual(reply.status_code, 409)
                self.assertEqual(reply.json['code'], 'mutation_id_conflict')
            self.assertEqual(self.playlist_action(other, kind, payload=payload)[0].json['code'], 'mutation_id_conflict')
            other_kind = 'add' if kind == 'delete' else 'delete'
            self.assertEqual(self.playlist_action(target, other_kind, payload=payload)[0].json['code'], 'mutation_id_conflict')

    def test_add_delete_validation_rejections_are_receipted(self):
        self.video('one')
        target = self.mutate(self.attempt()).json['id']
        for kind in ('add', 'delete'):
            for revision in (True, '1', 0, -1, 1.0, None):
                response, payload = self.playlist_action(target, kind, revision, 'one')
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json['mutation']['outcome'], 'rejected')
                self.assertEqual(self.receipt(payload).json, response.json)
            response, payload = self.playlist_action(target, kind, payload={
                'client_mutation_id': self.attempt()['client_mutation_id'],
                'expected_revision': 1, 'shared': True,
            })
            self.assertEqual(response.status_code, 400)
            self.assertEqual(self.receipt(payload).json, response.json)
        for identity in (None, '', 'missing', 123):
            response, payload = self.playlist_action(target, 'add', download_id=identity)
            self.assertEqual(response.status_code, 400)
            self.assertIn('download_id', response.json['field_errors'])
            self.assertEqual(self.receipt(payload).json, response.json)
        with mock.patch.object(vdl, 'PLAYLIST_MAX_ITEMS', 0):
            response, _ = self.playlist_action(target, 'add', download_id='one')
            self.assertEqual(response.status_code, 400)
        for kind in ('add', 'delete'):
            self.assertEqual(self.playlist_action(target, kind, payload={'client_mutation_id': 'bad'})[0].status_code, 400)
        self.assertEqual(self.client.delete('/api/playlists/' + target, json=[]).status_code, 400)
        self.assertEqual(self.client.delete('/api/playlists/' + target, data='broken', content_type='application/json').status_code, 400)

    def test_add_delete_receipt_failure_rolls_back_membership_and_removal(self):
        self.video('one')
        self.video('two')
        original = vdl.db
        @contextmanager
        def failing_db():
            with original() as conn:
                class Connection:
                    def __getattr__(self, name):
                        return getattr(conn, name)
                    def execute(self, sql, *args):
                        if sql.startswith('INSERT INTO mutation_receipts'):
                            raise RuntimeError('receipt failure')
                        return conn.execute(sql, *args)
                yield Connection()
        target = self.mutate(self.attempt(ids=['one'])).json['id']
        self.client.put('/api/playlists/' + target + '/progress', json={
            'download_id': 'one', 'position_seconds': 12, 'completed': False, 'write_sequence': 1,
        })
        before = self.client.get('/api/playlists/' + target).json
        for kind in ('add', 'delete'):
            payload = {'client_mutation_id': self.attempt()['client_mutation_id'], 'expected_revision': 1}
            if kind == 'add':
                payload['download_id'] = 'two'
            with mock.patch.object(vdl, 'db', failing_db), self.assertRaises(RuntimeError):
                self.playlist_action(target, kind, payload=payload)
            self.assertEqual(self.receipt(payload).status_code, 404)
            self.assertEqual(self.client.get('/api/playlists/' + target).json, before)

    def test_add_delete_response_loss_and_restart_recover_without_second_write(self):
        self.video('one')
        for kind in ('add', 'delete'):
            target = self.mutate(self.attempt()).json['id']
            with mock.patch.object(vdl, '_publish_metadata_change', side_effect=RuntimeError('response lost')):
                payload = {'client_mutation_id': self.attempt()['client_mutation_id'], 'expected_revision': 1}
                if kind == 'add':
                    payload['download_id'] = 'one'
                with self.assertRaises(RuntimeError):
                    self.playlist_action(target, kind, payload=payload)
            # Reinitializing the database models a new process with only durable
            # state; no client or process-local operation record is needed.
            vdl.init_db()
            recovered = self.receipt(payload)
            replayed, _ = self.playlist_action(target, kind, payload=payload)
            self.assertEqual(recovered.status_code, 200)
            self.assertEqual(replayed.json, recovered.json)
            self.assertEqual(recovered.json['revision'], 2)

    def test_delete_recovery_is_actor_scoped_and_rechecks_active_account(self):
        user = vdl.db_create_user('editor', 'password', 'normal')
        client = self.authenticated_client('editor', 'password')
        target = self.mutate(self.attempt('Secret title'), client=client).json['id']
        response, payload = self.playlist_action(target, 'delete', client=client)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.receipt(payload).status_code, 404)
        self.assertEqual(self.playlist_action(target, 'delete', payload=payload)[0].status_code, 404)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE users SET session_version = session_version + 1 WHERE id = ?', (user['id'],))
        self.assertEqual(self.receipt(payload, client).status_code, 401)
        self.assertEqual(self.playlist_action(target, 'delete', client=client, payload=payload)[0].status_code, 401)
        client = self.authenticated_client('editor', 'password')
        self.assertEqual(self.receipt(payload, client).json, response.json)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE users SET suspended = 1 WHERE id = ?', (user['id'],))
        self.assertEqual(self.receipt(payload, client).status_code, 401)

    def test_add_authorization_race_and_recovery_redact_lost_member_access(self):
        self.video('secret')
        vdl.db_create_user('editor', 'password', 'normal')
        client = self.authenticated_client('editor', 'password')
        target = self.mutate(self.attempt(), client=client).json['id']
        original = vdl._tag_actor
        def hide(conn):
            conn.execute("UPDATE downloads SET visibility = 'private' WHERE id = 'secret'")
            return original(conn)
        with mock.patch.object(vdl, '_tag_actor', side_effect=hide):
            response, rejected = self.playlist_action(target, 'add', download_id='secret', client=client)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json['member_ids'], [])
        vdl.db_set_download_visibility('secret', 'public')
        response, payload = self.playlist_action(target, 'add', download_id='secret', client=client)
        self.assertEqual(response.status_code, 200)
        vdl.db_set_download_visibility('secret', 'private')
        for recovered in (self.receipt(payload, client), self.playlist_action(target, 'add', client=client, payload=payload)[0]):
            self.assertEqual(recovered.status_code, 200)
            self.assertEqual(recovered.json['member_ids'], [None])
            self.assertNotIn('secret', json.dumps(recovered.json))
        no_op, _ = self.playlist_action(target, 'add', 2, 'secret', client=client)
        self.assertEqual(no_op.status_code, 400)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE playlists SET owner_user_id = ? WHERE id = ?',
                         (vdl.db_get_user_by_username('admin')['id'], target))
        self.assertEqual(self.receipt(payload, client).status_code, 404)
        self.assertEqual(self.playlist_action(target, 'add', client=client, payload=payload)[0].status_code, 404)

    def test_add_delete_use_shared_quota_expiry_namespace_and_finality(self):
        self.video('one')
        target = self.mutate(self.attempt()).json['id']
        for kind in ('add', 'delete'):
            for limit in ('MUTATION_ACTOR_RECEIPT_LIMIT', 'MUTATION_ACTOR_MINUTE_LIMIT'):
                with mock.patch.object(vdl, limit, 1):
                    self.assertEqual(self.playlist_action(target, kind, download_id='one')[0].status_code, 429)
            for created in (time.time() - 86401, time.time() + 301):
                payload = {'client_mutation_id': self.attempt(created=created)['client_mutation_id'], 'expected_revision': 1}
                if kind == 'add':
                    payload['download_id'] = 'one'
                rejected, _ = self.playlist_action(target, kind, payload=payload)
                self.assertEqual(rejected.status_code, 400)
                self.assertEqual(rejected.json['mutation']['outcome'], 'rejected')
                self.assertEqual(self.receipt(payload).json, rejected.json)
            namespace = self.attempt()
            self.mutate(namespace)
            payload = {'client_mutation_id': namespace['client_mutation_id'], 'expected_revision': 1}
            if kind == 'add':
                payload['download_id'] = 'one'
            self.assertEqual(self.playlist_action(target, kind, payload=payload)[0].json['code'], 'mutation_id_conflict')
        expired = self.attempt(created=time.time() - 86401)
        self.assertTrue(self.receipt(expired).json['final'])
        self.assertFalse(self.receipt(self.attempt()).json['final'])

    def test_add_delete_preserve_request_security_progress_and_worker_ownership(self):
        self.video('one')
        target = self.mutate(self.attempt(ids=['one'])).json['id']
        self.client.put('/api/playlists/' + target + '/progress', json={
            'download_id': 'one', 'position_seconds': 12, 'completed': False, 'write_sequence': 1,
        })
        before = self.client.get('/api/playlists/' + target).json['progress']
        for kind in ('add', 'delete'):
            url = '/api/playlists/' + target + ('/items' if kind == 'add' else '')
            sender = self.client.post if kind == 'add' else self.client.delete
            self.assertEqual(sender(url, json={'client_mutation_id': self.attempt()['client_mutation_id'], 'expected_revision': 1},
                                    headers={'Origin': 'https://attacker.invalid'}).status_code, 403)
        with mock.patch.object(vdl, '_new_rotation_members', side_effect=AssertionError('rotation changed')):
            added, _ = self.playlist_action(target, 'add', download_id='one')
            self.assertEqual(added.json['progress'], before)
            removed, _ = self.playlist_action(target, 'delete')
            self.assertEqual(removed.status_code, 200)
        self.assertEqual(vdl._playback_sessions, {})
        self.assertIsNotNone(vdl.db_get_download('one'))

    def test_delete_receipt_does_not_authorize_a_reused_foreign_identity(self):
        target = self.mutate(self.attempt()).json['id']
        _, payload = self.playlist_action(target, 'delete')
        owner = vdl.db_create_user('other-owner', 'password', 'normal')
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('INSERT INTO playlists(id, owner_user_id, name, revision, created_at, content_updated_at) VALUES (?, ?, ?, 1, ?, ?)',
                         (target, owner['id'], 'Other private playlist', time.time(), time.time()))
        self.assertEqual(self.receipt(payload).status_code, 404)
        self.assertEqual(self.playlist_action(target, 'delete', payload=payload)[0].status_code, 404)

    def test_add_delete_expired_recovery_waits_behind_admitted_commit(self):
        self.video('one')
        original = vdl.db
        for kind in ('add', 'delete'):
            target = self.mutate(self.attempt()).json['id']
            clients = [self.authenticated_client(), self.authenticated_client()]
            real_now = time.time()
            payload = {'client_mutation_id': self.attempt(created=real_now - vdl.MUTATION_REPLAY_SECONDS + 1)['client_mutation_id'],
                       'expected_revision': 1}
            if kind == 'add':
                payload['download_id'] = 'one'
            clock = [real_now]
            written, release, recovering = threading.Event(), threading.Event(), threading.Event()
            @contextmanager
            def gated_db():
                with original() as conn:
                    class Connection:
                        def __getattr__(self, name):
                            return getattr(conn, name)
                        def execute(self, sql, *args):
                            if sql.startswith('INSERT INTO mutation_receipts'):
                                written.set()
                                if not release.wait(5):
                                    raise AssertionError('receipt gate was not released')
                            return conn.execute(sql, *args)
                    yield Connection()
            def recover():
                recovering.set()
                return self.receipt(payload, clients[1])
            with mock.patch.object(vdl, 'db', gated_db), mock.patch.object(vdl.time, 'time', side_effect=lambda: clock[0]):
                with ThreadPoolExecutor(max_workers=2) as pool:
                    write = pool.submit(self.playlist_action, target, kind, client=clients[0], payload=payload)
                    self.assertTrue(written.wait(5))
                    clock[0] += 2
                    recovery = pool.submit(recover)
                    self.assertTrue(recovering.wait(5))
                    self.assertFalse(recovery.done())
                    release.set()
                    committed = write.result(5)[0]
                    recovered = recovery.result(5)
            self.assertEqual(committed.status_code, 200)
            self.assertEqual(recovered.json, committed.json)

    def test_add_delete_share_pending_rename_namespace_and_quota(self):
        self.video('rename-source')
        target = self.mutate(self.attempt()).json['id']
        attempt = self.attempt()
        def crash(phase, operation):
            if phase == 'prepared':
                raise RuntimeError('injected restart')
        with mock.patch.object(vdl, '_rename_checkpoint', side_effect=crash), self.assertRaises(RuntimeError):
            self.client.post('/api/rename/rename-source', json={
                'filename': 'New', 'expected_revision': '1',
                'client_mutation_id': attempt['client_mutation_id'],
            })
        with vdl.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM rename_operations').fetchone()[0], 1)
        for kind in ('add', 'delete'):
            payload = {'client_mutation_id': attempt['client_mutation_id'], 'expected_revision': 1}
            if kind == 'add':
                payload['download_id'] = 'rename-source'
            self.assertEqual(self.playlist_action(target, kind, payload=payload)[0].json['code'], 'mutation_id_conflict')
            # The creation receipt plus the active rename exhaust this quota.
            with mock.patch.object(vdl, 'MUTATION_ACTOR_RECEIPT_LIMIT', 2):
                self.assertEqual(self.playlist_action(target, kind, download_id='rename-source')[0].status_code, 429)

    def test_add_delete_transaction_rechecks_session_before_effects(self):
        self.video('one')
        target = self.mutate(self.attempt()).json['id']
        actor_id = vdl.db_get_user_by_username('admin')['id']
        original = vdl._tag_actor
        def expire(conn):
            conn.execute('UPDATE users SET session_version = session_version + 1 WHERE id = ?', (actor_id,))
            return original(conn)
        for kind in ('add', 'delete'):
            client = self.authenticated_client()
            with mock.patch.object(vdl, '_tag_actor', side_effect=expire):
                response, _ = self.playlist_action(target, kind, download_id='one', client=client)
            self.assertEqual(response.status_code, 401)
        self.client = self.authenticated_client()
        self.assertEqual(self.client.get('/api/playlists/' + target).json['member_ids'], [])
        self.assertEqual(self.client.get('/api/playlists/' + target).json['revision'], 1)

    def test_delete_receipt_recovery_is_invalidated_by_account_removal(self):
        user = vdl.db_create_user('removed-owner', 'password', 'normal')
        client = self.authenticated_client('removed-owner', 'password')
        target = self.mutate(self.attempt(), client=client).json['id']
        _, payload = self.playlist_action(target, 'delete', client=client)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('DELETE FROM users WHERE id = ?', (user['id'],))
        self.assertEqual(self.receipt(payload, client).status_code, 401)
        self.assertEqual(self.playlist_action(target, 'delete', payload=payload, client=client)[0].status_code, 401)

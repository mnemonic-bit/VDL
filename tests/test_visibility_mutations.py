"""Visibility writes and recovery preserve current authorization and revisions."""
import secrets
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class VisibilityMutationProtocolTest(AppCase):
    def setUp(self):
        super().setUp()
        self.owner = vdl.db_create_user('visibilityowner', 'owner-password', 'normal')
        self.viewer = vdl.db_create_user('visibilityviewer', 'viewer-password', 'normal')
        self.owner_client = self.authenticated_client('visibilityowner', 'owner-password')
        self.viewer_client = self.authenticated_client('visibilityviewer', 'viewer-password')
        vdl.db_insert_download('visibilityproto', 'https://fixture.invalid/video',
                               self.owner['id'], self.owner['username'])

    def attempt(self, visibility='private', revision='0', created=None):
        return {'visibility': visibility, 'expected_revision': revision,
                'client_mutation_id': f'{int((time.time() if created is None else created) * 1000)}-{secrets.token_hex(16)}'}

    def mutate(self, payload, client=None, target='visibilityproto'):
        return (client or self.owner_client).post('/api/visibility/' + target, json=payload)

    def state(self, client=None):
        return (client or self.owner_client).get('/api/downloads/visibilityproto/editable-state')

    def receipt(self, payload, client=None):
        return (client or self.owner_client).get('/api/mutations/' + payload['client_mutation_id'])

    def test_canonical_acknowledgement_capability_and_every_serializer(self):
        self.assertIn('visibility.set', self.client.get('/api/client-capabilities').json['actions'])
        payload = self.attempt()
        response = self.mutate(payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(response.json['mutation'], {'id': payload['client_mutation_id'],
                         'domain': 'visibility', 'revision': '1', 'outcome': 'committed'})
        for state in (response.json, self.state().json,
                      self.owner_client.get('/api/current-downloads').json[0]):
            self.assertEqual((state['visibility'], state['visibility_revision']), ('private', '1'))
            self.assertTrue(state['can_manage_visibility'])
            self.assertTrue(state['can_delete'])
            self.assertTrue(state['permissions']['visibility'])
        self.assertEqual(vdl.db_get_download('visibilityproto')['visibility_revision'], '1')
        self.assertEqual(vdl.db_list_downloads()[0]['visibility_revision'], '1')
        self.finished_file('visibilityproto')
        self.assertEqual(self.owner_client.get('/api/library').json[0]['visibility_revision'], '1')
        self.assertEqual(self.owner_client.get('/api/library-catalog').json[0]['visibility_revision'], '1')

    def test_all_writers_increment_only_actual_changes_and_restart_persists(self):
        self.mutate({'visibility': 'private'})
        self.assertEqual(self.state().json['visibility_revision'], '1')
        self.assertFalse(vdl.db_set_download_visibility('visibilityproto', 'private'))
        self.assertTrue(vdl.db_set_download_visibility('visibilityproto', 'public'))
        with vdl._db_lock, vdl.db() as conn:
            conn.execute("UPDATE downloads SET visibility='private' WHERE id='visibilityproto'")
        vdl.init_db()
        self.assertEqual(self.state().json['visibility_revision'], '3')
        response = self.mutate(self.attempt('private', '3'))
        self.assertFalse(response.json['changed'])
        self.assertEqual(response.json['visibility_revision'], '3')
        self.assertIsNone(vdl.db_set_download_visibility('missing', 'private'))

    def test_upgrade_adds_revision_without_replacing_visibility(self):
        vdl.db_set_download_visibility('visibilityproto', 'private')
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('DROP TRIGGER download_visibility_revision')
            conn.execute('ALTER TABLE downloads DROP COLUMN visibility_revision')
        vdl.init_db()
        self.assertEqual((self.state().json['visibility'], self.state().json['visibility_revision']), ('private', '0'))
        self.mutate({'visibility': 'public'})
        self.assertEqual(self.state().json['visibility_revision'], '1')

    def test_unrelated_metadata_progress_and_worker_changes_do_not_conflict(self):
        self.owner_client.post('/api/tags/visibilityproto', json={'tag': 'Independent'})
        self.owner_client.post('/api/favorite/visibilityproto', json={'favorite': True})
        vdl.db_update_download('visibilityproto', status='downloading', progress='50%')
        self.finished_file('visibilityproto')
        vdl.db_increment_view_count('visibilityproto')
        self.assertEqual(self.state().json['visibility_revision'], '0')
        self.assertEqual(self.mutate(self.attempt()).status_code, 200)
        self.assertEqual(self.state().json['tags_revision'], '1')
        self.assertEqual(self.state().json['favorite_revision'], '1')

    def test_public_viewer_gets_current_permissions_without_visibility_authority(self):
        state = self.state(self.viewer_client).json
        self.assertEqual(state['visibility'], 'public')
        self.assertFalse(state['can_manage_visibility'])
        self.assertFalse(state['permissions']['visibility'])
        self.assertTrue(state['can_delete'])
        response = self.mutate(self.attempt(), self.viewer_client)
        self.assertEqual(response.status_code, 403)
        self.assertNotIn('visibility', response.json)
        self.assertEqual(self.state().json['visibility_revision'], '0')

    def test_conflict_requires_current_state_and_canonical_receipt_snapshot(self):
        self.mutate({'visibility': 'private'})
        payload = self.attempt('public')
        conflict = self.mutate(payload)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json['mutation']['outcome'], 'conflicted')
        self.assertEqual(conflict.json['visibility'], 'private')
        self.mutate({'visibility': 'public'})
        for response in (self.mutate(payload), self.receipt(payload)):
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json['mutation'], conflict.json['mutation'])
            self.assertEqual((response.json['visibility'], response.json['visibility_revision']), ('public', '2'))

    def test_lost_ack_replays_original_outcome_with_current_security_snapshot(self):
        payload = self.attempt()
        committed = self.mutate(payload).json
        self.mutate({'visibility': 'public'})
        vdl.init_db()
        for response in (self.mutate(payload), self.receipt(payload)):
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json['mutation'], committed['mutation'])
            self.assertEqual((response.json['visibility'], response.json['visibility_revision']), ('public', '2'))
        self.assertEqual(self.receipt(payload).headers['Cache-Control'], 'no-store')

    def test_simultaneous_replay_is_one_write_and_competing_writes_conflict(self):
        clients = [self.authenticated_client('visibilityowner', 'owner-password') for _ in range(2)]
        barrier = threading.Barrier(2)
        payload = self.attempt()
        def replay(index):
            barrier.wait()
            return self.mutate(payload, clients[index])
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(replay, range(2)))
        self.assertEqual([response.status_code for response in responses], [200, 200])
        self.assertEqual(responses[0].json, responses[1].json)
        payloads = [self.attempt('public', '1') for _ in range(2)]
        def competing(index):
            barrier.wait()
            return self.mutate(payloads[index], clients[index])
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(competing, range(2)))
        self.assertEqual(sorted(response.status_code for response in responses), [200, 409])
        self.assertEqual(self.state().json['visibility_revision'], '2')

    def test_fingerprint_binds_value_revision_target_and_action(self):
        payload = self.attempt()
        self.mutate(payload)
        vdl.db_insert_download('othervisibility', 'https://fixture.invalid/other',
                               self.owner['id'], self.owner['username'])
        for response in (self.mutate(dict(payload, visibility='public')),
                         self.mutate(dict(payload, expected_revision='1')),
                         self.mutate(dict(payload, unrecognized=True)),
                         self.mutate(payload, target='othervisibility'),
                         self.owner_client.post('/api/favorite/visibilityproto', json=dict(payload, favorite=True))):
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json['code'], 'mutation_id_conflict')
        self.assertEqual(self.state().json['visibility_revision'], '1')

    def test_receipt_failure_rolls_back_value_revision_and_receipt(self):
        original = vdl.db
        @contextmanager
        def failing_db():
            with original() as conn:
                class Connection:
                    def execute(self, sql, *args):
                        if sql.startswith('INSERT INTO mutation_receipts'):
                            raise RuntimeError('injected receipt failure')
                        return conn.execute(sql, *args)
                yield Connection()
        payload = self.attempt()
        with mock.patch.object(vdl, 'db', failing_db):
            with self.assertRaises(RuntimeError):
                self.mutate(payload)
        vdl.init_db()
        self.assertEqual((self.state().json['visibility'], self.state().json['visibility_revision']), ('public', '0'))
        self.assertEqual(self.receipt(payload).status_code, 404)

    def test_commit_before_response_failure_is_recoverable(self):
        payload = self.attempt()
        with mock.patch.object(vdl, 'jsonify', side_effect=RuntimeError('lost response')):
            with self.assertRaises(RuntimeError):
                self.mutate(payload)
        recovered = self.receipt(payload)
        self.assertEqual(recovered.status_code, 200)
        self.assertEqual(recovered.json['mutation']['outcome'], 'committed')
        self.assertEqual(self.mutate(payload).json, recovered.json)
        self.assertEqual(self.state().json['visibility_revision'], '1')

    def test_expired_absence_serializes_behind_admitted_write(self):
        clients = [self.authenticated_client('visibilityowner', 'owner-password') for _ in range(2)]
        now = time.time()
        clock = [now]
        payload = self.attempt(created=now - vdl.MUTATION_REPLAY_SECONDS + 1)
        entered, release, recovering = threading.Event(), threading.Event(), threading.Event()
        original = vdl._visibility_snapshot
        calls = 0
        def hold_after_write(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                entered.set()
                if not release.wait(5):
                    raise AssertionError('visibility write gate was not released')
            return original(*args, **kwargs)
        def recover():
            recovering.set()
            return self.receipt(payload, clients[1])
        with mock.patch.object(vdl.time, 'time', side_effect=lambda: clock[0]), \
                mock.patch.object(vdl, '_visibility_snapshot', side_effect=hold_after_write):
            with ThreadPoolExecutor(max_workers=2) as pool:
                write = pool.submit(self.mutate, payload, clients[0])
                self.assertTrue(entered.wait(5))
                clock[0] += 2
                recovery = pool.submit(recover)
                self.assertTrue(recovering.wait(5))
                self.assertFalse(recovery.done())
                release.set()
                committed, recovered = write.result(5), recovery.result(5)
        self.assertEqual(recovered.json, committed.json)
        self.assertEqual(committed.status_code, 200)

    def test_invalid_payloads_limits_and_expiry_are_definite_rejections(self):
        for value in (None, True, 0, [], {}, 'friends'):
            payload = self.attempt(value)
            response = self.mutate(payload)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json['mutation']['outcome'], 'rejected')
            self.assertEqual(self.receipt(payload).json, response.json)
        for revision in (None, 0, '-1', '01', '9' * 1000):
            self.assertEqual(self.mutate(self.attempt(revision=revision)).status_code, 400)
        for created in (time.time() - 86401, time.time() + 301):
            self.assertEqual(self.mutate(self.attempt(created=created)).json['mutation']['outcome'], 'rejected')
        self.assertEqual(self.mutate(dict(self.attempt(), client_mutation_id='bad')).status_code, 400)
        self.assertEqual(self.mutate(dict(self.attempt(), unrecognized=True)).status_code, 400)
        self.assertEqual(self.mutate({'visibility': 'x' * 5000}).status_code, 413)
        self.assertEqual(self.mutate([]).status_code, 400)
        self.assertEqual(self.owner_client.post('/api/visibility/visibilityproto', data='x').status_code, 415)
        self.assertEqual(self.state().json['visibility_revision'], '0')

    def test_shared_quota_preserves_recovery_and_expired_absence_is_final(self):
        payload = self.attempt()
        self.mutate(payload)
        for limit in ('MUTATION_ACTOR_RECEIPT_LIMIT', 'MUTATION_ACTOR_MINUTE_LIMIT'):
            with mock.patch.object(vdl, limit, 1):
                self.assertEqual(self.mutate(self.attempt('public', '1')).status_code, 429)
                self.assertEqual(self.mutate(payload).status_code, 200)
        expired = self.attempt(created=time.time() - 86401)
        self.assertTrue(self.receipt(expired).json['final'])
        self.assertEqual(self.mutate(expired).json['mutation']['outcome'], 'rejected')
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE mutation_receipts SET recorded_at=?', (time.time() - 172801,))
        self.mutate(self.attempt('public', '1'))
        self.assertEqual(self.receipt(payload).status_code, 404)
        self.assertFalse(self.receipt(payload).json['final'])

    def test_receipts_are_actor_scoped_and_hidden_after_access_loss_or_deletion(self):
        payload = self.attempt()
        self.mutate(payload)
        self.assertEqual(self.receipt(payload, self.viewer_client).json,
                         self.receipt(self.attempt(), self.viewer_client).json)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE downloads SET owner_user_id=NULL WHERE id=?', ('visibilityproto',))
        self.assertEqual(self.mutate(payload).status_code, 404)
        self.assertEqual(self.receipt(payload).status_code, 404)
        self.assertNotIn('visibility', self.receipt(payload).json)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('DELETE FROM downloads WHERE id=?', ('visibilityproto',))
        self.assertEqual(self.receipt(payload, self.client).status_code, 404)

    def test_management_revocation_on_public_item_fences_receipt_and_replay(self):
        payload = self.attempt('public')
        self.mutate(payload)
        expired = self.attempt('public', created=time.time() - vdl.MUTATION_REPLAY_SECONDS - 1)
        self.assertEqual(self.mutate(expired).status_code, 400)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE downloads SET owner_user_id=NULL WHERE id=?', ('visibilityproto',))
        self.assertEqual(self.state().status_code, 200)
        self.assertFalse(self.state().json['can_manage_visibility'])
        self.assertEqual(self.mutate(payload).status_code, 403)
        self.assertEqual(self.receipt(payload).status_code, 404)
        self.assertNotIn('visibility', self.receipt(payload).json)
        self.assertEqual(self.receipt(payload).json, self.receipt(self.attempt()).json)
        self.assertEqual(self.receipt(payload).json, {'error': 'Mutation unavailable', 'final': False})
        expired_missing = self.attempt(created=time.time() - vdl.MUTATION_REPLAY_SECONDS - 1)
        self.assertEqual(self.receipt(expired).json, self.receipt(expired_missing).json)
        self.assertEqual(self.receipt(expired).json, {'error': 'Mutation unavailable', 'final': True})
        self.assertEqual(self.state().json['visibility'], 'public')
        self.assertFalse(self.state().json['permissions']['visibility'])

    def test_legacy_protocol_and_recovery_recheck_session_and_current_role(self):
        original = vdl._tag_actor
        def expire(conn):
            conn.execute('UPDATE users SET session_version=session_version+1 WHERE id=?', (self.owner['id'],))
            return original(conn)
        for payload in ({'visibility': 'private'}, self.attempt()):
            with mock.patch.object(vdl, '_tag_actor', side_effect=expire):
                self.assertEqual(self.mutate(payload).status_code, 401)
            with vdl._db_lock, vdl.db() as conn:
                conn.execute('UPDATE users SET session_version=session_version-1 WHERE id=?', (self.owner['id'],))
        payload = self.attempt('public')
        self.mutate(payload)
        with mock.patch.object(vdl, '_tag_actor', side_effect=expire):
            self.assertEqual(self.receipt(payload).status_code, 401)
        self.assertEqual(vdl.app.test_client().post('/api/visibility/visibilityproto', json=self.attempt()).status_code, 401)

    def test_serialized_ownership_and_suspension_checks_precede_write(self):
        original = vdl._tag_actor
        def revoke_owner(conn):
            conn.execute('UPDATE downloads SET owner_user_id=NULL WHERE id=?', ('visibilityproto',))
            return original(conn)
        with mock.patch.object(vdl, '_tag_actor', side_effect=revoke_owner):
            self.assertEqual(self.mutate(self.attempt()).status_code, 403)
        def suspend(conn):
            conn.execute('UPDATE users SET suspended=1 WHERE id=?', (self.owner['id'],))
            return original(conn)
        with mock.patch.object(vdl, '_tag_actor', side_effect=suspend):
            self.assertEqual(self.mutate({'visibility': 'private'}).status_code, 401)
        self.assertEqual(vdl.db_get_download('visibilityproto')['visibility_revision'], '0')

    def test_security_snapshot_values_and_permissions_share_authorized_transaction(self):
        original = vdl._tag_snapshot
        def concurrent_write(conn, download_id, row=None):
            vdl.db_set_download_visibility(download_id, 'private')
            return original(conn, download_id, row)
        with mock.patch.object(vdl, '_tag_snapshot', side_effect=concurrent_write):
            state = self.state(self.viewer_client)
        self.assertEqual(state.status_code, 200)
        self.assertEqual((state.json['visibility'], state.json['visibility_revision']), ('public', '0'))
        self.assertFalse(state.json['can_manage_visibility'])
        self.assertEqual(self.state(self.viewer_client).status_code, 404)

    def test_current_admin_role_is_rechecked_before_write_and_recovery(self):
        payload = self.attempt('public')
        self.assertEqual(self.mutate(payload, self.client).status_code, 200)
        original = vdl._tag_actor
        def demote(conn):
            conn.execute("DELETE FROM user_roles WHERE user_id=(SELECT id FROM users WHERE username='admin')")
            return original(conn)
        with mock.patch.object(vdl, '_tag_actor', side_effect=demote):
            self.assertEqual(self.receipt(payload, self.client).status_code, 404)
        self.assertEqual(self.mutate(payload, self.client).status_code, 403)
        self.assertEqual(self.state().json['visibility_revision'], '0')

    def test_collection_snapshot_uses_current_role_after_route_authentication(self):
        vdl.db_set_download_visibility('visibilityproto', 'private')
        self.finished_file('visibilityproto')
        original = vdl._tag_actor
        def demote(conn):
            conn.execute("DELETE FROM user_roles WHERE user_id=(SELECT id FROM users WHERE username='admin')")
            return original(conn)
        with mock.patch.object(vdl, '_tag_actor', side_effect=demote):
            response = self.client.get('/api/library')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, [])

    def test_collection_and_storage_reject_session_revoked_after_route_authentication(self):
        original = vdl._tag_actor
        def suspend(conn):
            conn.execute('UPDATE users SET suspended=1 WHERE id=?', (self.viewer['id'],))
            return original(conn)
        with mock.patch.object(vdl, '_tag_actor', side_effect=suspend):
            self.assertEqual(self.viewer_client.get('/api/library').status_code, 401)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE users SET suspended=0 WHERE id=?', (self.viewer['id'],))
        with mock.patch.object(vdl, '_tag_actor', side_effect=suspend):
            self.assertEqual(self.viewer_client.get('/api/library-storage').status_code, 401)

    def test_generic_sse_publication_and_postcommit_failure(self):
        subscriber = vdl.event_bus.subscribe()
        payload = self.attempt()
        response = self.mutate(payload)
        self.assertEqual(subscriber.get_nowait(), ('change', {'reason': 'visibility'}))
        self.assertTrue(subscriber.empty())
        self.assertEqual(self.receipt(payload).json, response.json)
        with mock.patch.object(vdl.event_bus, 'publish', side_effect=RuntimeError('unavailable')):
            response = self.mutate(self.attempt('public', '1'))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.state().json['visibility_revision'], '2')
        denied = self.owner_client.post('/api/visibility/visibilityproto', json=self.attempt(),
                                       headers={'Origin': 'https://attacker.invalid'})
        self.assertEqual(denied.status_code, 403)


if __name__ == '__main__':
    unittest.main()

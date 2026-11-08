"""Favorite revisions and receipt recovery through the actual HTTP routes."""
import secrets
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class FavoriteMutationProtocolTest(AppCase):
    def setUp(self):
        super().setUp()
        self.insert('favoriteproto')

    def attempt(self, favorite=True, revision='0', created=None):
        return {
            'favorite': favorite, 'expected_revision': revision,
            'client_mutation_id': f'{int((time.time() if created is None else created) * 1000)}-{secrets.token_hex(16)}',
        }

    def mutate(self, payload, client=None, target='favoriteproto'):
        return (client or self.client).post('/api/favorite/' + target, json=payload)

    def state(self, client=None):
        return (client or self.client).get('/api/downloads/favoriteproto/editable-state')

    def receipt(self, payload, client=None):
        return (client or self.client).get('/api/mutations/' + payload['client_mutation_id'])

    def test_capability_and_all_read_serializers(self):
        self.assertIn('favorite.set', self.client.get('/api/client-capabilities').json['actions'])
        payload = self.attempt()
        response = self.mutate(payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(response.json['mutation'], {
            'id': payload['client_mutation_id'], 'domain': 'favorite',
            'outcome': 'committed', 'revision': '1',
        })
        for entry in (self.state().json, vdl.db_get_download('favoriteproto'),
                      vdl.db_list_downloads()[0], self.client.get('/api/current-downloads').json[0]):
            self.assertIs(entry['favorite'], True)
            self.assertEqual(entry['favorite_revision'], '1')
        self.finished_file('favoriteproto')
        entry = self.client.get('/api/library').json[0]
        self.assertEqual((entry['favorite'], entry['favorite_revision']), (True, '1'))
        self.assertEqual(self.state().json['permissions'], {'tags': True, 'favorite': True})

    def test_legacy_helper_raw_writer_noops_and_restart(self):
        for writer in (lambda: self.mutate({'favorite': True}),
                       lambda: vdl.db_set_download_favorite('favoriteproto', True)):
            writer()
            self.assertEqual(self.state().json['favorite_revision'], '1')
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE downloads SET favorite = 0 WHERE id = ?', ('favoriteproto',))
        self.assertEqual(self.state().json['favorite_revision'], '2')
        vdl.init_db()
        self.assertEqual(self.state().json['favorite_revision'], '2')
        response = self.mutate(self.attempt(False, '2'))
        self.assertFalse(response.json['changed'])
        self.assertEqual(response.json['favorite_revision'], '2')
        self.assertIsNone(vdl.db_set_download_favorite('missing', True))

    def test_existing_database_upgrade_preserves_favorite_values(self):
        vdl.db_set_download_favorite('favoriteproto', True)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('DROP TRIGGER download_favorite_revision')
            conn.execute('ALTER TABLE downloads DROP COLUMN favorite_revision')
        vdl.init_db()
        self.assertEqual((self.state().json['favorite'], self.state().json['favorite_revision']), (True, '0'))
        self.mutate({'favorite': False})
        self.assertEqual(self.state().json['favorite_revision'], '1')

    def test_unrelated_domains_do_not_advance_favorite_revision(self):
        self.mutate(self.attempt())
        self.client.post('/api/tags/favoriteproto', json={'tag': 'Independent'})
        vdl.db_update_download('favoriteproto', progress='50%', status='downloading')
        vdl.db_set_download_visibility('favoriteproto', 'private')
        self.finished_file('favoriteproto')
        vdl.db_increment_view_count('favoriteproto')
        state = self.state().json
        self.assertEqual((state['tags_revision'], state['favorite_revision']), ('1', '1'))
        self.assertEqual(self.mutate(self.attempt(False, '1')).status_code, 200)

    def test_conflict_and_old_receipts_preserve_original_canonical_result(self):
        self.mutate({'favorite': True})
        payload = self.attempt(False)
        conflict = self.mutate(payload)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json['mutation']['outcome'], 'conflicted')
        self.mutate({'favorite': False})
        for response in (self.mutate(payload), self.receipt(payload)):
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json, conflict.json)
        self.assertEqual((self.state().json['favorite'], self.state().json['favorite_revision']), (False, '2'))

    def test_lost_response_and_replay_after_newer_edit_or_restart(self):
        payload = self.attempt()
        committed = self.mutate(payload).json
        self.mutate({'favorite': False})
        vdl.init_db()
        for response in (self.mutate(payload), self.receipt(payload)):
            self.assertEqual(response.json, committed)
            self.assertNotIn('available_tags', response.json)
        self.assertEqual(self.state().json['favorite_revision'], '2')
        self.assertEqual(self.receipt(payload).headers['Cache-Control'], 'no-store')

    def test_simultaneous_replay_and_competing_revisions(self):
        clients = [self.authenticated_client(), self.authenticated_client()]
        barrier = threading.Barrier(2)
        payload = self.attempt()
        def send(index):
            barrier.wait()
            return self.mutate(payload, clients[index])
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(send, range(2)))
        self.assertEqual([result.status_code for result in results], [200, 200])
        self.assertEqual(results[0].json, results[1].json)
        self.assertEqual(self.state().json['favorite_revision'], '1')
        payloads = [self.attempt(False, '1'), self.attempt(False, '1')]
        def compete(index):
            barrier.wait()
            return self.mutate(payloads[index], clients[index])
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(compete, range(2)))
        self.assertEqual(sorted(response.status_code for response in results), [200, 409])
        self.assertEqual(self.state().json['favorite_revision'], '2')

    def test_fingerprint_binds_boolean_revision_target_and_action(self):
        payload = self.attempt()
        self.mutate(payload)
        self.insert('otherfavorite')
        for response in (self.mutate(dict(payload, favorite=False)),
                         self.mutate(dict(payload, expected_revision='1')),
                         self.mutate(payload, target='otherfavorite'),
                         self.client.post('/api/tags/favoriteproto', json=dict(payload, tag='Other'))):
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json['code'], 'mutation_id_conflict')
        self.assertEqual(self.state().json['favorite_revision'], '1')
        self.assertEqual(self.state().json['tags_revision'], '0')

    def test_crash_before_commit_rolls_back_value_revision_and_receipt(self):
        payload = self.attempt()
        original = vdl._favorite_snapshot
        calls = 0
        def fail_after_write(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError('injected before receipt')
            return original(*args, **kwargs)
        with mock.patch.object(vdl, '_favorite_snapshot', side_effect=fail_after_write):
            with self.assertRaises(RuntimeError):
                self.mutate(payload)
        vdl.init_db()
        self.assertEqual((self.state().json['favorite'], self.state().json['favorite_revision']), (False, '0'))
        self.assertEqual(self.receipt(payload).status_code, 404)
        self.assertEqual(self.mutate(payload).status_code, 200)

    def test_receipt_insert_failure_rolls_back_domain_trigger_and_receipt(self):
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
        self.assertEqual((self.state().json['favorite'], self.state().json['favorite_revision']), (False, '0'))
        self.assertEqual(self.receipt(payload).status_code, 404)

    def test_expired_receipt_check_waits_for_admitted_commit(self):
        clients = [self.authenticated_client(), self.authenticated_client()]
        real_now = time.time()
        payload = self.attempt(created=real_now - vdl.MUTATION_REPLAY_SECONDS + 1)
        clock = [real_now]
        written = threading.Event()
        release = threading.Event()
        recovery_started = threading.Event()
        original = vdl._favorite_snapshot
        calls = 0
        def hold_after_write(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                written.set()
                if not release.wait(5):
                    raise AssertionError('receipt gate was not released')
            return original(*args, **kwargs)
        def recover():
            recovery_started.set()
            return self.receipt(payload, clients[1])
        with mock.patch.object(vdl.time, 'time', side_effect=lambda: clock[0]), \
                mock.patch.object(vdl, '_favorite_snapshot', side_effect=hold_after_write):
            with ThreadPoolExecutor(max_workers=2) as pool:
                write = pool.submit(self.mutate, payload, clients[0])
                self.assertTrue(written.wait(5))
                clock[0] += 2
                recovery = pool.submit(recover)
                self.assertTrue(recovery_started.wait(5))
                self.assertFalse(recovery.done())
                release.set()
                committed = write.result(5)
                recovered = recovery.result(5)
        self.assertEqual(committed.status_code, 200)
        self.assertEqual(recovered.json, committed.json)

    def test_postcommit_publication_failure_cannot_hide_commit(self):
        payload = self.attempt()
        with mock.patch.object(vdl.event_bus, 'publish', side_effect=RuntimeError('unavailable')):
            response = self.mutate(payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.receipt(payload).json, response.json)

    def test_validation_request_limits_and_clock_expiry(self):
        for value in (None, 0, 1, 'true', [], {}):
            payload = self.attempt(value)
            response = self.mutate(payload)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json['mutation']['outcome'], 'rejected')
            self.assertEqual(self.receipt(payload).json, response.json)
        for revision in (None, 0, '-1', '01', '9' * 1000):
            self.assertEqual(self.mutate(self.attempt(revision=revision)).status_code, 400)
        for created in (time.time() - 86401, time.time() + 301):
            payload = self.attempt(created=created)
            response = self.mutate(payload)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json['mutation']['outcome'], 'rejected')
        self.assertEqual(self.mutate(dict(self.attempt(), client_mutation_id='bad')).status_code, 400)
        self.assertEqual(self.mutate({'favorite': 'x' * 5000}).status_code, 413)
        self.assertEqual(self.mutate([]).status_code, 400)
        self.assertEqual(self.client.post('/api/favorite/favoriteproto', data='x').status_code, 415)
        self.assertEqual(self.state().json['favorite_revision'], '0')

    def test_shared_quota_preserves_receipts_and_expired_absence_is_final(self):
        payload = self.attempt()
        self.mutate(payload)
        for limit in ('MUTATION_ACTOR_MINUTE_LIMIT', 'MUTATION_ACTOR_RECEIPT_LIMIT'):
            with mock.patch.object(vdl, limit, 1):
                self.assertEqual(self.mutate(self.attempt(False, '1')).status_code, 429)
                self.assertEqual(self.client.post('/api/tags/favoriteproto', json={
                    'tag': 'Quota', 'expected_revision': '0',
                    'client_mutation_id': self.attempt()['client_mutation_id'],
                }).status_code, 429)
                self.assertEqual(self.mutate(payload).status_code, 200)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE mutation_receipts SET recorded_at = ?', (time.time() - 172801,))
        self.assertEqual(self.mutate(self.attempt(False, '1')).status_code, 200)
        self.assertEqual(self.receipt(payload).status_code, 404)
        self.assertFalse(self.receipt(payload).json['final'])
        expired = self.attempt(created=time.time() - 86401)
        self.assertTrue(self.receipt(expired).json['final'])
        self.assertEqual(self.mutate(expired).json['mutation']['outcome'], 'rejected')

    def test_current_authorization_and_actor_scoping_on_every_recovery(self):
        vdl.db_create_user('favoriteviewer', 'viewer-password', 'normal')
        client = self.authenticated_client('favoriteviewer', 'viewer-password')
        admin_payload = self.attempt()
        self.mutate(admin_payload)
        self.assertEqual(self.receipt(admin_payload, client).json,
                         self.receipt(self.attempt(), client).json)
        payload = self.attempt(False, '1')
        self.assertEqual(self.mutate(payload, client).status_code, 200)
        vdl.db_set_download_visibility('favoriteproto', 'private')
        self.assertEqual(self.state(client).status_code, 404)
        self.assertEqual(self.mutate(payload, client).status_code, 404)
        self.assertEqual(self.receipt(payload, client).status_code, 404)
        self.assertNotIn('favorite', self.receipt(payload, client).json)
        # A valid before-request actor cannot bypass a later revocation.
        original = vdl._tag_actor
        def revoke(conn):
            conn.execute('UPDATE users SET suspended = 1 WHERE username = ?', ('favoriteviewer',))
            return original(conn)
        with mock.patch.object(vdl, '_tag_actor', side_effect=revoke):
            self.assertEqual(self.mutate(self.attempt(), client).status_code, 401)
        self.assertEqual(vdl.app.test_client().post('/api/favorite/favoriteproto', json=self.attempt()).status_code, 401)

    def test_deletion_fences_original_write_and_recovery_payloads(self):
        payload = self.attempt()
        self.mutate(payload)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('DELETE FROM downloads WHERE id = ?', ('favoriteproto',))
        self.assertEqual(self.state().status_code, 404)
        self.assertEqual(self.mutate(payload).status_code, 404)
        recovered = self.receipt(payload)
        self.assertEqual(recovered.status_code, 404)
        self.assertNotIn('favorite', recovered.json)
        self.assertNotIn('mutation', recovered.json)

    def test_transaction_rechecks_visibility_and_session_version(self):
        viewer = vdl.db_create_user('favoriteviewer', 'viewer-password', 'normal')
        client = self.authenticated_client('favoriteviewer', 'viewer-password')
        original = vdl._tag_actor
        def make_private(conn):
            conn.execute("UPDATE downloads SET visibility = 'private' WHERE id = ?", ('favoriteproto',))
            return original(conn)
        with mock.patch.object(vdl, '_tag_actor', side_effect=make_private):
            self.assertEqual(self.mutate(self.attempt(), client).status_code, 404)
        def expire(conn):
            conn.execute('UPDATE users SET session_version = session_version + 1 WHERE id = ?', (viewer['id'],))
            return original(conn)
        with mock.patch.object(vdl, '_tag_actor', side_effect=expire):
            self.assertEqual(self.mutate(self.attempt(), client).status_code, 401)

    def test_cross_origin_is_denied_and_sse_contains_no_private_identity(self):
        response = self.client.post('/api/favorite/favoriteproto', json=self.attempt(),
                                    headers={'Origin': 'https://attacker.invalid'})
        self.assertEqual(response.status_code, 403)
        vdl.db_set_download_visibility('favoriteproto', 'private')
        subscriber = vdl.event_bus.subscribe()
        self.mutate(self.attempt())
        self.assertEqual(subscriber.get_nowait(), ('change', {'reason': 'favorite'}))
        self.assertTrue(subscriber.empty())

    def test_targeted_values_and_revisions_share_one_read_snapshot(self):
        # Change favorite after the row SELECT; the targeted read must serialize
        # the captured value and revision together rather than re-read one field.
        original = vdl._tag_snapshot
        def concurrent_write(conn, download_id, row=None):
            vdl.db_set_download_favorite(download_id, True)
            return original(conn, download_id, row)
        with mock.patch.object(vdl, '_tag_snapshot', side_effect=concurrent_write):
            state = self.state().json
        self.assertEqual((state['favorite'], state['favorite_revision']), (False, '0'))
        self.assertEqual((self.state().json['favorite'], self.state().json['favorite_revision']), (True, '1'))


if __name__ == '__main__':
    unittest.main()

"""Exercise the transactional tag protocol through the production routes."""
import secrets
import sqlite3
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class TagMutationProtocolTest(AppCase):
    def setUp(self):
        super().setUp()
        self.insert('tagproto')

    def attempt(self, tag='Music', revision='0', created=None):
        return {
            'tag': tag,
            'expected_revision': revision,
            'client_mutation_id': f'{int((time.time() if created is None else created) * 1000)}-{secrets.token_hex(16)}',
        }

    def mutate(self, payload, client=None, method='POST'):
        return (client or self.client).open('/api/tags/tagproto', method=method, json=payload)

    def state(self, client=None):
        return (client or self.client).get('/api/downloads/tagproto/editable-state')

    def test_capabilities_and_consistent_canonical_reads(self):
        capabilities = self.client.get('/api/client-capabilities')
        self.assertEqual(capabilities.status_code, 200)
        self.assertEqual(capabilities.headers['Cache-Control'], 'no-store')
        self.assertEqual(capabilities.json['mutation_protocol'], 1)
        self.assertEqual(capabilities.json['tag_identity_version'], vdl.TAG_IDENTITY_VERSION)
        self.assertEqual(set(capabilities.json['actions']), {'tag.add', 'tag.remove', 'favorite.set', 'rename.set'})
        payload = self.attempt('  Straße   Videos ')
        response = self.mutate(payload)
        self.assertEqual(response.status_code, 200)
        body = response.json
        self.assertEqual(body['tag_items'], [{'key': 'strasse videos', 'name': 'Straße Videos'}])
        self.assertEqual(body['submitted_tag'], body['tag_items'][0])
        self.assertEqual(body['mutation'], {'id': payload['client_mutation_id'], 'domain': 'tags',
                                          'outcome': 'committed', 'revision': '1'})
        for state in (self.state().json, vdl.db_get_download('tagproto'),
                      self.client.get('/api/current-downloads').json[0]):
            self.assertEqual(state['tags'], ['Straße Videos'])
            self.assertEqual(state['tag_items'], body['tag_items'])
            self.assertEqual(state['tags_revision'], '1')
        self.assertEqual(self.state().json['permissions'], {
            'tags': True, 'favorite': True, 'rename': False,
        })

    def test_legacy_noop_progress_remove_and_restart_revisions(self):
        self.assertEqual(self.mutate({'tag': 'First'}).json['tags_revision'], '1')
        self.assertEqual(self.mutate({'tag': 'FIRST'}).json['tags_revision'], '1')
        vdl.db_update_download('tagproto', status='cancelled')
        self.assertEqual(self.state().json['tags_revision'], '1')
        vdl.init_db()
        self.assertEqual(self.state().json['tags_revision'], '1')
        response = self.mutate(self.attempt('first', '1'), method='DELETE')
        self.assertEqual(response.json['tags'], [])
        self.assertEqual(response.json['submitted_tag'], {'key': 'first', 'name': 'First'})
        self.assertEqual(response.json['tags_revision'], '2')
        self.assertEqual(vdl.db_list_tags(), [])
        self.assertEqual(self.mutate(self.attempt('missing', '2'), method='DELETE').json['tags_revision'], '2')

    def test_conflict_is_durable_and_does_not_change_membership(self):
        self.mutate({'tag': 'Remote'})
        payload = self.attempt('Local')
        response = self.mutate(payload)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json['tags'], ['Remote'])
        self.assertEqual(response.json['mutation']['outcome'], 'conflicted')
        self.mutate({'tag': 'Newer'})
        replay = self.mutate(payload)
        self.assertEqual(replay.json['mutation'], response.json['mutation'])
        self.assertEqual(replay.json['tags'], response.json['tags'])
        self.assertEqual(self.state().json['tags'], ['Newer', 'Remote'])
        recovered = self.client.get('/api/mutations/' + payload['client_mutation_id'])
        self.assertEqual(recovered.status_code, 409)
        self.assertEqual(recovered.json['mutation'], response.json['mutation'])
        self.assertEqual(recovered.json['tags'], response.json['tags'])

    def test_identical_replay_comes_before_old_revision_check(self):
        payload = self.attempt()
        first = self.mutate(payload)
        self.mutate({'tag': 'Other'})
        self.assertEqual(self.mutate(payload).json['mutation'], first.json['mutation'])
        self.assertEqual(self.mutate(payload).json['tags'], first.json['tags'])
        receipt = self.client.get('/api/mutations/' + payload['client_mutation_id'])
        self.assertEqual(receipt.json['mutation'], first.json['mutation'])
        self.assertEqual(receipt.json['tags'], first.json['tags'])
        self.assertEqual(receipt.headers['Cache-Control'], 'no-store')
        altered = dict(payload, tag='Different')
        self.assertEqual(self.mutate(altered).status_code, 409)
        self.assertEqual(self.state().json['tags_revision'], '2')

    def test_simultaneous_duplicate_and_competing_writes(self):
        # Cookie signing belongs to the same authenticated actor in both clients.
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
        self.assertEqual(self.state().json['tags_revision'], '1')
        competing = [self.attempt('Second', '1'), self.attempt('Third', '1')]
        def compare(index):
            barrier.wait()
            return self.mutate(competing[index], clients[index])
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(compare, range(2)))
        self.assertEqual(sorted(result.status_code for result in results), [200, 409])
        self.assertEqual(self.state().json['tags_revision'], '2')

    def test_failure_before_receipt_rolls_back_and_publish_failure_keeps_receipt(self):
        payload = self.attempt()
        original = vdl._tag_snapshot
        count = 0
        def fail_after_write(*args, **kwargs):
            nonlocal count
            count += 1
            if count == 2:
                raise RuntimeError('injected failure before commit')
            return original(*args, **kwargs)
        with mock.patch.object(vdl, '_tag_snapshot', side_effect=fail_after_write):
            with self.assertRaises(RuntimeError):
                self.mutate(payload)
        self.assertEqual(self.state().json['tags_revision'], '0')
        self.assertEqual(self.client.get('/api/mutations/' + payload['client_mutation_id']).status_code, 404)
        with mock.patch.object(vdl.event_bus, 'publish', side_effect=RuntimeError('publisher stopped')):
            committed = self.mutate(payload)
        self.assertEqual(committed.status_code, 200)
        self.assertEqual(self.client.get('/api/mutations/' + payload['client_mutation_id']).json, committed.json)

    def test_validation_expiry_future_clock_and_request_limits(self):
        for bad in (None, '', 'bad,tag', '\n', 'x' * 65):
            with self.subTest(bad=bad):
                response = self.mutate(self.attempt(bad))
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json['mutation']['outcome'], 'rejected')
        for revision in (None, 0, '-1', '01', '1' * 1000):
            self.assertEqual(self.mutate(self.attempt(revision=revision)).status_code, 400)
        for created in (time.time() - 86401, time.time() + 301):
            response = self.mutate(self.attempt(created=created))
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json['mutation']['outcome'], 'rejected')
        self.assertEqual(self.mutate(dict(self.attempt(), client_mutation_id='bad')).status_code, 400)
        self.assertEqual(self.mutate({'tag': 'x' * 5000}).status_code, 413)
        self.assertEqual(self.client.post('/api/tags/tagproto', json=[]).status_code, 400)
        self.assertEqual(self.client.post('/api/tags/tagproto', data='x').status_code, 415)
        self.assertEqual(self.mutate(self.attempt('😀' * 64)).status_code, 200)

    def test_quota_rejects_new_work_without_evicting_receipts(self):
        payload = self.attempt()
        self.mutate(payload)
        for limit in ('MUTATION_ACTOR_MINUTE_LIMIT', 'MUTATION_ACTOR_RECEIPT_LIMIT'):
            with mock.patch.object(vdl, limit, 1):
                self.assertEqual(self.mutate(self.attempt('Next', '1')).status_code, 429)
                self.assertEqual(self.mutate(payload).status_code, 200)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE mutation_receipts SET recorded_at = ?', (time.time() - 172801,))
        self.assertEqual(self.mutate(self.attempt('Next', '1')).status_code, 200)
        self.assertEqual(self.client.get('/api/mutations/' + payload['client_mutation_id']).status_code, 404)
        expired = self.attempt(created=time.time() - 86401)['client_mutation_id']
        response = self.client.get('/api/mutations/' + expired)
        self.assertTrue(response.json['final'])
        self.assertFalse(self.client.get('/api/mutations/not-a-mutation').json['final'])

    def test_receipts_and_targeted_reads_require_current_authorization(self):
        payload = self.attempt()
        self.mutate(payload)
        viewer = vdl.db_create_user('tagviewer', 'viewer-password', 'normal')
        client = self.authenticated_client('tagviewer', 'viewer-password')
        receipt_path = '/api/mutations/' + payload['client_mutation_id']
        self.assertEqual(client.get(receipt_path).json,
                         client.get('/api/mutations/' + self.attempt()['client_mutation_id']).json)
        self.assertEqual(self.state(client).status_code, 200)
        normal_payload = self.attempt('Viewer', '1')
        self.assertEqual(self.mutate(normal_payload, client).status_code, 200)
        vdl.db_set_download_visibility('tagproto', 'private')
        self.assertEqual(self.state(client).status_code, 404)
        self.assertEqual(self.mutate(normal_payload, client).status_code, 404)
        self.assertEqual(client.get('/api/mutations/' + normal_payload['client_mutation_id']).status_code, 404)
        # The before-request actor may have been valid; the transaction must
        # still independently reject a subsequently revoked session.
        original = vdl._tag_actor
        def revoke(conn):
            conn.execute('UPDATE users SET suspended = 1 WHERE id = ?', (viewer['id'],))
            return original(conn)
        with mock.patch.object(vdl, '_tag_actor', side_effect=revoke):
            self.assertEqual(self.mutate(self.attempt(), client).status_code, 401)
        self.assertEqual(vdl.app.test_client().get('/api/client-capabilities').status_code, 401)
        self.assertEqual(self.mutate(self.attempt(), method='POST').status_code, 409)

    def test_receipt_vocabulary_uses_current_authorized_state(self):
        vdl.db_create_user('vocabviewer', 'viewer-password', 'normal')
        client = self.authenticated_client('vocabviewer', 'viewer-password')
        self.insert('othertag')
        self.client.post('/api/tags/othertag', json={'tag': 'Other private vocabulary'})
        payload = self.attempt()
        committed = self.mutate(payload, client)
        self.assertIn('Other private vocabulary', committed.json['available_tags'])
        vdl.db_set_download_visibility('othertag', 'private')
        for response in (self.mutate(payload, client),
                         client.get('/api/mutations/' + payload['client_mutation_id'])):
            self.assertEqual(response.status_code, 200)
            self.assertNotIn('Other private vocabulary', response.json['available_tags'])
        with vdl.db() as conn:
            stored = conn.execute('SELECT response FROM mutation_receipts').fetchone()[0]
        self.assertNotIn('Other private vocabulary', stored)

    def test_attachment_cleanup_writer_advances_revision(self):
        self.mutate({'tag': 'Cleanup'})
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('DELETE FROM tags WHERE normalized_name = ?', ('cleanup',))
        state = self.state().json
        self.assertEqual((state['tags'], state['tags_revision']), ([], '2'))

    def test_cross_origin_and_private_sse(self):
        response = self.client.post('/api/tags/tagproto', json=self.attempt(),
                                    headers={'Origin': 'https://attacker.invalid'})
        self.assertEqual(response.status_code, 403)
        vdl.db_set_download_visibility('tagproto', 'private')
        subscriber = vdl.event_bus.subscribe()
        self.mutate(self.attempt())
        self.assertEqual(subscriber.get_nowait(), ('change', {'reason': 'tag'}))

    def test_deleted_identity_cannot_be_reused(self):
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('DELETE FROM downloads WHERE id = ?', ('tagproto',))
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert('tagproto')

    def test_read_values_and_revision_share_explicit_snapshot(self):
        # A second connection commits between the download SELECT and its tags
        # SELECT. WAL lets that writer proceed while the reader retains its view.
        original = vdl._tag_snapshot
        def concurrent_write(conn, download_id, row=None):
            vdl.db_add_download_tag(download_id, 'Concurrent')
            return original(conn, download_id, row)
        with mock.patch.object(vdl, '_tag_snapshot', side_effect=concurrent_write):
            state = vdl.db_get_download('tagproto')
        self.assertEqual((state['tags_revision'], state['tags']), ('0', []))
        self.assertEqual(self.state().json['tags_revision'], '1')


if __name__ == '__main__':
    unittest.main()

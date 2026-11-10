import json
import os
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class BulkClearTest(AppCase):
    def setUp(self):
        super().setUp()
        self.source = self.finished_file('bulk-one', 'One.mp4', b'first-media')

    def preview(self, kind='library', client=None):
        route = '/api/library/clear/preview' if kind == 'library' else '/api/clear/preview'
        result = (client or self.client).get(route + '?include_scope=true')
        self.assertEqual(result.status_code, 200, result.json)
        return result.json

    def attempt(self, kind='library', preview=None, created=None):
        preview = preview or self.preview(kind)
        return {'scope_id': preview['scope_id'], 'expected_revision': preview['revision'],
                'client_mutation_id': str(int((time.time() if created is None else created) * 1000)) + '-' + secrets.token_hex(16)}

    def mutate(self, payload, kind='library', client=None):
        return (client or self.client).post('/api/library/clear' if kind == 'library' else '/api/clear', json=payload)

    def receipt(self, payload, client=None):
        return (client or self.client).get('/api/mutations/' + payload['client_mutation_id'])

    def operation(self, payload):
        with vdl.db() as conn:
            return dict(conn.execute('SELECT * FROM bulk_clear_scopes WHERE id=?', (payload['scope_id'],)).fetchone())

    def crash(self, payload, phase):
        def checkpoint(actual, operation):
            if actual == phase:
                raise RuntimeError('injected bulk restart')
        with mock.patch.object(vdl, '_bulk_clear_checkpoint', side_effect=checkpoint):
            with self.assertRaisesRegex(RuntimeError, 'injected bulk restart'):
                self.mutate(payload)

    def assert_counts(self, response, **counts):
        self.assertEqual(response.status_code, 200, response.json)
        for key, value in counts.items():
            self.assertEqual(response.json[key], value, response.json)
        self.assertEqual(response.json['total'], sum(response.json[key] for key in ('removed', 'retained', 'failed', 'pending')))
        self.assertEqual(len(response.json['removed_ids']), response.json['removed'])
        self.assertEqual(response.json['mutation']['revision'], response.json['revision'])

    def test_capabilities_legacy_shapes_and_no_store(self):
        capabilities = self.client.get('/api/client-capabilities').json
        self.assertEqual(capabilities['bulk_clear'], 1)
        self.assertTrue({'history.clear', 'library.clear'} <= set(capabilities['actions']))
        for route in ('/api/library/clear/preview', '/api/clear/preview'):
            response = self.client.get(route)
            self.assertEqual(set(response.json), {'entries', 'with_files'})
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
        result = self.client.post('/api/library/clear')
        self.assertEqual(result.json, {'message': 'Cleared', 'removed': 1, 'files_deleted': 1})
        self.assertFalse(os.path.exists(self.source))
        self.assertEqual(self.client.post('/api/clear').json, {'removed': 1, 'files_deleted': 0})

    def test_preview_and_abandonment_delete_nothing(self):
        preview = self.preview()
        self.assertEqual(preview['entries'], 1)
        self.assertEqual(preview['with_files'], 1)
        self.assertEqual(preview['revision'], '0')
        self.assertTrue(os.path.exists(self.source))
        self.assertIsNotNone(vdl.db_get_download('bulk-one'))
        with vdl.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM mutation_receipts').fetchone()[0], 0)

    def test_library_canonical_correlated_receipt_preserves_attempt_snapshots(self):
        with vdl.db() as conn:
            old_attempt = dict(conn.execute('SELECT * FROM download_attempts').fetchone())
        payload = self.attempt()
        result = self.mutate(payload)
        self.assert_counts(result, removed=1, files_deleted=1, retained=0, failed=0, pending=0)
        self.assertEqual(result.json['removed_ids'], ['bulk-one'])
        self.assertEqual(result.json['scope_id'], payload['scope_id'])
        self.assertEqual(result.json['operation_id'], payload['scope_id'])
        self.assertEqual(result.json['mutation']['id'], payload['client_mutation_id'])
        self.assertEqual(result.json['mutation']['domain'], 'bulk-clear')
        self.assertEqual(result.json['mutation']['action'], 'library.clear')
        self.assertEqual(result.json['mutation']['outcome'], 'committed')
        self.assertEqual(self.receipt(payload).json, result.json)
        self.assertEqual(self.mutate(payload).json, result.json)
        with vdl.db() as conn:
            new_attempt = dict(conn.execute('SELECT * FROM download_attempts').fetchone())
        self.assertEqual(new_attempt['id'], old_attempt['id'])
        self.assertEqual(new_attempt['status'], 'finished')
        self.assertIsNone(new_attempt['download_id'])
        self.assertFalse(os.path.exists(self.source))

    def test_history_clear_preserves_active_attempts_all_library_and_files(self):
        self.insert('active')
        for status in ('cancelled', 'interrupted', 'error'):
            self.insert(status)
            vdl.db_update_download(status, status=status)
        payload = self.attempt('history')
        result = self.mutate(payload, 'history')
        self.assert_counts(result, total=4, removed=4, files_deleted=0, retained=0, pending=0)
        self.assertTrue(os.path.exists(self.source))
        self.assertEqual(len(vdl.db_list_downloads()), 5)
        with vdl.db() as conn:
            self.assertEqual([row['work_id'] for row in conn.execute('SELECT work_id FROM download_attempts')], ['active'])
        self.assertEqual(self.receipt(payload).json, result.json)

    def test_frozen_library_preview_never_broadens_to_new_arrivals(self):
        payload = self.attempt()
        path = self.finished_file('new-arrival', 'New.mp4')
        result = self.mutate(payload)
        self.assert_counts(result, total=1, removed=1)
        self.assertTrue(os.path.exists(path))
        self.assertIsNotNone(vdl.db_get_download('new-arrival'))
        self.assertEqual(self.mutate(payload).json, result.json)

    def test_frozen_history_preview_never_broadens_to_later_terminal_attempts(self):
        self.insert('later')
        payload = self.attempt('history')
        vdl.db_update_download('later', status='error')
        result = self.mutate(payload, 'history')
        self.assert_counts(result, total=1, removed=1)
        with vdl.db() as conn:
            self.assertEqual([row['work_id'] for row in conn.execute('SELECT work_id FROM download_attempts')], ['later'])

    def test_changed_library_generation_retained_without_affecting_neighbor(self):
        self.finished_file('neighbor', 'Neighbor.mp4')
        payload = self.attempt()
        vdl.db_update_download('bulk-one', display_filename='New name.mp4')
        result = self.mutate(payload)
        self.assert_counts(result, total=2, removed=1, retained=1)
        self.assertEqual(result.json['removed_ids'], ['neighbor'])
        self.assertTrue(os.path.exists(self.source))

    def test_changed_history_eligibility_is_retained(self):
        payload = self.attempt('history')
        with vdl._db_lock, vdl.db() as conn:
            conn.execute("UPDATE download_attempts SET status='downloading'")
        result = self.mutate(payload, 'history')
        self.assert_counts(result, total=1, removed=0, retained=1)

    def test_disappeared_library_target_is_retained_and_ids_remain_retired(self):
        payload = self.attempt()
        self.assertEqual(self.client.post('/api/remove/bulk-one', json={}).status_code, 200)
        result = self.mutate(payload)
        self.assert_counts(result, removed=0, retained=1, files_deleted=0)
        with self.assertRaises(Exception):
            self.insert('bulk-one')

    def test_simultaneous_replay_executes_each_target_once(self):
        self.finished_file('two', 'Two.mp4')
        payload = self.attempt()
        clients = [self.authenticated_client(), self.authenticated_client()]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda client: self.mutate(payload, client=client), clients))
        self.assertTrue(all(result.status_code == 200 for result in results))
        self.assertEqual(results[0].json, results[1].json)
        with vdl.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM removal_operations').fetchone()[0], 2)

    def test_same_scope_cannot_be_accepted_twice_and_fingerprint_is_immutable(self):
        preview = self.preview()
        payload = self.attempt(preview=preview)
        self.assertEqual(self.mutate(payload).status_code, 200)
        self.assertEqual(self.mutate(self.attempt(preview=preview)).status_code, 409)
        self.assertEqual(self.mutate(dict(payload, expected_revision='1')).status_code, 409)
        self.assertEqual(self.mutate(payload, 'history').status_code, 409)

    def test_mutation_namespace_is_shared_with_metadata(self):
        payload = self.attempt()
        state = self.client.get('/api/downloads/bulk-one/editable-state').json
        response = self.client.post('/api/favorite/bulk-one', json={
            'client_mutation_id': payload['client_mutation_id'], 'expected_revision': state['favorite_revision'], 'favorite': True})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.mutate(payload).status_code, 409)
        self.assertTrue(os.path.exists(self.source))

    def test_parent_acceptance_and_each_target_publication_restart_same_set(self):
        for index, phase in enumerate(('accepted', 'target_completed', 'completed')):
            if index:
                self.finished_file('bulk-' + str(index), str(index) + '.mp4')
            payload = self.attempt()
            self.crash(payload, phase)
            survivor = self.finished_file('after-' + str(index), 'After' + str(index) + '.mp4')
            vdl.init_db()
            result = self.receipt(payload)
            self.assert_counts(result, pending=0)
            self.assertTrue(os.path.exists(survivor))
            self.assertEqual(self.mutate(payload).json, result.json)

    def test_restart_at_every_child_filesystem_boundary(self):
        for index, phase in enumerate(('prepared', 'anchor_created', 'anchored', 'source_retired', 'retired', 'committed', 'retired_removed', 'anchor_removed', 'cleaned')):
            target = 'boundary-' + str(index)
            if index == 0:
                vdl.db_update_download('bulk-one', status='cancelled')
            source = self.finished_file(target, target + '.mp4')
            payload = self.attempt()
            def checkpoint(actual, operation):
                if actual == phase:
                    raise RuntimeError('injected child restart')
            with mock.patch.object(vdl, '_removal_checkpoint', side_effect=checkpoint):
                with self.assertRaisesRegex(RuntimeError, 'injected child restart'):
                    self.mutate(payload)
            vdl.init_db()
            result = self.receipt(payload)
            self.assert_counts(result, total=1, removed=1, pending=0)
            self.assertFalse(os.path.lexists(source))

    def test_partial_cleanup_keeps_pending_and_explicit_recovery_completes_same_target(self):
        other = self.finished_file('two', 'Two.mp4')
        payload = self.attempt()
        def checkpoint(phase, operation):
            if phase == 'prepared' and operation['target_id'] == 'bulk-one':
                raise OSError('/private/raw/path')
        with mock.patch.object(vdl, '_removal_checkpoint', side_effect=checkpoint):
            result = self.mutate(payload)
        self.assert_counts(result, total=2, removed=1, pending=1, files_deleted=1)
        self.assertEqual(result.json['mutation']['outcome'], 'accepted')
        self.assertNotIn('/private', str(result.json))
        self.assertFalse(os.path.exists(other))
        survivor = self.finished_file('survivor', 'Survivor.mp4')
        result = self.receipt(payload)
        self.assert_counts(result, total=2, removed=2, pending=0)
        self.assertTrue(os.path.exists(survivor))

    def test_missing_media_counts_zero_files_without_touching_unrelated_bytes(self):
        os.unlink(self.source)
        unrelated = Path(self.download_dir, 'Unrelated.mp4')
        unrelated.write_bytes(b'unrelated')
        result = self.mutate(self.attempt())
        self.assert_counts(result, removed=1, files_deleted=0)
        self.assertEqual(unrelated.read_bytes(), b'unrelated')

    def test_shared_media_captured_aliases_delete_bytes_once(self):
        self.insert('alias')
        vdl.db_update_download('alias', status='finished', filename=self.source, output_dir=self.download_dir)
        result = self.mutate(self.attempt())
        self.assert_counts(result, total=2, removed=2, files_deleted=1)
        self.assertFalse(os.path.exists(self.source))

    def test_new_alias_after_preview_preserves_shared_media(self):
        payload = self.attempt()
        self.insert('alias')
        vdl.db_update_download('alias', status='finished', filename=self.source, output_dir=self.download_dir)
        result = self.mutate(payload)
        self.assert_counts(result, total=1, removed=1, files_deleted=0)
        self.assertTrue(os.path.exists(self.source))

    def test_file_discovery_and_cleanup_do_not_hold_sqlite_write_lock(self):
        original = vdl._removal_checkpoint
        checks = []
        def checkpoint(phase, operation):
            if phase in ('prepared','anchor_created','source_retired','retired_removed','anchor_removed'):
                acquired = vdl._db_lock.acquire(blocking=False)
                checks.append(acquired)
                if acquired:
                    vdl._db_lock.release()
                self.assertTrue(acquired, phase)
            original(phase, operation)
        with mock.patch.object(vdl, '_removal_checkpoint', side_effect=checkpoint):
            self.assertEqual(self.mutate(self.attempt()).status_code, 200)
        self.assertGreaterEqual(len(checks), 5)

    def test_shared_minute_limit_leaves_admitted_remainder_resumable(self):
        self.finished_file('two', 'Two.mp4')
        payload = self.attempt()
        with mock.patch.object(vdl, 'MUTATION_ACTOR_MINUTE_LIMIT', 2):
            result = self.mutate(payload)
        self.assert_counts(result, total=2, removed=1, pending=1)
        self.assert_counts(self.receipt(payload), total=2, removed=2, pending=0)

    def test_admission_quota_is_correlated_and_has_no_side_effect_or_eviction(self):
        payload = self.attempt()
        with mock.patch.object(vdl, 'MUTATION_ACTOR_RECEIPT_LIMIT', 1):
            result = self.mutate(payload)
        self.assertEqual(result.status_code, 429)
        self.assertEqual(result.json['mutation']['id'], payload['client_mutation_id'])
        self.assertEqual(result.json['mutation']['outcome'], 'rejected')
        self.assertTrue(os.path.exists(self.source))
        self.assertEqual(self.operation(payload)['phase'], 'preview')
        self.assertEqual(self.mutate(payload).status_code, 200)

    def test_accepted_unstarted_targets_can_continue_beyond_replay_window(self):
        payload = self.attempt()
        self.crash(payload, 'accepted')
        later = time.time() + vdl.MUTATION_RETENTION_SECONDS + 10
        with mock.patch.object(vdl.time, 'time', return_value=later):
            with vdl._db_lock, vdl.db() as conn:
                vdl._prune_mutation_receipts(conn, later)
                self.assertIsNotNone(conn.execute('SELECT 1 FROM mutation_receipts WHERE mutation_id=?', (payload['client_mutation_id'],)).fetchone())
            result = self.receipt(payload)
        self.assert_counts(result, total=1, removed=1, pending=0)
        self.assertFalse(os.path.exists(self.source))

    def test_expired_new_attempt_and_conflict_have_stable_rejected_receipts(self):
        payload = self.attempt(created=time.time() - vdl.MUTATION_REPLAY_SECONDS - 1)
        result = self.mutate(payload)
        self.assertEqual(result.status_code, 400)
        self.assertEqual(result.json['mutation']['outcome'], 'rejected')
        self.assertEqual(self.receipt(payload).json, result.json)
        self.assertEqual(self.mutate(payload).json, result.json)
        payload = self.attempt()
        payload['expected_revision'] = '1'
        result = self.mutate(payload)
        self.assertEqual(result.status_code, 409)
        self.assertEqual(result.json['mutation']['outcome'], 'conflicted')
        self.assertEqual(self.receipt(payload).json, result.json)
        self.assertTrue(os.path.exists(self.source))

    def test_validation_rejects_unknown_fields_nonobjects_and_invalid_scopes(self):
        payload = self.attempt()
        cases = [dict(payload, extra=True), dict(payload, scope_id='../'), dict(payload, client_mutation_id='bad'), {}]
        for bad in cases:
            self.assertEqual(self.mutate(bad).status_code, 400)
        self.assertEqual(self.client.post('/api/library/clear', json=[]).status_code, 400)
        self.assertEqual(self.client.post('/api/library/clear', data='x').status_code, 400)
        self.assertTrue(os.path.exists(self.source))

    def test_preview_storage_is_bounded_and_expired_unaccepted_snapshots_pruned(self):
        for index in range(16):
            vdl.db_update_download('bulk-one', display_filename=str(index) + '.mp4')
            self.preview()
        vdl.db_update_download('bulk-one', display_filename='different.mp4')
        result = self.client.get('/api/library/clear/preview?include_scope=true')
        self.assertEqual(result.status_code, 429)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE bulk_clear_scopes SET created_at=?', (time.time() - vdl.MUTATION_REPLAY_SECONDS - 1,))
        self.preview()
        with vdl.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM bulk_clear_scopes').fetchone()[0], 1)

    def test_identical_cancelled_previews_reuse_bounded_scope(self):
        previews = [self.preview() for _ in range(20)]
        self.assertEqual(len({preview['scope_id'] for preview in previews}), 1)
        self.assertTrue(os.path.exists(self.source))
        with vdl.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM bulk_clear_targets').fetchone()[0], 1)

    def test_postcommit_publish_failure_keeps_recoverable_receipt(self):
        payload = self.attempt('history')
        with mock.patch.object(vdl.event_bus, 'publish', side_effect=RuntimeError('event failure')):
            result = self.mutate(payload, 'history')
        self.assert_counts(result, removed=1)
        self.assertEqual(self.receipt(payload).json, result.json)

    def test_atomic_history_receipt_rollback_preserves_attempts(self):
        payload = self.attempt('history')
        with vdl._db_lock, vdl.db() as conn:
            conn.execute("CREATE TRIGGER reject_bulk_receipt BEFORE INSERT ON mutation_receipts BEGIN SELECT RAISE(ABORT, 'injected'); END")
        with self.assertRaises(Exception):
            self.mutate(payload, 'history')
        with vdl.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM download_attempts').fetchone()[0], 1)
            self.assertEqual(conn.execute('SELECT phase FROM bulk_clear_scopes').fetchone()[0], 'preview')

    def test_expired_missing_parent_receipt_has_serialized_finality(self):
        mutation_id = str(int((time.time() - vdl.MUTATION_REPLAY_SECONDS - 1) * 1000)) + '-' + secrets.token_hex(16)
        response = self.client.get('/api/mutations/' + mutation_id)
        self.assertEqual(response.status_code, 404)
        self.assertTrue(response.json['final'])

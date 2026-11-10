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


class EntryRemovalTest(AppCase):
    def setUp(self):
        super().setUp()
        self.source = self.finished_file('removeproto', 'Original.mp4', b'admitted-media')

    def attempt(self, *, target='removeproto', scope='entry-and-files', created=None, revision=None):
        state = self.client.get('/api/downloads/' + target + '/editable-state').json
        return {'scope': scope, 'expected_revision': revision if revision is not None else state['removal_revision'],
                'client_mutation_id': str(int((time.time() if created is None else created) * 1000)) + '-' + secrets.token_hex(16)}

    def mutate(self, payload, client=None, target='removeproto'):
        return (client or self.client).post('/api/remove/' + target, json=payload)

    def receipt(self, payload, client=None):
        return (client or self.client).get('/api/mutations/' + payload['client_mutation_id'])

    def operation(self, payload):
        with vdl.db() as conn:
            row = conn.execute('SELECT * FROM removal_operations WHERE mutation_id = ?', (payload['client_mutation_id'],)).fetchone()
        return dict(row) if row else None

    def crash(self, payload, phase):
        def checkpoint(actual, operation):
            if actual == phase:
                raise RuntimeError('injected restart')
        with mock.patch.object(vdl, '_removal_checkpoint', side_effect=checkpoint):
            with self.assertRaisesRegex(RuntimeError, 'injected restart'):
                self.mutate(payload)

    def test_success_correlates_removal_preserves_history_and_all_serializers(self):
        state = self.client.get('/api/downloads/removeproto/editable-state').json
        self.assertIsInstance(state['removal_revision'], str)
        self.assertIn('entry.remove', self.client.get('/api/client-capabilities').json['actions'])
        self.assertEqual(vdl.db_list_downloads()[0]['removal_revision'], state['removal_revision'])
        self.assertEqual(vdl.db_get_download('removeproto')['removal_revision'], state['removal_revision'])
        with vdl.db() as conn:
            attempts = conn.execute('SELECT id FROM download_attempts WHERE work_id = ?', ('removeproto',)).fetchall()
        payload = self.attempt()
        result = self.mutate(payload)
        self.assertEqual(result.status_code, 200, result.json)
        self.assertTrue(result.json['removed'])
        self.assertEqual(result.json['mutation']['action'], 'entry.remove')
        self.assertEqual(result.json['removal_revision'], str(int(state['removal_revision']) + 1))
        self.assertIsNone(vdl.db_get_download('removeproto'))
        self.assertFalse(os.path.lexists(self.source))
        self.assertEqual(self.receipt(payload).json, result.json)
        self.assertEqual(self.mutate(payload).json, result.json)
        with vdl.db() as conn:
            self.assertEqual([row['id'] for row in conn.execute('SELECT id FROM download_attempts WHERE work_id = ?', ('removeproto',))], [row['id'] for row in attempts])
            self.assertTrue(all(row['download_id'] is None for row in conn.execute('SELECT download_id FROM download_attempts WHERE work_id = ?', ('removeproto',))))
        self.assertFalse(any(name.startswith('.vdl-remove-') for name in os.listdir(self.download_dir)))

    def test_restart_at_every_filesystem_and_publication_boundary(self):
        for index, phase in enumerate(('prepared', 'anchor_created', 'anchored', 'source_retired', 'retired', 'committed', 'retired_removed', 'anchor_removed', 'cleaned')):
            target = 'boundary' + str(index)
            path = self.finished_file(target, target + '.mp4', b'boundary-media')
            payload = self.attempt(target=target)
            def checkpoint(actual, operation):
                if actual == phase:
                    raise RuntimeError('injected restart')
            with mock.patch.object(vdl, '_removal_checkpoint', side_effect=checkpoint):
                with self.assertRaisesRegex(RuntimeError, 'injected restart'):
                    self.mutate(payload, target=target)
            vdl.init_db()
            result = self.receipt(payload)
            self.assertEqual(result.status_code, 200, (phase, result.json))
            self.assertIsNone(vdl.db_get_download(target))
            self.assertFalse(os.path.lexists(path))
            self.assertEqual(self.mutate(payload, target=target).json, result.json)
            vdl.init_db()
            self.assertEqual(self.receipt(payload).json, result.json)

    def test_record_only_scope_leaves_media_and_has_durable_receipt(self):
        payload = self.attempt(scope='entry')
        response = self.mutate(payload)
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(Path(self.source).read_bytes(), b'admitted-media')
        self.assertEqual(self.receipt(payload).json, response.json)

    def test_legacy_uses_safe_ownership_journal(self):
        response = self.client.post('/api/remove/removeproto')
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json, {'id': 'removeproto', 'message': 'Removed'})
        self.assertFalse(os.path.exists(self.source))

    def test_simultaneous_duplicate_and_fingerprint_scope_target_binding(self):
        payload = self.attempt()
        clients = [self.authenticated_client(), self.authenticated_client()]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda client: self.mutate(payload, client), clients))
        self.assertTrue(all(result.status_code == 200 for result in results))
        self.assertEqual(results[0].json, results[1].json)
        self.assertEqual(self.mutate(dict(payload, scope='entry')).status_code, 409)
        self.finished_file('other', 'Other.mp4')
        self.assertEqual(self.mutate(payload, target='other').status_code, 409)

    def test_all_identity_and_worker_writers_advance_revision_independent_metadata_does_not(self):
        def revision():
            return int(self.client.get('/api/downloads/removeproto/editable-state').json['removal_revision'])
        before = revision()
        vdl.db_update_download('removeproto', progress='new progress', speed=2)
        vdl.db_set_download_favorite('removeproto', True)
        vdl.db_add_download_tag('removeproto', 'Music')
        self.assertEqual(revision(), before)
        for column, value in (('display_filename', 'Display.mp4'), ('status', 'error'),
                              ('output_dir', self.temp_dir.name), ('visibility', 'private'),
                              ('source_type', 'upload'), ('owner_user_id', vdl.db_get_user_by_username('admin')['id']),
                              ('command_revision', 100)):
            with vdl._db_lock, vdl.db() as conn:
                conn.execute('UPDATE downloads SET ' + column + ' = ? WHERE id = ?', (value, 'removeproto'))
            self.assertGreater(revision(), before)
            before = revision()
        vdl.init_db()
        self.assertEqual(revision(), before)

    def test_stale_revision_rejected_without_filesystem_effects(self):
        payload = self.attempt()
        vdl.db_update_download('removeproto', display_filename='New.mp4')
        response = self.mutate(payload)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json['mutation']['outcome'], 'conflicted')
        self.assertFalse(response.json['removed'])
        self.assertTrue(os.path.exists(self.source))
        self.assertEqual(self.receipt(payload).json, response.json)

    def test_active_and_queued_workers_cannot_be_removed(self):
        for active in ('starting', 'downloading', 'paused'):
            vdl.db_update_download('removeproto', status=active)
            self.assertEqual(self.mutate(self.attempt()).status_code, 409)
        vdl.db_update_download('removeproto', status='cancelled')
        for ownership in ('live', 'queue', 'host'):
            with vdl._worker_condition:
                if ownership == 'live':
                    vdl._live_worker_ids.add('removeproto')
                elif ownership == 'queue':
                    vdl._worker_queue.append({'id': 'removeproto'})
                else:
                    vdl._worker_hosts['removeproto'] = 'fixture.invalid'
            self.assertEqual(self.mutate(self.attempt()).status_code, 409)
            with vdl._worker_condition:
                vdl._live_worker_ids.clear()
                vdl._worker_queue.clear()
                vdl._worker_hosts.clear()
        self.assertTrue(os.path.exists(self.source))

    def test_prepared_source_replacement_is_preserved_and_playback_fenced(self):
        payload = self.attempt()
        self.crash(payload, 'prepared')
        os.unlink(self.source)
        Path(self.source).write_bytes(b'unrelated')
        for _ in range(2):
            vdl.init_db()
            response = self.receipt(payload)
            self.assertEqual(response.status_code, 503)
            self.assertNotIn(self.download_dir, str(response.json))
            self.assertEqual(Path(self.source).read_bytes(), b'unrelated')
            self.assertEqual(self.client.get('/api/file/removeproto').status_code, 404)
            self.assertIsNotNone(vdl.db_get_download('removeproto'))

    def test_source_replacement_after_retirement_is_never_deleted(self):
        payload = self.attempt()
        self.crash(payload, 'retired')
        Path(self.source).write_bytes(b'new-owner')
        vdl.init_db()
        self.assertEqual(self.receipt(payload).status_code, 200)
        self.assertEqual(Path(self.source).read_bytes(), b'new-owner')

    def test_replacement_racing_exclusive_retirement_is_restored(self):
        payload = self.attempt()
        replaced = False
        def checkpoint(phase, operation):
            nonlocal replaced
            if phase == 'before_retire' and not replaced:
                os.unlink(operation['source'])
                Path(operation['source']).write_bytes(b'racing-replacement')
                replaced = True
        with mock.patch.object(vdl, '_removal_checkpoint', side_effect=checkpoint):
            response = self.mutate(payload)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(Path(self.source).read_bytes(), b'racing-replacement')
        self.assertIsNotNone(vdl.db_get_download('removeproto'))
        self.assertEqual(self.receipt(payload).status_code, 503)

    def test_ambiguous_retirement_cleanup_is_truthful_and_never_unlinks_replacement(self):
        payload = self.attempt()
        self.crash(payload, 'committed')
        item = json.loads(self.operation(payload)['artifacts'])[0]
        os.unlink(item['retired'])
        Path(item['retired']).write_bytes(b'not-owned')
        for _ in range(2):
            self.assertEqual(self.receipt(payload).status_code, 503)
            self.assertEqual(Path(item['retired']).read_bytes(), b'not-owned')
        os.unlink(item['retired'])
        self.assertEqual(self.receipt(payload).status_code, 200)

    def test_pending_removal_blocks_rename_retry_resume_and_bulk_file_cleanup(self):
        payload = self.attempt()
        self.crash(payload, 'prepared')
        self.assertEqual(self.client.post('/api/rename/removeproto', json={'filename': 'Changed'}).status_code, 503)
        self.assertEqual(self.client.post('/api/retry/removeproto').status_code, 409)
        self.assertEqual(self.client.post('/api/resume/removeproto').status_code, 409)
        self.assertEqual(self.client.post('/api/library/clear').status_code, 500)
        self.assertEqual(self.receipt(payload).status_code, 200)

    def test_missing_media_is_allowed_without_touching_unrelated_files(self):
        os.unlink(self.source)
        other = Path(self.download_dir, 'Unrelated.mp4')
        other.write_bytes(b'unrelated')
        response = self.mutate(self.attempt())
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(other.read_bytes(), b'unrelated')

    def test_temporary_and_sidecar_files_are_owned_by_captured_stored_directory(self):
        paths = [Path(self.source + '.part'), Path(self.source + '.ytdl'),
                 Path(self.download_dir, 'Video_removeproto.f137.mp4.part')]
        for path in paths:
            path.write_bytes(b'partial')
        response = self.mutate(self.attempt())
        self.assertEqual(response.status_code, 200, response.json)
        self.assertTrue(all(not path.exists() for path in paths))

    def test_quotas_and_age_reject_without_removal(self):
        with mock.patch.object(vdl, 'MUTATION_ACTOR_RECEIPT_LIMIT', 0):
            response = self.mutate(self.attempt())
        self.assertEqual(response.status_code, 429)
        for created in (time.time() - 24 * 3600 - 10, time.time() + 310):
            self.assertEqual(self.mutate(self.attempt(created=created)).status_code, 400)
        self.assertTrue(os.path.exists(self.source))

    def test_active_journal_reserves_shared_namespace_and_survives_other_adapter_pruning(self):
        payload = self.attempt()
        self.crash(payload, 'prepared')
        with mock.patch.object(vdl.time, 'time', return_value=time.time() + 3 * 24 * 3600):
            with vdl._db_lock, vdl.db() as conn:
                vdl._prune_mutation_receipts(conn, vdl.time.time())
            with vdl.db() as conn:
                self.assertIsNotNone(conn.execute('SELECT 1 FROM mutation_receipts WHERE mutation_id = ?', (payload['client_mutation_id'],)).fetchone())
        other = {'client_mutation_id': payload['client_mutation_id'], 'expected_revision': '0', 'favorite': True}
        self.assertEqual(self.client.post('/api/favorite/removeproto', json=other).status_code, 409)
        self.assertEqual(self.receipt(payload).status_code, 200)

    def test_expired_absence_finality_serializes_behind_admitted_filesystem_work(self):
        payload = self.attempt(created=time.time() - 24 * 3600 - 10)
        receipt = self.receipt(payload)
        self.assertEqual(receipt.status_code, 404)
        self.assertTrue(receipt.json['final'])
        self.assertEqual(self.mutate(payload).status_code, 400)

    def test_postcommit_publish_failure_does_not_change_committed_receipt(self):
        payload = self.attempt()
        with mock.patch.object(vdl.event_bus, 'publish', side_effect=RuntimeError('offline SSE')):
            result = self.mutate(payload)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(self.receipt(payload).json, result.json)

    def test_database_publication_and_receipt_rollback_recover_same_journal(self):
        payload = self.attempt()
        with mock.patch.object(vdl, '_db_remove_download_from_playlists', side_effect=RuntimeError('rollback')):
            with self.assertRaisesRegex(RuntimeError, 'rollback'):
                self.mutate(payload)
        self.assertIsNotNone(vdl.db_get_download('removeproto'))
        with vdl.db() as conn:
            receipt = conn.execute('SELECT status FROM mutation_receipts WHERE mutation_id = ?', (payload['client_mutation_id'],)).fetchone()
            self.assertEqual(receipt['status'], 503)
        result = self.receipt(payload)
        self.assertEqual(result.status_code, 200, result.json)
        self.assertEqual(self.mutate(payload).json, result.json)

    def test_no_filesystem_effect_holds_database_write_lock(self):
        payload = self.attempt()
        observed = []
        def wrap(name, original):
            def check(*args, **kwargs):
                self.assertTrue(vdl._db_lock.acquire(blocking=False), name)
                vdl._db_lock.release()
                observed.append(name)
                return original(*args, **kwargs)
            return check
        with mock.patch.object(vdl, '_removal_identity', side_effect=wrap('identity', vdl._removal_identity)), mock.patch.object(vdl, '_rename_noreplace', side_effect=wrap('retire', vdl._rename_noreplace)), mock.patch.object(vdl.os, 'unlink', side_effect=wrap('unlink', vdl.os.unlink)):
            self.assertEqual(self.mutate(payload).status_code, 200)
        self.assertIn('identity', observed)
        self.assertIn('retire', observed)
        self.assertIn('unlink', observed)

    def test_symlink_artifact_removal_never_follows_external_target(self):
        external = Path(self.temp_dir.name, 'external.bin')
        external.write_bytes(b'external-private')
        link = self.source + '.part'
        os.symlink(external, link)
        self.assertEqual(self.mutate(self.attempt()).status_code, 200)
        self.assertEqual(external.read_bytes(), b'external-private')
        self.assertFalse(os.path.lexists(link))

    def test_failed_filesystem_recovery_uses_no_sensitive_exception_text(self):
        payload = self.attempt()
        with mock.patch.object(vdl, '_rename_noreplace', side_effect=PermissionError(self.download_dir + '/private detail')):
            response = self.mutate(payload)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn(self.download_dir, str(response.json))
        self.assertIsNotNone(vdl.db_get_download('removeproto'))
        self.assertEqual(self.receipt(payload).status_code, 200)

    def test_unknown_fields_and_non_json_body_never_enter_legacy_removal(self):
        self.assertEqual(self.client.post('/api/remove/removeproto', json={'unexpected': True}).status_code, 400)
        self.assertEqual(self.client.post('/api/remove/removeproto', data='arbitrary', content_type='text/plain').status_code, 400)
        self.assertEqual(self.client.post('/api/remove/removeproto', data='[1]', content_type='application/json').status_code, 400)
        self.assertTrue(os.path.exists(self.source))

    def test_removed_identity_cannot_be_reused_after_receipt_and_journal_pruning(self):
        payload = self.attempt()
        self.assertEqual(self.mutate(payload).status_code, 200)
        with vdl._db_lock, vdl.db() as conn:
            vdl._prune_mutation_receipts(conn, time.time() + 3 * 24 * 3600)
            self.assertIsNone(conn.execute('SELECT 1 FROM removal_operations WHERE mutation_id = ?', (payload['client_mutation_id'],)).fetchone())
        with self.assertRaises(Exception) as error:
            self.insert('removeproto')
        self.assertIn('identities cannot be reused', str(error.exception).lower())

    def test_shared_receipt_quota_includes_admitted_removal_and_count_recovers(self):
        payload = self.attempt()
        self.crash(payload, 'prepared')
        with mock.patch.object(vdl, 'MUTATION_ACTOR_RECEIPT_LIMIT', 1):
            response = self.client.post('/api/favorite/removeproto', json={
                'favorite': True, 'expected_revision': '0',
                'client_mutation_id': str(int(time.time() * 1000)) + '-' + secrets.token_hex(16)})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(self.receipt(payload).status_code, 200)

    def test_old_journal_completion_retains_new_terminal_receipt_for_full_retention(self):
        payload = self.attempt()
        self.crash(payload, 'prepared')
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE removal_operations SET recorded_at = ? WHERE mutation_id = ?', (time.time() - 3 * 24 * 3600, payload['client_mutation_id']))
        result = self.receipt(payload)
        self.assertEqual(result.status_code, 200)
        with vdl._db_lock, vdl.db() as conn:
            vdl._prune_mutation_receipts(conn, time.time())
        self.assertEqual(self.receipt(payload).json, result.json)

    def test_crash_after_raced_retirement_restores_replacement_on_restart(self):
        payload = self.attempt()
        def checkpoint(phase, operation):
            if phase == 'before_retire':
                os.unlink(operation['source'])
                Path(operation['source']).write_bytes(b'replacement-at-retirement')
            elif phase == 'source_retired':
                raise RuntimeError('injected restart')
        with mock.patch.object(vdl, '_removal_checkpoint', side_effect=checkpoint):
            with self.assertRaisesRegex(RuntimeError, 'injected restart'):
                self.mutate(payload)
        self.assertFalse(os.path.exists(self.source))
        vdl.init_db()
        self.assertEqual(Path(self.source).read_bytes(), b'replacement-at-retirement')
        self.assertEqual(self.receipt(payload).status_code, 503)
        self.assertIsNotNone(vdl.db_get_download('removeproto'))

    def test_expired_recovery_waits_behind_an_already_admitted_write(self):
        payload = self.attempt()
        clients = [self.authenticated_client(), self.authenticated_client()]
        entered, release, lookup_started = threading.Event(), threading.Event(), threading.Event()
        def checkpoint(phase, operation):
            if phase == 'prepared':
                entered.set()
                self.assertTrue(release.wait(5))
        def lookup():
            lookup_started.set()
            return self.receipt(payload, clients[1])
        now = time.time()
        with mock.patch.object(vdl, '_removal_checkpoint', side_effect=checkpoint), ThreadPoolExecutor(max_workers=2) as pool:
            write = pool.submit(self.mutate, payload, clients[0])
            self.assertTrue(entered.wait(5))
            with mock.patch.object(vdl.time, 'time', return_value=now + vdl.MUTATION_REPLAY_SECONDS + 10):
                recovery = pool.submit(lookup)
                self.assertTrue(lookup_started.wait(5))
                self.assertFalse(recovery.done())
                release.set()
                first = write.result(5)
                result = recovery.result(5)
            self.assertEqual(first.status_code, 200, first.json)
            self.assertEqual(result.status_code, 200, result.json)
            self.assertEqual(result.json, first.json)

    def test_rename_acknowledgement_supplies_immediately_usable_removal_generation(self):
        rename = self.client.post('/api/rename/removeproto', json={'filename': 'Renamed.mp4'})
        self.assertEqual(rename.status_code, 200)
        payload = self.attempt()
        # Production protocol carries the generation in the rename result.
        state = self.client.get('/api/downloads/removeproto/editable-state').json
        renamed = self.client.post('/api/rename/removeproto', json={
            'client_mutation_id': str(int(time.time() * 1000)) + '-' + secrets.token_hex(16),
            'expected_revision': state['rename_revision'], 'filename': 'RenamedAgain.mp4'})
        self.assertEqual(renamed.status_code, 200, renamed.json)
        payload['expected_revision'] = renamed.json['removal_revision']
        self.assertEqual(self.mutate(payload).status_code, 200)

    def test_unreadable_artifact_discovery_never_claims_complete_removal(self):
        payload = self.attempt()
        with mock.patch.object(vdl.os, 'scandir', side_effect=PermissionError('private directory')):
            result = self.mutate(payload)
        self.assertEqual(result.status_code, 503)
        self.assertIsNotNone(vdl.db_get_download('removeproto'))
        self.assertEqual(Path(self.source).read_bytes(), b'admitted-media')
        self.assertNotIn('private directory', str(result.json))

    def test_inaccessible_source_during_recovery_cannot_be_mistaken_for_absence(self):
        payload = self.attempt()
        self.crash(payload, 'anchored')
        original = vdl.os.lstat
        def inaccessible(path, *args, **kwargs):
            if os.fspath(path) == self.source:
                raise PermissionError('private source')
            return original(path, *args, **kwargs)
        with mock.patch.object(vdl.os, 'lstat', side_effect=inaccessible):
            result = self.receipt(payload)
        self.assertEqual(result.status_code, 503)
        self.assertIsNotNone(vdl.db_get_download('removeproto'))
        self.assertEqual(Path(self.source).read_bytes(), b'admitted-media')
        self.assertEqual(self.receipt(payload).status_code, 200)

    def test_inaccessible_cleanup_cannot_publish_cleaned_or_confirm_file_removal(self):
        payload = self.attempt()
        self.crash(payload, 'committed')
        retired = json.loads(self.operation(payload)['artifacts'])[0]['retired']
        original = vdl.os.lstat
        def inaccessible(path, *args, **kwargs):
            if os.fspath(path) == retired:
                raise PermissionError('private cleanup')
            return original(path, *args, **kwargs)
        with mock.patch.object(vdl.os, 'lstat', side_effect=inaccessible):
            result = self.receipt(payload)
        self.assertEqual(result.status_code, 503)
        self.assertEqual(self.operation(payload)['phase'], 'done')
        self.assertEqual(Path(retired).read_bytes(), b'admitted-media')
        self.assertEqual(self.receipt(payload).status_code, 200)

    def test_startup_cleans_only_committed_owned_bytes_after_actor_revocation_or_deletion(self):
        for action in ('revoked', 'deleted'):
            target = 'done-' + action
            path = self.finished_file(target, target + '.mp4')
            actor = vdl.db_create_user('cleanup-' + action, 'cleanup-password', 'normal')
            client = self.authenticated_client('cleanup-' + action, 'cleanup-password')
            payload = self.attempt(target=target)
            def checkpoint(phase, operation):
                if phase == 'committed':
                    raise RuntimeError('injected restart')
            with mock.patch.object(vdl, '_removal_checkpoint', side_effect=checkpoint):
                with self.assertRaisesRegex(RuntimeError, 'injected restart'):
                    self.mutate(payload, client, target)
            operation = self.operation(payload)
            owned = [item[name] for item in json.loads(operation['artifacts']) for name in ('anchor', 'retired')]
            self.assertTrue(all(os.path.exists(name) for name in owned))
            with vdl._db_lock, vdl.db() as conn:
                if action == 'revoked':
                    conn.execute('UPDATE users SET session_version = session_version + 1 WHERE id = ?', (actor['id'],))
                else:
                    conn.execute('DELETE FROM users WHERE id = ?', (actor['id'],))
            vdl.init_db()
            self.assertFalse(os.path.exists(path))
            self.assertTrue(all(not os.path.exists(name) for name in owned))
            self.assertEqual(self.operation(payload)['phase'], 'cleaned')
            self.assertEqual(self.receipt(payload, client).status_code, 401)

    def test_startup_retains_ambiguous_committed_hidden_bytes_after_actor_revocation(self):
        payload = self.attempt()
        self.crash(payload, 'committed')
        operation = self.operation(payload)
        item = json.loads(operation['artifacts'])[0]
        os.unlink(item['retired'])
        Path(item['retired']).write_bytes(b'unrelated-hidden')
        with vdl._db_lock, vdl.db() as conn:
            conn.execute("UPDATE users SET session_version = session_version + 1 WHERE username = 'admin'")
        vdl.init_db()
        self.assertEqual(Path(item['retired']).read_bytes(), b'unrelated-hidden')
        self.assertEqual(self.operation(payload)['phase'], 'done')
        self.assertEqual(self.receipt(payload).status_code, 401)

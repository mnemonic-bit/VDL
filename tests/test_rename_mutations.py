import os
import secrets
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class RenameMutationTest(AppCase):
    def setUp(self):
        super().setUp()
        self.source = self.finished_file('renameproto', 'Original.mp4', b'intended-video')

    def state(self, client=None):
        return (client or self.client).get('/api/downloads/renameproto/editable-state')

    def attempt(self, filename='New.webm', revision=None, created=None):
        return {'filename': filename,
                'expected_revision': revision if revision is not None else self.state().json['rename_revision'],
                'client_mutation_id': str(int((created if created is not None else time.time()) * 1000)) + '-' + secrets.token_hex(16)}

    def mutate(self, payload, client=None, target='renameproto'):
        return (client or self.client).post('/api/rename/' + target, json=payload)

    def receipt(self, payload, client=None):
        return (client or self.client).get('/api/mutations/' + payload['client_mutation_id'])

    def operation(self):
        with vdl.db() as conn:
            row = conn.execute('SELECT * FROM rename_operations').fetchone()
        return dict(row) if row else None

    def crash(self, payload, phase):
        def checkpoint(actual, operation):
            if phase == actual:
                raise RuntimeError('injected restart')
        with mock.patch.object(vdl, '_rename_checkpoint', side_effect=checkpoint):
            with self.assertRaisesRegex(RuntimeError, 'injected restart'):
                self.mutate(payload)

    def test_canonical_protocol_all_serializers_and_independent_revision(self):
        before = self.state().json
        self.assertIsInstance(before['rename_revision'], str)
        self.assertIn('rename.set', self.client.get('/api/client-capabilities').json['actions'])
        payload = self.attempt()
        result = self.mutate(payload)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['filename'], os.path.join(self.download_dir, 'New.mp4'))
        self.assertIsNone(result.json['display_filename'])
        self.assertEqual(result.json['mutation']['outcome'], 'committed')
        for state in (self.state().json, vdl.db_get_download('renameproto'), vdl.db_list_downloads()[0]):
            self.assertEqual(state['rename_revision'], str(int(before['rename_revision']) + 1))
            self.assertEqual(state['filename'], result.json['filename'])
        vdl.db_update_download('renameproto', progress='99%', speed=1)
        vdl.db_set_download_favorite('renameproto', True)
        vdl.db_add_download_tag('renameproto', 'Music')
        self.assertEqual(self.state().json['rename_revision'], result.json['rename_revision'])
        self.assertEqual(self.receipt(payload).json, result.json)
        self.assertEqual(self.mutate(payload).json, result.json)
        self.assertIsNone(self.operation())

    def test_restart_at_every_durable_and_filesystem_boundary(self):
        for phase in ('prepared', 'anchor_created', 'anchored', 'destination_created', 'linked', 'source_retired', 'source_removed', 'moved', 'committed', 'cleaned'):
            with self.subTest(phase=phase):
                before = self.state().json
                payload = self.attempt(filename='Boundary-' + phase)
                self.crash(payload, phase)
                vdl.init_db()
                first = self.receipt(payload)
                self.assertEqual(first.status_code, 200)
                self.assertEqual(first.json['mutation']['outcome'], 'committed')
                self.assertEqual(first.json['rename_revision'], str(int(before['rename_revision']) + 1))
                self.assertEqual(Path(first.json['filename']).read_bytes(), b'intended-video')
                self.assertFalse(os.path.exists(before['filename']))
                vdl.init_db()
                self.assertEqual(self.mutate(payload).json, first.json)
                self.assertEqual(self.state().json['rename_revision'], first.json['rename_revision'])
                self.assertIsNone(self.operation())
                self.assertFalse(any(name.startswith('.vdl-rename-') for name in os.listdir(self.download_dir)))

    def test_destination_replacement_is_never_overwritten_and_old_source_restored(self):
        payload = self.attempt()
        self.crash(payload, 'moved')
        operation = self.operation()
        os.unlink(operation['destination'])
        with open(operation['destination'], 'wb') as output:
            output.write(b'unrelated')
        for _ in range(2):
            vdl.init_db()
            result = self.receipt(payload)
            self.assertEqual(result.status_code, 503)
            self.assertEqual(result.json['code'], 'rename_recovery_required')
            self.assertNotIn(self.download_dir, str(result.json))
            self.assertEqual(Path(operation['destination']).read_bytes(), b'unrelated')
            self.assertEqual(Path(operation['source']).read_bytes(), b'intended-video')
        response = self.client.get('/api/file/renameproto')
        self.assertEqual(response.data, b'intended-video')
        response.close()
        self.assertEqual(self.client.post('/api/remove/renameproto').status_code, 503)
        self.assertEqual(self.mutate(self.attempt('Other')).status_code, 503)
        os.unlink(operation['destination'])
        self.assertEqual(self.receipt(payload).status_code, 200)

    def test_source_replacement_before_anchor_remains_unresolved(self):
        payload = self.attempt()
        self.crash(payload, 'prepared')
        os.unlink(self.source)
        with open(self.source, 'wb') as output:
            output.write(b'replacement')
        vdl.init_db()
        self.assertEqual(self.receipt(payload).status_code, 503)
        response = self.client.get('/api/file/renameproto')
        self.assertEqual(response.status_code, 404)
        self.assertEqual(Path(self.source).read_bytes(), b'replacement')
        self.assertFalse(os.path.exists(os.path.join(self.download_dir, 'New.mp4')))

    def test_samepath_alias_cannot_stream_replacement_during_unresolved_operation(self):
        self.insert('alias')
        vdl.db_update_download('alias', status='finished', filename=self.source, output_dir=self.download_dir)
        payload = self.attempt()
        self.crash(payload, 'prepared')
        os.unlink(self.source)
        Path(self.source).write_bytes(b'unrelated-alias-source')
        for download_id in ('renameproto', 'alias'):
            response = self.client.get('/api/file/' + download_id)
            self.assertEqual(response.status_code, 404)
        self.assertEqual(Path(self.source).read_bytes(), b'unrelated-alias-source')

    def test_replacement_at_old_name_after_move_is_preserved(self):
        payload = self.attempt()
        self.crash(payload, 'moved')
        with open(self.source, 'wb') as output:
            output.write(b'unrelated')
        vdl.init_db()
        result = self.receipt(payload)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(Path(result.json['filename']).read_bytes(), b'intended-video')
        self.assertEqual(Path(self.source).read_bytes(), b'unrelated')

    def test_collision_created_at_effect_boundary_never_overwrites(self):
        payload = self.attempt()
        def checkpoint(phase, operation):
            if phase == 'anchored':
                with open(operation['destination'], 'xb') as output:
                    output.write(b'racing-collision')
        with mock.patch.object(vdl, '_rename_checkpoint', side_effect=checkpoint):
            result = self.mutate(payload)
        self.assertEqual(result.status_code, 503)
        self.assertEqual(Path(os.path.join(self.download_dir, 'New.mp4')).read_bytes(), b'racing-collision')
        self.assertEqual(Path(self.source).read_bytes(), b'intended-video')

    def test_replacement_after_commit_before_response_keeps_intended_inode_and_intervention(self):
        payload = self.attempt()
        self.crash(payload, 'committed')
        operation = self.operation()
        os.unlink(operation['destination'])
        Path(operation['destination']).write_bytes(b'postcommit-unrelated')
        vdl.init_db()
        self.assertEqual(self.receipt(payload).status_code, 503)
        self.assertEqual(self.mutate(payload).status_code, 503)
        self.assertEqual(Path(operation['anchor']).read_bytes(), b'intended-video')
        self.assertEqual(Path(operation['destination']).read_bytes(), b'postcommit-unrelated')
        response = self.client.get('/api/file/renameproto')
        self.assertEqual(response.data, b'intended-video')
        response.close()
        os.unlink(operation['destination'])
        os.link(operation['anchor'], operation['destination'])
        self.assertEqual(self.receipt(payload).status_code, 200)
        self.assertIsNone(self.operation())
        self.assertFalse(os.path.exists(self.source))

    def test_live_destination_replacement_before_publication_cannot_claim_success(self):
        payload = self.attempt()
        def replace(phase, operation):
            if phase == 'moved':
                os.unlink(operation['destination'])
                Path(operation['destination']).write_bytes(b'live-unrelated-destination')
        with mock.patch.object(vdl, '_rename_checkpoint', side_effect=replace):
            result = self.mutate(payload)
        self.assertEqual(result.status_code, 503)
        self.assertEqual(Path(self.source).read_bytes(), b'intended-video')
        self.assertEqual(Path(os.path.join(self.download_dir, 'New.mp4')).read_bytes(), b'live-unrelated-destination')
        self.assertEqual(vdl.db_get_download('renameproto')['filename'], self.source)
        self.assertIsNotNone(self.operation())
        self.assertEqual(self.receipt(payload).status_code, 503)

    def test_clock_and_shared_quota_rechecked_after_preflight_hash(self):
        original = vdl._rename_identity
        submitted = False
        def fill_quota(path):
            nonlocal submitted
            if not submitted:
                submitted = True
                self.assertEqual(self.client.post('/api/favorite/renameproto', json={
                    'favorite': True, 'expected_revision': '0',
                    'client_mutation_id': self.attempt()['client_mutation_id']}).status_code, 200)
            return original(path)
        payload = self.attempt()
        with mock.patch.object(vdl, 'MUTATION_ACTOR_RECEIPT_LIMIT', 1), mock.patch.object(vdl, '_rename_identity', side_effect=fill_quota):
            self.assertEqual(self.mutate(payload).status_code, 429)
        self.assertIsNone(self.operation())
        now = time.time()
        clock = [now]
        def advance_clock(path):
            clock[0] += 2
            return original(path)
        payload = self.attempt(created=now - vdl.MUTATION_REPLAY_SECONDS + 1)
        with mock.patch.object(vdl.time, 'time', side_effect=lambda: clock[0]), mock.patch.object(vdl, '_rename_identity', side_effect=advance_clock):
            result = self.mutate(payload)
        self.assertEqual(result.status_code, 400)
        self.assertEqual(result.json['mutation']['outcome'], 'rejected')
        self.assertIsNone(self.operation())

    def test_shared_mutation_identifier_rechecked_after_preflight_hash(self):
        payload = self.attempt()
        original = vdl._rename_identity
        submitted = False
        def claim_identifier(path):
            nonlocal submitted
            if not submitted:
                submitted = True
                response = self.client.post('/api/favorite/renameproto', json={
                    'favorite': True, 'expected_revision': '0',
                    'client_mutation_id': payload['client_mutation_id']})
                self.assertEqual(response.status_code, 200)
            return original(path)
        with mock.patch.object(vdl, '_rename_identity', side_effect=claim_identifier):
            response = self.mutate(payload)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json['code'], 'mutation_id_conflict')
        self.assertEqual(Path(self.source).read_bytes(), b'intended-video')
        self.assertIsNone(self.operation())

    def test_preflight_rejection_respects_identifier_claimed_during_hash(self):
        payload = self.attempt('x' * 256)
        original = vdl._rename_identity
        submitted = False
        def claim_identifier(path):
            nonlocal submitted
            if not submitted:
                submitted = True
                self.assertEqual(self.client.post('/api/favorite/renameproto', json={
                    'favorite': True, 'expected_revision': '0',
                    'client_mutation_id': payload['client_mutation_id']}).status_code, 200)
            return original(path)
        with mock.patch.object(vdl, '_rename_identity', side_effect=claim_identifier):
            response = self.mutate(payload)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json['code'], 'mutation_id_conflict')
        self.assertEqual(self.receipt(payload).json['mutation']['domain'], 'favorite')
        self.assertIsNone(self.operation())

    def test_active_alias_cannot_be_physically_renamed(self):
        self.insert('activealias')
        vdl.db_update_download('activealias', status='downloading', filename=self.source, output_dir=self.download_dir)
        result = self.mutate(self.attempt())
        self.assertEqual(result.status_code, 409)
        self.assertEqual(result.json['mutation']['outcome'], 'rejected')
        self.assertEqual(Path(self.source).read_bytes(), b'intended-video')

    def test_source_replaced_between_identity_check_and_retirement_is_never_deleted(self):
        payload = self.attempt()
        original = vdl._rename_noreplace
        swapped = False
        def swap_before_retirement(source, destination):
            nonlocal swapped
            if source == self.source and not swapped:
                swapped = True
                os.unlink(source)
                Path(source).write_bytes(b'racing-source-replacement')
            return original(source, destination)
        with mock.patch.object(vdl, '_rename_noreplace', side_effect=swap_before_retirement):
            result = self.mutate(payload)
        self.assertEqual(result.status_code, 503)
        self.assertEqual(Path(self.source).read_bytes(), b'racing-source-replacement')
        self.assertEqual(Path(self.operation()['anchor']).read_bytes(), b'intended-video')
        self.assertEqual(vdl.db_get_download('renameproto')['filename'], self.source)
        response = self.client.get('/api/file/renameproto')
        self.assertEqual(response.data, b'intended-video')
        response.close()

    def test_definite_validation_and_collision_receipts_preserve_extension(self):
        conflict = os.path.join(self.download_dir, 'Taken.mp4')
        with open(conflict, 'wb') as output:
            output.write(b'taken')
        for name, status in [('Taken.webm', 409), ('../escape', 400), ('a/b', 400), ('a\\b', 400), ('\x00', 400), ('.', 400), ('..', 400), ('', 400), (None, 400), (7, 400), ('x' * 256, 400)]:
            with self.subTest(name=name):
                payload = self.attempt(name)
                response = self.mutate(payload)
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json['mutation']['outcome'], 'rejected')
                self.assertEqual(self.receipt(payload).json, response.json)
        self.assertEqual(Path(conflict).read_bytes(), b'taken')
        os.unlink(self.source)
        payload = self.attempt()
        self.assertEqual(self.mutate(payload).status_code, 410)
        self.assertEqual(self.receipt(payload).json['mutation']['outcome'], 'rejected')

    def test_noop_display_only_and_legacy_writers_keep_revisions(self):
        before = self.state().json['rename_revision']
        response = self.mutate(self.attempt('Original.mp4'))
        self.assertFalse(response.json['changed'])
        self.assertEqual(response.json['rename_revision'], before)
        legacy = self.mutate({'filename': 'Legacy.webm'})
        self.assertEqual(legacy.json['filename'], 'Legacy.mp4')
        self.assertEqual(self.state().json['rename_revision'], str(int(before) + 1))
        vdl.db_update_download('renameproto', display_filename='Mounted.webm')
        physical = self.state().json['filename']
        response = self.mutate(self.attempt('Visible.webm'))
        self.assertEqual(response.json['display_filename'], 'Visible.mp4')
        self.assertEqual(response.json['filename'], physical)
        self.assertTrue(os.path.exists(physical))
        vdl.init_db()
        self.assertEqual(self.state().json['rename_revision'], response.json['rename_revision'])

    def test_simultaneous_replay_and_conflicting_renames(self):
        clients = [self.authenticated_client(), self.authenticated_client()]
        payload = self.attempt()
        barrier = threading.Barrier(2)
        def send(index):
            barrier.wait()
            return self.mutate(payload, clients[index])
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(send, range(2)))
        self.assertEqual(responses[0].json, responses[1].json)
        self.assertEqual(responses[0].status_code, 200)
        revision = self.state().json['rename_revision']
        payloads = [self.attempt('First', revision), self.attempt('Second', revision)]
        def compete(index):
            barrier.wait()
            return self.mutate(payloads[index], clients[index])
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(compete, range(2)))
        self.assertEqual(sorted(response.status_code for response in responses), [200, 409])
        rejected = next(response for response in responses if response.status_code == 409)
        self.assertEqual(rejected.json['mutation']['outcome'], 'conflicted')

    def test_filesystem_work_releases_sqlite_lock_and_removal_serializes(self):
        payload = self.attempt()
        entered, release, removal_started = threading.Event(), threading.Event(), threading.Event()
        clients = [self.authenticated_client(), self.authenticated_client()]
        def checkpoint(phase, operation):
            if phase == 'destination_created':
                self.assertTrue(vdl._db_lock.acquire(blocking=False))
                vdl._db_lock.release()
                entered.set()
                self.assertTrue(release.wait(5))
        def remove():
            removal_started.set()
            return clients[1].post('/api/remove/renameproto')
        with mock.patch.object(vdl, '_rename_checkpoint', side_effect=checkpoint):
            with ThreadPoolExecutor(max_workers=2) as pool:
                rename = pool.submit(self.mutate, payload, clients[0])
                self.assertTrue(entered.wait(5))
                removal = pool.submit(remove)
                self.assertTrue(removal_started.wait(5))
                self.assertFalse(removal.done())
                release.set()
                self.assertEqual(rename.result(5).status_code, 200)
                self.assertEqual(removal.result(5).status_code, 200)
        self.assertIsNone(vdl.db_get_download('renameproto'))
        self.assertFalse(os.path.exists(os.path.join(self.download_dir, 'New.mp4')))
        self.assertEqual(self.receipt(payload).status_code, 404)

    def test_retry_serializes_file_ownership_and_blocks_unresolved_journal(self):
        payload = self.attempt()
        self.crash(payload, 'anchored')
        response = self.client.post('/api/retry/renameproto')
        self.assertEqual(response.status_code, 500)
        self.assertEqual(vdl.db_get_download('renameproto')['status'], 'finished')
        self.assertEqual(Path(self.source).read_bytes(), b'intended-video')
        self.assertEqual(self.receipt(payload).status_code, 200)
        original = vdl.delete_download_artifacts
        def cleanup_without_db_lock(*args, **kwargs):
            self.assertTrue(vdl._db_lock.acquire(blocking=False))
            vdl._db_lock.release()
            return original(*args, **kwargs)
        with mock.patch.object(vdl, 'delete_download_artifacts', side_effect=cleanup_without_db_lock), mock.patch.object(vdl, 'enqueue_download'):
            self.assertEqual(self.client.post('/api/retry/renameproto').status_code, 200)
        self.assertIsNone(vdl.db_get_download('renameproto')['filename'])

    def test_shared_path_and_hardlink_aliases_remain_valid(self):
        self.insert('samepath')
        vdl.db_update_download('samepath', status='finished', filename=self.source, output_dir=self.download_dir)
        self.insert('hardlink')
        hardlink = os.path.join(self.download_dir, 'Hardlink.mp4')
        os.link(self.source, hardlink)
        vdl.db_update_download('hardlink', status='finished', filename=hardlink, output_dir=self.download_dir)
        result = self.mutate(self.attempt())
        self.assertEqual(result.status_code, 200)
        self.assertEqual(vdl.db_get_download('samepath')['filename'], result.json['filename'])
        self.assertEqual(Path(hardlink).read_bytes(), b'intended-video')
        self.assertEqual(self.client.post('/api/remove/renameproto').status_code, 200)
        self.assertTrue(os.path.isfile(vdl.db_get_download('samepath')['filename']))
        self.assertEqual(self.client.post('/api/remove/samepath').status_code, 200)
        self.assertTrue(os.path.isfile(hardlink))

    def test_authorization_revocation_suspension_and_private_alias(self):
        user = vdl.db_create_user('renamer', 'viewer-password', 'normal')
        viewer = self.authenticated_client('renamer', 'viewer-password')
        payload = self.attempt()
        self.crash(payload, 'anchored')
        vdl.db_set_download_visibility('renameproto', 'private')
        self.assertEqual(self.mutate(payload, viewer).status_code, 404)
        self.assertEqual(self.receipt(payload, viewer).status_code, 404)
        # The original admitted actor is checked again before recovery effects.
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE users SET suspended = 1 WHERE username = ?', ('admin',))
        vdl.init_db()
        self.assertTrue(os.path.isfile(self.source))
        self.assertFalse(os.path.exists(os.path.join(self.download_dir, 'New.mp4')))
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE users SET suspended = 0 WHERE username = ?', ('admin',))
        self.assertEqual(self.receipt(payload).status_code, 200)
        # A visible row sharing an inaccessible path does not authorize edits to it.
        self.insert('privatealias')
        vdl.db_update_download('privatealias', status='finished', filename=self.state().json['filename'], output_dir=self.download_dir)
        vdl.db_set_download_visibility('privatealias', 'private')
        vdl.db_set_download_visibility('renameproto', 'public')
        result = self.mutate(self.attempt('Denied'), viewer)
        self.assertEqual(result.status_code, 409)
        self.assertEqual(result.json['mutation']['outcome'], 'rejected')

    def test_alias_access_loss_after_move_restores_every_confirmed_source_reference(self):
        vdl.db_create_user('aliasrenamer', 'alias-password', 'normal')
        viewer = self.authenticated_client('aliasrenamer', 'alias-password')
        self.insert('alias')
        vdl.db_update_download('alias', status='finished', filename=self.source, output_dir=self.download_dir)
        payload = self.attempt()
        def revoke_alias(phase, operation):
            if phase == 'moved':
                vdl.db_set_download_visibility('alias', 'private')
        with mock.patch.object(vdl, '_rename_checkpoint', side_effect=revoke_alias):
            result = self.mutate(payload, viewer)
        self.assertEqual(result.status_code, 503)
        self.assertEqual(Path(self.source).read_bytes(), b'intended-video')
        vdl.init_db()
        self.assertEqual(self.receipt(payload, viewer).status_code, 503)
        response = self.client.get('/api/file/alias')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b'intended-video')
        response.close()

    def test_authorization_loss_after_move_repairs_confirmed_source_without_overwrite(self):
        for phase in ('source_removed', 'moved'):
            with self.subTest(phase=phase):
                payload = self.attempt('Revoked-' + phase)
                def revoke(actual, operation):
                    if actual == phase:
                        with vdl._db_lock, vdl.db() as conn:
                            conn.execute('UPDATE users SET suspended = 1 WHERE username = ?', ('admin',))
                with mock.patch.object(vdl, '_rename_checkpoint', side_effect=revoke):
                    self.assertEqual(self.mutate(payload).status_code, 401)
                self.assertEqual(Path(self.source).read_bytes(), b'intended-video')
                vdl.init_db()
                self.assertEqual(Path(self.source).read_bytes(), b'intended-video')
                self.assertEqual(vdl.db_get_download('renameproto')['filename'], self.source)
                with vdl._db_lock, vdl.db() as conn:
                    conn.execute('UPDATE users SET suspended = 0 WHERE username = ?', ('admin',))
                self.assertEqual(self.receipt(payload).status_code, 200)
                self.source = self.state().json['filename']

    def test_fingerprint_actor_scoping_expiry_quotas_and_response_loss(self):
        payload = self.attempt()
        self.crash(payload, 'committed')
        result = self.receipt(payload)
        self.assertEqual(result.status_code, 200)
        for change in ({'filename': 'Other'}, {'expected_revision': '0'}):
            self.assertEqual(self.mutate(dict(payload, **change)).json['code'], 'mutation_id_conflict')
        self.assertEqual(self.client.post('/api/favorite/renameproto', json=dict(payload, favorite=True)).json['code'], 'mutation_id_conflict')
        for limit in ('MUTATION_ACTOR_RECEIPT_LIMIT', 'MUTATION_ACTOR_MINUTE_LIMIT'):
            with mock.patch.object(vdl, limit, 1):
                self.assertEqual(self.mutate(self.attempt('Quota')).status_code, 429)
                self.assertEqual(self.mutate(payload).status_code, 200)
        for created in (time.time() - 86401, time.time() + 301):
            response = self.mutate(self.attempt(created=created))
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json['mutation']['outcome'], 'rejected')
        for revision in (0, '-1', '01', '9' * 100):
            self.assertEqual(self.mutate(self.attempt(revision=revision)).status_code, 400)
        self.assertEqual(self.mutate({'filename': 'x' * 5000}).status_code, 413)
        self.assertEqual(self.mutate([]).status_code, 400)
        self.assertEqual(self.mutate(dict(payload, client_mutation_id='bad')).status_code, 400)
        vdl.db_create_user('foreign', 'foreign-password', 'normal')
        foreign = self.authenticated_client('foreign', 'foreign-password')
        self.assertEqual(self.receipt(payload, foreign).status_code, 404)
        self.assertEqual(self.mutate(self.attempt(), foreign).status_code, 200)

    def test_active_journals_never_expire_or_claim_final_absence(self):
        payload = self.attempt()
        self.crash(payload, 'prepared')
        with mock.patch.object(vdl.time, 'time', return_value=time.time() + 3 * 86400):
            with mock.patch.object(vdl, '_rename_checkpoint', side_effect=OSError('held recovery')):
                response = self.receipt(payload)
                self.assertEqual(response.status_code, 503)
                self.assertNotIn('final', response.json)
            with mock.patch.object(vdl, 'MUTATION_ACTOR_RECEIPT_LIMIT', 1):
                self.assertEqual(self.client.post('/api/favorite/renameproto', json={
                    'favorite': True, 'expected_revision': '0',
                    'client_mutation_id': self.attempt()['client_mutation_id']}).status_code, 429)
            self.assertEqual(self.receipt(payload).status_code, 200)
        self.assertEqual(self.mutate(payload).status_code, 200)

    def test_postcommit_cleanup_failure_preserves_result_and_bounded_housekeeping(self):
        payload = self.attempt()
        with mock.patch.object(vdl, '_finish_rename_cleanup', side_effect=OSError('cleanup unavailable')):
            self.assertEqual(self.mutate(payload).status_code, 200)
        operation = self.operation()
        self.assertEqual(operation['phase'], 'done')
        self.assertTrue(os.path.isfile(operation['anchor']))
        with mock.patch.object(vdl, '_finish_rename_cleanup', side_effect=OSError('cleanup unavailable')):
            self.assertEqual(self.receipt(payload).status_code, 200)
        # Receipt retention cannot discard the only anchor cleanup record.
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('DELETE FROM mutation_receipts')
        with mock.patch.object(vdl, 'MUTATION_ACTOR_RECEIPT_LIMIT', 1):
            self.assertEqual(self.client.post('/api/favorite/renameproto', json={
                'favorite': True, 'expected_revision': '0',
                'client_mutation_id': self.attempt()['client_mutation_id']}).status_code, 429)
        vdl.init_db()
        self.assertFalse(os.path.exists(operation['anchor']))
        self.assertIsNone(self.operation())

    def test_done_housekeeping_cannot_override_newer_canonical_file_identity(self):
        self.insert('alias')
        vdl.db_update_download('alias', status='finished', filename=self.source, output_dir=self.download_dir)
        payload = self.attempt()
        with mock.patch.object(vdl, '_finish_rename_cleanup', side_effect=OSError('cleanup unavailable')):
            self.assertEqual(self.mutate(payload).status_code, 200)
        operation = self.operation()
        replacement = os.path.join(self.download_dir, 'Replacement.mp4')
        Path(replacement).write_bytes(b'new-canonical-media')
        for target in ('renameproto', 'alias'):
            vdl.db_update_download(target, filename=replacement)
            response = self.client.get('/api/file/' + target)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data, b'new-canonical-media')
            response.close()
        # Supersession also fences an old path reused by a newer writer.
        vdl.db_update_download('renameproto', filename=operation['destination'])
        Path(operation['destination']).unlink()
        Path(operation['destination']).write_bytes(b'new-generation-at-old-path')
        response = self.client.get('/api/file/renameproto')
        self.assertEqual(response.data, b'new-generation-at-old-path')
        response.close()
        vdl.init_db()
        self.assertIsNone(self.operation())
        self.assertFalse(os.path.exists(operation['anchor']))
        self.assertFalse(os.path.exists(operation['source']))
        self.assertEqual(Path(replacement).read_bytes(), b'new-canonical-media')
        self.assertEqual(Path(operation['destination']).read_bytes(), b'new-generation-at-old-path')

    def test_security_headers_and_publication_do_not_disclose_private_identity(self):
        payload = self.attempt()
        self.assertEqual(self.client.post('/api/rename/renameproto', json=payload,
                                         headers={'Origin': 'https://attacker.invalid'}).status_code, 403)
        subscriber = vdl.event_bus.subscribe()
        result = self.mutate(payload)
        self.assertEqual(result.headers['Cache-Control'], 'no-store')
        self.assertEqual(subscriber.get_nowait(), ('change', {'reason': 'rename'}))
        self.assertTrue(subscriber.empty())
        with mock.patch.object(vdl.event_bus, 'publish', side_effect=RuntimeError('offline')):
            result = self.mutate(self.attempt('No-events'))
        self.assertEqual(result.status_code, 200)
        self.assertEqual(vdl.app.test_client().post('/api/rename/renameproto', json=self.attempt()).status_code, 401)


if __name__ == '__main__':
    unittest.main()

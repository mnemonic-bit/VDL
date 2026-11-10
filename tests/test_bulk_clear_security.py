"""Current administration authority throughout accepted bulk file operations."""
import os
import secrets
import time
from pathlib import Path
from unittest import mock

from flask import session

import vdl
from tests.support.app_case import AppCase


class BulkClearSecurityTest(AppCase):
    def setUp(self):
        super().setUp()
        self.actor = vdl.db_create_user('bulk-admin', 'bulk-password', 'admin')
        self.actor_client = self.authenticated_client('bulk-admin', 'bulk-password')
        self.source = self.finished_file('bulk-security', 'Confidential.mp4', b'private-media')

    def attempt(self):
        preview = self.actor_client.get('/api/library/clear/preview?include_scope=true')
        self.assertEqual(preview.status_code, 200, preview.json)
        return {'client_mutation_id': f'{int(time.time() * 1000)}-{secrets.token_hex(16)}',
                'scope_id': preview.json['scope_id'], 'expected_revision': preview.json['revision']}

    def execute(self, payload, client=None):
        return (client or self.actor_client).post('/api/library/clear', json=payload)

    def receipt(self, payload, client=None):
        return (client or self.actor_client).get('/api/mutations/' + payload['client_mutation_id'])

    def revoke(self, mode):
        if mode == 'role':
            vdl.db_update_user(self.actor['id'], role_name='normal')
        elif mode == 'session':
            vdl.db_update_user(self.actor['id'], password='replacement-password')
        elif mode == 'suspended':
            vdl.db_update_user(self.actor['id'], suspended=True)
        else:
            vdl.db_delete_user(self.actor['id'])

    def test_nonadministrator_cannot_preview_execute_or_recover_admin_scope(self):
        normal = vdl.db_create_user('normal', 'normal-password', 'normal')
        observer = self.authenticated_client('normal', 'normal-password')
        payload = self.attempt()
        self.assertEqual(observer.get('/api/library/clear/preview?include_scope=true').status_code, 403)
        self.assertEqual(self.execute(payload, observer).status_code, 403)
        self.assertEqual(self.receipt(payload, observer).status_code, 404)
        self.assertEqual(Path(self.source).read_bytes(), b'private-media')

    def test_completed_outcome_and_scope_do_not_cross_administrator_accounts(self):
        payload = self.attempt()
        result = self.execute(payload)
        self.assertEqual(result.status_code, 200, result.json)
        unavailable = self.receipt(payload, self.client)
        absent_id = f'{int(time.time() * 1000)}-{secrets.token_hex(16)}'
        absent = self.client.get('/api/mutations/' + absent_id)
        self.assertEqual(unavailable.status_code, 404)
        self.assertEqual(unavailable.json, absent.json)
        self.assertEqual(self.execute(payload, self.client).status_code, 409)

    def test_role_revocation_after_exclusive_retirement_restores_owned_source(self):
        payload = self.attempt()
        def checkpoint(phase, _operation):
            if phase == 'retired':
                self.revoke('role')
        with mock.patch.object(vdl, '_removal_checkpoint', side_effect=checkpoint):
            response = self.execute(payload)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(Path(self.source).read_bytes(), b'private-media')
        self.assertIsNotNone(vdl.db_get_download('bulk-security'))
        self.assertEqual(self.receipt(payload).status_code, 403)
        vdl.init_db()
        self.assertEqual(Path(self.source).read_bytes(), b'private-media')

    def test_session_revocation_after_anchors_prevents_publication_and_startup_replay(self):
        payload = self.attempt()
        def checkpoint(phase, _operation):
            if phase == 'anchored':
                self.revoke('session')
        with mock.patch.object(vdl, '_removal_checkpoint', side_effect=checkpoint):
            response = self.execute(payload)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.receipt(payload).status_code, 401)
        vdl.init_db()
        self.assertEqual(Path(self.source).read_bytes(), b'private-media')
        self.assertIsNotNone(vdl.db_get_download('bulk-security'))

    def test_suspension_after_preparation_retains_media_and_denies_recovery(self):
        payload = self.attempt()
        def checkpoint(phase, _operation):
            if phase == 'prepared':
                self.revoke('suspended')
        with mock.patch.object(vdl, '_removal_checkpoint', side_effect=checkpoint):
            response = self.execute(payload)
        self.assertEqual(response.status_code, 401)
        vdl.init_db()
        self.assertEqual(Path(self.source).read_bytes(), b'private-media')
        self.assertEqual(self.receipt(payload).status_code, 401)

    def test_account_deletion_after_retirement_restores_owned_bytes_and_does_not_transfer_recovery(self):
        payload = self.attempt()
        def checkpoint(phase, _operation):
            if phase == 'retired':
                self.revoke('deleted')
        with mock.patch.object(vdl, '_removal_checkpoint', side_effect=checkpoint):
            response = self.execute(payload)
        self.assertEqual(response.status_code, 401)
        vdl.init_db()
        self.assertEqual(Path(self.source).read_bytes(), b'private-media')
        self.assertEqual(self.receipt(payload).status_code, 401)
        self.assertEqual(self.receipt(payload, self.client).status_code, 404)

    def test_revocation_after_committed_removal_allows_owned_cleanup_but_hides_outcome(self):
        payload = self.attempt()
        def checkpoint(phase, _operation):
            if phase == 'committed':
                self.revoke('suspended')
        with mock.patch.object(vdl, '_removal_checkpoint', side_effect=checkpoint):
            response = self.execute(payload)
        self.assertEqual(response.status_code, 401)
        self.assertIsNone(vdl.db_get_download('bulk-security'))
        vdl.init_db()
        self.assertFalse(os.path.lexists(self.source))
        self.assertFalse(any(name.startswith('.vdl-remove-') for name in os.listdir(self.download_dir)))
        self.assertEqual(self.receipt(payload).status_code, 401)

    def test_receipt_retention_race_returns_authorized_receipt_or_serialized_final_absence(self):
        payload = self.attempt()
        result = self.execute(payload)
        self.assertEqual(result.status_code, 200)
        with vdl._db_lock, vdl.db() as conn:
            operation = dict(conn.execute('SELECT * FROM bulk_clear_scopes WHERE id=?', (payload['scope_id'],)).fetchone())
            conn.execute('DELETE FROM bulk_clear_scopes WHERE id=?', (payload['scope_id'],))
        with vdl.app.test_request_context('/api/mutations/' + payload['client_mutation_id']):
            session['user_id'] = self.actor['id']
            session['session_version'] = self.actor['session_version']
            recovered, status = vdl._recover_bulk_clear_operation(operation)
            self.assertEqual(status, 200)
            self.assertEqual(recovered, result.json)
            with vdl._db_lock, vdl.db() as conn:
                conn.execute('DELETE FROM mutation_receipts WHERE mutation_id=?', (payload['client_mutation_id'],))
            later = time.time() + vdl.MUTATION_REPLAY_SECONDS + 1
            with mock.patch.object(vdl.time, 'time', return_value=later):
                recovered, status = vdl._recover_bulk_clear_operation(operation)
            self.assertEqual(status, 404)
            self.assertTrue(recovered['final'])

    def test_startup_restores_changed_source_and_preserves_replacement_instead_of_claiming_success(self):
        payload = self.attempt()
        def checkpoint(phase, _operation):
            if phase == 'prepared':
                raise RuntimeError('injected restart')
        with mock.patch.object(vdl, '_removal_checkpoint', side_effect=checkpoint):
            with self.assertRaisesRegex(RuntimeError, 'injected restart'):
                self.execute(payload)
        os.unlink(self.source)
        Path(self.source).write_bytes(b'unrelated-replacement')
        vdl.init_db()
        result = self.receipt(payload)
        self.assertEqual(result.status_code, 200, result.json)
        self.assertEqual(result.json['mutation']['outcome'], 'accepted')
        self.assertEqual(result.json['pending'], 1)
        self.assertEqual(result.json['removed'], 0)
        self.assertEqual(Path(self.source).read_bytes(), b'unrelated-replacement')
        self.assertNotIn(self.download_dir, str(result.json))

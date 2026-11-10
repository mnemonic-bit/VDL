"""Removal authorization and privacy through the production HTTP boundaries."""
import os
import secrets
import time
from pathlib import Path
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class EntryRemovalSecurityTest(AppCase):
    def setUp(self):
        super().setUp()
        self.owner = vdl.db_create_user('remover', 'removal-password', 'normal')
        self.observer = vdl.db_create_user('observer', 'observer-password', 'normal')
        self.owner_client = self.authenticated_client('remover', 'removal-password')
        self.observer_client = self.authenticated_client('observer', 'observer-password')
        vdl.db_insert_download('remove-security', 'https://fixture.invalid/video',
                               owner_user_id=self.owner['id'], owner_username='remover')
        self.path = self.finished_file('remove-security', 'private-title.mp4', b'owned-media')

    def attempt(self, scope='entry-and-files'):
        state = self.owner_client.get('/api/downloads/remove-security/editable-state')
        self.assertEqual(state.status_code, 200)
        return {
            'client_mutation_id': f'{int(time.time() * 1000)}-{secrets.token_hex(16)}',
            'expected_revision': state.json['removal_revision'],
            'scope': scope,
        }

    def remove(self, payload, client=None, target='remove-security', **kwargs):
        return (client or self.owner_client).post('/api/remove/' + target,
                                                  json=payload, **kwargs)

    def receipt(self, payload, client=None):
        return (client or self.owner_client).get('/api/mutations/' + payload['client_mutation_id'])

    def test_private_target_and_missing_target_have_indistinguishable_denials(self):
        payload = self.attempt()
        vdl.db_set_download_visibility('remove-security', 'private')
        denied = self.remove(payload, self.observer_client)
        absent = self.remove(payload, self.observer_client, target='missing-entry')
        self.assertEqual(denied.status_code, 404)
        self.assertEqual(denied.json, absent.json)
        self.assertEqual(Path(self.path).read_bytes(), b'owned-media')
        self.assertIsNotNone(vdl.db_get_download('remove-security'))

    def test_public_visibility_keeps_existing_authenticated_removal_permission(self):
        result = self.remove(self.attempt(), self.observer_client)
        self.assertEqual(result.status_code, 200, result.json)
        self.assertTrue(result.json['removed'])
        self.assertFalse(os.path.exists(self.path))

    def test_removed_receipt_remains_actor_scoped_without_private_metadata(self):
        payload = self.attempt()
        result = self.remove(payload)
        self.assertEqual(result.status_code, 200, result.json)
        self.assertIsNone(vdl.db_get_download('remove-security'))
        receipt = self.receipt(payload)
        self.assertEqual(receipt.status_code, 200)
        self.assertEqual(receipt.json, result.json)
        self.assertEqual(self.remove(payload).json, result.json)
        for response in (result, receipt):
            self.assertEqual(response.headers.get('Cache-Control'), 'no-store')
            self.assertNotIn(self.download_dir, response.get_data(as_text=True))
            self.assertNotIn('private-title', response.get_data(as_text=True))
            self.assertNotIn('remover', response.get_data(as_text=True))
        for client in (self.observer_client, self.client):
            foreign = self.receipt(payload, client)
            missing = client.get('/api/mutations/' +
                                 f'{int(time.time() * 1000)}-{secrets.token_hex(16)}')
            self.assertEqual(foreign.status_code, 404)
            self.assertEqual(foreign.json, missing.json)

    def test_cross_origin_and_fetch_metadata_reject_before_removal(self):
        payload = self.attempt()
        for headers in ({'Origin': 'https://attacker.invalid'}, {'Origin': 'null'},
                        {'Sec-Fetch-Site': 'cross-site'}):
            with self.subTest(headers=headers):
                self.assertEqual(self.remove(payload, headers=headers).status_code, 403)
        self.assertEqual(Path(self.path).read_bytes(), b'owned-media')
        self.assertIsNotNone(vdl.db_get_download('remove-security'))

    def test_revoked_session_cannot_execute_or_recover(self):
        payload = self.attempt()
        vdl.db_update_user(self.owner['id'], password='replacement-password')
        self.assertEqual(self.remove(payload).status_code, 401)
        self.assertEqual(self.receipt(payload).status_code, 401)
        self.assertEqual(Path(self.path).read_bytes(), b'owned-media')

    def test_suspended_actor_cannot_recover_a_removed_entry(self):
        payload = self.attempt()
        self.assertEqual(self.remove(payload).status_code, 200)
        vdl.db_update_user(self.owner['id'], suspended=True)
        self.assertEqual(self.receipt(payload).status_code, 401)
        self.assertEqual(self.remove(payload).status_code, 401)

    def test_deleted_actor_cannot_recover_and_other_accounts_do_not_inherit_receipt(self):
        payload = self.attempt()
        self.assertEqual(self.remove(payload).status_code, 200)
        vdl.db_delete_user(self.owner['id'])
        self.assertEqual(self.receipt(payload).status_code, 401)
        self.assertEqual(self.receipt(payload, self.observer_client).status_code, 404)
        self.assertEqual(self.receipt(payload, self.client).status_code, 404)

    def test_record_only_removal_cannot_be_replayed_with_file_removal_scope(self):
        payload = self.attempt('entry')
        result = self.remove(payload)
        self.assertEqual(result.status_code, 200, result.json)
        self.assertEqual(Path(self.path).read_bytes(), b'owned-media')
        changed_scope = dict(payload, scope='entry-and-files')
        mismatch = self.remove(changed_scope)
        self.assertEqual(mismatch.status_code, 409, mismatch.json)
        self.assertEqual(mismatch.json['code'], 'mutation_id_conflict')
        self.assertEqual(Path(self.path).read_bytes(), b'owned-media')
        self.assertEqual(self.receipt(payload).json, result.json)

    def test_invalid_scopes_never_fall_back_to_destructive_legacy_behavior(self):
        for scope in ('files', '../all', '', None, False, 1, ['entry-and-files']):
            with self.subTest(scope=scope):
                response = self.remove(self.attempt(scope))
                self.assertEqual(response.status_code, 400, response.json)
                self.assertEqual(Path(self.path).read_bytes(), b'owned-media')
                self.assertIsNotNone(vdl.db_get_download('remove-security'))

    def test_stored_file_path_remains_authoritative_after_preference_change(self):
        payload = self.attempt()
        other_dir = os.path.join(self.temp_dir.name, 'new-downloads')
        os.mkdir(other_dir)
        decoy = Path(other_dir, 'private-title.mp4')
        decoy.write_bytes(b'unrelated-new-directory')
        vdl.db_set_preferences({'download_dir': other_dir})
        response = self.remove(payload)
        self.assertEqual(response.status_code, 200, response.json)
        self.assertFalse(os.path.exists(self.path))
        self.assertEqual(decoy.read_bytes(), b'unrelated-new-directory')

    def test_visibility_revocation_after_admission_prevents_filesystem_effects(self):
        payload = self.attempt()

        def revoke(phase, _operation):
            if phase == 'prepared':
                vdl.db_set_download_visibility('remove-security', 'private')

        with mock.patch.object(vdl, '_removal_checkpoint', side_effect=revoke):
            response = self.remove(payload, self.observer_client)
        self.assertNotEqual(response.status_code, 200)
        self.assertIsNotNone(vdl.db_get_download('remove-security'))
        self.assertEqual(Path(self.path).read_bytes(), b'owned-media')
        self.assertEqual(self.receipt(payload, self.observer_client).status_code, 404)

    def test_session_revocation_after_admission_prevents_filesystem_effects(self):
        payload = self.attempt()

        def revoke(phase, _operation):
            if phase == 'prepared':
                vdl.db_update_user(self.owner['id'], password='replacement-password')

        with mock.patch.object(vdl, '_removal_checkpoint', side_effect=revoke):
            response = self.remove(payload)
        self.assertNotEqual(response.status_code, 200)
        self.assertIsNotNone(vdl.db_get_download('remove-security'))
        self.assertEqual(Path(self.path).read_bytes(), b'owned-media')
        self.assertEqual(self.receipt(payload).status_code, 401)

    def test_removing_public_alias_preserves_private_entries_shared_media(self):
        vdl.db_insert_download('private-alias', 'https://fixture.invalid/alias',
                               owner_user_id=self.owner['id'], owner_username='remover')
        vdl.db_update_download('private-alias', status='finished', filename=self.path,
                               output_dir=self.download_dir)
        vdl.db_set_download_visibility('private-alias', 'private')
        response = self.remove(self.attempt(), self.observer_client)
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(Path(self.path).read_bytes(), b'owned-media')
        self.assertIsNotNone(vdl.db_get_download('private-alias'))
        playable = self.owner_client.get('/api/file/private-alias', buffered=True)
        self.assertEqual(playable.status_code, 200)
        self.assertEqual(playable.data, b'owned-media')
        playable.close()

    def test_recent_terminal_receipt_remains_recoverable_after_a_long_running_removal(self):
        payload = self.attempt()
        response = self.remove(payload)
        self.assertEqual(response.status_code, 200, response.json)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE removal_operations SET recorded_at = ? WHERE mutation_id = ?',
                         (time.time() - vdl.MUTATION_RETENTION_SECONDS - 60,
                          payload['client_mutation_id']))
            vdl._prune_mutation_receipts(conn, time.time())
        receipt = self.receipt(payload)
        self.assertEqual(receipt.status_code, 200, receipt.json)
        self.assertEqual(receipt.json, response.json)
        self.assertEqual(self.remove(payload).json, response.json)

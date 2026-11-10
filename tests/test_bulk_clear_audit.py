"""Independent checks of bulk scope, authorization, and shared-file safety."""

import os
import secrets
import time
from pathlib import Path
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class BulkClearAuditTest(AppCase):
    def preview(self, kind='library', client=None):
        path = '/api/library/clear' if kind == 'library' else '/api/clear'
        response = (client or self.client).get(path + '/preview?include_scope=true')
        self.assertEqual(response.status_code, 200, response.json)
        return response.json

    def attempt(self, preview):
        return {
            'client_mutation_id': f'{int(time.time() * 1000)}-{secrets.token_hex(16)}',
            'scope_id': preview['scope_id'],
            'expected_revision': preview['revision'],
        }

    def execute(self, payload, kind='library', client=None, **kwargs):
        path = '/api/library/clear' if kind == 'library' else '/api/clear'
        return (client or self.client).post(path, json=payload, **kwargs)

    def test_library_replay_preserves_new_alias_and_its_shared_media(self):
        source = self.finished_file('old-alias', 'Shared.mp4', b'shared-media')
        payload = self.attempt(self.preview())
        self.insert('new-alias')
        vdl.db_update_download('new-alias', status='finished', filename=source,
                               output_dir=self.download_dir)
        response = self.execute(payload)
        self.assertEqual(response.status_code, 200, response.json)
        self.assertIsNone(vdl.db_get_download('old-alias'))
        self.assertIsNotNone(vdl.db_get_download('new-alias'))
        self.assertEqual(Path(source).read_bytes(), b'shared-media')
        self.assertEqual(self.execute(payload).json, response.json)
        receipt = self.client.get('/api/mutations/' + payload['client_mutation_id'])
        self.assertEqual(receipt.json, response.json)
        self.assertEqual(Path(source).read_bytes(), b'shared-media')

    def test_history_clear_never_deletes_later_terminal_attempts_or_media(self):
        source = self.finished_file('old-attempt', 'Old.mp4')
        payload = self.attempt(self.preview('history'))
        newer = self.finished_file('new-attempt', 'New.mp4')
        response = self.execute(payload, 'history')
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json['removed'], 1)
        for path in (source, newer):
            self.assertTrue(os.path.exists(path))
        with vdl.db() as conn:
            remaining = [row['work_id'] for row in conn.execute('SELECT work_id FROM download_attempts')]
        self.assertEqual(remaining, ['new-attempt'])
        self.assertEqual(self.execute(payload, 'history').json, response.json)
        with vdl.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM download_attempts').fetchone()[0], 1)

    def test_preview_scope_is_actor_bound_even_for_another_administrator(self):
        self.finished_file('private-scope', 'Private.mp4')
        payload = self.attempt(self.preview())
        vdl.db_create_user('other-admin', 'another-password', 'admin')
        other = self.authenticated_client('other-admin', 'another-password')
        response = self.execute(payload, client=other)
        self.assertNotEqual(response.status_code, 200, response.json)
        self.assertIsNotNone(vdl.db_get_download('private-scope'))
        unavailable = other.get('/api/mutations/' + payload['client_mutation_id'])
        self.assertEqual(unavailable.status_code, 404)
        self.assertNotIn('private-scope', unavailable.get_data(as_text=True))

    def test_cross_origin_attempt_does_not_consume_preview_or_remove_files(self):
        source = self.finished_file('origin-scope', 'Origin.mp4')
        payload = self.attempt(self.preview())
        for headers in ({'Origin': 'https://attacker.invalid'},
                        {'Sec-Fetch-Site': 'cross-site'}, {'Origin': 'null'}):
            with self.subTest(headers=headers):
                response = self.execute(payload, headers=headers)
                self.assertEqual(response.status_code, 403)
                self.assertTrue(os.path.exists(source))
        self.assertEqual(self.execute(payload).status_code, 200)

    def test_role_revocation_after_child_preparation_prevents_file_removal(self):
        source = self.finished_file('role-scope', 'Role.mp4')
        vdl.db_create_user('bulk-admin', 'bulk-password', 'admin')
        actor = self.authenticated_client('bulk-admin', 'bulk-password')
        payload = self.attempt(self.preview(client=actor))
        revoked = []

        def checkpoint(phase, _operation):
            if phase == 'prepared' and not revoked:
                user = vdl.db_get_user_by_username('bulk-admin')
                vdl.db_update_user(user['id'], role_name='normal')
                revoked.append(True)

        with mock.patch.object(vdl, '_removal_checkpoint', side_effect=checkpoint):
            response = self.execute(payload, client=actor)
        self.assertTrue(revoked)
        self.assertNotEqual(response.status_code, 200, response.json)
        self.assertEqual(Path(source).read_bytes(), b'media')
        self.assertIsNotNone(vdl.db_get_download('role-scope'))
        self.assertNotEqual(actor.get('/api/mutations/' + payload['client_mutation_id']).status_code, 200)

    def test_unknown_scope_and_untrusted_fields_cannot_enter_legacy_clear(self):
        source = self.finished_file('validation-scope', 'Validation.mp4')
        preview = self.preview()
        payload = self.attempt(preview)
        invalid = [dict(payload, scope_id='missing'), dict(payload, expected_revision=0),
                   {'scope_id': preview['scope_id']}, dict(payload, all=True)]
        for value in invalid:
            with self.subTest(payload=value):
                response = self.execute(value)
                self.assertGreaterEqual(response.status_code, 400, response.json)
                self.assertTrue(os.path.exists(source))
                self.assertIsNotNone(vdl.db_get_download('validation-scope'))

    def test_completion_recovery_does_not_expose_file_paths_or_titles(self):
        source = self.finished_file('privacy-scope', 'Secret-title.mp4')
        payload = self.attempt(self.preview())
        response = self.execute(payload)
        self.assertEqual(response.status_code, 200, response.json)
        for result in (response, self.execute(payload),
                       self.client.get('/api/mutations/' + payload['client_mutation_id'])):
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.headers.get('Cache-Control'), 'no-store')
            for value in (source, self.download_dir, 'Secret-title'):
                self.assertNotIn(value, result.get_data(as_text=True))

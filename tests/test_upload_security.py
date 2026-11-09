"""Upload ownership and security through the production request boundaries."""
import os
import secrets
import time
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class UploadSecurityTest(AppCase):
    def setUp(self):
        super().setUp()
        self.owner = vdl.db_create_user('uploader', 'upload-password', 'normal')
        self.other = vdl.db_create_user('observer', 'observer-password', 'normal')
        self.owner_client = self.authenticated_client('uploader', 'upload-password')
        self.other_client = self.authenticated_client('observer', 'observer-password')

    def mutation_id(self):
        return f'{int(time.time() * 1000)}-{secrets.token_hex(16)}'

    def register(self):
        payload = dict(id=secrets.token_hex(16), filename='owned.mp4', filesize=5,
                       client_mutation_id=self.mutation_id())
        response = self.owner_client.post('/api/upload', json=payload)
        self.assertEqual(response.status_code, 202, response.json)
        return payload

    def test_public_library_visibility_does_not_grant_transfer_ownership(self):
        payload = self.register()
        upload_id = payload['id']
        self.assertEqual(vdl.db_get_download(upload_id)['visibility'], 'public')
        with mock.patch.object(vdl, 'inspect_uploaded_video') as inspect:
            denied = self.other_client.put('/api/upload/' + upload_id, data=b'video')
        self.assertEqual(denied.status_code, 404)
        inspect.assert_not_called()
        self.assertEqual(vdl.db_get_download(upload_id)['status'], 'starting')
        self.assertEqual(os.listdir(self.download_dir), [])

    def test_foreign_status_and_receipt_do_not_disclose_public_upload_ownership(self):
        payload = self.register()
        for client in (self.other_client, self.client):
            with self.subTest(actor=client):
                status = client.get('/api/upload/' + payload['id'] + '/status')
                missing = client.get('/api/upload/' + secrets.token_hex(16) + '/status')
                self.assertEqual(status.status_code, 404)
                self.assertEqual(status.json, missing.json)
                receipt = client.get('/api/mutations/' + payload['client_mutation_id'])
                self.assertEqual(receipt.status_code, 404)

    def test_foreign_cancellation_cannot_take_over_registration(self):
        payload = self.register()
        response = self.other_client.post('/api/upload/' + payload['id'] + '/cancel',
                                          json={'client_mutation_id': self.mutation_id()})
        self.assertEqual(response.status_code, 404)
        status = self.owner_client.get('/api/upload/' + payload['id'] + '/status')
        self.assertEqual(status.json['upload']['phase'], 'registered')

    def test_authorized_status_and_receipt_are_not_cacheable_or_filesystem_records(self):
        payload = self.register()
        for response in (
                self.owner_client.get('/api/upload/' + payload['id'] + '/status'),
                self.owner_client.get('/api/mutations/' + payload['client_mutation_id'])):
            self.assertIn(response.status_code, (200, 202))
            self.assertEqual(response.headers.get('Cache-Control'), 'no-store')
            self.assertNotIn(self.download_dir, response.get_data(as_text=True))
            self.assertNotIn('temporary_path', response.json.get('upload', {}))

    def test_all_upload_mutations_retain_origin_and_fetch_metadata_guards(self):
        payload = self.register()
        for headers in ({'Origin': 'https://attacker.invalid'},
                        {'Sec-Fetch-Site': 'cross-site'}, {'Origin': 'null'}):
            with self.subTest(headers=headers):
                new_payload = dict(payload, id=secrets.token_hex(16),
                                   client_mutation_id=self.mutation_id())
                responses = (
                    self.owner_client.post('/api/upload', json=new_payload, headers=headers),
                    self.owner_client.put('/api/upload/' + payload['id'], data=b'video', headers=headers),
                    self.owner_client.post('/api/upload/' + payload['id'] + '/cancel',
                                           json={'client_mutation_id': self.mutation_id()}, headers=headers),
                )
                self.assertEqual([response.status_code for response in responses], [403] * 3)
        self.assertEqual(len(vdl.db_list_downloads()), 1)
        self.assertEqual(os.listdir(self.download_dir), [])

    def test_revoked_session_cannot_check_replay_transfer_or_cancel(self):
        payload = self.register()
        vdl.db_update_user(self.owner['id'], password='replacement-password')
        responses = (
            self.owner_client.get('/api/upload/' + payload['id'] + '/status'),
            self.owner_client.get('/api/mutations/' + payload['client_mutation_id']),
            self.owner_client.post('/api/upload', json=payload),
            self.owner_client.put('/api/upload/' + payload['id'], data=b'video'),
            self.owner_client.post('/api/upload/' + payload['id'] + '/cancel',
                                   json={'client_mutation_id': self.mutation_id()}),
        )
        self.assertEqual([response.status_code for response in responses], [401] * 5)
        self.assertEqual(vdl.db_get_download(payload['id'])['status'], 'starting')

    def test_deleted_owner_does_not_leave_recoverable_receipt_for_other_accounts(self):
        payload = self.register()
        vdl.db_delete_user(self.owner['id'])
        self.assertEqual(self.owner_client.get('/api/upload/' + payload['id'] + '/status').status_code, 401)
        self.assertEqual(self.other_client.get('/api/upload/' + payload['id'] + '/status').status_code, 404)
        self.assertEqual(self.client.get('/api/mutations/' + payload['client_mutation_id']).status_code, 404)

    def test_partial_upload_cannot_be_played_or_removed_while_registered(self):
        payload = self.register()
        upload_id = payload['id']
        self.assertEqual(self.owner_client.get('/api/file/' + upload_id).status_code, 404)
        self.assertEqual(self.owner_client.post('/api/remove/' + upload_id).status_code, 409)
        self.assertIsNotNone(vdl.db_get_download(upload_id))

    def test_account_removal_during_processing_keeps_journal_until_owned_bytes_are_cleaned(self):
        payload = self.register()

        def remove_owner(_path):
            vdl.db_delete_user(self.owner['id'])
            return '720p'

        with mock.patch.object(vdl, 'inspect_uploaded_video', side_effect=remove_owner):
            response = self.owner_client.put('/api/upload/' + payload['id'], data=b'video')
        self.assertNotEqual(response.status_code, 200)
        self.assertNotEqual(vdl.db_get_download(payload['id'])['status'], 'finished')
        self.assertEqual(os.listdir(self.download_dir), [])

    def test_suspension_during_processing_prevents_publication_and_cleans_owned_bytes(self):
        payload = self.register()

        def suspend_owner(_path):
            vdl.db_update_user(self.owner['id'], suspended=True)
            return '720p'

        with mock.patch.object(vdl, 'inspect_uploaded_video', side_effect=suspend_owner):
            response = self.owner_client.put('/api/upload/' + payload['id'], data=b'video')
        self.assertNotEqual(response.status_code, 200)
        self.assertNotEqual(vdl.db_get_download(payload['id'])['status'], 'finished')
        self.assertEqual(os.listdir(self.download_dir), [])

    def test_published_file_remains_playable_and_cannot_be_replaced_by_another_body(self):
        payload = self.register()
        upload_id = payload['id']
        with mock.patch.object(vdl, 'inspect_uploaded_video', return_value='720p'):
            published = self.owner_client.put('/api/upload/' + upload_id, data=b'video')
        self.assertEqual(published.status_code, 200, published.json)
        path = vdl.db_get_download(upload_id)['filename']
        repeated = self.owner_client.put('/api/upload/' + upload_id, data=b'other')
        self.assertEqual(repeated.status_code, 409)
        with open(path, 'rb') as stored:
            self.assertEqual(stored.read(), b'video')
        playback = self.owner_client.get('/api/file/' + upload_id, buffered=True)
        self.assertEqual(playback.status_code, 200)
        self.assertEqual(playback.data, b'video')
        playback.close()

import os
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class VideoVisibilityTest(AppCase):
    def setUp(self):
        super().setUp()
        self.alice = vdl.db_create_user(
            'alice', 'alice-password', 'normal'
        )
        self.bob = vdl.db_create_user('bob', 'bob-password', 'normal')
        self.alice_client = self.authenticated_client(
            'alice', 'alice-password'
        )
        self.bob_client = self.authenticated_client('bob', 'bob-password')

    def owned_row(self, download_id, owner=None):
        owner = owner or self.alice
        vdl.db_insert_download(
            download_id,
            f'https://fixture.invalid/{download_id}',
            owner['id'],
            owner['username'],
        )
        return download_id

    def test_new_downloads_and_uploads_record_the_signed_in_user(self):
        with mock.patch.object(vdl.threading, 'Thread'):
            download = self.alice_client.post(
                '/api/download', json={'url': 'https://fixture.invalid/new'}
            )
        upload = self.alice_client.post('/api/upload', json={
            'filename': 'local.mp4',
            'filesize': 123,
        })

        download_row = vdl.db_get_download(download.get_json()['id'])
        upload_row = vdl.db_get_download(upload.get_json()['id'])
        for row in (download_row, upload_row):
            self.assertEqual(row['owner_user_id'], self.alice['id'])
            self.assertEqual(row['downloaded_by'], 'alice')
            self.assertEqual(row['visibility'], 'public')

    def test_private_rows_are_hidden_from_other_users_and_direct_routes(self):
        public_id = self.owned_row('public01')
        private_id = self.owned_row('private1')
        vdl.db_set_download_visibility(private_id, 'private')
        private_path = os.path.join(self.download_dir, 'private.mp4')
        with open(private_path, 'wb') as output:
            output.write(b'private media')
        vdl.db_update_download(
            private_id,
            status='finished',
            filename=private_path,
            output_dir=self.download_dir,
        )

        alice_rows = {
            row['id']: row
            for row in self.alice_client.get('/api/history').get_json()
        }
        bob_rows = {
            row['id']: row
            for row in self.bob_client.get('/api/history').get_json()
        }
        admin_ids = {
            row['id'] for row in self.client.get('/api/history').get_json()
        }

        self.assertEqual(set(alice_rows), {public_id, private_id})
        self.assertEqual(set(bob_rows), {public_id})
        self.assertEqual(admin_ids, {public_id, private_id})
        self.assertEqual(alice_rows[private_id]['downloaded_by'], 'alice')
        self.assertTrue(alice_rows[private_id]['can_manage_visibility'])
        self.assertFalse(bob_rows[public_id]['can_manage_visibility'])
        private_routes = (
            ('get', f'/api/file/{private_id}', {}),
            ('get', f'/api/thumbnail/{private_id}', {}),
            ('get', f'/api/preview/{private_id}', {}),
            ('put', f'/api/upload/{private_id}', {'data': b'x'}),
            ('post', f'/api/resume/{private_id}', {}),
            ('post', f'/api/stop/{private_id}', {}),
            ('post', f'/api/pause/{private_id}', {}),
            ('post', f'/api/unpause/{private_id}', {}),
            ('post', f'/api/rename/{private_id}', {
                'json': {'filename': 'renamed'}
            }),
            ('post', f'/api/remove/{private_id}', {}),
            ('post', f'/api/favorite/{private_id}', {
                'json': {'favorite': True}
            }),
            ('post', f'/api/tags/{private_id}', {
                'json': {'tag': 'hidden'}
            }),
            ('post', f'/api/visibility/{private_id}', {
                'json': {'visibility': 'public'}
            }),
        )
        for method, path, kwargs in private_routes:
            with self.subTest(path=path):
                response = getattr(self.bob_client, method)(path, **kwargs)
                self.assertEqual(response.status_code, 404)

    def test_only_owner_or_admin_can_change_visibility(self):
        download_id = self.owned_row('sharing1')

        denied = self.bob_client.post(
            f'/api/visibility/{download_id}',
            json={'visibility': 'private'},
        )
        changed = self.alice_client.post(
            f'/api/visibility/{download_id}',
            json={'visibility': 'private'},
        )
        hidden = self.bob_client.post(
            f'/api/visibility/{download_id}',
            json={'visibility': 'public'},
        )
        restored = self.client.post(
            f'/api/visibility/{download_id}',
            json={'visibility': 'public'},
        )
        invalid = self.alice_client.post(
            f'/api/visibility/{download_id}',
            json={'visibility': 'friends'},
        )

        self.assertEqual(denied.status_code, 403)
        self.assertEqual(changed.get_json()['visibility'], 'private')
        self.assertEqual(hidden.status_code, 404)
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(invalid.status_code, 400)

    def test_downloader_name_tracks_renames_and_survives_account_removal(self):
        download_id = self.owned_row('identity1')

        self.client.patch(
            f"/api/users/{self.alice['id']}",
            json={'username': 'renamed-alice'},
        )
        self.assertEqual(
            vdl.db_get_download(download_id)['downloaded_by'],
            'renamed-alice',
        )

        self.client.delete(f"/api/users/{self.alice['id']}")
        row = vdl.db_get_download(download_id)
        self.assertIsNone(row['owner_user_id'])
        self.assertEqual(row['downloaded_by'], 'renamed-alice')

    def test_tag_suggestions_do_not_reveal_private_video_tags(self):
        private_id = self.owned_row('tagsecret')
        public_id = self.owned_row('tagpublic')
        vdl.db_set_download_visibility(private_id, 'private')
        vdl.db_add_download_tag(private_id, 'Secret topic')

        response = self.bob_client.post(
            f'/api/tags/{public_id}', json={'tag': 'Shared topic'}
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['available_tags'], ['Shared topic'])


if __name__ == '__main__':
    unittest.main()

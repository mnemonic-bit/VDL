"""Exercise the shared rotation through authenticated public API boundaries."""

import json
import os
import subprocess
import sys
import unittest
from datetime import datetime
from unittest import mock
from zoneinfo import ZoneInfo

import vdl
from tests.support.app_case import AppCase


class RotationAccessTest(AppCase):
    def setUp(self):
        super().setUp()
        self.alice = vdl.db_create_user('alice', 'alice-password', 'normal')
        self.bob = vdl.db_create_user('bob', 'bob-password', 'normal')
        self.alice_client = self.authenticated_client('alice', 'alice-password')
        self.bob_client = self.authenticated_client('bob', 'bob-password')

    def tearDown(self):
        self.client.post('/api/preferences', json={'library_rotation_enabled': False})
        super().tearDown()

    def video(self, download_id, *, private=False):
        vdl.db_insert_download(
            download_id, f'https://fixture.invalid/{download_id}',
            self.alice['id'], self.alice['username'],
        )
        self.finished_file(download_id, f'{download_id}.mp4')
        if private:
            vdl.db_set_download_visibility(download_id, 'private')

    def enable(self):
        response = self.client.post('/api/preferences', json={
            'library_rotation_enabled': True,
        })
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

    def snapshot(self, client=None):
        response = (client or self.client).get('/api/library?include_order=true')
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()

    def launch(self, client, snapshot, download_id):
        return client.post('/api/playback-sessions', json={
            'mode': 'sequential', 'filter': '', 'ordering': 'newest',
            'page_size': 2, 'page': 0, 'position': 0,
            'generation_id': snapshot['order']['generation_id'],
            'start_download_id': download_id,
        })

    def test_shared_order_filters_private_members_without_navigation_gaps(self):
        for download_id in ('shared-a', 'shared-b', 'shared-c'):
            self.video(download_id)
        self.video('alice-secret', private=True)
        self.enable()
        admin = self.snapshot()
        alice = self.snapshot(self.alice_client)
        bob = self.snapshot(self.bob_client)
        expected = [entry['id'] for entry in admin['items']
                    if entry['id'] != 'alice-secret']
        self.assertEqual(alice['order'], admin['order'])
        self.assertEqual(bob['order'], admin['order'])
        self.assertEqual([entry['id'] for entry in alice['items']],
                         [entry['id'] for entry in admin['items']])
        self.assertEqual([entry['id'] for entry in bob['items']], expected)
        self.assertEqual(set(bob['order']),
                         {'kind', 'generation_id', 'created_at', 'expires_at'})
        self.assertNotIn('alice-secret', json.dumps(bob))
        catalog = self.bob_client.get('/api/library-catalog')
        self.assertEqual(catalog.status_code, 200)
        self.assertEqual({entry['id'] for entry in catalog.get_json()}, set(expected))
        self.assertNotIn('alice-secret', catalog.get_data(as_text=True))

        response = self.launch(self.bob_client, bob, expected[0])
        self.assertEqual(response.status_code, 201)
        state = response.get_json()
        for index in range(1, len(expected) + 1):
            response = self.bob_client.post(
                f"/api/playback-sessions/{state['session_id']}/advance",
                json={'expected_download_id': state['item']['id'],
                      'sequence': state['sequence'] + 1},
            )
            self.assertEqual(response.status_code, 200)
            state = response.get_json()
            self.assertEqual(state['item']['id'], expected[index % len(expected)])
            self.assertNotIn('alice-secret', json.dumps(state))
            self.assertEqual(state['page'] * 2 + state['position'],
                             index % len(expected))
        denied = self.launch(self.bob_client, bob, 'alice-secret')
        self.assertEqual(denied.status_code, 409)

    def test_visibility_changes_expose_existing_positions_without_new_arrivals(self):
        self.video('shared-a')
        self.video('shared-b')
        self.video('alice-secret', private=True)
        self.enable()
        initial = self.snapshot()
        self.video('later-video')
        vdl.db_set_download_visibility('alice-secret', 'public')
        visible = self.snapshot(self.bob_client)
        self.assertEqual(visible['order'], initial['order'])
        self.assertEqual([entry['id'] for entry in visible['items']],
                         [entry['id'] for entry in initial['items']])
        vdl.db_set_download_visibility('shared-a', 'private')
        hidden = self.snapshot(self.bob_client)
        self.assertEqual(hidden['order'], initial['order'])
        self.assertEqual([entry['id'] for entry in hidden['items']],
                         [entry['id'] for entry in initial['items']
                          if entry['id'] != 'shared-a'])

    def test_new_arrivals_keep_direct_and_personal_playlist_access(self):
        self.video('old-video')
        self.enable()
        self.video('later-video')
        current = self.snapshot(self.alice_client)
        self.assertNotIn('later-video', [entry['id'] for entry in current['items']])
        catalog = self.alice_client.get('/api/library-catalog').get_json()
        self.assertEqual({entry['id'] for entry in catalog}, {'old-video', 'later-video'})
        direct = self.alice_client.get('/api/file/later-video')
        self.assertEqual(direct.status_code, 200)
        direct.close()
        created = self.alice_client.post('/api/playlists', json={
            'name': 'New arrivals', 'download_ids': ['later-video', 'old-video'],
        })
        self.assertEqual(created.status_code, 201)
        playlist = created.get_json()
        playback = self.alice_client.post('/api/playback-sessions', json={
            'mode': 'playlist', 'playlist_id': playlist['id'],
        })
        self.assertEqual(playback.status_code, 201)
        self.assertEqual(playback.get_json()['item']['id'], 'later-video')
        denied = self.launch(self.alice_client, current, 'later-video')
        self.assertEqual(denied.status_code, 409)

    def test_fresh_process_retains_order_membership_and_original_deadline(self):
        for download_id in ('first', 'second', 'third'):
            self.video(download_id)
        self.enable()
        original = self.snapshot()
        self.video('after-generation')
        environment = os.environ.copy()
        environment.update({
            'DOWNLOADS_DB': vdl.DB_PATH,
            'DOWNLOADS_DIR': self.download_dir,
            'FLASK_DEBUG': '0',
        })
        result = subprocess.run(
            [sys.executable, '-c',
             'import json, vdl; '
             'items, order, _ = vdl.resolve_library_snapshot(None, True, "", "newest"); '
             'print(json.dumps({"ids": [item["id"] for item in items], "order": order}))'],
            cwd=os.path.dirname(vdl.__file__), env=environment,
            capture_output=True, text=True, timeout=20, check=True,
        )
        restored = json.loads(result.stdout)
        self.assertEqual(restored['order'], original['order'])
        self.assertEqual(restored['ids'], [entry['id'] for entry in original['items']])

    def test_elapsed_hours_cross_both_daylight_saving_transitions(self):
        berlin = ZoneInfo('Europe/Berlin')
        for month, day, expiry_hour in ((3, 29, 4), (10, 25, 2)):
            with self.subTest(month=month):
                self.client.post('/api/preferences', json={'library_rotation_enabled': False})
                started = datetime(2026, month, day, 1, 30, tzinfo=berlin).timestamp()
                with mock.patch.object(vdl, '_rotation_now', return_value=started) as clock, \
                        mock.patch.object(vdl, '_schedule_rotation_timer'):
                    self.client.post('/api/preferences', json={
                        'library_rotation_enabled': True, 'library_rotation_hours': 2,
                    })
                    order = self.snapshot()['order']
                    self.assertEqual(order['expires_at'], started + 7200)
                    local_expiry = datetime.fromtimestamp(order['expires_at'], berlin)
                    self.assertEqual((local_expiry.hour, local_expiry.minute), (expiry_hour, 30))
                    clock.return_value = started + 7199
                    self.assertEqual(self.snapshot()['order'], order)
                    clock.return_value = started + 7200
                    self.assertNotEqual(self.snapshot()['order']['generation_id'],
                                        order['generation_id'])


if __name__ == '__main__':
    unittest.main()

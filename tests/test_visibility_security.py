"""Verify visibility acknowledgements preserve access across related services."""
import json
import os
import secrets
import time
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class VisibilitySecurityTest(AppCase):
    def setUp(self):
        super().setUp()
        self.owner = vdl.db_create_user('visibility-owner', 'owner-password', 'normal')
        vdl.db_create_user('visibility-viewer', 'viewer-password', 'normal')
        self.owner_client = self.authenticated_client('visibility-owner', 'owner-password')
        self.viewer_client = self.authenticated_client('visibility-viewer', 'viewer-password')
        self.video('visibility-secret', b'confidential media')

    def video(self, target, data=b'shared media'):
        vdl.db_insert_download(target, 'https://fixture.invalid/' + target,
                               self.owner['id'], self.owner['username'])
        return self.finished_file(target, target + '.mp4', data)

    def change(self, target='visibility-secret', value='private', revision='0'):
        payload = {'visibility': value, 'expected_revision': revision,
                   'client_mutation_id': f'{int(time.time() * 1000)}-{secrets.token_hex(16)}'}
        response = self.owner_client.post('/api/visibility/' + target, json=payload)
        self.assertEqual(response.status_code, 200, response.json)
        return response

    def test_cached_storage_reauthorizes_after_protocol_change_without_rescan(self):
        self.assertTrue(vdl.refresh_library_storage())
        original = self.viewer_client.get('/api/library-storage').json
        self.assertEqual(original['total_bytes'], len(b'confidential media'))
        with mock.patch.object(vdl, '_measure_library_storage', side_effect=AssertionError('unexpected scan')):
            self.change()
            hidden = self.viewer_client.get('/api/library-storage').json
            self.assertEqual(hidden['total_bytes'], 0)
            self.assertEqual(hidden['measured_at'], original['measured_at'])
            self.assertEqual(hidden['next_refresh_at'], original['next_refresh_at'])
            self.assertEqual(self.owner_client.get('/api/library-storage').json['total_bytes'], original['total_bytes'])
            self.change(value='public', revision='1')
            self.assertEqual(self.viewer_client.get('/api/library-storage').json, original)

    def test_private_alias_does_not_hide_shared_file_or_double_storage(self):
        alias_path = self.video('visibility-alias')
        os.unlink(alias_path)
        os.link(vdl.db_get_download('visibility-secret')['filename'], alias_path)
        self.assertTrue(vdl.refresh_library_storage())
        self.change()
        self.assertEqual(self.viewer_client.get('/api/library-storage').json['total_bytes'], len(b'confidential media'))
        self.change(target='visibility-alias')
        self.assertEqual(self.viewer_client.get('/api/library-storage').json['total_bytes'], 0)
        self.assertEqual(self.owner_client.get('/api/library-storage').json['total_bytes'], len(b'confidential media'))

    def test_prepared_playback_rechecks_protocol_visibility_before_advance(self):
        self.video('visibility-shared')
        created = self.viewer_client.post('/api/playback-sessions', json={
            'mode': 'sequential', 'filter': '', 'ordering': 'newest',
            'page_size': 20, 'page': 0, 'position': 0,
            'start_download_id': 'visibility-shared',
        })
        self.assertEqual(created.status_code, 201, created.json)
        state = created.json
        step = {'expected_download_id': state['item']['id'], 'sequence': state['sequence'] + 1}
        prepared = self.viewer_client.post('/api/playback-sessions/' + state['session_id'] + '/prepare', json=step)
        self.assertEqual(prepared.status_code, 200, prepared.json)
        self.assertEqual(prepared.json['item']['id'], 'visibility-secret')
        self.change()
        self.assertEqual(self.viewer_client.get('/api/file/visibility-secret').status_code, 404)
        advanced = self.viewer_client.post('/api/playback-sessions/' + state['session_id'] + '/advance', json=step)
        self.assertEqual(advanced.status_code, 200, advanced.json)
        self.assertEqual(advanced.json['item']['id'], 'visibility-shared')
        self.assertNotIn('visibility-secret', json.dumps(advanced.json))

    def test_playlist_reads_redact_newly_private_member_without_changing_membership_revision(self):
        created = self.viewer_client.post('/api/playlists', json={
            'name': 'Viewer playlist', 'download_ids': ['visibility-secret'],
        })
        self.assertEqual(created.status_code, 201, created.json)
        playlist = created.json
        self.change()
        current = self.viewer_client.get('/api/playlists/' + playlist['id'])
        self.assertEqual(current.status_code, 200)
        self.assertEqual(current.json['revision'], playlist['revision'])
        self.assertEqual(current.json['member_ids'], [None])
        self.assertEqual(current.json['items'][0]['title'], 'Unavailable video')
        self.assertNotIn('visibility-secret', json.dumps(current.json))

    def test_rotation_keeps_generation_while_filtering_confirmed_visibility(self):
        self.video('visibility-shared')
        vdl.db_set_preferences({'library_rotation_enabled': 'true'})
        before = self.viewer_client.get('/api/library?include_order=true').json
        self.assertEqual({entry['id'] for entry in before['items']}, {'visibility-secret', 'visibility-shared'})
        self.change()
        after = self.viewer_client.get('/api/library?include_order=true').json
        self.assertEqual(after['order'], before['order'])
        self.assertEqual([entry['id'] for entry in after['items']], ['visibility-shared'])
        self.assertEqual(self.viewer_client.get('/api/downloads/visibility-secret/editable-state').status_code, 404)

    def test_helper_and_protocol_hints_never_publish_private_identity(self):
        subscriber = vdl.event_bus.subscribe()
        vdl.db_set_download_visibility('visibility-secret', 'private')
        self.assertEqual(subscriber.get_nowait(), ('change', {'reason': 'visibility'}))
        self.assertTrue(subscriber.empty())
        self.change(value='public', revision='1')
        self.assertEqual(subscriber.get_nowait(), ('change', {'reason': 'visibility'}))
        self.assertTrue(subscriber.empty())

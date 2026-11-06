import os
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class RotationPlaybackTest(AppCase):
    def setUp(self):
        super().setUp()
        self.clock = mock.patch.object(vdl, '_rotation_now', return_value=1000)
        self.now = self.clock.start()
        self.addCleanup(self.clock.stop)
        self.timer = mock.patch.object(vdl, '_schedule_rotation_timer')
        self.timer.start()
        self.addCleanup(self.timer.stop)
        self.shuffle = mock.patch.object(
            vdl, '_rotation_shuffle', side_effect=lambda ids: ids.sort()
        )
        self.shuffle.start()
        self.addCleanup(self.shuffle.stop)

    def videos(self, *ids):
        for index, download_id in enumerate(ids):
            self.finished_file(download_id, f'{download_id}.mp4')
            vdl.db_update_download(download_id, title=f'Match {download_id}',
                                   duration_seconds=120, resolution='720p', media_metadata_probed=True)
            with vdl._db_lock, vdl.db() as conn:
                conn.execute('UPDATE downloads SET created_at = ? WHERE id = ?',
                             (index, download_id))

    def settings(self, **values):
        response = self.client.post('/api/preferences', json=values)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()

    def enable(self):
        self.settings(library_rotation_enabled=True, library_rotation_hours=1)
        return self.client.get('/api/library?include_order=true').get_json()['order']

    def launch(self, order=None, start='a', **values):
        payload = dict(mode='sequential', page_size=2, page=0, position=0,
                       filter='', ordering='newest', start_download_id=start)
        if order is not None:
            payload['generation_id'] = order['generation_id']
        payload.update(values)
        return self.client.post('/api/playback-sessions', json=payload)

    def step(self, state, action='advance', **values):
        payload = dict(expected_download_id=state['item']['id'],
                       sequence=state['sequence'] + 1)
        payload.update(values)
        return self.client.post(
            f"/api/playback-sessions/{state['session_id']}/{action}", json=payload
        )

    def test_launch_requires_displayed_generation_and_starting_member(self):
        self.videos('a', 'b', 'c')
        order = self.enable()
        for token in (None, 'foreign', True, ''):
            response = self.launch(order, generation_id=token)
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.get_json()['code'], 'rotation_generation_changed')
        self.assertEqual(self.launch().status_code, 409)
        self.assertEqual(self.launch(order, start=None).status_code, 400)
        self.assertEqual(self.launch(order, start='missing').status_code, 409)
        self.assertFalse(vdl._playback_sessions)
        self.assertTrue(all(row['view_count'] == 0 for row in vdl.db_list_downloads()))
        accepted = self.launch(order, start='b', ordering='favorites_first')
        self.assertEqual(accepted.status_code, 201)
        self.assertEqual(accepted.get_json()['item']['id'], 'b')
        self.assertEqual(accepted.get_json()['order'], order)

    def test_rotation_traverses_full_filtered_subsequence_and_wraps(self):
        self.videos('a', 'b', 'c', 'd', 'e')
        vdl.db_update_download('b', duration_seconds=5)
        order = self.enable()
        state = self.launch(order, start='c', filter='duration:>1m', page_size=1).get_json()
        observed = [state['item']['id']]
        for _ in range(4):
            state = self.step(state).get_json()
            observed.append(state['item']['id'])
            self.assertEqual(state['order'], order)
        self.assertEqual(observed, ['c', 'd', 'e', 'a', 'c'])
        stored = vdl._playback_sessions[state['session_id']]
        self.assertNotIn('rotation_members', stored)
        self.assertNotIn('positions', stored)

    def test_removed_current_and_next_members_keep_surviving_successor(self):
        self.videos('a', 'b', 'c', 'd')
        order = self.enable()
        state = self.launch(order, start='b').get_json()
        os.remove(vdl.db_get_download('b')['filename'])
        state = self.step(state).get_json()
        self.assertEqual(state['item']['id'], 'c')
        os.remove(vdl.db_get_download('d')['filename'])
        state = self.step(state).get_json()
        self.assertEqual(state['item']['id'], 'a')
        state = self.step(state).get_json()
        self.assertEqual(state['item']['id'], 'c')

    def test_prepare_rechecks_generation_and_committed_retry_remains_idempotent(self):
        self.videos('a', 'b', 'c')
        order = self.enable()
        state = self.launch(order).get_json()
        prepared = self.step(state, 'prepare').get_json()
        self.assertEqual(prepared['item']['id'], 'b')
        self.assertEqual(prepared['order'], order)
        self.now.return_value = order['expires_at']
        with mock.patch.object(vdl, '_rotation_shuffle', side_effect=lambda ids: ids.sort(reverse=True)):
            refreshed = self.step(state, 'prepare').get_json()
        self.assertNotEqual(refreshed['order']['generation_id'], order['generation_id'])
        self.assertEqual(refreshed['item']['id'], 'c')
        committed = self.step(state).get_json()
        self.assertEqual(committed['item'], refreshed['item'])
        self.now.return_value = committed['order']['expires_at']
        # A committed request replays its response before attempting renewal.
        self.assertEqual(self.step(state).get_json(), committed)
        self.assertEqual(vdl._playback_sessions[state['session_id']]['sequence'], 1)

    def test_renewed_rotation_uses_current_successor_or_first_if_absent(self):
        self.videos('a', 'b', 'c', 'd')
        order = self.enable()
        state = self.launch(order, start='b').get_json()
        self.now.return_value = order['expires_at']
        with mock.patch.object(vdl, '_rotation_shuffle', side_effect=lambda ids: ids.sort(reverse=True)):
            state = self.step(state).get_json()
        self.assertEqual(state['item']['id'], 'a')
        self.assertNotEqual(state['order']['generation_id'], order['generation_id'])
        os.remove(vdl.db_get_download('a')['filename'])
        self.now.return_value = state['order']['expires_at']
        state = self.step(state).get_json()
        self.assertEqual(state['item']['id'], 'b')

    def test_enable_hours_change_and_disable_take_effect_only_at_handoff(self):
        self.videos('a', 'b', 'c')
        state = self.launch(start='b', filter='Match').get_json()
        self.assertEqual(state['order']['kind'], 'library')
        self.enable()
        state = self.step(state).get_json()
        self.assertEqual(state['item']['id'], 'c')
        self.assertEqual(state['order']['kind'], 'rotation')
        old_generation = state['order']['generation_id']
        self.settings(library_rotation_hours=2)
        self.assertEqual(vdl._playback_sessions[state['session_id']]['current_download_id'], 'c')
        state = self.step(state).get_json()
        self.assertEqual(state['item']['id'], 'a')
        self.assertNotEqual(state['order']['generation_id'], old_generation)
        self.settings(library_rotation_enabled=False)
        state = self.step(state).get_json()
        self.assertEqual(state['item']['id'], 'c')
        self.assertEqual(state['order']['kind'], 'library')
        self.assertEqual(vdl._playback_sessions[state['session_id']]['filter'], 'Match')
        self.assertEqual(self.launch({'generation_id': old_generation}).status_code, 409)

    def test_authorization_and_empty_selection_apply_on_every_handoff(self):
        self.videos('a', 'b', 'c')
        for download_id in ('a', 'b', 'c'):
            vdl.db_set_download_visibility(download_id, 'public')
        vdl.db_create_user('bob', 'password-2', 'normal')
        order = self.enable()
        self.client = self.authenticated_client('bob', 'password-2')
        state = self.launch(order).get_json()
        self.assertEqual(self.step(state, 'prepare').get_json()['item']['id'], 'b')
        vdl.db_set_download_visibility('b', 'private')
        state = self.step(state).get_json()
        self.assertEqual(state['item']['id'], 'c')
        for download_id in ('a', 'c'):
            vdl.db_set_download_visibility(download_id, 'private')
        self.assertEqual(self.step(state).status_code, 204)
        self.assertNotIn(state['session_id'], vdl._playback_sessions)

    def test_rotation_does_not_change_shuffle_or_one_member_repeat(self):
        self.videos('a')
        order = self.enable()
        state = self.launch(order).get_json()
        self.assertEqual(self.step(state).get_json()['item']['id'], 'a')
        self.videos('new')
        shuffled = self.launch(mode='shuffle').get_json()
        self.assertEqual(shuffled['mode'], 'shuffle')
        self.assertNotIn('order', shuffled)
        self.assertEqual({row['id'] for row in vdl.resolve_shuffle_pool(
            vdl.db_get_user_by_username('admin')['id'], True, 0, 0
        )[0]}, {'a', 'new'})

    def test_deadline_crossed_after_resolution_is_rechecked_at_commit(self):
        self.videos('a', 'b', 'c')
        order = self.enable()
        original = vdl.resolve_library_snapshot
        calls = []

        def cross_deadline(*args):
            result = original(*args)
            calls.append(result[1]['generation_id'])
            if len(calls) == 1:
                self.now.return_value = result[1]['expires_at']
            return result

        with mock.patch.object(vdl, 'resolve_library_snapshot', side_effect=cross_deadline):
            rejected = self.launch(order)
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.get_json()['code'], 'rotation_generation_changed')
        self.assertFalse(vdl._playback_sessions)
        fresh = self.client.get('/api/library?include_order=true').get_json()['order']
        state = self.launch(fresh).get_json()
        calls.clear()
        with mock.patch.object(vdl, 'resolve_library_snapshot', side_effect=cross_deadline):
            advanced = self.step(state).get_json()
        self.assertEqual(advanced['sequence'], 1)
        self.assertNotEqual(advanced['order']['generation_id'], fresh['generation_id'])
        self.assertEqual(advanced['item']['id'], 'b')
        self.assertGreaterEqual(len(calls), 2)

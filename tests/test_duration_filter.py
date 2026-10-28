import json
from pathlib import Path
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class DurationFilterCasesTest(unittest.TestCase):
    def test_shared_browser_and_server_matching_cases(self):
        cases = json.loads((Path(__file__).parent / 'fixtures'
                            / 'duration-filter-cases.json').read_text())
        for case in cases['cases']:
            with self.subTest(query=case['query']):
                matched = [entry['id'] for entry in cases['entries']
                           if vdl._matches_history_filter(entry, case['query'])]
                self.assertCountEqual(matched, case['expected_ids'])
                if case['valid']:
                    vdl._parse_duration_filter(vdl._parse_history_filter(case['query']))
                else:
                    with self.assertRaises(ValueError):
                        vdl._parse_duration_filter(vdl._parse_history_filter(case['query']))

    def test_invalid_stored_durations_do_not_satisfy_any_comparison(self):
        for value in (None, 0, -1, float('nan'), float('inf'),
                      float('-inf'), True, False, '303'):
            for query in ('duration:>0', 'duration:<10m', 'duration:<=0'):
                with self.subTest(duration=value, query=query):
                    self.assertFalse(vdl._matches_history_filter(
                        {'duration_seconds': value}, query,
                    ))
            self.assertTrue(vdl._matches_history_filter(
                {'duration_seconds': value}, '',
            ))

    def test_infinite_threshold_conversions_and_sums_are_invalid(self):
        for value in ('9' * 400, '9' * 400 + 'h',
                      '9' * 400 + ':00', '9' * 305 + 'h59m59s'):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    vdl._parse_duration_filter(['duration:>' + value])


class DurationPlaybackTest(AppCase):
    def video(self, download_id, duration=None, **updates):
        self.finished_file(download_id, f'{download_id}.mp4')
        vdl.db_update_download(download_id, duration_seconds=duration,
                               resolution='720p', media_metadata_probed=True,
                               **updates)

    def create_session(self, query='', **overrides):
        payload = {'filter': query, 'ordering': 'newest', 'page_size': 2,
                   'page': 0, 'position': 0}
        payload.update(overrides)
        return self.client.post('/api/playback-sessions', json=payload)

    def step(self, state, action='advance'):
        return self.client.post(
            f"/api/playback-sessions/{state['session_id']}/{action}",
            json={'expected_download_id': state['item']['id'],
                  'sequence': state['sequence'] + 1},
        )

    def test_range_selection_precedes_pagination_and_remains_on_handoffs(self):
        for download_id, duration in (
                ('below', 303), ('middle', 450), ('upper', 599.9),
                ('endpoint', 600), ('unknown', None)):
            self.video(download_id, duration)
        # Many newer nonmatches must not displace the matching first page.
        for index in range(5):
            self.video(f'newer-{index}', 60)
        with mock.patch.object(vdl, 'ffprobe_resolution',
                               side_effect=AssertionError('Search must not probe media')):
            response = self.create_session('duration:>5m3s duration:<10m',
                                           start_download_id='middle')
            self.assertEqual(response.status_code, 201)
            state = response.get_json()
            self.assertEqual(state['item']['id'], 'middle')
            prepared = self.step(state, 'prepare')
            self.assertEqual(prepared.status_code, 200)
            self.assertEqual(prepared.get_json()['item']['id'], 'upper')
            advanced = self.step(state)
            self.assertEqual(advanced.status_code, 200)
            state = advanced.get_json()
            self.assertEqual(state['item']['id'], 'upper')
            # Metadata updates are re-evaluated during live selection.
            vdl.db_update_download('middle', duration_seconds=300)
            repeated = self.step(state)
            self.assertEqual(repeated.status_code, 200)
            self.assertEqual(repeated.get_json()['item']['id'], 'upper')

    def test_comparison_boundaries_and_equivalent_formats_at_the_api(self):
        self.video('lower', 303)
        self.video('fraction', 303.1)
        self.video('upper', 600)
        for query in ('duration:>5m3s duration:<10m',
                      'duration:<600 duration:>303s',
                      'duration:>5:03 duration:<0:10:00'):
            with self.subTest(query=query):
                response = self.create_session(query)
                self.assertEqual(response.status_code, 201)
                self.assertEqual(response.get_json()['item']['id'], 'fraction')
        for download_id in ('lower', 'fraction', 'upper'):
            response = self.create_session(
                'duration:>=5m3s duration:<=10m0s',
                start_download_id=download_id,
            )
            self.assertEqual(response.status_code, 201)
            self.assertEqual(response.get_json()['item']['id'], download_id)
        self.assertEqual(self.create_session(
            'duration:>10m duration:<5m3s',
        ).status_code, 204)

    def test_malformed_duration_filters_return_400_before_creating_sessions(self):
        self.video('video', 500)
        for query in ('duration:', 'duration:>', 'duration:10m',
                      'duration:>-1m', 'duration:>1:60', 'duration:>NaN',
                      'duration:>5m3m', 'duration:>3s5m',
                      'duration:>1.5h30m', 'duration:>5:03s',
                      '"duration:>5m 3s"'):
            with self.subTest(query=query):
                response = self.create_session(query)
                self.assertEqual(response.status_code, 400)
                self.assertIn('Use duration:', response.get_json()['error'])
        self.assertEqual(vdl._playback_sessions, {})

    def test_duration_intersects_other_filter_groups(self):
        self.video('target', 500, title='Mountain tutorial')
        self.video('short', 30, title='Mountain tutorial')
        self.video('different', 500, title='River walk')
        query = 'tutorial mountain quality:720 duration:>5m3s duration:<10m'
        response = self.create_session(query)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()['item']['id'], 'target')
        state = response.get_json()
        self.assertEqual(self.step(state).get_json()['item']['id'], 'target')

    def test_duration_selection_does_not_expose_private_videos(self):
        self.video('private', 500)
        self.video('public', 500)
        vdl.db_set_download_visibility('private', 'private')
        vdl.db_create_user('bob', 'password-2', 'normal')
        self.client = self.authenticated_client('bob', 'password-2')
        self.assertEqual(self.create_session(
            'duration:>5m3s', start_download_id='private',
        ).status_code, 409)
        response = self.create_session('duration:>5m3s')
        self.assertEqual(response.status_code, 201)
        state = response.get_json()
        self.assertEqual(state['item']['id'], 'public')
        vdl.db_set_download_visibility('public', 'private')
        self.assertEqual(self.step(state).status_code, 204)

    def test_shuffle_modes_ignore_even_invalid_duration_search(self):
        self.video('short', 60)
        for mode in ('shuffle', 'shuffle_clips'):
            with self.subTest(mode=mode):
                response = self.create_session('duration:>', mode=mode)
                self.assertEqual(response.status_code, 201)
                self.assertEqual(response.get_json()['item']['id'], 'short')

    def test_attempt_history_keeps_literal_duration_search_behavior(self):
        self.insert('literal')
        vdl.db_update_download('literal', title='duration:>')
        self.video('literal', 60)
        response = self.client.get('/api/history', query_string={'filter': 'duration:>'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual([entry['download_id'] for entry in response.get_json()['items']],
                         ['literal'])


if __name__ == '__main__':
    unittest.main()

import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class LibraryRotationTest(AppCase):
    def setUp(self):
        self.timer_patch = mock.patch.object(vdl, '_schedule_rotation_timer')
        self.timer_patch.start()
        self.addCleanup(self.timer_patch.stop)
        super().setUp()
        self.now = 1_800_000_000.0
        self.clock_patch = mock.patch.object(vdl, '_rotation_now', side_effect=lambda: self.now)
        self.clock_patch.start()
        self.addCleanup(self.clock_patch.stop)
        self.shuffle_patch = mock.patch.object(vdl, '_rotation_shuffle', side_effect=lambda ids: ids.reverse())
        self.shuffle = self.shuffle_patch.start()
        self.addCleanup(self.shuffle_patch.stop)
        self.addCleanup(vdl._cancel_rotation_timer)

    def library(self):
        response = self.client.get('/api/library?include_order=true')
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()

    def enable(self, hours=24):
        response = self.client.post('/api/preferences', json={
            'library_rotation_enabled': True, 'library_rotation_hours': hours,
        })
        self.assertEqual(response.status_code, 200, response.get_json())
        return self.library()

    def fixture(self):
        for index in range(3):
            self.finished_file(str(index), f'{index}.mp4')

    def ids(self, snapshot):
        return [item['id'] for item in snapshot['items']]

    def test_defaults_disabled_array_compatibility_and_canonical_validation(self):
        preferences = self.client.get('/api/preferences').get_json()
        self.assertEqual(preferences['library_rotation_enabled'], 'false')
        self.assertEqual(preferences['library_rotation_hours'], '24')
        self.fixture()
        self.assertIsInstance(self.client.get('/api/library').get_json(), list)
        self.assertEqual(self.library()['order'], {
            'kind': 'library', 'generation_id': None, 'created_at': None, 'expires_at': None,
        })
        saved = self.client.post('/api/preferences', json={
            'library_rotation_enabled': 'false', 'library_rotation_hours': '0007',
        }).get_json()
        self.assertEqual(saved['library_rotation_hours'], '7')
        response = self.client.post('/api/preferences', json={
            'library_rotation_hours': '0' * 5000 + '8760',
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['library_rotation_hours'], '8760')
        self.assertEqual(self.shuffle.call_count, 0)

    def test_invalid_updates_leave_all_preferences_and_deck_unchanged(self):
        before = self.enable()
        for value in (0, 8761, 1.5, None, True, False, '+2', '-1', '2.0', ' 2', '', '２', '9' * 5000, float('inf'), float('nan')):
            with self.subTest(value=value):
                response = self.client.post('/api/preferences', json={
                    'library_rotation_hours': value, 'theme': 'dark',
                    'library_rotation_enabled': False,
                })
                self.assertEqual(response.status_code, 400)
                self.assertEqual(self.library(), before)
                self.assertEqual(vdl.db_get_preferences()['theme'], 'system')
        for value in (None, 0, 1, 'True', 'TRUE', [], {}):
            with self.subTest(enabled=value):
                self.assertEqual(self.client.post('/api/preferences', json={
                    'library_rotation_enabled': value,
                }).status_code, 400)
        self.assertEqual(self.shuffle.call_count, 1)

    def test_stable_permutation_and_no_same_value_reset(self):
        self.fixture()
        ordinary = self.ids(self.library())
        first = self.enable(7)
        self.assertEqual(self.ids(first), ordinary[::-1])
        self.assertEqual(set(self.ids(first)), {'0', '1', '2'})
        self.assertEqual(first['order']['expires_at'] - first['order']['created_at'], 7 * 3600)
        self.now += 300
        repeated = self.client.post('/api/preferences', json={
            'library_rotation_enabled': 'true', 'library_rotation_hours': '007',
        })
        self.assertEqual(repeated.status_code, 200)
        vdl.init_db()
        self.assertEqual(self.library(), first)
        self.assertEqual(self.shuffle.call_count, 1)

    def test_exact_expiry_and_long_downtime_generate_once(self):
        self.fixture()
        first = self.enable(2)
        self.now = first['order']['expires_at'] - .001
        self.assertEqual(self.library()['order'], first['order'])
        self.now += .001
        second = self.library()
        self.assertNotEqual(second['order']['generation_id'], first['order']['generation_id'])
        self.assertEqual(second['order']['created_at'], self.now)
        self.now += 10 * 86400
        third = self.library()
        self.assertEqual(third['order']['created_at'], self.now)
        self.assertEqual(self.library()['order'], third['order'])
        self.assertEqual(self.shuffle.call_count, 3)
        with vdl.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM library_rotation').fetchone()[0], 1)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM library_rotation_members').fetchone()[0], 3)

    def test_duration_change_disable_and_reenable(self):
        self.fixture()
        first = self.enable()
        self.now += 10
        second = self.enable(1)
        self.assertNotEqual(first['order']['generation_id'], second['order']['generation_id'])
        self.assertEqual(second['order']['expires_at'], self.now + 3600)
        response = self.client.post('/api/preferences', json={'library_rotation_enabled': False})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.library()['order']['kind'], 'library')
        self.assertEqual(vdl.db_get_preferences()['library_rotation_hours'], '1')
        self.client.post('/api/preferences', json={'library_rotation_hours': 8760})
        self.assertEqual(self.shuffle.call_count, 2)
        third = self.enable(8760)
        self.assertNotEqual(third['order']['generation_id'], second['order']['generation_id'])
        self.assertEqual(third['order']['expires_at'] - self.now, 8760 * 3600)

    def test_new_arrivals_wait_empty_deck_keeps_deadline(self):
        first = self.enable()
        self.assertEqual(first['items'], [])
        self.fixture()
        self.assertEqual(self.library(), first)
        self.assertEqual(self.shuffle.call_count, 1)
        self.assertEqual(len(self.client.get('/api/library-catalog').get_json()), 3)
        self.assertEqual(self.client.get('/api/library?scope=all').get_json(), [])
        self.now = first['order']['expires_at']
        self.assertEqual(len(self.library()['items']), 3)

    def test_live_eligibility_deletion_and_rename_preserve_positions(self):
        self.fixture()
        first = self.enable()
        ids = self.ids(first)
        row = vdl.db_get_download(ids[1])
        renamed = os.path.join(self.download_dir, 'renamed.mp4')
        os.rename(row['filename'], renamed)
        vdl.db_update_download(ids[1], filename=renamed, title='Renamed')
        self.assertEqual(self.ids(self.library()), ids)
        os.unlink(renamed)
        self.assertEqual(self.ids(self.library()), [ids[0], ids[2]])
        vdl.db_update_download(ids[0], filename='/etc/passwd')
        self.assertEqual(self.ids(self.library()), [ids[2]])
        self.assertEqual(self.shuffle.call_count, 1)

    def test_filter_selects_saved_subsequence(self):
        self.fixture()
        self.enable()
        vdl.db_update_download('1', title='match', duration_seconds=60)
        vdl.db_update_download('2', title='match', duration_seconds=180)
        admin = vdl.db_get_user_by_username('admin')
        entries, order, positions = vdl.resolve_library_snapshot(admin['id'], True, 'match duration:>2m', 'favorites_first')
        self.assertEqual([entry['id'] for entry in entries], ['2'])
        self.assertEqual(order['kind'], 'rotation')
        self.assertEqual(set(positions), {'0', '1', '2'})

    def test_expiry_concurrency_publishes_one_generation(self):
        self.fixture()
        first = self.enable()
        self.now = first['order']['expires_at']
        admin = vdl.db_get_user_by_username('admin')
        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(lambda _: vdl.resolve_library_snapshot(admin['id'], True, '', 'newest')[1], range(16)))
        self.assertEqual(len({order['generation_id'] for order in results}), 1)
        self.assertEqual(self.shuffle.call_count, 2)

    def test_preference_transaction_failure_keeps_previous_state(self):
        self.fixture()
        before = self.enable()
        preferences = vdl.db_get_preferences()
        original = vdl._write_library_rotation

        def fail_after_write(conn, ids, hours):
            original(conn, ids, hours)
            raise sqlite3.OperationalError('injected failure')

        with mock.patch.object(vdl, '_write_library_rotation', side_effect=fail_after_write):
            with self.assertRaises(sqlite3.OperationalError):
                vdl.db_set_preferences({'library_rotation_hours': '2', 'theme': 'dark'})
        self.assertEqual(vdl.db_get_preferences(), preferences)
        self.assertEqual(self.library(), before)

    def test_failed_renewal_is_actionable_and_retry_preserves_deadline(self):
        self.fixture()
        first = self.enable()
        self.now = first['order']['expires_at']
        with mock.patch.object(vdl, '_write_library_rotation', side_effect=sqlite3.OperationalError('injected failure')):
            failed = self.client.get('/api/library?include_order=true')
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.get_json()['code'], 'rotation_refresh_failed')
        with vdl.db() as conn:
            saved = dict(conn.execute('SELECT * FROM library_rotation').fetchone())
        self.assertEqual(saved['expires_at'], first['order']['expires_at'])
        self.assertEqual(saved['generation_id'], first['order']['generation_id'])
        recovered = self.library()
        self.assertNotEqual(recovered['order']['generation_id'], saved['generation_id'])
        self.assertEqual(recovered['order']['created_at'], self.now)

    def test_rotation_events_coalesce_without_membership_details(self):
        subscriber = vdl.event_bus.subscribe()
        self.enable()
        self.enable(3)
        self.client.post('/api/preferences', json={'library_rotation_enabled': False})
        self.assertEqual(subscriber.qsize(), 1)
        self.assertEqual(subscriber.get_nowait(), ('change', {'reason': 'library_rotation'}))

    def test_fisher_yates_uses_unbiased_bounded_choices(self):
        self.shuffle_patch.stop()
        ids = ['a', 'b', 'c', 'd']
        with mock.patch.object(vdl.secrets, 'randbelow', return_value=0) as random_choice:
            vdl._rotation_shuffle(ids)
        self.assertEqual(ids, ['b', 'c', 'd', 'a'])
        self.assertEqual(random_choice.call_args_list, [mock.call(4), mock.call(3), mock.call(2)])

    def fake_timers(self):
        timers = []

        class Timer:
            def __init__(self, interval, callback):
                self.interval = interval
                self.callback = callback
                self.cancelled = False
                timers.append(self)

            def start(self):
                pass

            def cancel(self):
                self.cancelled = True

        self.timer_patch.stop()
        timer_patch = mock.patch.object(vdl.threading, 'Timer', Timer)
        timer_patch.start()
        self.addCleanup(timer_patch.stop)
        return timers

    def test_deadline_timer_wakes_once_restores_and_rejects_stale_callbacks(self):
        timers = self.fake_timers()
        self.fixture()
        first = self.enable(2)
        self.assertEqual(len(timers), 1)
        self.assertEqual(timers[0].interval, 7200)
        self.library()
        self.assertEqual(len(timers), 1)
        self.now = first['order']['expires_at']
        timers[0].callback()
        second = self.library()
        self.assertNotEqual(first['order']['generation_id'], second['order']['generation_id'])
        self.assertEqual(len(timers), 2)
        vdl.init_db()
        self.assertTrue(timers[1].cancelled)
        self.assertEqual(timers[2].interval, 7200)
        self.enable(3)
        saved = self.library()
        timers[2].callback()
        self.assertEqual(self.library(), saved)
        current = timers[-1]
        self.client.post('/api/preferences', json={'library_rotation_enabled': False})
        self.assertTrue(current.cancelled)
        current.callback()
        self.assertEqual(self.library()['order']['kind'], 'library')
        self.assertIsNone(vdl._rotation_timer)

    def test_timer_failure_retries_without_resetting_durable_deadline(self):
        timers = self.fake_timers()
        self.fixture()
        first = self.enable(1)
        self.now = first['order']['expires_at']
        subscriber = vdl.event_bus.subscribe()
        with mock.patch.object(vdl, '_write_library_rotation', side_effect=sqlite3.OperationalError('injected failure')):
            timers[0].callback()
        self.assertEqual(timers[-1].interval, 30)
        self.assertEqual(subscriber.get_nowait(), ('change', {'reason': 'library_rotation'}))
        with vdl.db() as conn:
            row = conn.execute('SELECT * FROM library_rotation').fetchone()
            self.assertEqual(row['expires_at'], first['order']['expires_at'])
        self.now += 30
        timers[-1].callback()
        self.assertEqual(self.library()['order']['created_at'], self.now)
        self.assertEqual(timers[-1].interval, 3600)

    def test_concurrent_stale_timer_and_settings_cannot_revive_disabled_mode(self):
        timers = self.fake_timers()
        first = self.enable(1)
        self.now = first['order']['expires_at']
        with ThreadPoolExecutor(max_workers=2) as executor:
            wake = executor.submit(timers[0].callback)
            disable = executor.submit(vdl.db_set_preferences, {'library_rotation_enabled': 'false'})
            wake.result()
            disable.result()
        self.assertEqual(self.library()['order']['kind'], 'library')
        self.assertIsNone(vdl._rotation_timer)
        with vdl.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM library_rotation').fetchone()[0], 0)

    def test_file_checks_do_not_hold_database_write_lock(self):
        self.fixture()
        original = vdl._playable_library_entry

        def check(entry, allowed_bases=None):
            self.assertFalse(vdl._db_lock.locked())
            return original(entry, allowed_bases)

        with mock.patch.object(vdl, '_playable_library_entry', side_effect=check):
            self.enable()
            self.library()

    def test_timer_startup_owned_by_serving_process_and_wsgi_import(self):
        for module_name, debug, reloader_child, starts in (
            ('__main__', '1', '', False),
            ('__main__', '1', 'true', True),
            ('__main__', '0', '', True),
            ('vdl', '1', '', True),
        ):
            with (self.subTest(module=module_name, debug=debug, child=reloader_child),
                  mock.patch.object(vdl, '__name__', module_name),
                  mock.patch.dict(os.environ, {
                      'FLASK_DEBUG': debug, 'WERKZEUG_RUN_MAIN': reloader_child,
                  }),
                  mock.patch.object(vdl, '_restore_rotation_timer') as restore):
                vdl.init_db()
                self.assertEqual(restore.call_count, int(starts))

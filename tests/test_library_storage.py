import os
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class LibraryStorageTest(AppCase):
    def setUp(self):
        super().setUp()
        self.now = 1_800_000_000.0
        clock = mock.patch.object(vdl, '_storage_now', side_effect=lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)
        self.addCleanup(vdl.stop_library_storage)

    def storage(self, client=None):
        response = (client or self.client).get('/api/library-storage')
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.headers.get('Cache-Control'), 'no-store')
        result = response.get_json()
        self.assertEqual(set(result), {
            'total_bytes', 'measured_at', 'next_refresh_at', 'state',
        })
        return result

    def epoch(self, value):
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()

    def measure(self):
        self.assertTrue(vdl.refresh_library_storage())
        return self.storage()

    def row_for_path(self, download_id, path, owner=None, private=False):
        vdl.db_insert_download(
            download_id, f'https://fixture.invalid/{download_id}',
            owner['id'] if owner else None,
            owner['username'] if owner else None,
        )
        vdl.db_update_download(
            download_id, status='finished', filename=path,
            output_dir=self.download_dir, filesize=99999999,
        )
        if private:
            vdl.db_set_download_visibility(download_id, 'private')

    def test_authenticated_read_only_endpoint_and_initial_unknown(self):
        self.assertEqual(
            vdl.app.test_client().get('/api/library-storage').status_code, 401,
        )
        self.assertEqual(self.client.post('/api/library-storage').status_code, 405)
        self.assertEqual(self.storage(), {
            'total_bytes': None, 'measured_at': None,
            'next_refresh_at': None, 'state': 'calculating',
        })
        self.assertNotIn('total_bytes', self.client.get('/api/health').get_json())

    def test_empty_snapshot_is_successful_zero_and_has_utc_deadline(self):
        first = self.measure()
        self.assertEqual(first['state'], 'ready')
        self.assertEqual(first['total_bytes'], 0)
        self.assertEqual(self.epoch(first['measured_at']), self.now)
        self.assertEqual(self.epoch(first['next_refresh_at']), self.now + 86400)
        self.assertTrue(first['measured_at'].endswith(('Z', '+00:00')))

    def test_file_identity_deduplication_and_distinct_copies(self):
        original = self.finished_file('original', 'original.mp4', b'x' * 123)
        self.row_for_path('repeat', original)
        symlink = os.path.join(self.download_dir, 'alias.webm')
        os.symlink(original, symlink)
        self.row_for_path('symlink', symlink)
        hardlink = os.path.join(self.download_dir, 'hardlink.mkv')
        os.link(original, hardlink)
        self.row_for_path('hardlink', hardlink)
        self.finished_file('copy', 'copy.mp4', b'x' * 123)
        self.assertEqual(self.measure()['total_bytes'], 246)

    def test_only_finished_supported_regular_videos_count(self):
        self.finished_file('video', 'video.MP4', b'video')
        for index, extension in enumerate(('.mp3', '.m4a', '.jpg', '.vtt', '.json', '.part', '.tmp', '.db')):
            self.finished_file(f'excluded{index}', f'file{extension}', b'exclude')
        for index, status in enumerate(('starting', 'downloading', 'paused', 'cancelled', 'interrupted', 'error')):
            download_id = f'status{index}'
            self.finished_file(download_id, f'{download_id}.mp4', b'exclude')
            vdl.db_update_download(download_id, status=status)
        self.row_for_path('missing', os.path.join(self.download_dir, 'missing.mp4'))
        directory = os.path.join(self.download_dir, 'directory.mp4')
        os.mkdir(directory)
        self.row_for_path('directory', directory)
        outside = os.path.join(self.temp_dir.name, 'outside.mp4')
        with open(outside, 'wb') as output:
            output.write(b'unsafe')
        self.row_for_path('outside', outside)
        alias = os.path.join(self.download_dir, 'escape.mp4')
        os.symlink(outside, alias)
        self.row_for_path('escape', alias)
        self.assertEqual(self.measure()['total_bytes'], 5)

    def test_sparse_large_file_uses_actual_metadata_not_download_estimate(self):
        path = self.finished_file('large', 'large.mp4', b'')
        byte_count = 1_000_000_000_000 + 123
        with open(path, 'r+b') as output:
            output.truncate(byte_count)
        vdl.db_update_download('large', filesize=12)
        with mock.patch.object(vdl, 'ffprobe_resolution', side_effect=AssertionError('no probing')):
            self.assertEqual(self.measure()['total_bytes'], byte_count)

    def test_sources_rotation_filters_and_changed_directory_do_not_limit_scan(self):
        for index, source in enumerate(('url', 'upload', 'upload', 'upload')):
            download_id = f'source{index}'
            self.finished_file(download_id, f'{download_id}.mp4', bytes(index + 1))
            with vdl._db_lock, vdl.db() as conn:
                conn.execute('UPDATE downloads SET source_type = ? WHERE id = ?', (source, download_id))
        vdl.db_set_preferences({'library_rotation_enabled': 'true'})
        self.finished_file('arrival', 'arrival.mp4', b'new arrival')
        replacement = os.path.join(self.temp_dir.name, 'new-output')
        os.mkdir(replacement)
        vdl.db_set_preferences({'download_dir': replacement})
        self.assertEqual(self.measure()['total_bytes'], 21)
        self.assertEqual(self.client.get('/api/library-storage?search=missing&limit=1').get_json()['total_bytes'], 21)

    def test_current_authorization_is_applied_before_file_deduplication(self):
        alice = vdl.db_create_user('alice', 'alice-password', 'normal')
        bob = vdl.db_create_user('bob', 'bob-password', 'normal')
        alice_client = self.authenticated_client('alice', 'alice-password')
        bob_client = self.authenticated_client('bob', 'bob-password')
        shared = self.finished_file('shared', 'shared.mp4', bytes(13))
        self.row_for_path('private-alias', shared, owner=alice, private=True)
        a_path = os.path.join(self.download_dir, 'alice.mp4')
        b_path = os.path.join(self.download_dir, 'bob.mp4')
        for path, count in ((a_path, 17), (b_path, 19)):
            with open(path, 'wb') as output:
                output.write(bytes(count))
        self.row_for_path('alice-only', a_path, owner=alice, private=True)
        self.row_for_path('bob-only', b_path, owner=bob, private=True)
        first = self.measure()
        self.assertEqual(first['total_bytes'], 49)
        self.assertEqual(self.storage(alice_client)['total_bytes'], 30)
        self.assertEqual(self.storage(bob_client)['total_bytes'], 32)
        with mock.patch.object(vdl, '_measure_library_storage', side_effect=AssertionError('no scan')):
            vdl.db_set_download_visibility('shared', 'private')
            self.assertEqual(self.storage(alice_client)['total_bytes'], 30)
            self.assertEqual(self.storage(bob_client)['total_bytes'], 19)
            vdl.db_set_download_visibility('alice-only', 'public')
            self.assertEqual(self.storage(bob_client)['total_bytes'], 36)
            with vdl._db_lock, vdl.db() as conn:
                conn.execute("DELETE FROM downloads WHERE id = 'bob-only'")
            self.assertEqual(self.storage(bob_client)['total_bytes'], 17)
        self.assertEqual(self.storage()['next_refresh_at'], first['next_refresh_at'])

    def test_reads_do_not_stat_media_or_measure_even_when_expired(self):
        self.finished_file(data=bytes(27))
        first = self.measure()
        self.now += 86400
        with (mock.patch.object(vdl.os, 'stat', side_effect=AssertionError('endpoint stat')),
              mock.patch.object(vdl, '_measure_library_storage', side_effect=AssertionError('endpoint scan'))):
            response = self.storage()
            health = self.client.get('/api/health')
        self.assertEqual(response['total_bytes'], 27)
        self.assertEqual(response['measured_at'], first['measured_at'])
        self.assertEqual(response['state'], 'stale')
        self.assertEqual(health.status_code, 200)

    def test_new_entries_and_external_edits_wait_for_exact_daily_expiry(self):
        path = self.finished_file(data=bytes(9))
        first = self.measure()
        with open(path, 'ab') as output:
            output.write(bytes(11))
        self.finished_file('new', 'new.mp4', bytes(7))
        self.now += 86399.999
        self.assertFalse(vdl.refresh_library_storage())
        self.assertEqual(self.storage(), first)
        self.now += .001
        second = self.measure()
        self.assertEqual(second['total_bytes'], 27)
        self.assertEqual(self.epoch(second['measured_at']), self.now)
        self.assertFalse(vdl.refresh_library_storage())

    def test_renames_reuse_measurements_and_removal_immediately_excludes_members(self):
        path = self.finished_file(data=bytes(9))
        first = self.measure()
        renamed = os.path.join(self.download_dir, 'renamed.mp4')
        os.rename(path, renamed)
        vdl.db_update_download('test0001', filename=renamed)
        with mock.patch.object(vdl, '_measure_library_storage', side_effect=AssertionError('no scan')):
            self.assertEqual(self.storage(), first)
            with vdl._db_lock, vdl.db() as conn:
                conn.execute("DELETE FROM downloads WHERE id = 'test0001'")
            self.assertEqual(self.storage()['total_bytes'], 0)
        self.assertEqual(self.storage()['measured_at'], first['measured_at'])

    def test_restart_reuses_committed_deadline_and_overdue_downtime_runs_once(self):
        self.finished_file(data=bytes(9))
        first = self.measure()
        self.now += 100
        vdl.init_db()
        self.assertEqual(self.storage(), first)
        self.assertFalse(vdl.refresh_library_storage())
        self.now += 10 * 86400
        second = self.measure()
        self.assertEqual(self.epoch(second['measured_at']), self.now)
        self.assertEqual(self.epoch(second['next_refresh_at']), self.now + 86400)
        self.assertFalse(vdl.refresh_library_storage())

    def test_failed_initial_measurement_is_unavailable_and_retries_after_half_hour(self):
        with mock.patch.object(vdl, '_measure_library_storage', side_effect=PermissionError('offline')) as scan:
            self.assertFalse(vdl.refresh_library_storage())
            self.assertEqual(self.storage(), {
                'total_bytes': None, 'measured_at': None,
                'next_refresh_at': None, 'state': 'unavailable',
            })
            self.now += 1799.999
            self.assertFalse(vdl.refresh_library_storage())
            self.assertEqual(scan.call_count, 1)
        self.now += .001
        recovered = self.measure()
        self.assertEqual(recovered['state'], 'ready')
        self.assertEqual(recovered['total_bytes'], 0)

    def test_failed_refresh_retains_generation_and_successful_deadline(self):
        self.finished_file(data=bytes(23))
        first = self.measure()
        self.now += 86400
        with mock.patch.object(vdl, '_measure_library_storage', side_effect=OSError('offline')):
            self.assertFalse(vdl.refresh_library_storage())
        stale = self.storage()
        self.assertEqual(stale, dict(first, state='stale'))
        self.now += 1799
        self.assertFalse(vdl.refresh_library_storage())
        self.now += 1
        recovered = self.measure()
        self.assertEqual(recovered['total_bytes'], 23)
        self.assertEqual(self.epoch(recovered['next_refresh_at']), self.now + 86400)

    def test_concurrent_refreshes_share_owner_and_requests_remain_responsive(self):
        self.finished_file(data=bytes(31))
        entered = threading.Event()
        release = threading.Event()
        original = vdl._measure_library_storage

        def blocked(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return original(*args, **kwargs)

        with mock.patch.object(vdl, '_measure_library_storage', side_effect=blocked) as scan:
            with ThreadPoolExecutor(max_workers=8) as executor:
                first = executor.submit(vdl.refresh_library_storage)
                self.assertTrue(entered.wait(2))
                try:
                    self.assertEqual(self.storage()['state'], 'calculating')
                    remaining = list(executor.map(lambda _: vdl.refresh_library_storage(), range(12)))
                    self.assertFalse(any(remaining))
                    self.assertEqual(scan.call_count, 1)
                finally:
                    release.set()
                self.assertTrue(first.result(timeout=5))
        self.assertEqual(self.storage()['total_bytes'], 31)

    def test_expired_snapshot_stays_available_while_scan_is_running(self):
        self.finished_file(data=bytes(31))
        first = self.measure()
        self.now += 86400
        original = vdl._measure_library_storage

        def observe(*args, **kwargs):
            self.assertEqual(self.storage(), dict(first, state='stale'))
            return original(*args, **kwargs)

        with mock.patch.object(vdl, '_measure_library_storage', side_effect=observe):
            self.measure()

    def test_commit_events_are_coalesced_and_contain_no_storage_details(self):
        subscriber = vdl.event_bus.subscribe()
        self.measure()
        self.now += 86400
        self.measure()
        self.assertEqual(subscriber.qsize(), 1)
        self.assertEqual(subscriber.get_nowait(), ('library_storage', {}))

    def fake_timers(self):
        timers = []

        class Timer:
            def __init__(self, interval, callback, *args, **kwargs):
                self.interval = interval
                self.callback = callback
                self.cancelled = False
                self.daemon = False
                timers.append(self)

            def start(self):
                pass

            def cancel(self):
                self.cancelled = True

        self._storage_start_patch.stop()
        timer_patch = mock.patch.object(vdl.threading, 'Timer', Timer)
        timer_patch.start()
        self.addCleanup(timer_patch.stop)
        return timers

    def test_unattended_timer_refreshes_at_expiry_with_single_startup_owner(self):
        timers = self.fake_timers()
        self.finished_file(data=bytes(41))
        vdl.start_library_storage()
        vdl.start_library_storage()
        self.assertEqual(len(timers), 1)
        self.assertLessEqual(timers[0].interval, 1)
        timers[0].callback()
        first = self.storage()
        self.assertEqual(first['total_bytes'], 41)
        self.assertEqual(timers[-1].interval, 86400)
        vdl.start_library_storage()
        self.assertEqual(len(timers), 2)
        self.now += 86400
        timers[-1].callback()
        self.assertEqual(self.epoch(self.storage()['measured_at']), self.now)
        self.assertEqual(timers[-1].interval, 86400)
        current = timers[-1]
        vdl.stop_library_storage()
        self.assertTrue(current.cancelled)
        self.assertIsNone(vdl._storage_timer)

    def test_restart_timer_retains_deadline_and_retry_wakes_after_30_minutes(self):
        self.finished_file(data=bytes(41))
        first = self.measure()
        timers = self.fake_timers()
        self.now += 23 * 3600
        vdl.init_db()
        self.assertEqual(timers[-1].interval, 3600)
        self.assertEqual(self.storage(), first)
        self.now += 3600
        with mock.patch.object(vdl, '_measure_library_storage', side_effect=PermissionError('offline')):
            timers[-1].callback()
        self.assertEqual(timers[-1].interval, 1800)
        self.assertEqual(self.storage(), dict(first, state='stale'))
        self.now += 1800
        timers[-1].callback()
        self.assertEqual(self.storage()['state'], 'ready')
        self.assertEqual(timers[-1].interval, 86400)

    def test_reloader_parent_cannot_own_storage_scheduler(self):
        for module_name, debug, child, expected in (
            ('__main__', '1', '', False),
            ('__main__', '1', 'true', True),
            ('__main__', '0', '', True),
            ('vdl', '1', '', True),
        ):
            with (self.subTest(module=module_name, debug=debug, child=child),
                  mock.patch.object(vdl, '__name__', module_name),
                  mock.patch.dict(os.environ, {'FLASK_DEBUG': debug, 'WERKZEUG_RUN_MAIN': child}),
                  mock.patch.object(vdl, 'start_library_storage') as start):
                vdl.init_db()
                self.assertEqual(start.call_count, int(expected))

    def test_metadata_and_aggregate_read_one_committed_generation(self):
        path = self.finished_file(data=bytes(7))
        first = self.measure()
        self.now += 86400
        original_db = vdl.db
        injected = False
        test = self

        class Cursor:
            def __init__(self, cursor):
                self.cursor = cursor

            def fetchone(self):
                row = self.cursor.fetchone()
                nonlocal injected
                if not injected:
                    injected = True
                    with open(path, 'ab') as output:
                        output.write(bytes(12))
                    test.assertTrue(vdl.refresh_library_storage())
                return row

        class Connection:
            def __init__(self, connection):
                self.connection = connection

            def execute(self, sql, *args):
                cursor = self.connection.execute(sql, *args)
                if sql.startswith('SELECT * FROM library_storage_snapshot') and not injected:
                    return Cursor(cursor)
                return cursor

            def __getattr__(self, name):
                return getattr(self.connection, name)

        @contextmanager
        def interleaved_db():
            with original_db() as connection:
                yield Connection(connection)

        with mock.patch.object(vdl, 'db', interleaved_db):
            observed = self.storage()
        self.assertTrue(injected)
        self.assertEqual(observed, dict(first, state='stale'))
        self.assertEqual(self.storage()['total_bytes'], 19)

    def test_publication_database_failure_rolls_back_members_and_metadata(self):
        path = self.finished_file(data=bytes(7))
        first = self.measure()
        self.now += 86400
        with open(path, 'ab') as output:
            output.write(bytes(12))
        original_db = vdl.db

        class Connection:
            def __init__(self, connection):
                self.connection = connection

            def execute(self, sql, *args):
                if sql.startswith('UPDATE library_storage_snapshot SET measured_at'):
                    raise sqlite3.OperationalError('injected publication failure')
                return self.connection.execute(sql, *args)

            def __getattr__(self, name):
                return getattr(self.connection, name)

        @contextmanager
        def failing_db():
            with original_db() as connection:
                yield Connection(connection)

        with mock.patch.object(vdl, 'db', failing_db):
            self.assertFalse(vdl.refresh_library_storage())
        self.assertEqual(self.storage(), dict(first, state='stale'))
        self.now += 1800
        self.assertEqual(self.measure()['total_bytes'], 19)

    def test_database_outage_fallback_timer_really_retries_after_recovery(self):
        timers = self.fake_timers()
        self.finished_file(data=bytes(41))
        vdl.start_library_storage()
        with mock.patch.object(vdl, 'db', side_effect=sqlite3.OperationalError('database offline')):
            timers[0].callback()
        self.assertEqual(timers[-1].interval, 1800)
        self.now += 1800
        timers[-1].callback()
        self.assertEqual(self.storage()['total_bytes'], 41)
        self.assertEqual(self.storage()['state'], 'ready')
        self.assertEqual(timers[-1].interval, 86400)

    def test_permission_failure_and_missing_mount_preserve_last_snapshot(self):
        path = self.finished_file(data=bytes(17))
        first = self.measure()
        self.now += 86400
        original_stat = vdl.os.stat

        def permission_failure(filename, *args, **kwargs):
            if filename == path:
                raise PermissionError('video unreadable')
            return original_stat(filename, *args, **kwargs)

        with mock.patch.object(vdl.os, 'stat', side_effect=permission_failure):
            self.assertFalse(vdl.refresh_library_storage())
        self.assertEqual(self.storage(), dict(first, state='stale'))
        self.now += 1800
        with mock.patch.dict(os.environ, {'VDL_INGEST_DIR': os.path.join(self.temp_dir.name, 'missing-mount')}):
            self.assertFalse(vdl.refresh_library_storage())
        self.assertEqual(self.storage(), dict(first, state='stale'))

    def test_disappearing_file_during_scan_is_skipped_and_does_not_hold_write_lock(self):
        path = self.finished_file(data=bytes(17))
        original_stat = vdl.os.stat
        checked = False

        def disappeared(filename, *args, **kwargs):
            nonlocal checked
            if filename == path:
                checked = True
                self.assertFalse(vdl._db_lock.locked())
                raise FileNotFoundError(path)
            return original_stat(filename, *args, **kwargs)

        with mock.patch.object(vdl.os, 'stat', side_effect=disappeared):
            result = self.measure()
        self.assertTrue(checked)
        self.assertEqual(result['total_bytes'], 0)
        self.assertEqual(result['state'], 'ready')

    def test_replacement_during_scan_cannot_receive_old_file_measurement(self):
        path = self.finished_file(data=bytes(17))
        original_file = vdl._storage_file
        calls = 0

        def replaced(entry, allowed_bases):
            nonlocal calls
            result = original_file(entry, allowed_bases)
            calls += 1
            if calls == 1:
                replacement = os.path.join(self.download_dir, 'replacement.mp4')
                with open(replacement, 'wb') as output:
                    output.write(bytes(29))
                os.replace(replacement, path)
            return result

        with mock.patch.object(vdl, '_storage_file', side_effect=replaced):
            result = self.measure()
        self.assertEqual(result['total_bytes'], 0)
        self.now += 86400
        self.assertEqual(self.measure()['total_bytes'], 29)

    def test_record_rename_during_scan_cannot_attach_old_measurement(self):
        self.finished_file(data=bytes(17))
        replacement = self.finished_file('replacement', 'replacement.mp4', bytes(29))
        original_measure = vdl._measure_library_storage

        def renamed(generation):
            original_measure(generation)
            vdl.db_update_download('test0001', filename=replacement)

        with mock.patch.object(vdl, '_measure_library_storage', side_effect=renamed):
            result = self.measure()
        self.assertEqual(result['total_bytes'], 29)
        with vdl.db() as conn:
            members = [row['download_id'] for row in conn.execute('SELECT * FROM library_storage_members')]
        self.assertEqual(members, ['replacement'])

    def test_small_batches_cover_entire_collection_and_restart_discards_staging(self):
        for index in range(7):
            self.finished_file(str(index), f'{index}.mp4', bytes(index + 1))
        with mock.patch.object(vdl, 'LIBRARY_STORAGE_BATCH', 2):
            self.assertEqual(self.measure()['total_bytes'], 28)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute(
                'INSERT INTO library_storage_staging '
                '(generation, download_id, entry_created_at, filename, output_dir, device, inode, byte_size, mtime_ns) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                ('interrupted', 'old', 1, '/old.mp4', self.download_dir, '1', '1', 99, 1),
            )
        vdl.init_db()
        self.now += 86400
        self.assertEqual(self.measure()['total_bytes'], 28)
        with vdl.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM library_storage_staging').fetchone()[0], 0)

    def test_interrupted_scan_cannot_publish_and_next_owner_reclaims_it(self):
        self.finished_file(data=bytes(17))
        first = self.measure()
        self.now += 86400
        original_measure = vdl._measure_library_storage

        def interrupted(generation):
            original_measure(generation)
            vdl.stop_library_storage()

        with mock.patch.object(vdl, '_measure_library_storage', side_effect=interrupted):
            self.assertFalse(vdl.refresh_library_storage())
        self.assertEqual(self.storage(), dict(first, state='stale'))
        with vdl.db() as conn:
            snapshot = conn.execute('SELECT * FROM library_storage_snapshot').fetchone()
            self.assertEqual(snapshot['failed'], 0)
        self.assertEqual(self.measure()['total_bytes'], 17)

    def test_stopped_or_previous_database_timer_callbacks_cannot_restart_owner(self):
        timers = self.fake_timers()
        vdl.start_library_storage()
        first = timers[-1]
        vdl.stop_library_storage()
        first.callback()
        self.assertEqual(len(timers), 1)
        self.assertIsNone(vdl._storage_timer)
        vdl.start_library_storage()
        current = timers[-1]
        with mock.patch.object(vdl, 'DB_PATH', os.path.join(self.temp_dir.name, 'other.db')):
            current.callback()
        self.assertEqual(len(timers), 2)
        self.assertEqual(self.storage()['state'], 'calculating')

    def test_replaced_configured_source_root_is_unavailable_until_original_mount_returns(self):
        self.finished_file(data=bytes(17))
        source = os.path.join(self.temp_dir.name, 'source-mount')
        detached = os.path.join(self.temp_dir.name, 'detached-source')
        os.mkdir(source)
        with mock.patch.dict(os.environ, {'VDL_INGEST_DIR': source}):
            first = self.measure()
            vdl.init_db()
            os.rename(source, detached)
            os.mkdir(source)
            self.now += 86400
            self.assertFalse(vdl.refresh_library_storage())
            self.assertEqual(self.storage(), dict(first, state='stale'))
            os.rmdir(source)
            os.rename(detached, source)
            self.now += 1800
            self.assertEqual(self.measure()['total_bytes'], 17)

    def test_replaced_captured_output_root_cannot_publish_false_empty_snapshot(self):
        self.finished_file(data=bytes(17))
        first = self.measure()
        replacement_output = os.path.join(self.temp_dir.name, 'current-output')
        os.mkdir(replacement_output)
        vdl.db_set_preferences({'download_dir': replacement_output})
        detached = os.path.join(self.temp_dir.name, 'detached-output')
        os.rename(self.download_dir, detached)
        os.mkdir(self.download_dir)
        vdl.init_db()
        self.now += 86400
        self.assertFalse(vdl.refresh_library_storage())
        self.assertEqual(self.storage(), dict(first, state='stale'))
        os.rmdir(self.download_dir)
        os.rename(detached, self.download_dir)
        self.now += 1800
        self.assertEqual(self.measure()['total_bytes'], 17)

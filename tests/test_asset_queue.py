"""Deterministic scheduling tests independent of Flask and real video decoding."""
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager

from asset_generation import AssetQueue


class AssetQueueTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.database = os.path.join(self.directory.name, 'queue.db')
        self.entries = {}
        self.now = 1000.0
        self.generated = []
        self.notifications = []
        self.lock = threading.Lock()
        with self.db() as conn:
            conn.execute('CREATE TABLE downloads (id TEXT PRIMARY KEY,status TEXT)')
            AssetQueue.init_schema(conn)
        self.queue = self.make_queue()
        self.addCleanup(self.queue.stop)

    @contextmanager
    def db(self):
        conn = sqlite3.connect(self.database, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def make_queue(self, generate=None, versions=None):
        return AssetQueue(
            db=self.db, db_lock=self.lock, get_entry=self.entries.get,
            eligible=lambda entry: entry['status'] == 'finished' and os.path.isfile(entry['filename']),
            asset_path=self.path, generate=generate or self.generate,
            versions=versions or {'thumbnail': 2, 'montage': 4},
            notify=lambda ids: self.notifications.extend(ids), clock=lambda: self.now,
        )

    def path(self, entry, kind):
        return os.path.join(os.path.dirname(entry['filename']), entry['id'] + '.' + kind)

    def generate(self, kind, source, target):
        self.generated.append((os.path.basename(source), kind))
        with open(target, 'wb') as output:
            output.write(b'generated')
        return True

    def add(self, name, register=True):
        path = os.path.join(self.directory.name, name + '.mp4')
        with open(path, 'wb') as output:
            output.write(b'video')
        entry = {'id': name, 'filename': path, 'status': 'finished'}
        self.entries[name] = entry
        with self.db() as conn:
            conn.execute('INSERT INTO downloads VALUES (?,?)', (name, 'finished'))
        if register:
            self.queue.register(entry)
        return entry

    def rows(self):
        with self.db() as conn:
            return [dict(row) for row in conn.execute('SELECT * FROM generated_assets ORDER BY sequence')]

    def drain(self, limit=100):
        count = 0
        while count < limit and self.queue.step():
            count += 1
        return count

    def test_independent_tasks_deduplicate_and_preserve_enqueue_order(self):
        entry = self.add('first')
        self.queue.register(entry)
        self.add('second')
        self.assertEqual(len(self.rows()), 4)
        self.assertEqual(self.drain(), 4)
        self.assertEqual(self.generated, [('first.mp4', 'thumbnail'), ('first.mp4', 'montage'),
                                          ('second.mp4', 'thumbnail'), ('second.mp4', 'montage')])
        self.assertEqual(self.queue.readiness(entry), {'thumbnail': 'ready', 'montage': 'ready'})
        self.assertEqual(self.notifications.count('first'), 2)

    def test_priority_tiers_view_order_stale_requests_and_same_set(self):
        for name in ('background', 'page1', 'page2', 'page3'):
            self.add(name)
        self.queue.replace_demand('user-a', 'tab-a', 1, ['page1', 'page2'], 'page2')
        self.queue.replace_demand('user-b', 'tab-b', 1, ['page3'])
        self.queue.replace_demand('user-a', 'tab-a', 2, ['page1', 'page2'], 'page2')
        self.assertFalse(self.queue.replace_demand('user-b', 'tab-b', 1, ['background']))
        self.drain(6)
        self.assertEqual(self.generated, [('page3.mp4', 'thumbnail'), ('page1.mp4', 'thumbnail'),
                                          ('page2.mp4', 'thumbnail'), ('page2.mp4', 'montage'),
                                          ('page3.mp4', 'montage'), ('page1.mp4', 'montage')])

    def test_replacing_tab_leaves_other_tabs_and_expiry_restores_background(self):
        for name in ('old', 'other', 'new'):
            self.add(name)
        self.queue.replace_demand('user', 'one', 1, ['old'])
        self.queue.replace_demand('user', 'two', 1, ['other'])
        self.queue.replace_demand('user', 'one', 2, ['new'])
        self.queue.step()
        self.assertEqual(self.generated[-1], ('new.mp4', 'thumbnail'))
        self.queue.step()
        self.assertEqual(self.generated[-1], ('other.mp4', 'thumbnail'))
        self.now += 61
        self.queue.step()
        self.assertEqual(self.generated[-1], ('old.mp4', 'thumbnail'))
        self.queue.clear_owner('user')

    def test_eight_foreground_tasks_allow_oldest_ordinary_task(self):
        self.add('ordinary')
        for index in range(10):
            self.add(f'page{index}')
        self.queue.replace_demand('user', 'tab', 1, [f'page{i}' for i in range(10)])
        self.drain(9)
        self.assertEqual(self.generated[8], ('ordinary.mp4', 'thumbnail'))
        self.assertEqual(self.generated[7], ('page7.mp4', 'thumbnail'))

    def test_bounded_failures_survive_new_queue_and_do_not_block_other_kind(self):
        entry = self.add('corrupt')
        def generator(kind, source, target):
            if kind == 'thumbnail':
                raise OSError('missing tool ' + 'x' * 400)
            return self.generate(kind, source, target)
        self.queue.generate = generator
        self.queue.step()
        self.queue.step()
        self.assertFalse(self.queue.step())
        self.assertEqual(self.rows()[0]['retry_at'], 1030)
        self.now = 1030
        self.queue = self.make_queue(generator)
        self.queue.step()
        self.assertEqual(self.rows()[0]['retry_at'], 1330)
        self.queue.register(entry)
        self.now = 1330
        self.queue.step()
        states = self.queue.readiness(entry)
        self.assertEqual(states, {'thumbnail': 'failed', 'montage': 'ready'})
        self.assertEqual(self.rows()[0]['attempts'], 3)
        self.assertLessEqual(len(self.rows()[0]['failure']), 240)
        self.now += 10000
        self.assertFalse(self.queue.step())

    def test_finalization_write_failures_recover_with_backoff_without_repeating_decoders(self):
        entry = self.add('busy')
        self.add('other')
        thumbnail_sequence = self.rows()[0]['sequence']
        failure = {'remaining': 3, 'recovery_unavailable': False}

        class Connection:
            def __init__(self, connection):
                self.connection = connection

            def __getattr__(self, name):
                return getattr(self.connection, name)

            def execute(self, sql, arguments=()):
                if (sql.startswith("UPDATE generated_assets SET state='ready'")
                        and arguments == (thumbnail_sequence,)
                        and failure['remaining']):
                    failure['remaining'] -= 1
                    raise sqlite3.OperationalError('database is locked')
                if (failure['recovery_unavailable']
                        and 'temporary_path=NULL WHERE sequence=? AND token=?' in sql):
                    raise sqlite3.OperationalError('database is locked')
                return self.connection.execute(sql, arguments)

        @contextmanager
        def failing_db():
            with self.db() as connection:
                yield Connection(connection)

        self.queue.db = failing_db
        self.assertTrue(self.queue.step())
        self.assertEqual((self.rows()[0]['state'], self.rows()[0]['attempts']), ('running', 1))
        failure['recovery_unavailable'] = True
        with self.assertRaises(sqlite3.OperationalError):
            self.queue.step()
        self.assertEqual(len(self.generated), 1)
        failure['recovery_unavailable'] = False
        self.assertTrue(self.queue.step())
        self.assertEqual((self.rows()[0]['state'], self.rows()[0]['retry_at']), ('queued', 1030))
        self.assertEqual(self.generated[-1], ('busy.mp4', 'montage'))
        self.drain()
        self.assertEqual({row['state'] for row in self.rows()[1:]}, {'ready'})

        self.now = 1030
        self.assertTrue(self.queue.step())
        self.assertFalse(self.queue.step())
        self.assertEqual((self.rows()[0]['attempts'], self.rows()[0]['retry_at']), (2, 1330))
        self.now = 1330
        self.assertTrue(self.queue.step())
        self.assertFalse(self.queue.step())
        self.assertEqual(self.queue.readiness(entry), {'thumbnail': 'failed', 'montage': 'ready'})
        self.assertEqual(self.rows()[0]['attempts'], 3)
        self.assertEqual(self.generated.count(('busy.mp4', 'thumbnail')), 3)
        self.assertFalse(any('asset-tmp' in path for path in os.listdir(self.directory.name)))

    def test_deleted_task_is_not_recreated_by_deferred_finalization(self):
        entry = self.add('removed')
        original_finish = self.queue._finish

        def fail(*_arguments):
            raise sqlite3.OperationalError('database is locked')

        self.queue._finish = fail
        self.assertTrue(self.queue.step())
        self.queue._finish = original_finish
        self.queue.invalidate(['removed'])
        self.entries.pop('removed')
        with self.db() as connection:
            connection.execute("DELETE FROM downloads WHERE id='removed'")
        os.remove(entry['filename'])
        self.assertFalse(self.queue.step())
        self.assertEqual(self.rows(), [])
        self.assertIsNone(self.queue._deferred_failure)

    def test_identity_change_requeues_both_kinds_without_serving_stale_assets(self):
        entry = self.add('changed')
        self.drain()
        with open(entry['filename'], 'ab') as output:
            output.write(b'changed')
        self.assertEqual(self.queue.readiness_many([entry])['changed'],
                         {'thumbnail': 'queued', 'montage': 'queued'})
        self.queue.register(entry)
        self.assertFalse(os.path.exists(self.path(entry, 'thumbnail')))
        self.assertFalse(os.path.exists(self.path(entry, 'montage')))
        self.drain()
        self.assertEqual(self.rows()[0]['attempts'], 1)

    def test_lost_sidecar_does_not_reset_attempt_count(self):
        entry = self.add('lost')
        self.drain()
        with self.db() as conn:
            conn.execute("UPDATE generated_assets SET attempts=3 WHERE kind='thumbnail'")
        os.remove(self.path(entry, 'thumbnail'))
        self.assertEqual(self.queue.readiness(entry)['thumbnail'], 'failed')
        self.assertFalse(self.queue.step())
        self.assertEqual(self.rows()[0]['attempts'], 3)

    def test_existing_valid_sidecars_adopted_without_generation(self):
        entry = self.add('cached', register=False)
        for kind in ('thumbnail', 'montage'):
            with open(self.path(entry, kind), 'wb') as output:
                output.write(b'cached')
        self.assertEqual(self.queue.register(entry), {'thumbnail': 'ready', 'montage': 'ready'})
        self.assertEqual(self.drain(), 0)

    def test_blocked_generation_serialization_deletion_and_next_priority(self):
        first = self.add('first')
        self.add('background')
        self.add('visible')
        entered, release = threading.Event(), threading.Event()
        def blocked(kind, source, target):
            entered.set()
            release.wait(3)
            return self.generate(kind, source, target)
        self.queue.generate = blocked
        thread = threading.Thread(target=self.queue.step)
        thread.start()
        self.assertTrue(entered.wait(2))
        self.assertFalse(self.queue.step())
        self.queue.replace_demand('user', 'tab', 1, ['visible'])
        with self.queue.publication_lock, self.lock, self.db() as conn:
            self.queue.invalidate(['first'], conn=conn)
            self.entries.pop('first')
            conn.execute("DELETE FROM downloads WHERE id='first'")
            os.remove(first['filename'])
        release.set()
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertFalse(os.path.exists(self.path(first, 'thumbnail')))
        self.assertFalse(any('asset-tmp' in path for path in os.listdir(self.directory.name)))
        self.queue.generate = self.generate
        self.queue.step()
        self.assertEqual(self.generated[-1], ('visible.mp4', 'thumbnail'))

    def test_invalidation_blocks_stale_route_registration_before_row_deletion(self):
        entry = self.add('removed')
        self.queue.invalidate(['removed'])
        self.assertEqual(self.queue.register(entry), {})
        self.assertEqual(self.rows(), [])

    def test_source_changes_during_generation_discard_result_and_register_new_work(self):
        entry = self.add('replace')
        def replace(kind, source, target):
            result = self.generate(kind, source, target)
            with open(source, 'ab') as output:
                output.write(b'changed')
            return result
        self.queue.generate = replace
        self.queue.step()
        self.assertFalse(os.path.exists(self.path(entry, 'thumbnail')))
        self.assertEqual({row['state'] for row in self.rows()}, {'queued'})
        self.assertEqual({row['attempts'] for row in self.rows()}, {0})

    def test_rename_during_generation_publishes_at_current_stored_directory(self):
        entry = self.add('renamed')
        directory = os.path.join(self.directory.name, 'moved')
        os.mkdir(directory)
        def rename(kind, source, target):
            result = self.generate(kind, source, target)
            current = os.path.join(directory, 'renamed.mp4')
            os.rename(source, current)
            entry['filename'] = current
            return result
        self.queue.generate = rename
        self.queue.step()
        self.assertTrue(os.path.isfile(self.path(entry, 'thumbnail')))
        self.assertFalse(os.path.exists(os.path.join(self.directory.name, 'renamed.thumbnail')))

    def test_recovery_reclaims_running_task_and_removes_owned_temporary_files(self):
        entry = self.add('restart')
        task = self.queue._claim(self.queue._candidate())
        with open(task['temporary_path'], 'wb') as output:
            output.write(b'abandoned')
        self.queue.replace_demand('user', 'tab', 1, ['restart'])
        replacement = self.make_queue()
        replacement._recover()
        self.assertFalse(os.path.exists(task['temporary_path']))
        self.assertEqual(self.rows()[0]['state'], 'queued')
        self.assertEqual(self.rows()[0]['attempts'], 1)
        replacement.step()
        self.assertEqual(self.rows()[0]['state'], 'ready')
        self.assertEqual(self.rows()[0]['attempts'], 2)

    def test_recovery_removes_owned_temporary_even_when_source_has_disappeared(self):
        entry = self.add('missing')
        task = self.queue._claim(self.queue._candidate())
        with open(task['temporary_path'], 'wb') as output:
            output.write(b'abandoned')
        os.remove(entry['filename'])
        replacement = self.make_queue()
        replacement._recover()
        self.assertFalse(os.path.exists(task['temporary_path']))
        replacement.step()
        self.assertEqual(self.rows(), [])

    def test_ineligible_source_cannot_leave_stale_cache_for_later_replacement(self):
        entry = self.add('missing')
        self.drain()
        os.remove(entry['filename'])
        self.queue.register(entry)
        self.assertFalse(os.path.exists(self.path(entry, 'thumbnail')))
        self.assertEqual(self.rows(), [])
        with open(entry['filename'], 'wb') as output:
            output.write(b'new source')
        self.assertEqual(self.queue.register(entry)['thumbnail'], 'queued')

    def test_upgrade_creates_new_version_without_reusing_exhausted_failure(self):
        entry = self.add('upgrade')
        with self.db() as conn:
            conn.execute("UPDATE generated_assets SET state='failed',attempts=3")
        replacement = self.make_queue(versions={'thumbnail': 3, 'montage': 5})
        replacement.register(entry)
        self.assertEqual({row['version'] for row in self.rows()}, {3, 5})
        self.assertEqual({row['attempts'] for row in self.rows()}, {0})

    def test_bounded_reconciliation_and_single_unattended_worker_for_1500_videos(self):
        # No browser demand, no request threads, and no image requests occur.
        entries = [self.add(f'bulk{i:04d}', register=False) for i in range(1500)]
        self.assertTrue(self.queue.reconcile_batch())
        self.assertEqual(len(self.rows()), self.queue.BATCH_SIZE * 2)
        active = 0
        maximum = 0
        counter_lock = threading.Lock()
        def observed(kind, source, target):
            nonlocal active, maximum
            with counter_lock:
                active += 1
                maximum = max(maximum, active)
            try:
                return self.generate(kind, source, target)
            finally:
                with counter_lock:
                    active -= 1
        self.queue.generate = observed
        first = self.queue.start()
        self.assertIs(self.queue.start(), first)
        # The coverage gate traces every worker line; allow its instrumentation
        # overhead while still bounding a dispatcher that stops making progress.
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            with self.db() as conn:
                counts = conn.execute("SELECT COUNT(*),SUM(state='ready') FROM generated_assets").fetchone()
            if counts[0] == 3000 and counts[1] == 3000:
                break
            time.sleep(.02)
        self.queue.stop()
        self.assertEqual(tuple(counts), (3000, 3000))
        self.assertEqual(maximum, 1)
        self.assertEqual(len(self.generated), 3000)
        self.assertEqual(self.queue.readiness_many(entries[-10:])[entries[-1]['id']]['montage'], 'ready')

    def test_passive_reconciliation_does_not_renew_or_promote_expiring_demand(self):
        self.add('first')
        self.add('second')
        self.queue.replace_demand('user', 'one', 1, ['first'])
        self.queue.replace_demand('user', 'two', 1, ['second'])
        self.now += 59
        self.queue.replace_demand('user', 'one', 2, ['first'], renew=False)
        self.queue.step()
        self.assertEqual(self.generated[-1], ('second.mp4', 'thumbnail'))
        self.now += 2
        self.assertFalse(self.queue.replace_demand('user', 'one', 3, ['first'], renew=False))
        self.queue.step()
        self.assertEqual(self.generated[-1], ('first.mp4', 'thumbnail'))

    def test_zero_byte_sidecar_is_not_ready(self):
        entry = self.add('empty', register=False)
        open(self.path(entry, 'thumbnail'), 'wb').close()
        self.assertEqual(self.queue.register(entry)['thumbnail'], 'queued')

    def test_demand_bookkeeping_validation_and_bounds(self):
        entry = self.add('demand')
        for index in range(self.queue.MAX_TABS + 10):
            self.queue.replace_demand('user', str(index), 1, ['demand'])
        with self.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM asset_demand_tabs').fetchone()[0],
                             self.queue.MAX_TABS)
        with self.assertRaises(ValueError):
            self.queue.replace_demand('user', 'tab', True, ['demand'])
        with self.assertRaises(ValueError):
            self.queue.replace_demand('user', 'tab', 2, ['demand'], 'hidden')
        self.assertEqual(self.queue.readiness_many([entry])['demand']['thumbnail'], 'queued')

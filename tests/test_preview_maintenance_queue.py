"""Cache-upgrade invariants with synthetic files, a fake clock and one dispatcher."""
import os
import sqlite3
import threading
import unittest
from unittest import mock

from tests import test_asset_queue as support


class PreviewMaintenanceQueueTests(unittest.TestCase):
    setUp = support.AssetQueueTests.setUp
    db = support.AssetQueueTests.db
    generate = support.AssetQueueTests.generate
    add = support.AssetQueueTests.add
    rows = support.AssetQueueTests.rows
    drain = support.AssetQueueTests.drain

    def path(self, entry, kind):
        suffix = '.thumbnail' if kind == 'thumbnail' else '.preview-v6.mp4'
        return os.path.join(os.path.dirname(entry['filename']), entry['id'] + suffix)

    def make_queue(self, generate=None, versions=None):
        return support.AssetQueueTests.make_queue(self, generate, versions or {'thumbnail': 2, 'montage': 6})

    def legacy(self, name='legacy', *, known=True):
        entry = self.add(name, register=False)
        path = self.path(entry, 'montage').replace('preview-v6', 'preview-v5')
        with open(path, 'wb') as output:
            output.write(b'legacy montage')
        with open(self.path(entry, 'thumbnail'), 'wb') as output:
            output.write(b'thumbnail')
        if known:
            with self.db() as conn:
                conn.execute('INSERT INTO generated_assets(download_id,kind,version,source,state) VALUES (?,?,?,?,?)',
                             (name, 'montage', 5, self.queue._identity(entry['filename']), 'ready'))
        self.queue.register(entry)
        return entry, path

    def finish_discovery(self):
        while self.queue.reconcile_batch():
            pass

    def test_fallback_is_playable_and_visible_demand_does_not_bypass_grace(self):
        entry, path = self.legacy()
        delivery = self.queue.delivery(entry)
        self.assertTrue(delivery['available'])
        self.assertFalse(delivery['current'])
        self.assertEqual(delivery['path'], path)
        self.queue.replace_demand('user', 'tab', 1, ['legacy'])
        self.assertFalse(self.queue.step())
        self.now += 29
        self.assertFalse(self.queue.step())
        self.now += 1
        self.assertTrue(self.queue.step())
        self.assertTrue(self.queue.delivery(entry)['current'])
        self.now += 121
        self.queue.maintenance.cleanup()
        self.assertFalse(os.path.exists(path))

    def test_hover_bypasses_grace_but_keeps_active_old_reader_pinned(self):
        entry, path = self.legacy()
        old = self.queue.delivery(entry, lease=True)
        self.queue.replace_demand('user', 'tab', 1, ['legacy'], 'legacy')
        self.assertTrue(self.queue.step())
        self.assertNotEqual(self.queue.delivery(entry)['identity'], old['identity'])
        self.assertEqual(self.queue.delivery(entry, old['identity'], lease=True)['path'], path)
        self.now += 119
        self.queue.maintenance.cleanup()
        self.assertTrue(os.path.exists(path))
        self.now += 2
        self.queue.maintenance.cleanup()
        self.assertFalse(os.path.exists(path))
        self.assertFalse(self.queue.delivery(entry, old['identity'])['available'])

    def test_pending_recipe_upgrade_serves_old_reader_during_encode_and_restart_cleanup(self):
        entry, path = self.legacy()
        old = self.queue.delivery(entry, lease=True)
        entered, release = threading.Event(), threading.Event()

        def blocked(kind, source, target):
            entered.set()
            if not release.wait(3):
                return False
            return self.generate(kind, source, target)

        self.queue.generate = blocked
        self.queue.replace_demand('user', 'tab', 1, [entry['id']], entry['id'])
        thread = threading.Thread(target=self.queue.step)
        thread.start()
        try:
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.queue.delivery(entry)['identity'], old['identity'])
            self.assertEqual(self.queue.delivery(entry, old['identity'], lease=True)['path'], path)
            self.assertTrue(os.path.isfile(path))
        finally:
            release.set()
            thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertTrue(self.queue.delivery(entry)['current'])
        self.assertTrue(os.path.exists(path))

        # Restart after publication must resume retirement, not encode again.
        replacement = self.make_queue()
        replacement._recover()
        self.assertTrue(replacement.delivery(entry, old['identity'])['available'])
        self.now += 121
        replacement.maintenance.cleanup()
        self.assertFalse(os.path.exists(path))
        self.assertTrue(replacement.delivery(entry)['current'])
        self.assertFalse(replacement.step())
        self.assertEqual(len(self.generated), 1)

    def test_missing_provenance_never_adopts_an_old_named_file(self):
        entry, path = self.legacy(known=False)
        self.assertFalse(self.queue.delivery(entry)['available'])
        self.assertEqual(self.queue.maintenance_status()['state'], 'idle')
        self.assertTrue(self.queue.step())
        self.assertTrue(os.path.exists(path), 'Unverified ownership is retained, not guessed')

    def test_failed_upgrade_keeps_fallback_and_hover_does_not_reset_backoff(self):
        entry, path = self.legacy()
        self.queue.generate = lambda *_args: False
        self.queue.replace_demand('user', 'tab', 1, ['legacy'], 'legacy')
        for attempt, advance in ((1, 30), (2, 300), (3, 10000)):
            self.assertTrue(self.queue.step())
            self.assertTrue(self.queue.delivery(entry)['available'])
            self.queue.register(entry)
            self.queue.replace_demand('user', 'tab', attempt + 1, ['legacy'], 'legacy')
            self.assertFalse(self.queue.step())
            self.now += advance
        self.finish_discovery()
        self.assertEqual(self.queue.maintenance_status()['failed'], 1)
        self.assertEqual(self.queue.maintenance_status()['left'], 0)
        self.assertEqual(self.queue.maintenance_status()['state'], 'completed_with_warnings')
        self.assertTrue(os.path.exists(path))
        self.assertIn('upgrade_failed', [item['event_type'] for item in self.queue.system_logs()['items']])

    def test_automatic_cooldown_is_persisted_and_unrelated_work_runs(self):
        self.legacy('first')
        self.legacy('second')
        self.now += 30
        self.assertTrue(self.queue.step())
        self.assertFalse(self.queue.step())
        replacement = self.make_queue()
        self.assertFalse(replacement.step())
        self.queue = replacement
        self.add('new')
        self.assertEqual(self.drain(), 2)
        self.now += 29
        self.assertFalse(self.queue.step())
        self.now += 1
        self.assertTrue(self.queue.step())
        self.assertEqual(self.queue.maintenance_status()['updated'], 2)

    def test_due_upgrade_gets_fairness_turn_after_eight_foreground_tasks(self):
        self.legacy()
        visible = [self.add(f'page{i}') for i in range(10)]
        self.queue.replace_demand('user', 'tab', 1, [entry['id'] for entry in visible])
        self.now += 30
        for _ in range(9):
            self.queue.step()
        self.assertEqual(self.generated[8], ('legacy.mp4', 'montage'))

    def test_publication_commit_failure_recovers_without_second_encode(self):
        entry, path = self.legacy()
        self.queue.replace_demand('user', 'tab', 1, ['legacy'], 'legacy')
        original = self.queue._commit_publication
        with mock.patch.object(self.queue, '_commit_publication', side_effect=sqlite3.OperationalError('full')):
            self.assertTrue(self.queue.step())
        self.assertTrue(os.path.exists(path))
        replacement = self.make_queue()
        replacement._recover()
        self.assertEqual(len(self.generated), 1)
        self.assertEqual(replacement.maintenance_status()['updated'], 1)
        self.assertTrue(replacement.delivery(entry)['current'])
        replacement._recover()
        self.assertEqual(replacement.maintenance_status()['updated'], 1)

    def test_publication_replace_failure_preserves_old_sequence(self):
        entry, path = self.legacy()
        self.now += 30
        with mock.patch('asset_generation.os.replace', side_effect=OSError('no space')):
            self.queue.step()
        self.assertEqual(self.queue.delivery(entry)['path'], path)
        self.assertEqual(self.queue.maintenance_status()['updated'], 0)
        self.assertEqual(self.queue.maintenance_status()['left'], 1)

    def test_validation_failure_never_retires_old_sequence(self):
        entry, path = self.legacy()
        self.queue.validate = lambda *_args: False
        self.now += 30
        self.queue.step()
        self.assertEqual(self.queue.delivery(entry)['path'], path)
        self.assertEqual(self.queue.maintenance_status()['updated'], 0)

    def test_cleanup_failure_is_separate_and_retried_without_generation(self):
        entry, path = self.legacy()
        self.now += 30
        original_remove = os.remove
        def deny_old(candidate):
            if candidate == path:
                raise PermissionError('denied')
            return original_remove(candidate)
        with mock.patch('preview_maintenance.os.remove', side_effect=deny_old):
            self.queue.step()
        self.assertTrue(self.queue.delivery(entry)['current'])
        self.assertEqual(self.queue.maintenance_status()['updated'], 1)
        self.assertTrue(os.path.exists(path))
        self.now += 121
        with mock.patch('preview_maintenance.os.remove', side_effect=deny_old):
            self.queue.maintenance.cleanup()
        self.now += 30
        self.assertFalse(self.queue.step())
        self.assertFalse(os.path.exists(path))
        self.assertEqual(len(self.generated), 1)
        self.assertIn('cleanup_failed', [item['event_type'] for item in self.queue.system_logs()['items']])

    def test_change_source_revokes_old_identity_and_skips_old_membership(self):
        entry, path = self.legacy()
        old = self.queue.delivery(entry, lease=True)
        with open(entry['filename'], 'ab') as output:
            output.write(b'changed source')
        self.assertFalse(self.queue.delivery(entry, old['identity'])['available'])
        self.queue.register(entry)
        self.finish_discovery()
        self.assertEqual(self.queue.maintenance_status()['skipped'], 1)
        self.assertFalse(self.queue.delivery(entry)['available'])

    def test_invalidation_revokes_lease_without_erasing_log_history(self):
        entry, path = self.legacy()
        old = self.queue.delivery(entry, lease=True)
        before = self.queue.system_logs()['total']
        self.queue.invalidate(['legacy'])
        self.assertFalse(self.queue.delivery(entry, old['identity'])['available'])
        self.assertGreaterEqual(self.queue.system_logs()['total'], before)
        self.assertEqual(self.queue.maintenance_status()['skipped'], 1)

    def test_graceful_pause_and_abrupt_restart_have_distinct_durable_events(self):
        self.legacy()
        self.queue.stop()
        self.assertEqual(self.queue.maintenance_status()['state'], 'paused')
        replacement = self.make_queue()
        replacement._recover()
        self.assertEqual(replacement.system_logs()['items'][0]['event_type'], 'resuming')
        replacement = self.make_queue()
        replacement._recover()
        self.assertEqual(replacement.system_logs()['items'][0]['event_type'], 'interrupted')

    def test_shutdown_during_encode_does_not_publish_or_accept_new_work(self):
        entry, path = self.legacy()
        entered, release = threading.Event(), threading.Event()
        def blocked(kind, source, target):
            entered.set()
            release.wait(3)
            return self.generate(kind, source, target)
        self.queue.generate = blocked
        self.now += 30
        thread = threading.Thread(target=self.queue.step)
        thread.start()
        self.assertTrue(entered.wait(2))
        self.queue.stop()
        release.set()
        thread.join(3)
        self.assertEqual(self.queue.maintenance_status()['updated'], 0)
        self.assertEqual(self.queue.delivery(entry)['path'], path)
        self.assertFalse(self.queue.step())
        replacement = self.make_queue()
        replacement._recover()
        self.assertEqual([r for r in self.rows() if r['kind']=='montage'][0]['attempts'], 1)
        self.assertEqual(replacement.maintenance_status()['left'], 1)

    def test_last_interrupted_attempt_exhausts_member_on_recovery(self):
        self.legacy()
        with self.db() as conn:
            conn.execute("UPDATE generated_assets SET attempts=2 WHERE kind='montage'")
        self.now += 30
        self.queue._claim(self.queue._candidate())
        replacement = self.make_queue()
        replacement._recover()
        self.assertEqual(replacement.maintenance_status()['failed'], 1)
        self.assertEqual(replacement.maintenance_status()['left'], 0)

    def test_partial_discovery_never_finishes_early_and_completion_once(self):
        self.legacy()
        self.now += 30
        self.queue.step()
        self.assertFalse(self.queue.maintenance_status()['discovery_complete'])
        self.assertEqual(self.queue.maintenance_status()['state'], 'running')
        self.finish_discovery()
        self.assertEqual(self.queue.maintenance_status()['state'], 'completed')
        events = self.queue.system_logs()['items']
        self.assertEqual(sum(event['event_type']=='finished' for event in events), 1)
        replacement = self.make_queue()
        replacement._recover()
        while replacement.reconcile_batch():
            pass
        self.assertTrue(replacement.maintenance_status()['discovery_complete'])
        self.assertEqual(replacement.system_logs()['total'], len(events))

    def test_progress_logs_coalesce_and_filters_precede_anchored_pagination(self):
        for name in ('one', 'two', 'three'):
            self.legacy(name)
        self.now += 30
        self.finish_discovery()
        for name in ('one', 'two', 'three'):
            self.queue.replace_demand('user', 'tab', int(self.now), [name], name)
            self.queue.step()
            self.now += 1
        logs = self.queue.system_logs(page_size=1)
        snapshot = logs['snapshot_id']
        self.assertGreater(logs['total'], 1)
        second = self.queue.system_logs(page=2, page_size=1, snapshot_id=snapshot)
        self.assertNotEqual(logs['items'][0]['id'], second['items'][0]['id'])
        self.assertEqual(self.queue.system_logs(text='Finished updating')['total'], 1)
        self.assertEqual(self.queue.system_logs(severity='error')['total'], 0)
        self.assertLessEqual(self.queue.system_logs(page_size=1000)['page_size'], 100)

    def test_lost_replacement_reactivates_valid_legacy_even_after_retirement_grace(self):
        entry, path = self.legacy()
        old = self.queue.delivery(entry, lease=True)
        self.now += 30
        self.queue.step()
        os.remove(self.path(entry, 'montage'))
        self.now += 121
        self.queue.maintenance.cleanup()
        self.assertTrue(os.path.exists(path))
        self.assertEqual(self.queue.delivery(entry)['identity'], old['identity'])
        self.assertTrue(self.queue.delivery(entry, old['identity'], lease=True)['available'])

    def test_cleanup_failed_batch_does_not_starve_later_owned_files(self):
        entries = [self.legacy(name) for name in ('one', 'two')]
        self.now += 30
        for index, (entry, path) in enumerate(entries):
            self.queue.replace_demand('user', 'tab', index + 1, [entry['id']], entry['id'])
            self.queue.step()
        self.now += 121
        self.queue.BATCH_SIZE = 1
        with self.db() as conn:
            first = conn.execute('SELECT path FROM preview_deliveries WHERE selected=0 ORDER BY identity LIMIT 1').fetchone()[0]
        original_remove = os.remove
        def deny_first(path):
            if path == first:
                raise PermissionError('denied')
            return original_remove(path)
        with mock.patch('preview_maintenance.os.remove', side_effect=deny_first):
            self.queue.maintenance.cleanup()
            self.queue.maintenance.cleanup()
        self.assertTrue(os.path.exists(first))
        self.assertEqual(sum(os.path.exists(path) for entry, path in entries), 1)

    def test_bulk_read_snapshot_identity_matches_later_provenance_adoption(self):
        entry = self.add('bulk-read', register=False)
        old = self.path(entry, 'montage').replace('preview-v6', 'preview-v5')
        with open(old, 'wb') as output:
            output.write(b'old')
        with self.db() as conn:
            conn.execute('INSERT INTO generated_assets(download_id,kind,version,source,state) VALUES (?,?,?,?,?)',
                         (entry['id'], 'montage', 5, self.queue._identity(entry['filename']), 'ready'))
        with self.lock:
            metadata = self.queue.readiness_many([entry], include_delivery=True)[entry['id']]['montage_delivery']
        self.assertTrue(metadata['available'])
        self.queue.register(entry)
        self.assertEqual(self.queue.delivery(entry, metadata['identity'], lease=True)['identity'], metadata['identity'])

    def test_failed_file_sync_preserves_fallback_and_unfinished_credit(self):
        entry, path = self.legacy()
        self.now += 30
        with mock.patch('asset_generation.os.fsync', side_effect=OSError('disk failure')):
            self.queue.step()
        self.assertEqual(self.queue.delivery(entry)['path'], path)
        self.assertEqual(self.queue.maintenance_status()['updated'], 0)
        self.assertEqual(self.queue.maintenance_status()['left'], 1)

    def test_directory_sync_failure_recovers_journal_before_counting_updated(self):
        entry, path = self.legacy()
        self.now += 30
        with mock.patch.object(self.queue, '_sync_directory', side_effect=OSError('disk failure')):
            self.queue.step()
        self.assertEqual(self.queue.delivery(entry)['path'], path)
        self.assertEqual(self.queue.maintenance_status()['updated'], 0)
        replacement = self.make_queue()
        replacement._recover()
        self.assertEqual(len(self.generated), 1)
        self.assertEqual(replacement.maintenance_status()['updated'], 1)

    def test_legacy_lazy_adoption_before_startup_discovery(self):
        entry = self.add('lazy', register=False)
        old = self.path(entry, 'montage').replace('preview-v6', 'preview-v5')
        with open(old, 'wb') as output:
            output.write(b'old')
        with self.db() as conn:
            conn.execute('INSERT INTO generated_assets(download_id,kind,version,source,state) VALUES (?,?,?,?,?)',
                         ('lazy','montage',5,self.queue._identity(entry['filename']),'ready'))
        self.assertEqual(self.queue.delivery(entry)['path'], old)

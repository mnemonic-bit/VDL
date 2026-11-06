"""Owned legacy JPEG retirement survives restart and leaves ambiguous files alone."""
import os
import unittest
from unittest import mock

from cache_retirement import CacheRetirement
from tests import test_asset_queue as support


class CacheRetirementTests(unittest.TestCase):
    setUp = support.AssetQueueTests.setUp
    db = support.AssetQueueTests.db
    generate = support.AssetQueueTests.generate
    add = support.AssetQueueTests.add
    make_queue = support.AssetQueueTests.make_queue

    def path(self, entry, kind):
        return os.path.join(os.path.dirname(entry['filename']),
                            f".vdl_{entry['id']}.{'thumbnail-v2.jpg' if kind == 'thumbnail' else 'preview-v4.mp4'}")

    def fixture(self):
        entry = self.add('owned', register=False)
        self.queue.legacy_path = lambda item, kind, version: self.path(item, kind).replace('thumbnail-v2', 'thumbnail')
        self.old = self.queue.legacy_path(entry, 'thumbnail', 1)
        self.current = self.path(entry, 'thumbnail')
        for path in (self.old, self.current):
            with open(path, 'wb') as stream:
                stream.write(b'image')
        with self.db() as conn:
            CacheRetirement.init_schema(conn)
            conn.execute('INSERT INTO generated_assets(download_id,kind,version,source,state) VALUES (?,?,?,?,?)',
                         (entry['id'], 'thumbnail', 2, self.queue._identity(entry['filename']), 'ready'))
        return entry, CacheRetirement(self.queue)

    def test_metadata_less_leftover_retires_after_restart_without_encoding(self):
        entry, retirement = self.fixture()
        retirement.discover(entry)
        restarted = CacheRetirement(self.queue)
        restarted.cleanup()
        self.assertFalse(os.path.exists(self.old))
        self.assertTrue(os.path.exists(self.current))
        self.assertTrue(os.path.exists(entry['filename']))
        self.assertEqual(self.generated, [])
        restarted.discover(entry)
        restarted.cleanup()

    def test_failed_replacement_retains_old_then_retries(self):
        entry, retirement = self.fixture()
        retirement.discover(entry)
        os.remove(self.current)
        retirement.cleanup()
        self.assertTrue(os.path.exists(self.old))
        with open(self.current, 'wb') as stream:
            stream.write(b'replacement')
        self.now += 31
        retirement.cleanup()
        self.assertFalse(os.path.exists(self.old))

    def test_source_change_and_reused_sidecar_remain_blocked(self):
        entry, retirement = self.fixture()
        retirement.discover(entry)
        with open(self.old, 'ab') as stream:
            stream.write(b'unrelated replacement')
        retirement.cleanup()
        self.assertTrue(os.path.exists(self.old))
        self.now += 31
        with open(entry['filename'], 'ab') as stream:
            stream.write(b'new source')
        retirement.cleanup()
        with self.db() as conn:
            self.assertEqual(conn.execute('SELECT blocked_reason FROM thumbnail_retirements').fetchone()[0],
                             'source_changed_or_missing')

    def test_symlink_and_hardlinked_source_and_unrelated_images_are_retained(self):
        entry, retirement = self.fixture()
        unrelated = os.path.join(self.directory.name, 'cover.jpg')
        with open(unrelated, 'wb') as stream:
            stream.write(b'cover')
        os.remove(self.old)
        os.symlink(unrelated, self.old)
        retirement.discover(entry)
        retirement.cleanup()
        self.assertTrue(os.path.islink(self.old))
        self.assertTrue(os.path.exists(unrelated))
        os.remove(self.old)
        os.link(entry['filename'], self.old)
        retirement.discover(entry)
        retirement.cleanup()
        self.assertTrue(os.path.exists(self.old))
        self.assertTrue(os.path.exists(entry['filename']))

    def test_unlink_failure_persists_and_retries_after_restart(self):
        entry, retirement = self.fixture()
        retirement.discover(entry)
        with mock.patch('cache_retirement.os.remove', side_effect=PermissionError('denied')):
            retirement.cleanup()
        with self.db() as conn:
            self.assertEqual(conn.execute('SELECT blocked_reason FROM thumbnail_retirements').fetchone()[0], 'unlink_failed')
        self.now += 31
        CacheRetirement(self.queue).cleanup()
        self.assertFalse(os.path.exists(self.old))

    def test_directory_swap_cannot_redirect_unlink_to_outside_files(self):
        entry, retirement = self.fixture()
        media = os.path.join(self.directory.name, 'media')
        moved = os.path.join(self.directory.name, 'moved')
        outside = os.path.join(self.directory.name, 'outside')
        os.mkdir(media)
        os.mkdir(outside)
        for path in (entry['filename'], self.old, self.current):
            os.rename(path, os.path.join(media, os.path.basename(path)))
        entry['filename'] = os.path.join(media, os.path.basename(entry['filename']))
        self.old = os.path.join(media, os.path.basename(self.old))
        self.current = os.path.join(media, os.path.basename(self.current))
        outside_old = os.path.join(outside, os.path.basename(self.old))
        with open(outside_old, 'wb') as stream:
            stream.write(b'unrelated outside image')
        retirement.discover(entry)
        remove = os.remove

        def swap_then_remove(path, **kwargs):
            os.rename(media, moved)
            os.symlink(outside, media)
            remove(path, **kwargs)

        with mock.patch('cache_retirement.os.remove', side_effect=swap_then_remove):
            retirement.cleanup()
        with open(outside_old, 'rb') as stream:
            self.assertEqual(stream.read(), b'unrelated outside image')
        self.assertFalse(os.path.exists(os.path.join(moved, os.path.basename(self.old))))
        self.assertTrue(os.path.exists(os.path.join(moved, os.path.basename(self.current))))

    def test_revoked_output_authorization_keeps_the_old_file(self):
        entry, retirement = self.fixture()
        retirement.discover(entry)
        self.queue.confined = lambda path: False
        retirement.cleanup()
        self.assertTrue(os.path.exists(self.old))
        self.assertTrue(os.path.exists(self.current))

    def test_batch_is_bounded_and_failed_first_does_not_starve_next(self):
        entry, retirement = self.fixture()
        retirement.discover(entry)
        other = self.add('second', register=False)
        other_old = self.queue.legacy_path(other, 'thumbnail', 1)
        for path in (other_old, self.path(other, 'thumbnail')):
            with open(path, 'wb') as stream:
                stream.write(b'image')
        with self.db() as conn:
            conn.execute('INSERT INTO generated_assets(download_id,kind,version,source,state) VALUES (?,?,?,?,?)',
                         (other['id'], 'thumbnail', 2, self.queue._identity(other['filename']), 'ready'))
        retirement.discover(other)
        self.queue.BATCH_SIZE = 1
        remove = os.remove
        def deny_first(path, **kwargs):
            if path == os.path.basename(self.old):
                raise PermissionError('denied')
            remove(path, **kwargs)
        with mock.patch('cache_retirement.os.remove', side_effect=deny_first):
            retirement.cleanup()
            self.assertTrue(os.path.exists(other_old))
            retirement.cleanup()
        self.assertFalse(os.path.exists(other_old))
        self.assertTrue(os.path.exists(self.old))

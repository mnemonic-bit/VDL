"""The offline cache report reads exact authorized directories without writes."""
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from cache_inventory import file_identity, inventory


class CacheInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = os.path.join(self.temp.name, 'media')
        os.mkdir(self.directory)
        self.database = os.path.join(self.temp.name, 'inventory.db')
        self.source = self.write('video.mp4', b'source')
        with sqlite3.connect(self.database) as conn:
            conn.execute('CREATE TABLE downloads(id TEXT PRIMARY KEY,filename TEXT,status TEXT)')
            conn.execute('INSERT INTO downloads VALUES (?,?,?)', ('abc', self.source, 'finished'))
            conn.execute('CREATE TABLE preview_deliveries(path TEXT,source TEXT,file_identity TEXT,version INTEGER,selected INTEGER,lease_until REAL,cleanup_failed INTEGER)')

    def write(self, name, data=b'image'):
        path = os.path.join(self.directory, name)
        with open(path, 'wb') as output:
            output.write(data)
        return path

    def test_families_bytes_orphans_temporaries_and_unrecorded_montage_are_distinct(self):
        self.write('.vdl_abc.thumbnail.jpg', b'old')
        self.write('.vdl_abc.thumbnail-v2.jpg', b'new2')
        self.write('.vdl_abc.preview-v4.mp4', b'old-preview')
        self.write('.vdl_abc.preview-v5.mp4', b'new-preview')
        self.write('.vdl_absent.thumbnail.jpg', b'orphan')
        self.write('.vdl_abc.thumbnail-v2.jpg.token.tmp.jpg', b'tmp')
        before = hashlib.sha256(Path(self.database).read_bytes()).hexdigest()
        result = inventory(self.database, [self.directory])
        items = {os.path.basename(item['path']): item for item in result['items']}
        self.assertEqual(items['.vdl_abc.preview-v4.mp4']['disposition'], 'obsolete_unattributable')
        self.assertEqual(items['.vdl_absent.thumbnail.jpg']['disposition'], 'orphan_without_live_row')
        self.assertEqual(result['families']['jpeg'], {'count': 3, 'bytes': 13})
        self.assertEqual(result['families']['temporary'], {'count': 1, 'bytes': 3})
        self.assertEqual(result['dispositions']['current_unverified']['count'], 2)
        self.assertEqual(result['versions']['jpeg-v2']['count'], 1)
        self.assertEqual(hashlib.sha256(Path(self.database).read_bytes()).hexdigest(), before)

    def test_reader_lease_and_blocked_cleanup_are_not_completed_retirement(self):
        old = self.write('.vdl_abc.preview-v4.mp4')
        current = self.write('.vdl_abc.preview-v5.mp4')
        with sqlite3.connect(self.database) as conn:
            conn.execute('INSERT INTO preview_deliveries VALUES (?,?,?,?,?,?,?)',
                         (old, file_identity(os.stat(self.source)), file_identity(os.stat(old)), 4, 0, 200, 0))
            conn.execute('INSERT INTO preview_deliveries VALUES (?,?,?,?,?,?,?)',
                         (current, file_identity(os.stat(self.source)), file_identity(os.stat(current)), 5, 1, 0, 0))
        result = inventory(self.database, [self.directory], now=100)
        self.assertEqual(result['dispositions']['retained_reader_lease']['count'], 1)
        with sqlite3.connect(self.database) as conn:
            conn.execute('UPDATE preview_deliveries SET cleanup_failed=1')
        result = inventory(self.database, [self.directory], now=300)
        self.assertEqual(result['dispositions']['cleanup_blocked']['count'], 1)
        os.remove(current)
        result = inventory(self.database, [self.directory], now=300)
        self.assertEqual(result['dispositions']['retained_fallback']['count'], 1)

    def test_pages_resume_after_restart_and_are_bounded(self):
        for index in range(7):
            self.write(f'.vdl_abc.thumbnail-v{index + 1}.jpg')
        items, after = [], ''
        while True:
            result = inventory(self.database, [self.directory], limit=2, after=after)
            self.assertLessEqual(len(result['items']), 2)
            items.extend(item['path'] for item in result['items'])
            if result['complete']:
                break
            after = result['next_after']
        self.assertEqual(len(items), 8)
        self.assertEqual(len(set(items)), 8)

    def test_symlinks_outside_files_and_nested_directories_are_not_traversed(self):
        outside = os.path.join(self.temp.name, 'outside')
        os.mkdir(outside)
        os.symlink(self.source, os.path.join(self.directory, '.vdl_abc.thumbnail.jpg'))
        os.mkdir(os.path.join(self.directory, 'nested'))
        with open(os.path.join(self.directory, 'nested', '.vdl_abc.thumbnail-v2.jpg'), 'wb') as stream:
            stream.write(b'nested')
        result = inventory(self.database, [self.directory])
        self.assertEqual(result['dispositions']['unsafe_nonregular']['count'], 1)
        self.assertEqual(len(result['items']), 2)
        os.symlink(outside, os.path.join(self.temp.name, 'link'))
        with self.assertRaises(ValueError):
            inventory(self.database, [os.path.join(self.temp.name, 'link')])

    def test_cli_uses_read_only_database_and_does_not_import_application(self):
        self.write('.vdl_abc.thumbnail.jpg')
        result = subprocess.run([sys.executable, 'cache_inventory.py', '--database', self.database,
                                 '--directory', self.directory, '--limit', '2'],
                                capture_output=True, text=True, check=True,
                                env={**os.environ, 'DOWNLOADS_DB': '/cannot-create/import-side-effect.db'})
        self.assertEqual(len(json.loads(result.stdout)['items']), 2)
        missing = os.path.join(self.temp.name, 'missing.db')
        with self.assertRaises(sqlite3.OperationalError):
            inventory(missing, [self.directory])
        self.assertFalse(os.path.exists(missing))

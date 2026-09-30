import os
import sqlite3
import tempfile
import unittest

import vdl


class SchemaMigrationTest(unittest.TestCase):
    def test_initial_schema_upgrades_through_every_download_migration(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            database = os.path.join(temp_dir, "old.db")
            with sqlite3.connect(database) as connection:
                connection.executescript("""
                    CREATE TABLE downloads (
                        id TEXT PRIMARY KEY,
                        url TEXT NOT NULL,
                        status TEXT NOT NULL,
                        progress TEXT NOT NULL DEFAULT '0%',
                        created_at REAL NOT NULL
                    );
                    CREATE TABLE preferences (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    );
                    INSERT INTO downloads(id, url, status, progress, created_at)
                    VALUES ('legacy1', 'https://fixture.invalid/legacy',
                            'downloading', '31%', 1);
                    INSERT INTO preferences(key, value)
                    VALUES ('theme', 'dark');
                """)

            old_path = vdl.DB_PATH
            old_default = vdl.DEFAULT_DOWNLOAD_DIR
            try:
                vdl.DB_PATH = database
                vdl.DEFAULT_DOWNLOAD_DIR = os.path.join(temp_dir, "downloads")
                vdl.init_db()

                with sqlite3.connect(database) as connection:
                    columns = {
                        row[1] for row in connection.execute(
                            "PRAGMA table_info(downloads)"
                        )
                    }
                    tables = {
                        row[0] for row in connection.execute(
                            "SELECT name FROM sqlite_master WHERE type = 'table'"
                        )
                    }
                self.assertEqual(columns, {
                    "id", "url", "status", "progress", "created_at",
                    "filename", "resolution", "filesize", "speed", "eta",
                    "title", "finished_at", "formats", "requested_format",
                    "output_dir", "requested_filename",
                    "downloaded_bytes", "total_bytes", "favorite",
                })
                self.assertTrue({"tags", "download_tags"}.issubset(tables))
                self.assertEqual(
                    vdl.db_get_download("legacy1")["status"],
                    "interrupted",
                )
                self.assertIs(vdl.db_get_download("legacy1")["favorite"], False)
                self.assertEqual(vdl.db_get_preferences(), {
                    "download_dir": vdl.DEFAULT_DOWNLOAD_DIR,
                    "format": "best",
                    "max_concurrent": "3",
                    "player_mode": "overlay",
                    "theme": "dark",
                })
            finally:
                vdl.DB_PATH = old_path
                vdl.DEFAULT_DOWNLOAD_DIR = old_default


if __name__ == "__main__":
    unittest.main()

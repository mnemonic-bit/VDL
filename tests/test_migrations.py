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
                    CREATE TABLE users (
                        id INTEGER PRIMARY KEY,
                        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                        password_hash TEXT,
                        suspended INTEGER NOT NULL DEFAULT 0,
                        session_version INTEGER NOT NULL DEFAULT 0,
                        created_at REAL NOT NULL
                    );
                    INSERT INTO downloads(id, url, status, progress, created_at)
                    VALUES ('legacy1', 'https://fixture.invalid/legacy',
                            'downloading', '31%', 1);
                    INSERT INTO preferences(key, value)
                    VALUES ('theme', 'dark');
                    INSERT INTO users(username, password_hash, created_at)
                    VALUES ('legacy-user', 'legacy-hash', 1);
                """)

            old_path = vdl.DB_PATH
            old_default = vdl.DEFAULT_DOWNLOAD_DIR
            old_secret_key = vdl.app.secret_key
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
                    user_columns = {
                        row[1] for row in connection.execute(
                            "PRAGMA table_info(users)"
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
                    "view_count",
                    "source_type", "owner_user_id", "owner_username",
                    "visibility", "browser_authenticated",
                    "extension_request_id",
                    "duration_seconds", "media_metadata_probed",
                })
                self.assertTrue({
                    "tags", "download_tags", "app_config", "roles", "users",
                    "user_roles", "ingest_receipts",
                    "extension_tokens",
                }.issubset(tables))
                self.assertIn("name", user_columns)
                admin = vdl.db_get_user_by_username("admin")
                self.assertEqual(admin["roles"], ["admin"])
                self.assertEqual(admin["name"], "admin")
                self.assertIsNone(admin["password_hash"])
                self.assertEqual(
                    vdl.db_get_user_by_username("legacy-user")["name"],
                    "legacy-user",
                )
                self.assertEqual(
                    vdl.db_get_download("legacy1")["status"],
                    "interrupted",
                )
                self.assertIs(vdl.db_get_download("legacy1")["favorite"], False)
                self.assertEqual(vdl.db_get_download("legacy1")["view_count"], 0)
                self.assertEqual(
                    vdl.db_get_download("legacy1")["source_type"],
                    "download",
                )
                self.assertEqual(
                    vdl.db_get_download("legacy1")["visibility"],
                    "public",
                )
                self.assertEqual(vdl.db_get_preferences(), {
                    "download_dir": vdl.DEFAULT_DOWNLOAD_DIR,
                    "format": "best",
                    "history_page_size": "10",
                    "max_concurrent": "3",
                    "player_mode": "overlay",
                    "start_fullscreen": "false",
                    "shuffle_min_height": "0",
                    "shuffle_min_duration_minutes": "0",
                    "theme": "dark",
                })
            finally:
                vdl.DB_PATH = old_path
                vdl.DEFAULT_DOWNLOAD_DIR = old_default
                vdl.app.secret_key = old_secret_key


if __name__ == "__main__":
    unittest.main()

import os
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class PreferencesTest(AppCase):
    def test_download_limits_default_migrate_and_persist(self):
        prefs = self.client.get('/api/preferences').get_json()
        self.assertEqual(prefs['max_concurrent'], '3')
        self.assertEqual(prefs['max_concurrent_per_host'], '2')
        self.assertEqual(prefs['max_total_download_mbps'], '0')
        with vdl._db_lock, vdl.db() as conn:
            conn.execute("DELETE FROM preferences WHERE key = 'max_concurrent_per_host'")
            conn.execute("DELETE FROM preferences WHERE key = 'max_total_download_mbps'")
            conn.execute("UPDATE preferences SET value = '7' WHERE key = 'max_concurrent'")
        vdl.init_db()
        self.assertEqual(vdl.db_get_preferences()['max_concurrent'], '7')
        self.assertEqual(vdl.db_get_preferences()['max_concurrent_per_host'], '2')
        for value, canonical in (('0016.00', '16'), (0, '0'), (1.25, '1.25'), ('0.01', '0.01')):
            response = self.client.post('/api/preferences', json={
                'max_concurrent': 2, 'max_concurrent_per_host': '4',
                'max_total_download_mbps': value,
            })
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()['max_total_download_mbps'], canonical)
            vdl.init_db()
            current = vdl.db_get_preferences()
            self.assertEqual(current['max_concurrent'], '2')
            self.assertEqual(current['max_concurrent_per_host'], '4')
            self.assertEqual(current['max_total_download_mbps'], canonical)

    def test_download_limits_reject_invalid_values_atomically(self):
        original = vdl.db_get_preferences()
        invalid = [True, False, None, '', ' ', -1, '-1', [], {}, 'abc', '1e2']
        for key in ('max_concurrent', 'max_concurrent_per_host', 'max_total_download_mbps'):
            values = invalid + ([0, '0', '1.5', 1.5, 2.0] if key != 'max_total_download_mbps'
                                else ['1 Mbps', '1.001', 1.001, float('nan'), float('inf')])
            for value in values:
                with self.subTest(key=key, value=value):
                    response = self.client.post('/api/preferences', json={
                        key: value, 'theme': 'dark',
                    })
                    self.assertEqual(response.status_code, 400)
                    self.assertIn('error', response.get_json())
                    self.assertEqual(vdl.db_get_preferences(), original)

    def test_skip_video_edges_defaults_and_survives_database_initialization(self):
        self.assertEqual(
            self.client.get('/api/preferences').get_json()['skip_video_edges'],
            'false',
        )
        vdl.db_set_preferences({'skip_video_edges': 'true'})
        vdl.init_db()
        self.assertEqual(vdl.db_get_preferences()['skip_video_edges'], 'true')

    def test_skip_video_edges_normalizes_only_booleans_and_exact_strings(self):
        for value, expected in ((True, 'true'), (False, 'false'),
                                ('true', 'true'), ('false', 'false')):
            with self.subTest(value=value):
                response = self.client.post('/api/preferences', json={
                    'skip_video_edges': value,
                })
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.get_json()['skip_video_edges'], expected)

    def test_invalid_skip_video_edges_rejects_the_entire_request(self):
        original = vdl.db_get_preferences()
        for value in (None, 0, 1, 1.5, '', 'True', 'FALSE', ' true ', [], {}):
            with self.subTest(value=value):
                response = self.client.post('/api/preferences', json={
                    'skip_video_edges': value, 'theme': 'dark',
                    'shuffle_min_height': '1080',
                })
                self.assertEqual(response.status_code, 400)
                self.assertEqual(vdl.db_get_preferences(), original)

    def test_shuffle_thresholds_default_validate_normalize_and_persist(self):
        preferences = self.client.get('/api/preferences').get_json()
        self.assertEqual(preferences['shuffle_min_height'], '0')
        self.assertEqual(preferences['shuffle_min_duration_minutes'], '0')

        for height in vdl.SHUFFLE_MIN_HEIGHTS:
            with self.subTest(height=height):
                response = self.client.post('/api/preferences', json={
                    'shuffle_min_height': height,
                })
                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    response.get_json()['shuffle_min_height'], str(height)
                )
        for minutes in (0, 1, 1440):
            with self.subTest(minutes=minutes):
                response = self.client.post('/api/preferences', json={
                    'shuffle_min_duration_minutes': minutes,
                })
                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    response.get_json()['shuffle_min_duration_minutes'],
                    str(minutes),
                )

    def test_shuffle_threshold_rejection_is_atomic(self):
        vdl.db_set_preferences({
            'shuffle_min_height': '720',
            'shuffle_min_duration_minutes': '12',
        })
        invalid_values = (True, -1, 1.5, '+1', '1e2', '12.0', 1441)
        for value in invalid_values:
            with self.subTest(value=value):
                response = self.client.post('/api/preferences', json={
                    'shuffle_min_height': '1080',
                    'shuffle_min_duration_minutes': value,
                })
                self.assertEqual(response.status_code, 400)
                current = vdl.db_get_preferences()
                self.assertEqual(current['shuffle_min_height'], '720')
                self.assertEqual(
                    current['shuffle_min_duration_minutes'], '12'
                )

        rejected_height = self.client.post('/api/preferences', json={
            'shuffle_min_height': '1000',
        })
        self.assertEqual(rejected_height.status_code, 400)
        self.assertEqual(
            vdl.db_get_preferences()['shuffle_min_height'], '720'
        )

    def test_history_page_size_is_available_validated_and_persists(self):
        self.assertEqual(
            self.client.get("/api/preferences").get_json()["history_page_size"],
            "10",
        )

        response = self.client.post(
            "/api/preferences",
            json={"history_page_size": "20"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["history_page_size"], "20")
        endless = self.client.post(
            "/api/preferences",
            json={"history_page_size": "endless"},
        )
        self.assertEqual(endless.status_code, 200)
        self.assertEqual(
            endless.get_json()["history_page_size"],
            "endless",
        )
        rejected = self.client.post(
            "/api/preferences",
            json={"history_page_size": "12"},
        )
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(
            vdl.db_get_preferences()["history_page_size"],
            "endless",
        )

    def test_fullscreen_preference_is_available_and_persists(self):
        self.assertEqual(
            self.client.get("/api/preferences").get_json()["start_fullscreen"],
            "false",
        )

        response = self.client.post(
            "/api/preferences",
            json={"start_fullscreen": "true"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["start_fullscreen"], "true")

    def test_rejects_empty_and_unusable_download_directories(self):
        original = vdl.db_get_preferences()["download_dir"]
        blocking_file = os.path.join(self.temp_dir.name, "not-a-directory")
        with open(blocking_file, "wb") as output:
            output.write(b"fixture")

        responses = [
            self.client.post("/api/preferences", json={"download_dir": ""}),
            self.client.post(
                "/api/preferences",
                json={"download_dir": os.path.join(blocking_file, "child")},
            ),
        ]
        with mock.patch.object(vdl.os, "access", return_value=False):
            responses.append(self.client.post(
                "/api/preferences",
                json={"download_dir": self.download_dir},
            ))

        self.assertEqual(
            [response.status_code for response in responses],
            [400, 400, 400],
        )
        self.assertEqual(vdl.db_get_preferences()["download_dir"], original)

    def test_worker_setup_failure_becomes_a_terminal_error(self):
        download_id = self.insert("bad-dir1")
        blocking_file = os.path.join(self.temp_dir.name, "not-a-directory")
        with open(blocking_file, "wb") as output:
            output.write(b"fixture")
        vdl.db_set_preferences({
            "download_dir": os.path.join(blocking_file, "child"),
        })

        try:
            vdl.background_download("https://fixture.invalid/video", download_id)
        except OSError as exc:
            self.fail(f"worker setup escaped its failure boundary: {exc}")

        row = vdl.db_list_downloads()[0]
        self.assertEqual(row["status"], "error")
        self.assertIn("directory", row["progress"].lower())
        self.assertEqual(vdl._active_worker_count, 0)


if __name__ == "__main__":
    unittest.main()

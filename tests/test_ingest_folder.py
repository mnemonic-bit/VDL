import os
import threading
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class IngestFolderTest(AppCase):
    def setUp(self):
        super().setUp()
        self.ingest_dir = os.path.join(self.temp_dir.name, "ingest")
        os.mkdir(self.ingest_dir)

    def source(self, name="movie.mp4", data=b"video bytes"):
        path = os.path.join(self.ingest_dir, name)
        with open(path, "wb") as output:
            output.write(data)
        return path

    def test_scan_requires_three_observations_across_the_settle_window(self):
        source = self.source()
        watcher = vdl.IngestFolderWatcher(
            self.ingest_dir, scan_seconds=10, settle_seconds=60
        )

        with mock.patch.object(
            vdl, "_ingest_watched_file", return_value="ingest01"
        ) as ingest:
            watcher.scan_once(now=0)
            watcher.scan_once(now=30)
            watcher.scan_once(now=59)
            ingest.assert_not_called()
            watcher.scan_once(now=60)

        ingest.assert_called_once_with(
            source, vdl._source_signature(source)
        )

    def test_changed_file_restarts_the_settle_window(self):
        source = self.source()
        watcher = vdl.IngestFolderWatcher(
            self.ingest_dir, scan_seconds=10, settle_seconds=60
        )

        with mock.patch.object(vdl, "_ingest_watched_file") as ingest:
            watcher.scan_once(now=0)
            with open(source, "ab") as output:
                output.write(b" more")
            watcher.scan_once(now=60)
            watcher.scan_once(now=119)
            ingest.assert_not_called()
            watcher.scan_once(now=120)

        ingest.assert_called_once()

    def test_settled_video_is_copied_validated_and_registered(self):
        source = self.source(data=b"complete movie")
        signature = vdl._source_signature(source)

        with mock.patch.object(
            vdl, "inspect_uploaded_video", return_value="1080p"
        ) as inspect:
            download_id = vdl._ingest_watched_file(source, signature)

        row = vdl.db_get_download(download_id)
        self.assertEqual(row["status"], "finished")
        self.assertEqual(row["progress"], "100%")
        self.assertEqual(row["source_type"], "upload")
        self.assertEqual(row["title"], "movie")
        self.assertEqual(row["resolution"], "1080p")
        self.assertEqual(row["filesize"], len(b"complete movie"))
        self.assertEqual(row["downloaded_bytes"], len(b"complete movie"))
        self.assertEqual(row["total_bytes"], len(b"complete movie"))
        self.assertEqual(os.path.basename(row["filename"]), "movie.mp4")
        self.assertTrue(os.path.isfile(source))
        with open(row["filename"], "rb") as stored:
            self.assertEqual(stored.read(), b"complete movie")
        self.assertEqual(
            vdl.db_get_ingest_receipts(self.ingest_dir)[source], signature
        )
        inspect.assert_called_once()

    def test_source_change_during_validation_discards_unpublished_copy(self):
        source = self.source(data=b"first version")
        signature = vdl._source_signature(source)

        def change_source(_temporary_path):
            with open(source, "ab") as output:
                output.write(b" changed")
            return "720p"

        with (
            mock.patch.object(
                vdl, "inspect_uploaded_video", side_effect=change_source
            ),
            self.assertRaises(vdl.IngestSourceChanged),
        ):
            vdl._ingest_watched_file(source, signature)

        self.assertEqual(vdl.db_list_downloads(), [])
        self.assertEqual(os.listdir(self.download_dir), [])
        self.assertTrue(os.path.isfile(source))

    def test_invalid_video_is_left_in_inbox_without_library_artifacts(self):
        source = self.source(name="notes.txt", data=b"not a movie")

        with (
            mock.patch.object(
                vdl,
                "inspect_uploaded_video",
                side_effect=ValueError("no video stream"),
            ),
            self.assertRaisesRegex(ValueError, "video stream"),
        ):
            vdl._ingest_watched_file(
                source, vdl._source_signature(source)
            )

        self.assertTrue(os.path.isfile(source))
        self.assertEqual(os.listdir(self.download_dir), [])
        self.assertEqual(vdl.db_list_downloads(), [])

    def test_receipt_prevents_reimport_until_source_is_removed(self):
        source = self.source()
        signature = vdl._source_signature(source)
        with mock.patch.object(vdl, "inspect_uploaded_video", return_value=None):
            vdl._ingest_watched_file(source, signature)

        restarted = vdl.IngestFolderWatcher(
            self.ingest_dir, scan_seconds=10, settle_seconds=60
        )
        with mock.patch.object(vdl, "_ingest_watched_file") as ingest:
            restarted.scan_once(now=0)
            restarted.scan_once(now=60)
            restarted.scan_once(now=120)
        ingest.assert_not_called()

        os.remove(source)
        restarted.scan_once(now=130)
        self.assertEqual(vdl.db_get_ingest_receipts(self.ingest_dir), {})

    def test_scan_ignores_hidden_temporary_directory_and_symlink_entries(self):
        self.source(name=".hidden.mp4")
        self.source(name="copy.mp4.part")
        os.mkdir(os.path.join(self.ingest_dir, "season"))
        target = self.source(name="target.mp4")
        os.symlink(target, os.path.join(self.ingest_dir, "linked.mp4"))
        watcher = vdl.IngestFolderWatcher(
            self.ingest_dir, scan_seconds=10, settle_seconds=1
        )

        with mock.patch.object(vdl, "_ingest_watched_file") as ingest:
            watcher.scan_once(now=0)
            watcher.scan_once(now=1)
            watcher.scan_once(now=2)

        ingest.assert_called_once()
        self.assertEqual(ingest.call_args.args[0], target)

    def test_failed_candidate_is_logged_once_until_its_signature_changes(self):
        self.source()
        watcher = vdl.IngestFolderWatcher(
            self.ingest_dir, scan_seconds=1, settle_seconds=1
        )

        with (
            mock.patch.object(
                vdl, "_ingest_watched_file", side_effect=ValueError("invalid")
            ) as ingest,
            mock.patch("builtins.print") as output,
        ):
            watcher.scan_once(now=0)
            watcher.scan_once(now=1)
            watcher.scan_once(now=2)
            watcher.scan_once(now=3)

        ingest.assert_called_once()
        self.assertIn("could not add", output.call_args.args[0])

    def test_racing_candidate_restarts_without_becoming_a_failure(self):
        self.source()
        watcher = vdl.IngestFolderWatcher(
            self.ingest_dir, scan_seconds=1, settle_seconds=1
        )

        with mock.patch.object(
            vdl,
            "_ingest_watched_file",
            side_effect=vdl.IngestSourceChanged,
        ) as ingest:
            watcher.scan_once(now=0)
            watcher.scan_once(now=1)
            watcher.scan_once(now=2)
            watcher.scan_once(now=3)

        ingest.assert_called_once()

    def test_scan_and_run_report_errors_without_killing_the_watcher(self):
        missing = os.path.join(self.temp_dir.name, "missing")
        watcher = vdl.IngestFolderWatcher(
            missing, scan_seconds=1, settle_seconds=1
        )
        with mock.patch("builtins.print") as output:
            watcher.scan_once(now=0)
        self.assertIn("unable to scan", output.call_args.args[0])

        stop_event = threading.Event()

        def fail_once():
            stop_event.set()
            raise RuntimeError("database unavailable")

        with (
            mock.patch.object(watcher, "scan_once", side_effect=fail_once),
            mock.patch("builtins.print") as output,
        ):
            watcher.run(stop_event)
        self.assertIn("scan failed", output.call_args.args[0])

    def test_source_signature_rejects_missing_and_non_regular_paths(self):
        with self.assertRaises(vdl.IngestSourceChanged):
            vdl._source_signature(os.path.join(self.ingest_dir, "missing"))
        with self.assertRaises(vdl.IngestSourceChanged):
            vdl._source_signature(self.ingest_dir)

    def test_ingest_and_download_directories_must_differ(self):
        source = os.path.join(self.download_dir, "movie.mp4")
        with open(source, "wb") as output:
            output.write(b"video")

        with self.assertRaisesRegex(ValueError, "must be different"):
            vdl._ingest_watched_file(
                source, vdl._source_signature(source)
            )

    def test_stale_ingest_partials_are_removed_without_touching_other_files(self):
        stale = os.path.join(
            self.download_dir, ".vdl_abcdef12.random.ingest.part"
        )
        retained = os.path.join(self.download_dir, "ordinary.part")
        for path in (stale, retained):
            with open(path, "wb") as output:
                output.write(b"data")

        vdl._remove_stale_ingest_partials(self.download_dir)

        self.assertFalse(os.path.exists(stale))
        self.assertTrue(os.path.exists(retained))

    def test_watcher_service_validates_configuration_and_stops_cleanly(self):
        with mock.patch.dict(
            os.environ, {"VDL_INGEST_DIR": ""}, clear=False
        ):
            self.assertIsNone(vdl.start_ingest_watcher())
        invalid_path = os.path.join(self.temp_dir.name, "missing")
        with (
            mock.patch.dict(
                os.environ, {"VDL_INGEST_DIR": invalid_path}, clear=False
            ),
            self.assertRaisesRegex(RuntimeError, "not a directory"),
        ):
            vdl.start_ingest_watcher()
        with (
            mock.patch.dict(
                os.environ, {"VDL_INGEST_DIR": self.ingest_dir}, clear=False
            ),
            mock.patch.object(vdl.os, "access", return_value=False),
            self.assertRaisesRegex(RuntimeError, "not readable"),
        ):
            vdl.start_ingest_watcher()
        with (
            mock.patch.dict(
                os.environ, {"VDL_INGEST_DIR": self.download_dir}, clear=False
            ),
            self.assertRaisesRegex(RuntimeError, "must be different"),
        ):
            vdl.start_ingest_watcher()

        environment = {
            "VDL_INGEST_DIR": self.ingest_dir,
            "VDL_INGEST_SCAN_SECONDS": "1",
            "VDL_INGEST_SETTLE_SECONDS": "1",
        }
        with (
            mock.patch.dict(os.environ, environment, clear=False),
            mock.patch("builtins.print"),
        ):
            try:
                first = vdl.start_ingest_watcher()
                second = vdl.start_ingest_watcher()
                self.assertIs(first, second)
                self.assertTrue(first.is_alive())
            finally:
                vdl.stop_ingest_watcher()
        self.assertFalse(first.is_alive())
        vdl.stop_ingest_watcher()

    def test_watcher_timing_environment_requires_finite_positive_seconds(self):
        for value in ("invalid", "nan", "inf", "0", "-1"):
            with (
                self.subTest(value=value),
                mock.patch.dict(
                    os.environ, {"VDL_TEST_SECONDS": value}, clear=False
                ),
                self.assertRaises(RuntimeError),
            ):
                vdl._positive_seconds_from_env("VDL_TEST_SECONDS", 10)
        with mock.patch.dict(
            os.environ, {"VDL_TEST_SECONDS": "2.5"}, clear=False
        ):
            self.assertEqual(
                vdl._positive_seconds_from_env("VDL_TEST_SECONDS", 10), 2.5
            )


if __name__ == "__main__":
    unittest.main()

import json
import os
import subprocess
import threading
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class ShuffleMetadataTest(AppCase):
    def test_combined_probe_returns_final_height_and_duration(self):
        result = subprocess.CompletedProcess(
            [], 0, stdout=json.dumps({
                'streams': [{'height': 1080, 'duration': '119.5'}],
                'format': {'duration': '120.25'},
            }),
        )
        with mock.patch.object(vdl.subprocess, 'run', return_value=result) as run:
            self.assertEqual(
                vdl.ffprobe_media_metadata('movie.mp4'),
                ('1080p', 120.25),
            )
        command = run.call_args.args[0]
        self.assertIn('stream=height,duration:format=duration', command)

    def test_backfill_probes_without_db_lock_and_publishes_metadata(self):
        path = self.finished_file('legacy', 'legacy.mp4')
        lock_states = []

        def inspect(probed_path):
            self.assertEqual(probed_path, path)
            lock_states.append(vdl._db_lock.locked())
            return '1440p', 321.5

        with mock.patch.object(
            vdl, 'ffprobe_media_metadata', side_effect=inspect
        ):
            vdl._metadata_backfill(threading.Event())

        row = vdl.db_get_download('legacy')
        self.assertEqual(lock_states, [False])
        self.assertEqual(row['resolution'], '1440p')
        self.assertEqual(row['duration_seconds'], 321.5)
        self.assertTrue(row['media_metadata_probed'])

    def test_backfill_does_not_update_a_replaced_path(self):
        original = self.finished_file('legacy', 'legacy.mp4')
        replacement = os.path.join(self.download_dir, 'replacement.mp4')
        with open(replacement, 'wb') as output:
            output.write(b'replacement')

        def replace_path(_path):
            vdl.db_update_download('legacy', filename=replacement)
            return '720p', 60.0

        with mock.patch.object(
            vdl, 'ffprobe_media_metadata', side_effect=replace_path
        ):
            vdl._metadata_backfill(threading.Event())

        row = vdl.db_get_download('legacy')
        self.assertEqual(row['filename'], replacement)
        self.assertFalse(row['media_metadata_probed'])
        self.assertIsNone(row['duration_seconds'])
        self.assertTrue(os.path.isfile(original))


if __name__ == '__main__':
    unittest.main()

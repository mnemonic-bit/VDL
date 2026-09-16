import os
import tempfile
import threading
import time
import unittest
from unittest import mock

import vdl


class AppCase(unittest.TestCase):
    """Give each test an isolated database, download tree, and runtime state."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.download_dir = os.path.join(self.temp_dir.name, "downloads")
        os.mkdir(self.download_dir)
        self._old_db_path = vdl.DB_PATH
        self._old_default_dir = vdl.DEFAULT_DOWNLOAD_DIR
        self._old_event_bus = vdl.event_bus
        self._threads_before = set(threading.enumerate())

        vdl.DB_PATH = os.path.join(self.temp_dir.name, "downloads.db")
        vdl.DEFAULT_DOWNLOAD_DIR = self.download_dir
        vdl.event_bus = vdl.EventBus()
        with vdl._cancel_lock:
            vdl._cancel_flags.clear()
            vdl._pause_flags.clear()
        with vdl._progress_estimate_lock:
            vdl._progress_estimates.clear()
        with vdl._worker_condition:
            vdl._worker_queue.clear()
            vdl._active_worker_count = 0
        vdl.init_db()
        vdl.db_set_preferences({"download_dir": self.download_dir})
        vdl.app.config.update(TESTING=True)
        self.client = vdl.app.test_client()

    def tearDown(self):
        # Wake every worker owned by this test before restoring shared globals.
        for row in vdl.db_list_downloads():
            if row["status"] in ("starting", "downloading", "paused"):
                vdl.request_cancel(row["id"])
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            workers = [
                thread for thread in threading.enumerate()
                if thread not in self._threads_before and thread is not threading.current_thread()
            ]
            if not workers:
                break
            for thread in workers:
                thread.join(0.05)

        with vdl._cancel_lock:
            vdl._cancel_flags.clear()
            vdl._pause_flags.clear()
        with vdl._progress_estimate_lock:
            vdl._progress_estimates.clear()
        with vdl._worker_condition:
            vdl._worker_queue.clear()
            vdl._active_worker_count = 0
        vdl.event_bus = self._old_event_bus
        vdl.DB_PATH = self._old_db_path
        vdl.DEFAULT_DOWNLOAD_DIR = self._old_default_dir
        self.temp_dir.cleanup()

    def insert(self, download_id="test0001", url="https://fixture.invalid/video"):
        vdl.db_insert_download(download_id, url)
        return download_id

    def finished_file(self, download_id="test0001", name="fixture.mp4", data=b"media"):
        if vdl.db_get_download(download_id) is None:
            self.insert(download_id)
        path = os.path.join(self.download_dir, name)
        with open(path, "wb") as output:
            output.write(data)
        vdl.db_update_download(
            download_id,
            status="finished",
            progress="100%",
            filename=path,
            output_dir=self.download_dir,
            filesize=len(data),
            finished_at=time.time(),
        )
        return path

    def start_immediately(self):
        """Run route-created worker targets synchronously and deterministically."""
        return mock.patch.object(vdl.threading, "Thread", ImmediateThread)


class ImmediateThread:
    def __init__(self, target=None, args=(), kwargs=None, **_ignored):
        self.target = target
        self.args = args
        self.kwargs = kwargs or {}
        self.daemon = False

    def start(self):
        self.target(*self.args, **self.kwargs)

    def join(self, _timeout=None):
        return None

    def is_alive(self):
        return False

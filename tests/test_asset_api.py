"""Authorization and nonblocking delivery for the shared asset queue."""

import os
import json
import threading
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class AssetApiTest(AppCase):
    def demand(self, ordered_ids, *, client=None, **overrides):
        payload = {"tab_id": "library-tab", "revision": 1, "ids": ordered_ids}
        payload.update(overrides)
        return (client or self.client).post("/api/assets/demand", json=payload)

    def test_library_reports_pending_assets_without_decoding_or_blocking_playback(self):
        self.finished_file()
        with (mock.patch.object(vdl, "generate_video_thumbnail") as thumbnail,
              mock.patch.object(vdl, "generate_video_preview") as montage):
            rows = self.client.get("/api/library").get_json()
            response = self.demand(["test0001"])
            self.assertEqual(rows[0]["assets"], {
                "thumbnail": "queued", "montage": "queued",
            })
            self.assertEqual(response.get_json()["assets"], {
                "test0001": rows[0]["assets"],
            })
            for route in ("thumbnail", "preview"):
                for method in ("get", "head"):
                    pending = getattr(self.client, method)(f"/api/{route}/test0001")
                    self.assertEqual(pending.status_code, 202)
                    self.assertEqual(pending.headers["Cache-Control"], "no-store")
            media = self.client.get("/api/file/test0001")
            self.assertEqual(media.status_code, 200)
            media.close()
        thumbnail.assert_not_called()
        montage.assert_not_called()
        self.assertEqual(vdl.db_get_download("test0001")["view_count"], 0)

    def test_demand_requires_authentication_and_same_origin(self):
        self.finished_file()
        anonymous = self.demand(["test0001"], client=vdl.app.test_client())
        self.assertEqual(anonymous.status_code, 401)
        hostile = self.client.post("/api/assets/demand", json={
            "tab_id": "hostile", "revision": 1, "ids": ["test0001"],
        }, headers={"Origin": "https://hostile.invalid"})
        self.assertEqual(hostile.status_code, 403)

    def test_demand_rejects_malformed_unbounded_and_unrelated_hover_values(self):
        self.finished_file()
        invalid = (
            {"tab_id": ""}, {"tab_id": 3}, {"tab_id": "x" * 201},
            {"revision": True}, {"revision": -1}, {"revision": "1"},
            {"ids": "test0001"}, {"ids": [3]}, {"ids": ["x" * 201]},
            {"ids": [f"video{i:04d}" for i in range(201)]},
            {"hovered_id": "another1"}, {"hovered_id": []},
        )
        for overrides in invalid:
            with self.subTest(overrides=overrides):
                self.assertEqual(self.demand(["test0001"], **overrides).status_code, 400)
        oversized = self.client.post("/api/assets/demand", data=" " * 70000,
                                     content_type="application/json")
        self.assertIn(oversized.status_code, (400, 413))

    def test_unknown_private_missing_and_audio_ids_are_silently_omitted(self):
        owner = vdl.db_create_user("asset-owner", "owner-password", "normal")
        viewer = vdl.db_create_user("asset-viewer", "viewer-password", "normal")
        viewer_client = self.authenticated_client("asset-viewer", "viewer-password")
        vdl.db_insert_download("private1", "https://fixture.invalid/private",
                               owner["id"], owner["username"])
        self.finished_file("private1", name="private.mp4")
        vdl.db_set_download_visibility("private1", "private")
        self.finished_file("public01", name="public.mp4")
        missing = self.finished_file("missing1", name="missing.mp4")
        os.remove(missing)
        self.finished_file("audio001", name="audio.mp3")
        payload = self.demand(["private1", "public01", "missing1", "audio001", "unknown1"],
                              client=viewer_client).get_json()
        self.assertEqual(set(payload["assets"]), {"public01"})
        self.assertTrue(viewer["id"])
        for kind in ("thumbnail", "preview"):
            self.assertEqual(viewer_client.get(f"/api/{kind}/private1").status_code, 404)

    def test_source_replacement_invalidates_ready_sidecars(self):
        path = self.finished_file()
        self.demand(["test0001"])
        entry = vdl.db_get_download("test0001")
        for output in (vdl._thumbnail_path(entry), vdl._preview_path(entry)):
            with open(output, "wb") as stream:
                stream.write(b"cached original")
        self.assertEqual(self.demand(["test0001"], revision=2).get_json()["assets"]["test0001"],
                         {"thumbnail": "ready", "montage": "ready"})
        with open(path, "ab") as stream:
            stream.write(b"different source")
        readiness = self.demand(["test0001"], revision=3).get_json()["assets"]["test0001"]
        self.assertEqual(readiness, {"thumbnail": "queued", "montage": "queued"})
        self.assertEqual(self.client.get("/api/thumbnail/test0001").status_code, 202)
        self.assertEqual(self.client.get("/api/preview/test0001").status_code, 202)

    def test_cached_montage_keeps_range_and_conditional_delivery(self):
        self.finished_file()
        entry = vdl.db_get_download("test0001")
        with open(vdl._preview_path(entry), "wb") as stream:
            stream.write(bytes(range(100)))
        response = self.client.get("/api/preview/test0001", headers={"Range": "bytes=10-19"})
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.data, bytes(range(10, 20)))
        response.close()
        thumbnail_path = vdl._thumbnail_path(entry)
        with open(thumbnail_path, "wb") as stream:
            stream.write(b"cached image")
        response = self.client.get("/api/thumbnail/test0001")
        etag = response.headers["ETag"]
        response.close()
        response = self.client.get("/api/thumbnail/test0001", headers={"If-None-Match": etag})
        self.assertEqual(response.status_code, 304)
        response.close()

    def test_replacement_serves_persisted_caches_while_startup_scan_is_blocked(self):
        self.finished_file('backlog1', 'backlog.mp4')
        self.finished_file('cached01', 'cached.mp4')
        entry = vdl.db_get_download('cached01')
        for path in (vdl._thumbnail_path(entry), vdl._preview_path(entry)):
            with open(path, 'wb') as stream:
                stream.write(b'persistent cache')
        previous = vdl._get_asset_queue()
        self.assertEqual(previous.register(entry), {'thumbnail': 'ready', 'montage': 'ready'})
        previous.stop()
        entered, release = threading.Event(), threading.Event()
        with (mock.patch.object(vdl, '_asset_queue', None),
              mock.patch.object(vdl, 'generate_video_thumbnail') as thumbnail,
              mock.patch.object(vdl, 'generate_video_preview') as montage):
            replacement = vdl._get_asset_queue()
            original_register = replacement.register

            def blocked(entry):
                if threading.current_thread().name == 'vdl-assets':
                    entered.set()
                    if not release.wait(5):
                        raise RuntimeError('Cache test did not release startup scan')
                return original_register(entry)

            replacement.register = blocked
            replacement.start()
            try:
                self.assertTrue(entered.wait(3))
                for route in ('thumbnail', 'preview'):
                    response = self.client.get(f'/api/{route}/cached01')
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.data, b'persistent cache')
                    response.close()
                thumbnail.assert_not_called()
                montage.assert_not_called()
            finally:
                replacement._stop.set()
                release.set()
                replacement.stop()

    def test_startup_generation_makes_missing_thumbnail_available_over_http(self):
        self.finished_file()
        pending = self.client.get('/api/thumbnail/test0001')
        self.assertEqual(pending.status_code, 202)
        pending.close()
        queue = vdl._get_asset_queue()
        ready = threading.Event()
        original_notify = queue.notify

        def notify(ids):
            original_notify(ids)
            ready.set()

        def thumbnail(_source, target):
            with open(target, 'wb') as stream:
                stream.write(b'new thumbnail')
            return True

        queue.notify = notify
        with (mock.patch.object(vdl, 'generate_video_thumbnail', side_effect=thumbnail),
              mock.patch.object(vdl, 'generate_video_preview', return_value=False)):
            queue.start()
            try:
                self.assertTrue(ready.wait(3))
                response = self.client.get('/api/thumbnail/test0001')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.data, b'new thumbnail')
                response.close()
            finally:
                queue.stop()

    def test_stale_revisions_do_not_replace_newer_view(self):
        self.finished_file("newpage1", "new.mp4")
        self.finished_file("oldpage1", "old.mp4")
        self.assertTrue(self.demand(["newpage1"], revision=4).get_json()["accepted"])
        self.assertFalse(self.demand(["oldpage1"], revision=3).get_json()["accepted"])
        self.assertTrue(self.demand([], revision=5).get_json()["accepted"])

    def test_logout_clears_only_its_session_demand(self):
        self.finished_file()
        another_session = self.authenticated_client()
        self.demand(["test0001"])
        self.demand(["test0001"], client=another_session)
        with vdl.db() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM asset_demand_tabs").fetchone()[0], 2)
        self.assertEqual(self.client.post("/logout").status_code, 302)
        with vdl.db() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM asset_demand_tabs").fetchone()[0], 1)

    def test_exhaustion_is_unavailable_without_changing_media_success(self):
        self.finished_file()
        scheduler = vdl._get_asset_queue()
        now = [1000.0]
        scheduler.clock = lambda: now[0]
        with (mock.patch.object(vdl, "generate_video_thumbnail", return_value=False),
              mock.patch.object(vdl, "generate_video_preview", return_value=False)):
            for elapsed in (0, 30, 300):
                now[0] += elapsed
                self.assertTrue(scheduler.step())
                self.assertTrue(scheduler.step())
                self.assertFalse(scheduler.step())
            for revision in (1, 2, 3):
                readiness = self.demand(["test0001"], revision=revision).get_json()["assets"]["test0001"]
                self.assertEqual(readiness, {"thumbnail": "failed", "montage": "failed"})
            self.assertFalse(scheduler.step())
        for kind in ("thumbnail", "preview"):
            self.assertEqual(self.client.get(f"/api/{kind}/test0001").status_code, 404)
        media = self.client.get("/api/file/test0001")
        self.assertEqual(media.status_code, 200)
        media.close()
        row = vdl.db_get_download("test0001")
        self.assertEqual((row["status"], row["view_count"]), ("finished", 0))

    def test_asset_events_recheck_visibility_before_delivery_and_coalesce(self):
        owner = vdl.db_create_user("event-owner", "owner-password", "normal")
        vdl.db_create_user("event-viewer", "viewer-password", "normal")
        viewer = self.authenticated_client("event-viewer", "viewer-password")
        vdl.db_insert_download("private1", "https://fixture.invalid/private",
                               owner["id"], owner["username"])
        self.finished_file("private1", "private.mp4")
        self.finished_file("public01", "public.mp4")
        response = viewer.get("/api/events", buffered=False)
        iterator = iter(response.response)
        self.assertEqual(next(iterator), b"event: ready\ndata: {}\n\n")
        try:
            # Queue the completion while public, then revoke access before the
            # sender consumes it. The pending ID must never reach this user.
            vdl._notify_assets(["private1"])
            with vdl._db_lock, vdl.db() as connection:
                connection.execute("UPDATE downloads SET visibility='private' WHERE id='private1'")
            vdl._notify_assets(["public01"])
            packet = next(iterator).decode()
            self.assertTrue(packet.startswith("event: assets\n"))
            payload = json.loads(packet.split("data: ", 1)[1])
            self.assertEqual(set(payload["assets"]), {"public01"})
            self.assertNotIn("private1", packet)
            self.assertNotIn(self.download_dir, packet)
        finally:
            response.close()

    def test_demand_and_delivery_reject_paths_outside_trusted_roots(self):
        outside = os.path.join(self.temp_dir.name, "outside.mp4")
        with open(outside, "wb") as stream:
            stream.write(b"outside")
        self.insert("outside1")
        vdl.db_update_download("outside1", status="finished", filename=outside)
        response = self.demand(["outside1"])
        self.assertEqual(response.get_json()["assets"], {})
        for kind in ("thumbnail", "preview"):
            self.assertEqual(self.client.get(f"/api/{kind}/outside1").status_code, 403)


if __name__ == "__main__":
    unittest.main()

import os
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class CrossOriginMutationTest(AppCase):
    def test_cross_origin_requests_cannot_reach_any_mutating_route(self):
        form_origin = {
            "Origin": "https://attacker.invalid",
            "Content-Type": "application/x-www-form-urlencoded",
        }

        self.insert("pause001")
        vdl.db_update_download("pause001", status="downloading")
        self.insert("unpause1")
        vdl.db_update_download("unpause1", status="paused")
        vdl.request_pause("unpause1")
        self.insert("stop0001")
        vdl.db_update_download("stop0001", status="downloading")
        self.insert("resume01")
        vdl.db_update_download("resume01", status="cancelled")
        remove_path = self.finished_file("remove01", "remove.mp4")
        rename_path = self.finished_file("rename01", "rename.mp4")
        clear_path = self.finished_file("clear001", "clear.mp4")

        with (
            mock.patch.object(vdl, "background_download"),
            self.start_immediately(),
        ):
            body_dependent = {
                "download": self.client.post(
                    "/api/download",
                    data={"url": "https://fixture.invalid/cross-origin"},
                    headers=form_origin,
                ),
                "preferences": self.client.post(
                    "/api/preferences",
                    data={"theme": "dark"},
                    headers=form_origin,
                ),
                "rename": self.client.post(
                    "/api/rename/rename01",
                    data={"filename": "renamed"},
                    headers=form_origin,
                ),
            }
            simple_actions = {
                "pause": self.client.post("/api/pause/pause001", headers=form_origin),
                "unpause": self.client.post("/api/unpause/unpause1", headers=form_origin),
                "stop": self.client.post("/api/stop/stop0001", headers=form_origin),
                "resume": self.client.post("/api/resume/resume01", headers=form_origin),
                "remove": self.client.post("/api/remove/remove01", headers=form_origin),
                "clear": self.client.post("/api/clear", headers=form_origin),
            }

        self.assertTrue(all(
            response.status_code in (400, 403, 415)
            for response in body_dependent.values()
        ))
        self.assertEqual(
            {
                name: response.status_code
                for name, response in simple_actions.items()
            },
            {name: 403 for name in simple_actions},
        )

        self.assertIsNotNone(vdl.db_get_download("clear001"))
        self.assertIsNotNone(vdl.db_get_download("remove01"))
        self.assertEqual(
            vdl.db_get_download("rename01")["filename"], rename_path
        )
        self.assertTrue(os.path.isfile(clear_path))
        self.assertTrue(os.path.isfile(remove_path))
        self.assertTrue(os.path.isfile(rename_path))

    def test_same_origin_and_non_browser_api_requests_remain_supported(self):
        self.insert("same0001")
        vdl.db_update_download("same0001", status="downloading")
        self.insert("client01")
        vdl.db_update_download("client01", status="downloading")

        same_origin = self.client.post(
            "/api/pause/same0001",
            headers={"Origin": "http://localhost"},
        )
        api_client = self.client.post("/api/pause/client01")

        self.assertEqual(same_origin.status_code, 200)
        self.assertEqual(api_client.status_code, 200)
        self.assertTrue(vdl.is_pause_requested("same0001"))
        self.assertTrue(vdl.is_pause_requested("client01"))

    def test_invalid_or_fetch_metadata_cross_site_origins_are_rejected(self):
        self.insert("opaque01")
        vdl.db_update_download("opaque01", status="downloading")
        self.insert("invalid1")
        vdl.db_update_download("invalid1", status="downloading")
        self.insert("metadata")
        vdl.db_update_download("metadata", status="downloading")

        opaque = self.client.post(
            "/api/pause/opaque01",
            headers={"Origin": "null"},
        )
        malformed = self.client.post(
            "/api/pause/invalid1",
            headers={"Origin": "http://[invalid"},
        )
        metadata = self.client.post(
            "/api/pause/metadata",
            headers={"Sec-Fetch-Site": "cross-site"},
        )

        self.assertEqual(opaque.status_code, 403)
        self.assertEqual(malformed.status_code, 403)
        self.assertEqual(metadata.status_code, 403)
        self.assertFalse(vdl.is_pause_requested("opaque01"))
        self.assertFalse(vdl.is_pause_requested("invalid1"))
        self.assertFalse(vdl.is_pause_requested("metadata"))


if __name__ == "__main__":
    unittest.main()

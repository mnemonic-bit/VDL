import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class CrossOriginMutationTest(AppCase):
    @unittest.expectedFailure  # BUG 15
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
        self.finished_file("remove01", "remove.mp4")
        self.finished_file("rename01", "rename.mp4")
        self.finished_file("clear001", "clear.mp4")

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


if __name__ == "__main__":
    unittest.main()

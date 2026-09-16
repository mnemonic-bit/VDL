import unittest

import vdl
from tests.support.app_case import AppCase


class DownloadTagsTest(AppCase):
    def test_tags_are_reusable_case_insensitive_and_keep_first_spelling(self):
        self.insert("tagone01")
        self.insert("tagtwo02")

        first = self.client.post(
            "/api/tags/tagone01", json={"tag": "  Music   Videos "}
        )
        second = self.client.post(
            "/api/tags/tagtwo02", json={"tag": "music videos"}
        )

        self.assertEqual(first.status_code, 200)
        self.assertTrue(first.get_json()["changed"])
        self.assertEqual(second.get_json()["tags"], ["Music Videos"])
        self.assertEqual(vdl.db_list_tags(), ["Music Videos"])
        rows = {row["id"]: row for row in self.client.get("/api/history").get_json()}
        self.assertEqual(rows["tagone01"]["tags"], ["Music Videos"])
        self.assertEqual(rows["tagtwo02"]["tags"], ["Music Videos"])

    def test_duplicate_attach_is_idempotent(self):
        self.insert("tagdup01")
        self.client.post("/api/tags/tagdup01", json={"tag": "Tutorial"})
        response = self.client.post(
            "/api/tags/tagdup01", json={"tag": "tutorial"}
        )
        self.assertFalse(response.get_json()["changed"])
        self.assertEqual(response.get_json()["tags"], ["Tutorial"])

    def test_tag_disappears_only_after_its_last_attachment_is_removed(self):
        self.insert("tagkeep1")
        self.insert("tagkeep2")
        for download_id in ("tagkeep1", "tagkeep2"):
            self.client.post(
                f"/api/tags/{download_id}", json={"tag": "Keep Me"}
            )

        first = self.client.delete(
            "/api/tags/tagkeep1", json={"tag": "keep me"}
        ).get_json()
        self.assertEqual(first["available_tags"], ["Keep Me"])
        second = self.client.delete(
            "/api/tags/tagkeep2", json={"tag": "KEEP ME"}
        ).get_json()
        self.assertEqual(second["available_tags"], [])
        self.assertEqual(vdl.db_list_tags(), [])

    def test_deleted_download_cleans_up_its_unused_tags(self):
        download_id = self.insert("taggone1")
        self.client.post(
            f"/api/tags/{download_id}", json={"tag": "Temporary"}
        )
        vdl.db_update_download(download_id, status="cancelled")

        response = self.client.post(f"/api/remove/{download_id}")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(vdl.db_list_tags(), [])

    def test_tag_mutations_publish_change_events(self):
        self.insert("tagevent")
        subscriber = vdl.event_bus.subscribe()

        self.client.post("/api/tags/tagevent", json={"tag": "Live"})

        kind, payload = subscriber.get_nowait()
        self.assertEqual(kind, "change")
        self.assertEqual(payload, {"reason": "tag", "id": "tagevent"})

    def test_tag_validation_and_unknown_download_errors(self):
        self.insert("tagvalid")
        invalid = [
            None, "", "   ", "one,two", "x" * 65,
            "bad\x00tag", "line\nbreak", "tab\tname",
        ]
        for value in invalid:
            with self.subTest(value=value):
                response = self.client.post(
                    "/api/tags/tagvalid", json={"tag": value}
                )
                self.assertEqual(response.status_code, 400)
        response = self.client.post(
            "/api/tags/missing1", json={"tag": "Valid"}
        )
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()

import os
import unittest

import vdl
from tests.support.app_case import AppCase


class HistoryApiTest(AppCase):
    def test_favorites_are_persisted_without_changing_date_order(self):
        older_id = self.insert("older001")
        newer_id = self.insert("newer001")

        response = self.client.post(
            f"/api/favorite/{older_id}", json={"favorite": True}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {
            "id": older_id,
            "favorite": True,
            "changed": True,
        })
        rows = self.client.get("/api/history").get_json()
        self.assertEqual([row["id"] for row in rows], [newer_id, older_id])
        self.assertIs(rows[0]["favorite"], False)
        self.assertIs(rows[1]["favorite"], True)

        response = self.client.post(
            f"/api/favorite/{older_id}", json={"favorite": False}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [row["id"] for row in self.client.get("/api/history").get_json()],
            [newer_id, older_id],
        )

    def test_favorite_rejects_invalid_state_and_unknown_download(self):
        download_id = self.insert("favorite1")
        invalid = self.client.post(
            f"/api/favorite/{download_id}", json={"favorite": 1}
        )
        missing = self.client.post(
            "/api/favorite/missing1", json={"favorite": True}
        )
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(missing.status_code, 404)

    def test_history_exposes_persisted_progress_bytes(self):
        download_id = self.insert("bytes001")
        vdl.db_update_download(
            download_id,
            status="downloading",
            downloaded_bytes=125,
            total_bytes=1000,
        )

        row = self.client.get("/api/history").get_json()[0]
        self.assertEqual(row["downloaded_bytes"], 125)
        self.assertEqual(row["total_bytes"], 1000)

    def test_clear_preview_and_clear_target_finished_and_error_rows(self):
        paths = []
        for index, status in enumerate(("finished", "error")):
            download_id = self.insert(f"history{index}")
            path = os.path.join(self.download_dir, f"history{index}.mp4")
            with open(path, "wb") as output:
                output.write(b"fixture")
            paths.append(path)
            vdl.db_update_download(download_id, status=status, filename=path)

        preview = self.client.get("/api/clear/preview").get_json()
        self.assertEqual(preview, {"entries": 2, "with_files": 2})
        result = self.client.post("/api/clear").get_json()
        self.assertEqual((result["removed"], result["files_deleted"]), (2, 2))
        self.assertTrue(all(not os.path.exists(path) for path in paths))

    def test_clear_history_preserves_cancelled_and_interrupted_current_rows(self):
        paths = {}
        for index, status in enumerate(("finished", "error", "cancelled", "interrupted")):
            download_id = self.insert(f"clear{index}")
            path = os.path.join(self.download_dir, f"clear{index}.mp4")
            with open(path, "wb") as output:
                output.write(b"fixture")
            paths[status] = path
            vdl.db_update_download(download_id, status=status, filename=path)
        preview = self.client.get("/api/clear/preview").get_json()
        self.assertEqual(preview, {"entries": 2, "with_files": 2})
        result = self.client.post("/api/clear").get_json()
        self.assertEqual((result["removed"], result["files_deleted"]), (2, 2))
        remaining = {row["status"] for row in vdl.db_list_downloads()}
        self.assertEqual(remaining, {"cancelled", "interrupted"})
        self.assertFalse(os.path.exists(paths["finished"]))
        self.assertFalse(os.path.exists(paths["error"]))
        self.assertTrue(os.path.exists(paths["cancelled"]))
        self.assertTrue(os.path.exists(paths["interrupted"]))

    def test_rows_and_preferences_survive_database_reopening(self):
        self.insert("persist1")
        vdl.db_set_preferences({"theme": "dark", "max_concurrent": 2})
        vdl.init_db()
        self.assertIsNotNone(vdl.db_get_download("persist1"))
        self.assertEqual(vdl.db_get_preferences()["theme"], "dark")
        self.assertEqual(vdl.db_get_preferences()["max_concurrent"], "2")


if __name__ == "__main__":
    unittest.main()

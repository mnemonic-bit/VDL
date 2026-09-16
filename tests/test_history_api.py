import os
import unittest

import vdl
from tests.support.app_case import AppCase


class HistoryApiTest(AppCase):
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

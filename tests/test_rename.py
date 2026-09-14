import os
import unittest

import vdl
from tests.support.app_case import AppCase


class RenameTest(AppCase):
    def test_rename_preserves_original_extension(self):
        old_path = self.finished_file(name="old.mp4")
        response = self.client.post("/api/rename/test0001", json={"filename": "new.webm"})
        new_path = os.path.join(self.download_dir, "new.mp4")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(os.path.exists(old_path))
        self.assertTrue(os.path.exists(new_path))
        self.assertEqual(vdl.db_get_download("test0001")["filename"], new_path)

    def test_rename_rejects_traversal_control_and_dot_names(self):
        self.finished_file()
        for filename in ("../escape", "a/b", "a\\b", "\x00", ".", ".."):
            with self.subTest(filename=filename):
                response = self.client.post(
                    "/api/rename/test0001", json={"filename": filename}
                )
                self.assertEqual(response.status_code, 400)

    def test_rename_reports_conflict_and_missing_source(self):
        path = self.finished_file()
        conflict = os.path.join(self.download_dir, "taken.mp4")
        with open(conflict, "wb") as output:
            output.write(b"taken")
        self.assertEqual(
            self.client.post("/api/rename/test0001", json={"filename": "taken"}).status_code,
            409,
        )
        os.remove(path)
        self.assertEqual(
            self.client.post("/api/rename/test0001", json={"filename": "gone"}).status_code,
            410,
        )


if __name__ == "__main__":
    unittest.main()

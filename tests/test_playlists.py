import os
import time
import unittest

import vdl
from tests.support.app_case import AppCase


class PlaylistTest(AppCase):
    def video(self, download_id, *, duration=60, extension="mp4"):
        self.finished_file(
            download_id, f"{download_id}.{extension}", data=b"media"
        )
        vdl.db_update_download(
            download_id,
            title=f"Video {download_id}",
            duration_seconds=duration,
            media_metadata_probed=True,
        )
        return download_id

    def create_playlist(self, name="My playlist", ids=None, client=None):
        response = (client or self.client).post("/api/playlists", json={
            "name": name,
            "download_ids": ids or [],
        })
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        return response.get_json()

    def test_create_list_replace_quick_add_and_delete(self):
        for download_id in ("one", "two", "three"):
            self.video(download_id)

        created = self.create_playlist("  Café  ", ["one", "two"])
        self.assertEqual(created["name"], "Café")
        self.assertEqual([item["id"] for item in created["items"]], ["one", "two"])

        listed = self.client.get("/api/playlists").get_json()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["item_count"], 2)
        self.assertEqual(listed[0]["duration_seconds"], 120)
        self.assertEqual(listed[0]["mosaic_ids"], ["one", "two"])

        replaced = self.client.put(
            f"/api/playlists/{created['id']}",
            json={
                "name": "Reordered",
                "download_ids": ["two", "one"],
                "expected_revision": created["revision"],
            },
        )
        self.assertEqual(replaced.status_code, 200)
        edited = replaced.get_json()
        self.assertEqual(edited["revision"], 2)
        self.assertEqual([item["id"] for item in edited["items"]], ["two", "one"])

        stale = self.client.put(
            f"/api/playlists/{created['id']}",
            json={
                "name": "Lost update",
                "download_ids": ["one"],
                "expected_revision": 1,
            },
        )
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(
            self.client.get(f"/api/playlists/{created['id']}").get_json()["name"],
            "Reordered",
        )

        added = self.client.post(
            f"/api/playlists/{created['id']}/items",
            json={"download_id": "three"},
        )
        repeated = self.client.post(
            f"/api/playlists/{created['id']}/items",
            json={"download_id": "three"},
        )
        self.assertTrue(added.get_json()["changed"])
        self.assertFalse(repeated.get_json()["changed"])
        self.assertEqual(
            [item["id"] for item in repeated.get_json()["items"]],
            ["two", "one", "three"],
        )

        deleted = self.client.delete(f"/api/playlists/{created['id']}")
        self.assertEqual(deleted.status_code, 204)
        self.assertEqual(self.client.get("/api/playlists").get_json(), [])
        self.assertIsNotNone(vdl.db_get_download("one"))

    def test_validation_is_transactional_and_duplicate_free(self):
        self.video("valid")
        playlist = self.create_playlist(ids=["valid"])
        invalid_payloads = (
            {"name": "", "download_ids": ["valid"], "expected_revision": 1},
            {"name": "ok", "download_ids": ["valid", "valid"], "expected_revision": 1},
            {"name": "ok", "download_ids": ["missing"], "expected_revision": 1},
            {"name": "ok", "download_ids": ["valid"], "expected_revision": True},
        )
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                response = self.client.put(
                    f"/api/playlists/{playlist['id']}", json=payload
                )
                self.assertEqual(response.status_code, 400)
        current = self.client.get(
            f"/api/playlists/{playlist['id']}"
        ).get_json()
        self.assertEqual(current["name"], "My playlist")
        self.assertEqual([item["id"] for item in current["items"]], ["valid"])

    def test_owner_and_administrator_are_isolated_and_account_delete_cascades(self):
        self.video("shared")
        alice = vdl.db_create_user("alice", "alice-password", "normal")
        alice_client = self.authenticated_client("alice", "alice-password")
        playlist = self.create_playlist("Alice list", ["shared"], alice_client)

        self.assertEqual(self.client.get("/api/playlists").get_json(), [])
        self.assertEqual(
            self.client.get(f"/api/playlists/{playlist['id']}").status_code,
            404,
        )
        self.assertEqual(
            self.client.delete(f"/api/playlists/{playlist['id']}").status_code,
            404,
        )

        vdl.db_create_user("second-admin", "admin-password", "admin")
        self.assertTrue(vdl.db_delete_user(alice["id"]))
        with vdl.db() as connection:
            count = connection.execute(
                "SELECT COUNT(*) FROM playlists WHERE id = ?", (playlist["id"],)
            ).fetchone()[0]
        self.assertEqual(count, 0)
        self.assertIsNotNone(vdl.db_get_download("shared"))

    def test_progress_validation_stale_write_and_membership_repair(self):
        self.video("first", duration=100)
        self.video("second", duration=200)
        playlist = self.create_playlist(ids=["first", "second"])
        progress_url = f"/api/playlists/{playlist['id']}/progress"

        saved = self.client.put(progress_url, json={
            "download_id": "first",
            "position_seconds": 41.5,
            "completed": False,
            "write_sequence": 2,
        })
        stale = self.client.put(progress_url, json={
            "download_id": "first",
            "position_seconds": 3,
            "completed": False,
            "write_sequence": 1,
        })
        conflict = self.client.put(progress_url, json={
            "download_id": "second",
            "position_seconds": 1,
            "completed": False,
            "write_sequence": 2,
        })
        self.assertEqual(saved.status_code, 204)
        self.assertEqual(stale.status_code, 204)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(
            self.client.get(f"/api/playlists/{playlist['id']}").get_json()
            ["progress"]["position_seconds"],
            41.5,
        )

        replaced = self.client.put(
            f"/api/playlists/{playlist['id']}",
            json={
                "name": "Removed current",
                "download_ids": ["second"],
                "expected_revision": 1,
            },
        ).get_json()
        self.assertEqual(replaced["progress"]["download_id"], "second")
        self.assertEqual(replaced["progress"]["position_seconds"], 0)
        self.assertFalse(replaced["progress"]["completed"])

        invalid_seconds = (True, -1, float("inf"), vdl.PLAYLIST_MAX_POSITION_SECONDS + 1)
        for seconds in invalid_seconds:
            with self.subTest(seconds=seconds):
                response = self.client.put(progress_url, json={
                    "download_id": "second",
                    "position_seconds": seconds,
                    "completed": False,
                    "write_sequence": 10,
                })
                self.assertEqual(response.status_code, 400)

    def test_download_delete_cascades_membership_and_repairs_progress(self):
        self.video("first")
        self.video("second")
        self.video("third")
        playlist = self.create_playlist(ids=["first", "second", "third"])
        self.client.put(f"/api/playlists/{playlist['id']}/progress", json={
            "download_id": "second", "position_seconds": 22,
            "completed": False, "write_sequence": 1,
        })

        self.assertEqual(self.client.post("/api/remove/second").status_code, 200)
        detail = self.client.get(f"/api/playlists/{playlist['id']}").get_json()
        self.assertEqual(
            [item["id"] for item in detail["items"]], ["first", "third"]
        )
        self.assertEqual([item["position"] for item in detail["items"]], [0, 1])
        self.assertEqual(detail["progress"]["download_id"], "third")
        self.assertEqual(detail["progress"]["position_seconds"], 0)

    def test_visibility_loss_is_sanitized_and_unplayable_content_is_rejected(self):
        self.video("visible")
        alice = vdl.db_create_user("alice", "alice-password", "normal")
        alice_client = self.authenticated_client("alice", "alice-password")
        playlist = self.create_playlist(ids=["visible"], client=alice_client)
        bob = vdl.db_create_user("bob", "bob-password", "normal")
        vdl.db_set_download_visibility("visible", "private")
        with vdl._db_lock, vdl.db() as connection:
            connection.execute(
                "UPDATE downloads SET owner_user_id = ? WHERE id = ?",
                (bob["id"], "visible"),
            )

        detail = alice_client.get(
            f"/api/playlists/{playlist['id']}"
        ).get_json()
        self.assertEqual(detail["items"], [{
            "duration_seconds": None,
            "extension": "",
            "id": None,
            "position": 0,
            "title": "Unavailable video",
            "unavailable": True,
        }])
        self.assertEqual(
            alice_client.post("/api/playback-sessions", json={
                "mode": "playlist", "playlist_id": playlist["id"],
            }).status_code,
            204,
        )

        self.insert("unfinished")
        invalid = alice_client.post("/api/playlists", json={
            "name": "Invalid", "download_id": "unfinished",
        })
        self.assertEqual(invalid.status_code, 400)

    def test_route_payload_validation_and_empty_progress_cleanup(self):
        malformed = (
            self.client.post("/api/playlists", json=[]),
            self.client.put("/api/playlists/unknown", json=[]),
            self.client.post("/api/playlists/unknown/items", json=[]),
            self.client.put("/api/playlists/unknown/progress", json=[]),
        )
        self.assertTrue(all(response.status_code == 400 for response in malformed))
        self.assertEqual(
            self.client.get("/api/playlists/unknown").status_code, 404
        )
        empty = self.create_playlist("Empty")
        self.assertIsNone(empty["progress"])
        self.assertEqual(
            self.client.post("/api/playback-sessions", json={
                "mode": "playlist", "playlist_id": empty["id"],
            }).status_code,
            204,
        )
        invalid_create = (
            {"mode": "playlist", "playlist_id": 3},
            {"mode": "playlist", "playlist_id": empty["id"], "restart": "yes"},
            {"mode": "playlist", "playlist_id": empty["id"], "start_download_id": 3},
        )
        for payload in invalid_create:
            self.assertEqual(
                self.client.post("/api/playback-sessions", json=payload).status_code,
                400,
            )

    def test_playlist_playback_resume_select_advance_and_stop(self):
        self.video("first", duration=100)
        self.video("second", duration=100)
        playlist = self.create_playlist(ids=["first", "second"])
        self.client.put(f"/api/playlists/{playlist['id']}/progress", json={
            "download_id": "first", "position_seconds": 25,
            "completed": False, "write_sequence": 1,
        })

        created = self.client.post("/api/playback-sessions", json={
            "mode": "playlist", "playlist_id": playlist["id"],
            "restart": False,
        })
        self.assertEqual(created.status_code, 201)
        session = created.get_json()
        self.assertEqual(session["item"]["id"], "first")
        self.assertEqual(session["resume_seconds"], 25)
        self.assertEqual([item["id"] for item in session["queue"]], ["first", "second"])

        advanced = self.client.post(
            f"/api/playback-sessions/{session['session_id']}/advance",
            json={
                "expected_download_id": "first",
                "sequence": 1,
                "completed": True,
            },
        )
        repeated_advance = self.client.post(
            f"/api/playback-sessions/{session['session_id']}/advance",
            json={
                "expected_download_id": "first",
                "sequence": 1,
                "completed": True,
            },
        )
        self.assertEqual(advanced.get_json(), repeated_advance.get_json())
        self.assertEqual(advanced.get_json()["item"]["id"], "second")

        selected = self.client.post(
            f"/api/playback-sessions/{session['session_id']}/select",
            json={
                "expected_download_id": "second",
                "download_id": "first",
                "sequence": 2,
            },
        )
        repeated = self.client.post(
            f"/api/playback-sessions/{session['session_id']}/select",
            json={
                "expected_download_id": "second",
                "download_id": "first",
                "sequence": 2,
            },
        )
        self.assertEqual(selected.get_json(), repeated.get_json())
        self.assertEqual(selected.get_json()["queue_position"], 0)

        next_item = self.client.post(
            f"/api/playback-sessions/{session['session_id']}/advance",
            json={
                "expected_download_id": "first",
                "sequence": 3,
                "completed": True,
            },
        )
        self.assertEqual(next_item.get_json()["item"]["id"], "second")

        ended = self.client.post(
            f"/api/playback-sessions/{session['session_id']}/advance",
            json={
                "expected_download_id": "second",
                "sequence": 4,
                "completed": True,
            },
        )
        repeated_end = self.client.post(
            f"/api/playback-sessions/{session['session_id']}/advance",
            json={
                "expected_download_id": "second",
                "sequence": 4,
                "completed": True,
            },
        )
        self.assertEqual((ended.status_code, repeated_end.status_code), (204, 204))
        detail = self.client.get(f"/api/playlists/{playlist['id']}").get_json()
        self.assertTrue(detail["progress"]["completed"])

        completed = self.client.post("/api/playback-sessions", json={
            "mode": "playlist", "playlist_id": playlist["id"],
            "restart": False,
        })
        restarted = self.client.post("/api/playback-sessions", json={
            "mode": "playlist", "playlist_id": playlist["id"],
            "restart": True,
        })
        self.assertEqual(completed.status_code, 409)
        self.assertEqual(completed.get_json()["code"], "playlist_completed")
        self.assertEqual(restarted.get_json()["item"]["id"], "first")
        self.assertEqual(restarted.get_json()["resume_seconds"], 0)

    def test_playback_skips_missing_and_near_end_resume(self):
        self.video("missing", duration=100)
        second_path = self.finished_file("available", "available.mp4")
        vdl.db_update_download("available", duration_seconds=100)
        playlist = self.create_playlist(ids=["missing", "available"])
        os.remove(os.path.join(self.download_dir, "missing.mp4"))

        started = self.client.post("/api/playback-sessions", json={
            "mode": "playlist", "playlist_id": playlist["id"],
        }).get_json()
        self.assertEqual(started["item"]["id"], "available")
        self.assertTrue(started["queue"][0]["unavailable"])
        self.assertTrue(os.path.isfile(second_path))

        self.client.put(f"/api/playlists/{playlist['id']}/progress", json={
            "download_id": "available", "position_seconds": 96,
            "completed": False, "write_sequence": 1,
        })
        near_end = self.client.post("/api/playback-sessions", json={
            "mode": "playlist", "playlist_id": playlist["id"],
        })
        self.assertEqual(near_end.status_code, 409)
        self.assertEqual(near_end.get_json()["code"], "playlist_completed")


if __name__ == "__main__":
    unittest.main()

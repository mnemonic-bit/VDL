import os
import time
import unittest

import vdl
from tests.support.app_case import AppCase


class PlaybackSessionTest(AppCase):
    def create_session(self, **overrides):
        payload = {
            "filter": "",
            "ordering": "newest",
            "page_size": 2,
            "page": 0,
            "position": 0,
        }
        payload.update(overrides)
        return self.client.post("/api/playback-sessions", json=payload)

    def set_created_at(self, download_id, created_at):
        with vdl._db_lock, vdl.db() as connection:
            connection.execute(
                "UPDATE downloads SET created_at = ? WHERE id = ?",
                (created_at, download_id),
            )

    def test_create_advance_retry_page_boundary_and_wrap(self):
        for index, download_id in enumerate(("old", "middle", "new"), 1):
            self.finished_file(download_id, f"{download_id}.mp4")
            self.set_created_at(download_id, index)

        created = self.create_session(start_download_id="new")
        self.assertEqual(created.status_code, 201)
        initial = created.get_json()
        self.assertEqual(initial["sequence"], 0)
        self.assertEqual((initial["page"], initial["position"]), (0, 0))
        self.assertEqual(initial["item"], {
            "id": "new", "title": "new", "extension": "mp4",
        })

        session_id = initial["session_id"]
        with vdl._playback_sessions_lock:
            stored = vdl._playback_sessions[session_id]
            self.assertFalse(any(isinstance(value, list) for value in stored.values()))
            self.assertNotIn("filename", stored)

        first_request = {
            "expected_download_id": "new",
            "sequence": 1,
        }
        first = self.client.post(
            f"/api/playback-sessions/{session_id}/advance",
            json=first_request,
        )
        repeated = self.client.post(
            f"/api/playback-sessions/{session_id}/advance",
            json=first_request,
        )
        self.assertEqual(first.get_json(), repeated.get_json())
        self.assertEqual(first.get_json()["item"]["id"], "middle")
        self.assertEqual(
            (first.get_json()["page"], first.get_json()["position"]),
            (0, 1),
        )

        gap = self.client.post(
            f"/api/playback-sessions/{session_id}/advance",
            json={"expected_download_id": "middle", "sequence": 3},
        )
        mismatch = self.client.post(
            f"/api/playback-sessions/{session_id}/advance",
            json={"expected_download_id": "old", "sequence": 2},
        )
        self.assertEqual(gap.status_code, 409)
        self.assertEqual(mismatch.status_code, 409)

        second = self.client.post(
            f"/api/playback-sessions/{session_id}/advance",
            json={"expected_download_id": "middle", "sequence": 2},
        ).get_json()
        wrapped = self.client.post(
            f"/api/playback-sessions/{session_id}/advance",
            json={"expected_download_id": "old", "sequence": 3},
        ).get_json()
        self.assertEqual((second["item"]["id"], second["page"], second["position"]),
                         ("old", 1, 0))
        self.assertEqual((wrapped["item"]["id"], wrapped["page"], wrapped["position"]),
                         ("new", 0, 0))

    def test_filter_contract_and_tie_breaking_match_history(self):
        admin = vdl.db_get_user_by_username("admin")
        vdl.db_insert_download(
            "target", "https://fixture.invalid/target",
            admin["id"], admin["username"],
        )
        self.finished_file("target", "mountain.mp4")
        vdl.db_update_download(
            "target", title="Mountain Light", resolution="1080p"
        )
        vdl.db_add_download_tag("target", "Alpine Ridge")
        vdl.db_set_download_favorite("target", True)
        vdl.db_increment_view_count("target")
        vdl.db_increment_view_count("target")

        self.finished_file("other", "other.mp4")
        vdl.db_update_download("other", title="Mountain Light", resolution="360p")
        for download_id in ("target", "other"):
            self.set_created_at(download_id, 10)

        normalized = vdl._normalize_history_filter(
            '"Alpine Ridge" user:admin quality:720 star:yes views:2'
        )
        matches = vdl.resolve_library_selection(
            admin["id"],
            True,
            normalized,
            "newest",
        )
        self.assertEqual([entry["id"] for entry in matches], ["target"])

        unfiltered = vdl.resolve_library_selection(
            admin["id"], True, "", "newest"
        )
        self.assertEqual([entry["id"] for entry in unfiltered], ["target", "other"])

    def test_stale_private_missing_and_unsafe_start_items_are_rejected(self):
        self.finished_file("missing", "missing.mp4")
        os.remove(vdl.db_get_download("missing")["filename"])
        self.assertEqual(
            self.create_session(start_download_id="missing").status_code,
            409,
        )

        outside = os.path.join(self.temp_dir.name, "outside.mp4")
        with open(outside, "wb") as output:
            output.write(b"outside")
        self.insert("unsafe")
        vdl.db_update_download("unsafe", status="finished", filename=outside)
        self.assertEqual(
            self.create_session(start_download_id="unsafe").status_code,
            409,
        )

        alice = vdl.db_create_user("alice", "password-1", "normal")
        vdl.db_create_user("bob", "password-2", "normal")
        private_path = os.path.join(self.download_dir, "private.mp4")
        with open(private_path, "wb") as output:
            output.write(b"private")
        vdl.db_insert_download("private", "https://fixture.invalid/private",
                               alice["id"], "alice")
        vdl.db_update_download(
            "private", status="finished", filename=private_path,
            output_dir=self.download_dir,
        )
        vdl.db_set_download_visibility("private", "private")
        bob = self.authenticated_client("bob", "password-2")
        response = bob.post("/api/playback-sessions", json={
            "filter": "", "ordering": "newest", "page_size": 10,
            "page": 0, "position": 0, "start_download_id": "private",
        })
        self.assertEqual(response.status_code, 409)

    def test_live_file_removal_ends_session_without_looping(self):
        path = self.finished_file("only", "only.mp4")
        created = self.create_session(start_download_id="only").get_json()
        os.remove(path)

        advanced = self.client.post(
            f"/api/playback-sessions/{created['session_id']}/advance",
            json={"expected_download_id": "only", "sequence": 1},
        )
        self.assertEqual(advanced.status_code, 204)
        with vdl._playback_sessions_lock:
            self.assertNotIn(created["session_id"], vdl._playback_sessions)

    def test_keepalive_expiry_cap_release_and_logout_cleanup(self):
        self.finished_file("lease", "lease.mp4")
        session_ids = []
        for _index in range(vdl.PLAYBACK_SESSION_MAX_PER_USER + 1):
            response = self.create_session(start_download_id="lease")
            session_ids.append(response.get_json()["session_id"])
        with vdl._playback_sessions_lock:
            self.assertEqual(len(vdl._playback_sessions), 8)
            self.assertNotIn(session_ids[0], vdl._playback_sessions)
            vdl._playback_sessions[session_ids[-1]]["last_activity"] = (
                time.monotonic() - vdl.PLAYBACK_SESSION_TTL_SECONDS - 1
            )

        expired = self.client.post(
            f"/api/playback-sessions/{session_ids[-1]}/keepalive"
        )
        self.assertEqual(expired.status_code, 404)
        unknown = self.client.delete("/api/playback-sessions/not-a-session")
        self.assertEqual(unknown.status_code, 204)

        remaining_id = next(iter(vdl._playback_sessions))
        self.assertEqual(
            self.client.delete(f"/api/playback-sessions/{remaining_id}").status_code,
            204,
        )
        self.assertEqual(
            self.client.delete(f"/api/playback-sessions/{remaining_id}").status_code,
            204,
        )
        self.client.post("/logout")
        with vdl._playback_sessions_lock:
            self.assertEqual(vdl._playback_sessions, {})

    def test_another_user_cannot_control_a_session(self):
        self.finished_file("owned", "owned.mp4")
        created = self.create_session(start_download_id="owned").get_json()
        session_id = created["session_id"]

        vdl.db_create_user("bob", "password-2", "normal")
        bob = self.authenticated_client("bob", "password-2")
        advanced = bob.post(
            f"/api/playback-sessions/{session_id}/advance",
            json={"expected_download_id": "owned", "sequence": 1},
        )
        kept_alive = bob.post(
            f"/api/playback-sessions/{session_id}/keepalive"
        )
        deleted = bob.delete(f"/api/playback-sessions/{session_id}")

        self.assertEqual(advanced.status_code, 404)
        self.assertEqual(kept_alive.status_code, 404)
        self.assertEqual(deleted.status_code, 204)
        self.assertEqual(
            self.client.post(
                f"/api/playback-sessions/{session_id}/keepalive"
            ).status_code,
            204,
        )

    def test_validation_and_empty_selection(self):
        self.assertEqual(self.create_session().status_code, 204)
        invalid_cases = (
            {"ordering": "random"},
            {"page_size": True},
            {"page_size": 0},
            {"page": -1},
            {"position": 2},
            {"filter": "x" * 257},
        )
        for changes in invalid_cases:
            with self.subTest(changes=changes):
                self.assertEqual(
                    self.create_session(**changes).status_code,
                    400,
                )

    def test_suspending_or_removing_an_owner_releases_sessions(self):
        admin = vdl.db_get_user_by_username("admin")
        other_admin = vdl.db_create_user(
            "other-admin", "password-1", "admin"
        )
        self.finished_file("account-cleanup", "account-cleanup.mp4")
        first = self.create_session(
            start_download_id="account-cleanup"
        ).get_json()["session_id"]

        vdl.db_update_user(admin["id"], suspended=True)
        with vdl._playback_sessions_lock:
            self.assertNotIn(first, vdl._playback_sessions)

        other_client = self.authenticated_client("other-admin", "password-1")
        created = other_client.post("/api/playback-sessions", json={
            "filter": "", "ordering": "newest", "page_size": 10,
            "page": 0, "position": 0,
            "start_download_id": "account-cleanup",
        }).get_json()["session_id"]
        vdl.db_update_user(admin["id"], suspended=False)
        vdl.db_delete_user(other_admin["id"])
        with vdl._playback_sessions_lock:
            self.assertNotIn(created, vdl._playback_sessions)


if __name__ == "__main__":
    unittest.main()

import queue
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class SseTest(AppCase):
    def test_stream_headers_ready_and_change_event(self):
        response = self.client.get("/api/events", buffered=False)
        iterator = iter(response.response)
        self.assertEqual(next(iterator), b"event: ready\ndata: {}\n\n")
        vdl.event_bus.publish("change", {"reason": "test"})
        self.assertEqual(
            next(iterator),
            b'event: change\ndata: {"reason": "test"}\n\n',
        )
        self.assertEqual(response.headers["Content-Type"], "text/event-stream; charset=utf-8")
        self.assertEqual(response.headers["Cache-Control"], "no-cache, no-transform")
        self.assertEqual(response.headers["X-Accel-Buffering"], "no")
        response.close()
        self.assertEqual(len(vdl.event_bus._subs), 0)

    def private_entry_clients(self):
        owner = vdl.db_create_user('sseowner', 'owner-password', 'normal')
        vdl.db_create_user('sseviewer', 'viewer-password', 'normal')
        vdl.db_insert_download('sseprivate', 'https://fixture.invalid/private', owner['id'], owner['username'])
        return (self.authenticated_client('sseowner', 'owner-password'),
                self.authenticated_client('sseviewer', 'viewer-password'))

    def test_public_hint_queued_before_privatization_is_authorized_at_delivery(self):
        _owner, viewer = self.private_entry_clients()
        response = viewer.get('/api/events', buffered=False)
        self.addCleanup(response.close)
        iterator = iter(response.response)
        next(iterator)
        vdl.event_bus.publish('change', {'reason': 'update', 'id': 'sseprivate'})
        vdl.db_set_download_visibility('sseprivate', 'private')
        self.assertEqual(next(iterator), b'event: change\ndata: {"reason": "update"}\n\n')
        self.assertEqual(next(iterator), b'event: change\ndata: {"reason": "visibility"}\n\n')

    def test_private_worker_and_view_hints_expose_no_entry_identity(self):
        _owner, viewer = self.private_entry_clients()
        self.finished_file('sseprivate')
        vdl.db_set_download_visibility('sseprivate', 'private')
        response = viewer.get('/api/events', buffered=False)
        self.addCleanup(response.close)
        iterator = iter(response.response)
        next(iterator)
        vdl.db_update_download('sseprivate', progress='75%')
        self.assertEqual(next(iterator), b'event: change\ndata: {"reason": "update"}\n\n')
        vdl.db_increment_view_count('sseprivate')
        self.assertEqual(next(iterator), b'event: change\ndata: {"reason": "view"}\n\n')

    def test_authorized_owner_keeps_private_hint_identity(self):
        owner, _viewer = self.private_entry_clients()
        vdl.db_set_download_visibility('sseprivate', 'private')
        response = owner.get('/api/events', buffered=False)
        self.addCleanup(response.close)
        iterator = iter(response.response)
        next(iterator)
        vdl.db_update_download('sseprivate', progress='75%')
        self.assertEqual(next(iterator), b'event: change\ndata: {"reason": "update", "id": "sseprivate"}\n\n')

    def test_queued_private_hint_uses_current_administrator_role(self):
        self.private_entry_clients()
        vdl.db_set_download_visibility('sseprivate', 'private')
        response = self.client.get('/api/events', buffered=False)
        self.addCleanup(response.close)
        iterator = iter(response.response)
        next(iterator)
        vdl.event_bus.publish('change', {'reason': 'update', 'id': 'sseprivate'})
        with vdl._db_lock, vdl.db() as conn:
            conn.execute("DELETE FROM user_roles WHERE user_id=(SELECT id FROM users WHERE username='admin')")
        self.assertEqual(next(iterator), b'event: change\ndata: {"reason": "update"}\n\n')

    def test_queued_entry_hint_closes_stream_after_session_revocation(self):
        owner, _viewer = self.private_entry_clients()
        response = owner.get('/api/events', buffered=False)
        self.addCleanup(response.close)
        iterator = iter(response.response)
        next(iterator)
        vdl.event_bus.publish('change', {'reason': 'update', 'id': 'sseprivate'})
        with vdl._db_lock, vdl.db() as conn:
            conn.execute("UPDATE users SET session_version=session_version+1 WHERE username='sseowner'")
        with self.assertRaises(StopIteration):
            next(iterator)

    def test_idle_stream_emits_keepalive_comment(self):
        idle = mock.Mock()
        idle.get.side_effect = queue.Empty
        with mock.patch.object(vdl.event_bus, "subscribe", return_value=idle):
            response = self.client.get("/api/events", buffered=False)
            iterator = iter(response.response)
            self.assertEqual(next(iterator), b"event: ready\ndata: {}\n\n")
            self.assertEqual(next(iterator), b": keepalive\n\n")
            response.close()

    def test_overflow_drops_oldest_signal_and_retains_latest(self):
        bus = vdl.EventBus()
        subscriber = bus.subscribe()
        for index in range(65):
            bus.publish("change", {"index": index})
        retained = [subscriber.get_nowait()[1]["index"] for _ in range(64)]
        self.assertEqual(retained, list(range(1, 65)))

    def test_owner_targeted_events_do_not_reach_other_users(self):
        bus = vdl.EventBus()
        owner = bus.subscribe(10)
        other = bus.subscribe(20)
        legacy = bus.subscribe()
        bus.publish(
            "playlist-progress", {"playlist_id": "opaque"},
            owner_user_id=10,
        )
        self.assertEqual(owner.get_nowait()[0], "playlist-progress")
        with self.assertRaises(queue.Empty):
            other.get_nowait()
        with self.assertRaises(queue.Empty):
            legacy.get_nowait()
        bus.unsubscribe(owner)
        self.assertNotIn(owner, bus._subs)


if __name__ == "__main__":
    unittest.main()

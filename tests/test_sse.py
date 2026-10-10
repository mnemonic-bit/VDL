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

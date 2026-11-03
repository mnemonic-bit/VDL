"""Preview delivery identity and administrator maintenance contracts."""

import json
import os
import time
import unittest
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class PreviewMaintenanceApiTest(AppCase):
    def legacy_cache(self, download_id='legacy01', name='legacy.mp4', *, provenance=True):
        self.finished_file(download_id, name)
        entry = vdl.db_get_download(download_id)
        queue = vdl._get_asset_queue()
        legacy = vdl._preview_path(entry, version=vdl._PREVIEW_CACHE_VERSION - 1)
        with open(legacy, 'wb') as output:
            output.write(bytes(range(100)))
        with open(vdl._thumbnail_path(entry), 'wb') as output:
            output.write(b'cached thumbnail')
        if provenance:
            with vdl._db_lock, vdl.db() as connection:
                connection.execute(
                    'INSERT INTO generated_assets(download_id,kind,version,source,state) '
                    "VALUES (?,'montage',?,?,'ready')",
                    (download_id, vdl._PREVIEW_CACHE_VERSION - 1,
                     queue._identity(entry['filename'])),
                )
        queue.register(entry)
        return queue, entry, legacy

    def demand(self, download_id, revision=1, hovered=True):
        return self.client.post('/api/assets/demand', json={
            'tab_id': 'maintenance-test', 'revision': revision,
            'ids': [download_id], 'hovered_id': download_id if hovered else None,
        }).get_json()['assets'][download_id]

    def test_logs_and_status_require_an_administrator(self):
        vdl.db_create_user('maintenance-user', 'user-password', 'normal')
        normal = self.authenticated_client('maintenance-user', 'user-password')
        anonymous = vdl.app.test_client()
        for path in ('/api/system/logs', '/api/preview-maintenance'):
            with self.subTest(path=path):
                self.assertEqual(anonymous.get(path).status_code, 401)
                self.assertEqual(normal.get(path).status_code, 403)
                self.assertEqual(self.client.get(path).status_code, 200)
                self.assertEqual(self.client.post(path).status_code, 405)

    def test_log_reads_are_bounded_and_validate_filters(self):
        initial = self.client.get('/api/system/logs').get_json()
        self.assertEqual(initial['page_size'], 50)
        self.assertEqual(initial['items'], [])
        for query in ('page=0', 'page=oops', 'page_size=0', 'page_size=101',
                      'snapshot_id=-1', 'snapshot_id=oops', 'severity=debug',
                      'filter=' + 'x' * 501):
            with self.subTest(query=query):
                self.assertEqual(self.client.get('/api/system/logs?' + query).status_code, 400)
        self.assertEqual(self.client.get('/api/system/logs?page_size=100').status_code, 200)

    def test_filtering_precedes_pagination_and_snapshot_preserves_older_pages(self):
        with vdl._db_lock, vdl.db() as connection:
            connection.executemany(
                'INSERT INTO system_logs(timestamp,severity,event_type,component,lifecycle_state,'
                'message,data,counters) VALUES (?,?,?,?,?,?,?,?)',
                [('2026-11-03T10:00:00Z', 'warning' if index % 2 else 'info',
                  'progress', 'Preview cache', 'running',
                  f'Updating cached preview sequences: {index} updated, 200 left.', '{}', '{}')
                 for index in range(120)],
            )
        query = '/api/system/logs?filter=updating&severity=warning&page_size=10'
        first = self.client.get(query).get_json()
        self.assertEqual((first['total'], first['pages']), (60, 6))
        self.assertEqual(len(first['items']), 10)
        self.assertTrue(all(row['severity'] == 'warning' for row in first['items']))
        ids = [row['id'] for row in first['items']]
        self.assertEqual(ids, sorted(ids, reverse=True))
        snapshot = first['snapshot_id']
        older_query = query + f'&page=2&snapshot_id={snapshot}'
        older = self.client.get(older_query).get_json()
        with vdl._db_lock, vdl.db() as connection:
            connection.execute(
                'INSERT INTO system_logs(timestamp,severity,event_type,component,lifecycle_state,'
                'message,data,counters) VALUES (?,?,?,?,?,?,?,?)',
                ('2026-11-03T10:01:00Z', 'warning', 'progress', 'Preview cache', 'running',
                 'Updating cached preview sequences: 120 updated, 80 left.', '{}', '{}'),
            )
        refreshed = self.client.get(older_query).get_json()
        self.assertEqual(refreshed['items'], older['items'])
        self.assertEqual(refreshed['total'], 60)
        self.assertEqual(self.client.get(query).get_json()['total'], 61)

    def test_maintenance_hints_are_filtered_against_current_roles(self):
        vdl.db_create_user('hint-viewer', 'user-password', 'normal')
        normal = self.authenticated_client('hint-viewer', 'user-password')
        response = normal.get('/api/events', buffered=False)
        iterator = iter(response.response)
        self.assertIn(b'event: ready', next(iterator))
        try:
            vdl.event_bus.publish('maintenance', {'private_count': 47})
            vdl.event_bus.publish('change', {'reason': 'sentinel'})
            packet = next(iterator)
            self.assertIn(b'event: change', packet)
            self.assertNotIn(b'private_count', packet)
        finally:
            response.close()
        response = self.client.get('/api/events', buffered=False)
        iterator = iter(response.response)
        next(iterator)
        try:
            vdl.event_bus.publish('maintenance', {})
            self.assertIn(b'event: maintenance', next(iterator))
        finally:
            response.close()

    def test_legacy_delivery_is_nonblocking_consistent_and_pins_ranges(self):
        queue, entry, legacy = self.legacy_cache()
        with mock.patch.object(vdl, 'generate_video_preview') as generate:
            demand = self.demand(entry['id'], hovered=False)
            library = self.client.get('/api/library').get_json()[0]['assets']
            self.assertEqual(demand['montage'], 'queued')
            self.assertEqual(demand['montage_delivery'], library['montage_delivery'])
            selected = demand['montage_delivery']
            self.assertTrue(selected['available'])
            self.assertFalse(selected['current'])
            self.assertIn('asset=' + selected['identity'], selected['url'])
            self.assertNotIn(self.download_dir, json.dumps(selected))
            old = self.client.get(selected['url'], headers={'Range': 'bytes=10-19'})
            self.assertEqual(old.status_code, 206)
            self.assertEqual(old.data, bytes(range(10, 20)))
            etag = old.headers['ETag']
            old.close()
            cached = self.client.get(selected['url'], headers={'If-None-Match': etag})
            self.assertEqual(cached.status_code, 304)
            cached.close()
            self.assertTrue(os.path.isfile(legacy))
            generate.assert_not_called()
        self.assertEqual(vdl.db_get_download(entry['id'])['view_count'], 0)

    def test_published_replacement_does_not_change_an_existing_playback_identity(self):
        queue, entry, legacy = self.legacy_cache()
        selected = self.demand(entry['id'])['montage_delivery']
        response = self.client.get(selected['url'], headers={'Range': 'bytes=0-9'})
        old_etag = response.headers['ETag']
        response.close()

        def generate(_source, destination):
            with open(destination, 'wb') as output:
                output.write(b'new published sequence' * 10)
            return True

        with mock.patch.object(vdl, 'generate_video_preview', side_effect=generate) as encode:
            self.assertTrue(queue.step())
            self.assertEqual(encode.call_count, 1)
        latest = self.demand(entry['id'], revision=2)['montage_delivery']
        self.assertTrue(latest['current'])
        self.assertNotEqual(latest['identity'], selected['identity'])
        response = self.client.get(selected['url'], headers={'Range': 'bytes=20-29'})
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.data, bytes(range(20, 30)))
        self.assertEqual(response.headers['ETag'], old_etag)
        response.close()
        response = self.client.get(latest['url'], headers={'Range': 'bytes=0-9'})
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.data, b'new publis')
        self.assertNotEqual(response.headers['ETag'], old_etag)
        response.close()
        self.assertTrue(os.path.isfile(legacy))

    def test_unproven_old_sidecars_and_forged_tokens_are_not_playable(self):
        _queue, entry, legacy = self.legacy_cache(provenance=False)
        readiness = self.demand(entry['id'])
        self.assertFalse(readiness['montage_delivery']['available'])
        self.assertTrue(os.path.isfile(legacy))
        self.assertEqual(self.client.get('/api/preview/' + entry['id']).status_code, 202)
        for token in ('../legacy.mp4', 'f' * 32, '', '/etc/passwd'):
            with self.subTest(token=token):
                response = self.client.get('/api/preview/' + entry['id'], query_string={'asset': token})
                self.assertEqual(response.status_code, 404)

    def test_browser_incompatible_legacy_recipe_is_retained_but_not_selected(self):
        self.finished_file()
        entry = vdl.db_get_download('test0001')
        queue = vdl._get_asset_queue()
        path = vdl._preview_path(entry, version=2)
        with open(path, 'wb') as output:
            output.write(b'old incompatible encoding')
        with vdl._db_lock, vdl.db() as connection:
            connection.execute(
                'INSERT INTO generated_assets(download_id,kind,version,source,state) '
                "VALUES (?,'montage',2,?,'ready')",
                (entry['id'], queue._identity(entry['filename'])),
            )
        metadata = self.client.get('/api/library').get_json()[0]['assets']['montage_delivery']
        self.assertFalse(metadata['available'])
        readiness = self.demand(entry['id'])
        self.assertFalse(readiness['montage_delivery']['available'])
        self.assertEqual(self.client.get('/api/preview/' + entry['id']).status_code, 202)
        self.assertTrue(os.path.isfile(path))

    def test_reader_lease_requires_an_authorized_owned_delivery_identity(self):
        _queue, entry, _legacy = self.legacy_cache()
        selected = self.demand(entry['id'])['montage_delivery']
        route = '/api/preview/' + entry['id'] + '/lease'
        self.assertEqual(vdl.app.test_client().post(route, json={'asset': selected['identity']}).status_code, 401)
        for body in ({}, [], {'asset': 3}, {'asset': '/etc/passwd'}):
            self.assertEqual(self.client.post(route, json=body).status_code, 400)
        self.assertEqual(self.client.post(route, json={'asset': 'f' * 32}).status_code, 404)
        self.assertEqual(self.client.post(route, json={'asset': selected['identity']}).status_code, 204)
        self.assertEqual(self.client.post('/api/preview/missing1/lease',
                                         json={'asset': selected['identity']}).status_code, 404)
        with open(entry['filename'], 'ab') as output:
            output.write(b'changed source')
        self.assertEqual(self.client.post(route, json={'asset': selected['identity']}).status_code, 404)

    def test_exhausted_upgrade_keeps_fallback_and_sanitizes_persistent_failure_events(self):
        queue, entry, legacy = self.legacy_cache()
        now = [time.time()]
        queue.clock = lambda: now[0]
        private_detail = 'https://private.invalid/video?cookie=secret /private/absolute/file Cookie: password'
        with mock.patch.object(vdl, 'generate_video_preview', side_effect=OSError(private_detail)) as encode:
            for revision, elapsed in enumerate((0, 30, 300), start=1):
                now[0] += elapsed
                self.demand(entry['id'], revision=revision)
                self.assertTrue(queue.step())
            self.assertEqual(encode.call_count, 3)
            for revision in (4, 5):
                readiness = self.demand(entry['id'], revision=revision)
                self.assertEqual(readiness['montage'], 'failed')
                self.assertTrue(readiness['montage_delivery']['available'])
                self.assertFalse(queue.step())
            self.assertEqual(encode.call_count, 3)
        response = self.client.get(readiness['montage_delivery']['url'])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, bytes(range(100)))
        response.close()
        self.assertTrue(os.path.isfile(legacy))
        events = self.client.get('/api/system/logs').get_json()['items']
        self.assertTrue(any(row['severity'] == 'error' for row in events))
        serialized = json.dumps(events)
        for detail in ('private.invalid', 'secret', '/private/absolute', 'Cookie:'):
            self.assertNotIn(detail, serialized)

    def test_historical_url_rechecks_source_identity_and_visibility(self):
        owner = vdl.db_create_user('cache-owner', 'owner-password', 'normal')
        vdl.db_create_user('cache-viewer', 'viewer-password', 'normal')
        viewer = self.authenticated_client('cache-viewer', 'viewer-password')
        vdl.db_insert_download('legacy01', 'https://private.invalid/source', owner['id'], owner['username'])
        _queue, entry, _legacy = self.legacy_cache()
        url = self.demand(entry['id'])['montage_delivery']['url']
        response = viewer.get(url)
        self.assertEqual(response.status_code, 200)
        response.close()
        vdl.db_set_download_visibility(entry['id'], 'private')
        self.assertEqual(viewer.get(url).status_code, 404)
        with open(entry['filename'], 'ab') as output:
            output.write(b'changed source')
        self.assertEqual(self.client.get(url).status_code, 404)

    def test_clear_attempts_and_remove_media_preserve_historical_system_logs(self):
        _queue, entry, _legacy = self.legacy_cache()
        before = self.client.get('/api/system/logs').get_json()['items']
        self.assertTrue(before)
        self.assertEqual(self.client.post('/api/clear').status_code, 200)
        self.assertEqual(self.client.post('/api/remove/' + entry['id']).status_code, 200)
        after = self.client.get('/api/system/logs').get_json()['items']
        self.assertTrue({row['id'] for row in before}.issubset({row['id'] for row in after}))
        events = json.dumps(after)
        self.assertNotIn(self.download_dir, events)
        self.assertNotIn('private.invalid', events)


if __name__ == '__main__':
    unittest.main()

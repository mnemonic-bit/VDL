"""Installation preference transactions, receipts and controller recovery."""
import os
import secrets
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class PreferenceMutationProtocolTest(AppCase):
    def state(self, client=None):
        return (client or self.client).get('/api/preferences')

    def attempt(self, values=None, revision=None, created=None):
        return {
            'values': {'theme': 'dark'} if values is None else values,
            'expected_revision': self.state().json['preferences_revision'] if revision is None else revision,
            'client_mutation_id': f'{int((time.time() if created is None else created) * 1000)}-{secrets.token_hex(16)}',
        }

    def mutate(self, payload, client=None):
        return (client or self.client).post('/api/preferences', json=payload)

    def receipt(self, payload, client=None):
        return (client or self.client).get('/api/mutations/' + payload['client_mutation_id'])

    def test_capability_canonical_values_normalization_and_no_store(self):
        self.assertIn('preference.set', self.client.get('/api/client-capabilities').json['actions'])
        payload = self.attempt({'theme': 'dark', 'max_concurrent': '004', 'max_total_download_mbps': '0016.00',
                                'skip_video_edges': True, 'library_rotation_hours': '0024'})
        response = self.mutate(payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(response.json['id'], 'installation')
        self.assertEqual(set(response.json['values']), vdl.PREFERENCE_FIELDS)
        self.assertEqual(response.json['values']['max_concurrent'], '4')
        self.assertEqual(response.json['values']['max_total_download_mbps'], '16')
        self.assertEqual(response.json['values']['skip_video_edges'], 'true')
        self.assertEqual(response.json['mutation'], {
            'id': payload['client_mutation_id'], 'domain': 'preferences',
            'outcome': 'committed', 'revision': response.json['preferences_revision'],
        })
        current = self.state()
        self.assertEqual(current.json['values'], response.json['values'])
        self.assertEqual(current.json['theme'], 'dark')
        self.assertEqual(current.headers['Cache-Control'], 'no-store')
        self.assertEqual(self.receipt(payload).json, response.json)

    def test_all_legacy_helper_raw_writers_and_noops_advance_persistent_revision(self):
        start = int(self.state().json['preferences_revision'])
        self.client.post('/api/preferences', json={'theme': 'dark'})
        self.assertEqual(int(self.state().json['preferences_revision']), start + 1)
        vdl.db_set_preferences({'theme': 'dark'})
        self.assertEqual(int(self.state().json['preferences_revision']), start + 1)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute("UPDATE preferences SET value = 'light' WHERE key = 'theme'")
        vdl.init_db()
        self.assertEqual(int(self.state().json['preferences_revision']), start + 2)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute("INSERT INTO preferences(key, value) VALUES ('unknown_private', 'opaque')")
            conn.execute("DELETE FROM preferences WHERE key = 'unknown_private'")
        self.assertEqual(int(self.state().json['preferences_revision']), start + 4)
        response = self.mutate(self.attempt({'theme': 'light'}))
        self.assertEqual(int(response.json['preferences_revision']), start + 4)

    def test_existing_database_migration_seeds_revision_without_losing_settings(self):
        self.client.post('/api/preferences', json={'theme': 'dark'})
        with vdl._db_lock, vdl.db() as conn:
            for name in ('preference_insert_revision', 'preference_update_revision', 'preference_delete_revision'):
                conn.execute('DROP TRIGGER ' + name)
            conn.execute('DROP TABLE preference_state')
        vdl.init_db()
        state = self.state().json
        self.assertEqual((state['theme'], state['preferences_revision']), ('dark', '0'))
        self.assertEqual(self.mutate(self.attempt({'theme': 'light'})).json['preferences_revision'], '1')

    def test_unknown_table_fields_are_not_advertised_as_editable(self):
        with vdl._db_lock, vdl.db() as conn:
            conn.execute("INSERT INTO preferences(key, value) VALUES ('not_an_editable_setting', 'secret')")
        state = self.state().json
        self.assertNotIn('not_an_editable_setting', state)
        self.assertNotIn('not_an_editable_setting', state['values'])

    def test_conflict_does_not_replay_stale_form_and_receipt_retains_result(self):
        payload = self.attempt({'theme': 'dark', 'player_mode': 'tab'})
        self.client.post('/api/preferences', json={'theme': 'light'})
        conflict = self.mutate(payload)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json['mutation']['outcome'], 'conflicted')
        self.assertEqual(conflict.json['values']['theme'], 'light')
        self.client.post('/api/preferences', json={'theme': 'dark'})
        self.assertEqual(self.mutate(payload).json, conflict.json)
        self.assertEqual(self.receipt(payload).json, conflict.json)
        self.assertEqual(self.state().json['player_mode'], 'overlay')

    def test_lost_response_restart_and_replay_keep_old_receipt_but_latest_state(self):
        payload = self.attempt()
        committed = self.mutate(payload).json
        self.client.post('/api/preferences', json={'theme': 'light'})
        vdl.init_db()
        self.assertEqual(self.receipt(payload).json, committed)
        self.assertEqual(self.mutate(payload).json, committed)
        self.assertEqual(self.state().json['theme'], 'light')

    def test_simultaneous_replay_commits_once_and_competing_forms_conflict(self):
        payload = self.attempt()
        clients = [self.authenticated_client(), self.authenticated_client()]
        barrier = threading.Barrier(2)
        def send(index):
            barrier.wait()
            return self.mutate(payload, clients[index])
        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(send, range(2)))
        self.assertEqual([reply.status_code for reply in replies], [200, 200])
        self.assertEqual(replies[0].json, replies[1].json)
        payloads = [self.attempt({'theme': 'light'}), self.attempt({'theme': 'system'})]
        def compete(index):
            barrier.wait()
            return self.mutate(payloads[index], clients[index])
        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(compete, range(2)))
        self.assertEqual(sorted(reply.status_code for reply in replies), [200, 409])

    def test_fingerprint_binds_values_revision_and_shared_action_namespace(self):
        payload = self.attempt()
        self.mutate(payload)
        self.insert('preference_namespace')
        for response in (
                self.mutate(dict(payload, values={'theme': 'light'})),
                self.mutate(dict(payload, expected_revision='999')),
                self.client.post('/api/favorite/preference_namespace', json=dict(payload, favorite=True))):
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json['code'], 'mutation_id_conflict')
        other = self.attempt()
        self.client.post('/api/favorite/preference_namespace', json=dict(other, favorite=True, expected_revision='0'))
        self.assertEqual(self.mutate(other).json['code'], 'mutation_id_conflict')

    def test_receipt_insert_failure_rolls_back_settings_revision_rotation_and_outbox(self):
        original = vdl.db
        @contextmanager
        def failing_db():
            with original() as conn:
                class Connection:
                    def __getattr__(self, name):
                        return getattr(conn, name)
                    def execute(self, sql, *args):
                        if sql.startswith('INSERT INTO mutation_receipts'):
                            raise RuntimeError('injected receipt failure')
                        return conn.execute(sql, *args)
                yield Connection()
        before = self.state().json
        payload = self.attempt({'theme': 'dark', 'library_rotation_enabled': 'true'})
        with mock.patch.object(vdl, 'db', failing_db):
            with self.assertRaises(RuntimeError):
                self.mutate(payload)
        self.assertEqual(self.state().json, before)
        self.assertEqual(self.receipt(payload).status_code, 404)
        with vdl.db() as conn:
            self.assertIsNone(conn.execute('SELECT * FROM library_rotation').fetchone())
            self.assertEqual(conn.execute('SELECT runtime_pending FROM preference_state').fetchone()[0], 0)

    def test_controller_failure_recovers_current_durable_values_without_recreating_rotation(self):
        payload = self.attempt({'max_total_download_mbps': '8', 'library_rotation_enabled': 'true'})
        with mock.patch.object(vdl._bandwidth, 'configure', side_effect=RuntimeError('injected controller failure')):
            committed = self.mutate(payload)
        self.assertEqual(committed.status_code, 200)
        with vdl.db() as conn:
            rotation = dict(conn.execute('SELECT * FROM library_rotation').fetchone())
            self.assertEqual(conn.execute('SELECT runtime_pending FROM preference_state').fetchone()[0], 1)
        with mock.patch.object(vdl, '_new_rotation_members', side_effect=AssertionError('receipt regenerated deck')):
            self.assertEqual(self.receipt(payload).json, committed.json)
            self.assertEqual(self.mutate(payload).json, committed.json)
        with vdl.db() as conn:
            self.assertEqual(dict(conn.execute('SELECT * FROM library_rotation').fetchone()), rotation)
            self.assertEqual(conn.execute('SELECT runtime_pending FROM preference_state').fetchone()[0], 0)
        self.client.post('/api/preferences', json={'max_total_download_mbps': '4'})
        with mock.patch.object(vdl._bandwidth, 'configure') as configure:
            self.receipt(payload)
            configure.assert_not_called()

    def test_clean_restart_restores_bandwidth_and_durable_rotation_deadline(self):
        self.mutate(self.attempt({'max_total_download_mbps': '8', 'library_rotation_enabled': 'true'}))
        with vdl.db() as conn:
            rotation = dict(conn.execute('SELECT * FROM library_rotation').fetchone())
        with mock.patch.object(vdl._bandwidth, 'configure') as configure, \
                mock.patch.object(vdl, '_new_rotation_members', side_effect=AssertionError('restart regenerated deck')):
            vdl.init_db()
            configure.assert_called_once_with('8')
        with vdl.db() as conn:
            self.assertEqual(dict(conn.execute('SELECT * FROM library_rotation').fetchone()), rotation)

    def test_crash_after_directory_creation_is_safe_and_keeps_stored_playback_identity(self):
        self.insert('preferences_directory')
        filename = self.finished_file('preferences_directory')
        folder = os.path.join(self.temp_dir.name, 'next', 'nested')
        payload = self.attempt({'download_dir': '  ' + folder + '  '})
        original = vdl._write_preferences
        with mock.patch.object(vdl, '_write_preferences', side_effect=RuntimeError('crash before DB write')):
            with self.assertRaises(RuntimeError):
                self.mutate(payload)
        self.assertTrue(os.path.isdir(folder))
        self.assertNotEqual(self.state().json['download_dir'], folder)
        self.assertEqual(self.mutate(payload).json['values']['download_dir'], folder)
        with mock.patch.object(vdl, '_prepare_download_directory', side_effect=AssertionError('replay touched filesystem')):
            self.assertEqual(self.mutate(payload).status_code, 200)
        self.assertEqual(vdl.db_get_download('preferences_directory')['filename'], filename)

    def test_directory_rejections_hide_private_paths_and_do_not_change_values(self):
        before = self.state().json['values']
        with mock.patch.object(vdl, '_prepare_download_directory', side_effect=ValueError('/private/secret')):
            payload = self.attempt({'download_dir': '/private/secret', 'theme': 'dark'})
            response = self.mutate(payload)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json['mutation']['outcome'], 'rejected')
        self.assertIn('download_dir', response.json['field_errors'])
        self.assertNotIn('/private/secret', response.get_data(as_text=True))
        self.assertEqual(self.state().json['values'], before)
        self.assertEqual(self.receipt(payload).json, response.json)

    def test_validation_clock_revision_request_limits_and_field_errors(self):
        for values in ({'max_concurrent': 0}, {'max_total_download_mbps': 'bad'},
                       {'library_rotation_hours': 9999}, {'skip_video_edges': 'yes'},
                       {'start_fullscreen': 'yes'}, {'library_rotation_enabled': None},
                       {'shuffle_min_height': 999}, {'shuffle_min_duration_minutes': -1},
                       {'history_page_size': 12}, {'theme': []}, {}, ['dark']):
            with self.subTest(values=values):
                payload = self.attempt(values)
                response = self.mutate(payload)
                self.assertEqual(response.status_code, 400)
                self.assertTrue(response.json['field_errors'])
                self.assertEqual(self.receipt(payload).json, response.json)
        for revision in (False, 1, '-1', '01', '9' * 100):
            self.assertEqual(self.mutate(self.attempt(revision=revision)).status_code, 400)
        for created in (time.time() - 86401, time.time() + 301):
            self.assertEqual(self.mutate(self.attempt(created=created)).json['mutation']['outcome'], 'rejected')
        self.assertEqual(self.mutate(dict(self.attempt(), client_mutation_id='bad')).status_code, 400)
        self.assertEqual(self.mutate([]).status_code, 400)
        self.assertEqual(self.client.post('/api/preferences', data='x').status_code, 415)
        self.assertEqual(self.mutate(self.attempt({'format': 'x' * 33000})).status_code, 413)

    def test_shared_quota_retention_and_expired_absence_finality(self):
        payload = self.attempt()
        self.mutate(payload)
        for limit in ('MUTATION_ACTOR_MINUTE_LIMIT', 'MUTATION_ACTOR_RECEIPT_LIMIT'):
            with mock.patch.object(vdl, limit, 1):
                self.assertEqual(self.mutate(self.attempt({'theme': 'light'})).status_code, 429)
                self.assertEqual(self.mutate(payload).status_code, 200)
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE mutation_receipts SET recorded_at = ?', (time.time() - 172801,))
        self.mutate(self.attempt({'theme': 'light'}))
        self.assertEqual(self.receipt(payload).status_code, 404)
        expired = self.attempt(created=time.time() - 86401)
        self.assertTrue(self.receipt(expired).json['final'])

    def test_all_authenticated_users_share_scope_without_sharing_actor_receipts(self):
        vdl.db_create_user('preferenceviewer', 'viewer-password', 'normal')
        viewer = self.authenticated_client('preferenceviewer', 'viewer-password')
        payload = self.attempt()
        self.assertEqual(self.mutate(payload, viewer).status_code, 200)
        self.assertEqual(self.state().json['theme'], 'dark')
        self.assertEqual(self.receipt(payload).status_code, 404)
        self.assertEqual(self.receipt(payload, viewer).status_code, 200)
        self.assertEqual(self.mutate(self.attempt({'theme': 'light'}, revision='0')).status_code, 409)

    def test_live_session_changes_fence_write_read_and_receipt(self):
        user = vdl.db_create_user('preferenceviewer', 'viewer-password', 'normal')
        client = self.authenticated_client('preferenceviewer', 'viewer-password')
        payload = self.attempt()
        self.mutate(payload, client)
        original = vdl._tag_actor
        def expire(conn):
            conn.execute('UPDATE users SET session_version = session_version + 1 WHERE id = ?', (user['id'],))
            return original(conn)
        with mock.patch.object(vdl, '_tag_actor', side_effect=expire):
            self.assertEqual(self.receipt(payload, client).status_code, 401)
        client = self.authenticated_client('preferenceviewer', 'viewer-password')
        with mock.patch.object(vdl, '_tag_actor', side_effect=expire):
            self.assertEqual(self.mutate(self.attempt({'theme': 'light'}), client).status_code, 401)
        client = self.authenticated_client('preferenceviewer', 'viewer-password')
        with mock.patch.object(vdl, '_tag_actor', side_effect=expire):
            self.assertEqual(self.state(client).status_code, 401)
        self.assertEqual(self.state().json['theme'], 'dark')

    def test_legacy_write_also_rechecks_current_session_in_transaction(self):
        original = vdl._tag_actor
        def expire(conn):
            conn.execute("UPDATE users SET session_version = session_version + 1 WHERE username = 'admin'")
            return original(conn)
        with mock.patch.object(vdl, '_tag_actor', side_effect=expire):
            self.assertEqual(self.client.post('/api/preferences', json={'theme': 'dark'}).status_code, 401)
        self.assertEqual(vdl.db_get_preferences()['theme'], 'system')

    def test_cross_origin_and_sse_payload_keep_private_settings_on_authorized_responses(self):
        self.assertEqual(self.client.post('/api/preferences', json=self.attempt(),
                                         headers={'Origin': 'https://attacker.invalid'}).status_code, 403)
        subscription = vdl.event_bus.subscribe()
        payload = self.attempt()
        self.mutate(payload)
        self.assertEqual(subscription.get_nowait(), ('change', {'reason': 'preferences'}))
        self.assertTrue(subscription.empty())
        with mock.patch.object(vdl.event_bus, 'publish', side_effect=RuntimeError('publish failed')):
            response = self.mutate(self.attempt({'theme': 'light'}))
        self.assertEqual(response.status_code, 200)

    def test_reloader_parent_restores_bandwidth_without_owning_a_rotation_timer(self):
        self.mutate(self.attempt({'max_total_download_mbps': '8', 'library_rotation_enabled': 'true'}))
        vdl._cancel_rotation_timer()
        with mock.patch.object(vdl, '__name__', '__main__'), \
                mock.patch.dict(os.environ, {'FLASK_DEBUG': '1', 'WERKZEUG_RUN_MAIN': 'false'}), \
                mock.patch.object(vdl, '_schedule_rotation_timer') as schedule, \
                mock.patch.object(vdl._bandwidth, 'configure') as configure:
            vdl.init_db()
        schedule.assert_not_called()
        configure.assert_called_once_with('8')

    def test_preflight_rechecks_current_session_and_raw_remote_revision(self):
        original = vdl._prepare_preference_directory
        for security_change in (True, False):
            with self.subTest(security_change=security_change):
                client = self.authenticated_client()
                payload = self.attempt({'theme': 'dark', 'download_dir': self.download_dir})
                def change(updates):
                    original(updates)
                    with vdl._db_lock, vdl.db() as conn:
                        if security_change:
                            conn.execute("UPDATE users SET session_version = session_version + 1 WHERE username = 'admin'")
                        else:
                            conn.execute("UPDATE preferences SET value = 'light' WHERE key = 'theme'")
                with mock.patch.object(vdl, '_prepare_preference_directory', side_effect=change):
                    response = self.mutate(payload, client)
                self.assertEqual(response.status_code, 401 if security_change else 409)
                self.assertNotEqual(vdl.db_get_preferences()['theme'], 'dark')
                self.client = self.authenticated_client()

    def test_preflight_rechecks_expiry_shared_receipt_namespace_and_quotas(self):
        self.insert('preflight_metadata')
        other = self.authenticated_client()
        original = vdl._prepare_preference_directory
        for race in ('expiry', 'namespace', 'quota'):
            with self.subTest(race=race):
                clock = [time.time()]
                payload = self.attempt({'theme': 'dark'}, created=clock[0] - vdl.MUTATION_REPLAY_SECONDS + 1)
                def change(updates):
                    original(updates)
                    if race == 'expiry':
                        clock[0] += 2
                    else:
                        favorite = {
                            'favorite': True, 'expected_revision': '0',
                            'client_mutation_id': payload['client_mutation_id'] if race == 'namespace' else self.attempt()['client_mutation_id'],
                        }
                        self.assertEqual(other.post('/api/favorite/preflight_metadata', json=favorite).status_code, 200)
                with mock.patch.object(vdl.time, 'time', side_effect=lambda: clock[0]), \
                        mock.patch.object(vdl, '_prepare_preference_directory', side_effect=change):
                    if race == 'quota':
                        with vdl.db() as conn:
                            count = conn.execute('SELECT COUNT(*) FROM mutation_receipts').fetchone()[0]
                        with mock.patch.object(vdl, 'MUTATION_ACTOR_MINUTE_LIMIT', count + 1):
                            response = self.mutate(payload)
                    else:
                        response = self.mutate(payload)
                self.assertEqual(response.status_code, {'expiry': 400, 'namespace': 409, 'quota': 429}[race])
                self.assertNotEqual(self.state().json['theme'], 'dark')
                if race != 'expiry':
                    # Keep the next side-effect's favorite precondition simple.
                    with vdl._db_lock, vdl.db() as conn:
                        conn.execute("UPDATE downloads SET favorite = 0, favorite_revision = 0 WHERE id = 'preflight_metadata'")
                        conn.execute("UPDATE downloads SET favorite_revision = 0 WHERE id = 'preflight_metadata'")

    def test_filesystem_scan_does_not_hold_database_write_serialization(self):
        self.insert('during_preference_scan')
        entered = threading.Event()
        release = threading.Event()
        client = self.authenticated_client()
        payload = self.attempt({'library_rotation_enabled': 'true'})
        def scan():
            entered.set()
            if not release.wait(5):
                raise AssertionError('preflight scan gate was not released')
            return []
        with mock.patch.object(vdl, '_new_rotation_members', side_effect=scan):
            with ThreadPoolExecutor(max_workers=2) as pool:
                save = pool.submit(self.mutate, payload, client)
                self.assertTrue(entered.wait(5))
                write = pool.submit(vdl.db_update_download, 'during_preference_scan', title='Unrelated work')
                try:
                    write.result(2)
                finally:
                    release.set()
                self.assertEqual(save.result(5).status_code, 200)
        self.assertEqual(vdl.db_get_download('during_preference_scan')['title'], 'Unrelated work')

    def test_runtime_failure_after_timer_effect_reuses_deck_and_deadline(self):
        original = vdl._schedule_rotation_timer
        def fail_after_schedule(deadline):
            original(deadline)
            raise RuntimeError('injected after timer scheduling')
        payload = self.attempt({'max_total_download_mbps': '8', 'library_rotation_enabled': 'true'})
        with mock.patch.object(vdl, '_schedule_rotation_timer', side_effect=fail_after_schedule):
            response = self.mutate(payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(vdl._bandwidth.rate, 8 * 125000)
        with vdl.db() as conn:
            rotation = dict(conn.execute('SELECT * FROM library_rotation').fetchone())
            self.assertEqual(conn.execute('SELECT runtime_pending FROM preference_state').fetchone()[0], 1)
        timer = vdl._rotation_timer
        self.receipt(payload)
        self.assertIs(vdl._rotation_timer, timer)
        with vdl.db() as conn:
            self.assertEqual(dict(conn.execute('SELECT * FROM library_rotation').fetchone()), rotation)
            self.assertEqual(conn.execute('SELECT runtime_pending FROM preference_state').fetchone()[0], 0)

    def test_runtime_failure_after_worker_ownership_never_starts_the_same_job_twice(self):
        ready = threading.Event()
        with vdl._worker_condition:
            vdl._worker_queue.append({'id': 'already_accepted', 'host': 'fixture.invalid', 'ready': ready})
        original = vdl._dispatch_worker_queue
        def fail_after_dispatch():
            original()
            raise RuntimeError('injected after dispatch')
        payload = self.attempt({'max_concurrent': '4'})
        with mock.patch.object(vdl, '_dispatch_worker_queue', side_effect=fail_after_dispatch):
            response = self.mutate(payload)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(ready.is_set())
        self.assertEqual(vdl._active_worker_count, 1)
        self.assertEqual(vdl._worker_hosts, {'already_accepted': 'fixture.invalid'})
        self.assertEqual(self.receipt(payload).json, response.json)
        self.assertEqual(self.mutate(payload).json, response.json)
        self.assertEqual(vdl._active_worker_count, 1)
        self.assertEqual(vdl._worker_queue, [])
        self.assertEqual(vdl._worker_hosts, {'already_accepted': 'fixture.invalid'})

    def test_private_download_named_like_scope_still_requires_download_authorization(self):
        self.insert('installation')
        vdl.db_create_user('preferenceviewer', 'viewer-password', 'normal')
        viewer = self.authenticated_client('preferenceviewer', 'viewer-password')
        payload = self.attempt()
        result = viewer.post('/api/favorite/installation', json=dict(payload, favorite=True, expected_revision='0'))
        self.assertEqual(result.status_code, 200)
        vdl.db_set_download_visibility('installation', 'private')
        self.assertEqual(self.receipt(payload, viewer).status_code, 404)

    def test_canonical_values_and_revision_are_one_read_snapshot(self):
        original = vdl.db
        changed = False
        @contextmanager
        def interleaved_db():
            with original() as conn:
                class Connection:
                    def execute(self, sql, *args):
                        nonlocal changed
                        result = conn.execute(sql, *args)
                        if sql == 'SELECT key, value FROM preferences' and not changed:
                            changed = True
                            with original() as writer:
                                writer.execute("UPDATE preferences SET value = 'dark' WHERE key = 'theme'")
                        return result
                yield Connection()
        before = self.state().json
        with mock.patch.object(vdl, 'db', interleaved_db):
            captured = self.state().json
        self.assertEqual(captured, before)
        self.assertEqual(int(self.state().json['preferences_revision']), int(before['preferences_revision']) + 1)
        self.assertEqual(self.state().json['theme'], 'dark')


if __name__ == '__main__':
    unittest.main()

"""Durable command acceptance, generation fencing and real route recovery."""
import json
import os
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class DownloadCommandTest(AppCase):
    def command(self, target, **changes):
        row = vdl.db_get_download(target)
        payload = dict(client_mutation_id=f'{int(time.time() * 1000)}-{secrets.token_hex(16)}',
                       expected_revision=row['command_revision'], expected_attempt_id=row['current_attempt_id'])
        payload.update(changes)
        return payload

    def send(self, action, target, payload, client=None):
        return (client or self.client).post('/api/' + action + '/' + target, json=payload)

    def receipt(self, payload, client=None):
        return (client or self.client).get('/api/mutations/' + payload['client_mutation_id'])

    def terminal(self, target='work', status='cancelled'):
        self.insert(target)
        vdl.db_update_download(target, status=status)
        return target

    def test_acceptance_is_correlated_and_never_fabricates_worker_pause(self):
        self.insert('work')
        payload = self.command('work')
        response = self.send('pause', 'work', payload)
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        result = response.json
        self.assertEqual(result['id'], 'work')
        self.assertEqual(result['mutation'], dict(id=payload['client_mutation_id'], domain='download-command',
                                                 revision=result['command_revision'], outcome='accepted'))
        self.assertEqual(int(result['command_revision']), int(payload['expected_revision']) + 1)
        self.assertEqual(result['current_attempt_id'], payload['expected_attempt_id'])
        self.assertEqual(result['command']['source_attempt_id'], payload['expected_attempt_id'])
        self.assertEqual(result['command']['attempt_id'], payload['expected_attempt_id'])
        self.assertIsNone(result['command']['job_id'])
        self.assertEqual(vdl.db_get_download('work')['status'], 'starting')
        self.assertTrue(vdl.is_pause_requested('work'))
        checked = self.receipt(payload).json
        self.assertEqual(checked['command']['id'], result['command']['id'])
        self.assertEqual(checked['command']['status'], 'dispatched')
        self.assertIn('download.pause', self.client.get('/api/client-capabilities').json['actions'])

    def test_resume_and_retry_each_create_one_durable_job_and_attempt(self):
        for action in ('resume', 'retry'):
            target = self.terminal(action)
            payload = self.command(target)
            with mock.patch.object(vdl, 'enqueue_download') as enqueue:
                first = self.send(action, target, payload)
                replay = self.send(action, target, payload)
                self.assertEqual(first.status_code, 202)
                self.assertEqual(replay.json['command']['id'], first.json['command']['id'])
                self.assertEqual(first.json['command']['job_id'], first.json['command']['id'])
                self.assertNotEqual(first.json['command']['attempt_id'], payload['expected_attempt_id'])
                enqueue.assert_called_once_with('https://fixture.invalid/video', target)
            with vdl.db() as conn:
                self.assertEqual(conn.execute('SELECT COUNT(*) FROM download_attempts WHERE work_id = ?', (target,)).fetchone()[0], 2)
            checked = self.receipt(payload).json
            self.assertEqual(checked['command']['attempt_id'], first.json['command']['attempt_id'])
            self.assertEqual(vdl.db_get_download(target)['status'], 'starting')

    def test_simultaneous_replay_dispatches_exactly_once(self):
        target = self.terminal()
        payload = self.command(target)
        clients = [self.authenticated_client(), self.authenticated_client()]
        barrier = threading.Barrier(2)
        def submit(index):
            barrier.wait()
            return self.send('resume', target, payload, clients[index])
        with mock.patch.object(vdl, 'enqueue_download') as enqueue, ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(submit, range(2)))
        self.assertEqual([response.status_code for response in responses], [202, 202])
        self.assertEqual(responses[0].json['command']['id'], responses[1].json['command']['id'])
        enqueue.assert_called_once()

    def test_competing_commands_and_old_history_generation_cannot_start_work(self):
        target = self.terminal()
        old = self.command(target)
        competing = self.command(target)
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            self.assertEqual(self.send('resume', target, old).status_code, 202)
            response = self.send('retry', target, competing)
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json['mutation']['outcome'], 'conflicted')
            vdl.db_update_download(target, status='cancelled')
            stale = self.command(target, expected_attempt_id=old['expected_attempt_id'])
            self.assertEqual(self.send('resume', target, stale).status_code, 409)
            enqueue.assert_called_once()

    def test_acceptance_and_attempt_rollback_if_receipt_cannot_commit(self):
        target = self.terminal()
        payload = self.command(target)
        with vdl.db() as conn:
            conn.execute("CREATE TRIGGER fail_command_receipt BEFORE INSERT ON mutation_receipts BEGIN SELECT RAISE(ABORT, 'injected'); END")
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            with self.assertRaises(vdl.sqlite3.IntegrityError):
                self.send('resume', target, payload)
            enqueue.assert_not_called()
        self.assertEqual(vdl.db_get_download(target)['status'], 'cancelled')
        self.assertEqual(vdl.db_get_download(target)['current_attempt_id'], payload['expected_attempt_id'])
        with vdl.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM download_commands').fetchone()[0], 0)

    def test_crash_before_dispatch_recovers_truthful_interruption_without_effects(self):
        target = self.terminal()
        payload = self.command(target)
        with mock.patch.object(vdl, '_dispatch_download_command'):
            first = self.send('resume', target, payload).json
        vdl.init_db()
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            replay = self.send('resume', target, payload)
            enqueue.assert_not_called()
        self.assertEqual(replay.status_code, 202)
        self.assertEqual(replay.json['command']['id'], first['command']['id'])
        self.assertEqual(replay.json['command']['status'], 'interrupted')
        self.assertEqual(vdl.db_get_download(target)['status'], 'interrupted')
        self.assertEqual(self.receipt(payload).json['command']['status'], 'interrupted')

    def test_crash_after_dispatch_and_lost_response_never_dispatch_twice(self):
        class Crash(BaseException):
            pass
        target = self.terminal()
        payload = self.command(target)
        dispatch = vdl._dispatch_download_command
        def lose_response(command_id):
            dispatch(command_id)
            raise Crash()
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            with mock.patch.object(vdl, '_dispatch_download_command', side_effect=lose_response):
                with self.assertRaises(Crash):
                    self.send('resume', target, payload)
            self.assertEqual(self.send('resume', target, payload).status_code, 202)
            enqueue.assert_called_once()
        vdl.init_db()
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            self.assertEqual(self.send('resume', target, payload).json['command']['status'], 'interrupted')
            enqueue.assert_not_called()

    def test_retry_cleanup_failure_is_accepted_worker_error_and_replay_does_not_clean_again(self):
        path = self.finished_file('work')
        payload = self.command('work')
        with mock.patch.object(vdl, 'delete_download_artifacts', side_effect=OSError('secret/path')) as cleanup, mock.patch.object(vdl, 'enqueue_download') as enqueue:
            response = self.send('retry', 'work', payload)
            self.assertEqual(response.status_code, 202)
            self.assertEqual(self.send('retry', 'work', payload).status_code, 202)
            cleanup.assert_called_once()
            enqueue.assert_not_called()
        self.assertTrue(os.path.isfile(path))
        self.assertEqual(vdl.db_get_download('work')['status'], 'error')
        self.assertEqual(self.receipt(payload).json['command']['status'], 'error')
        self.assertNotIn('secret/path', str(response.json))

    def test_crash_during_retry_cleanup_never_deletes_replacement_file(self):
        class Crash(BaseException):
            pass
        path = self.finished_file('work')
        payload = self.command('work')
        def crash_cleanup(*_args):
            os.unlink(path)
            raise Crash()
        with mock.patch.object(vdl, 'delete_download_artifacts', side_effect=crash_cleanup):
            with self.assertRaises(Crash):
                self.send('retry', 'work', payload)
        with open(path, 'wb') as replacement:
            replacement.write(b'replacement')
        vdl.init_db()
        with mock.patch.object(vdl, 'delete_download_artifacts') as cleanup, mock.patch.object(vdl, 'enqueue_download') as enqueue:
            self.assertEqual(self.send('retry', 'work', payload).json['command']['status'], 'interrupted')
            cleanup.assert_not_called()
            enqueue.assert_not_called()
        with open(path, 'rb') as replacement:
            self.assertEqual(replacement.read(), b'replacement')

    def test_pause_stop_and_late_pause_preserve_cancellation_priority(self):
        self.insert('work')
        pause = self.command('work')
        self.assertEqual(self.send('pause', 'work', pause).status_code, 202)
        vdl._live_worker_ids.add('work')
        try:
            stop = self.command('work')
            self.assertEqual(self.send('stop', 'work', stop).status_code, 202)
            self.assertFalse(vdl.is_pause_requested('work'))
            self.assertTrue(vdl.is_cancel_requested('work'))
            self.assertEqual(self.send('pause', 'work', self.command('work')).status_code, 409)
            self.assertEqual(self.client.post('/api/pause/work').status_code, 409)
            self.send('pause', 'work', pause)
            self.assertFalse(vdl.is_pause_requested('work'))
        finally:
            vdl._live_worker_ids.discard('work')

    def test_unpause_only_accepts_paused_generation_and_keeps_status(self):
        self.insert('work')
        self.assertEqual(self.send('unpause', 'work', self.command('work')).status_code, 409)
        vdl.db_update_download('work', status='paused')
        vdl.request_pause('work')
        response = self.send('unpause', 'work', self.command('work'))
        self.assertEqual(response.status_code, 202)
        self.assertFalse(vdl.is_pause_requested('work'))
        self.assertEqual(vdl.db_get_download('work')['status'], 'paused')

    def test_fingerprint_namespace_expiry_validation_and_quotas(self):
        target = self.terminal()
        payload = self.command(target)
        with mock.patch.object(vdl, 'enqueue_download'):
            self.send('resume', target, payload)
        self.assertEqual(self.send('retry', target, payload).json['code'], 'mutation_id_conflict')
        self.assertEqual(self.send('resume', target, dict(payload, extra=True)).json['code'], 'mutation_id_conflict')
        self.assertEqual(self.client.post('/api/favorite/' + target, json=dict(client_mutation_id=payload['client_mutation_id'], expected_revision='0', favorite=True)).json['code'], 'mutation_id_conflict')
        bad = self.command(target, client_mutation_id='invalid')
        self.assertEqual(self.send('stop', target, bad).status_code, 400)
        for fields in ({'expected_revision': 1}, {'expected_attempt_id': 1}, {'extra': True},
                       {'client_mutation_id': f'{int((time.time()-90000)*1000)}-{secrets.token_hex(16)}'}):
            response = self.send('stop', target, self.command(target, **fields))
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json['mutation']['outcome'], 'rejected')
        with mock.patch.object(vdl, 'MUTATION_ACTOR_RECEIPT_LIMIT', 0):
            self.assertEqual(self.send('stop', target, self.command(target)).status_code, 429)

    def test_receipts_require_current_target_and_account_authorization(self):
        alice = vdl.db_create_user('alice', 'alice-password', 'normal')
        bob = vdl.db_create_user('bob', 'bob-password', 'normal')
        vdl.db_insert_download('work', 'https://fixture.invalid/video', alice['id'], 'alice')
        client = self.authenticated_client('alice', 'alice-password')
        other = self.authenticated_client('bob', 'bob-password')
        payload = self.command('work')
        self.assertEqual(self.send('pause', 'work', payload, client).status_code, 202)
        self.assertEqual(self.receipt(payload, other).status_code, 404)
        with vdl.db() as conn:
            conn.execute("UPDATE downloads SET visibility='private', owner_user_id=? WHERE id='work'", (bob['id'],))
        self.assertEqual(self.receipt(payload, client).status_code, 404)
        self.assertEqual(self.send('pause', 'work', payload, client).status_code, 404)
        with vdl.db() as conn:
            conn.execute('UPDATE users SET suspended=1 WHERE id=?', (alice['id'],))
        self.assertEqual(self.receipt(payload, client).status_code, 401)

    def test_authorization_rechecked_after_acceptance_before_dispatch(self):
        target = self.terminal()
        payload = self.command(target)
        original = vdl._dispatch_download_command
        def revoke(command_id):
            with vdl.db() as conn:
                conn.execute("UPDATE users SET session_version=session_version+1 WHERE username='admin'")
            original(command_id)
        with mock.patch.object(vdl, '_dispatch_download_command', side_effect=revoke), mock.patch.object(vdl, 'enqueue_download') as enqueue:
            self.assertEqual(self.send('resume', target, payload).status_code, 202)
            enqueue.assert_not_called()
        self.assertEqual(vdl.db_get_download(target)['status'], 'interrupted')

    def test_shared_cleanup_retains_active_acceptance_beyond_receipt_retention(self):
        target = self.terminal()
        payload = self.command(target)
        with mock.patch.object(vdl, 'enqueue_download'):
            result = self.send('resume', target, payload).json
        with vdl.db() as conn:
            conn.execute('UPDATE mutation_receipts SET recorded_at=0')
            conn.execute('UPDATE download_commands SET recorded_at=0')
        self.client.post('/api/favorite/' + target, json=dict(favorite=True, expected_revision='0', client_mutation_id=self.command(target)['client_mutation_id']))
        self.assertEqual(self.receipt(payload).status_code, 202)
        self.assertEqual(self.receipt(payload).json['command']['job_id'], result['command']['id'])
        vdl.db_update_download(target, status='finished')
        with vdl._db_lock, vdl.db() as conn:
            vdl._prune_mutation_receipts(conn, time.time())
        self.assertEqual(self.receipt(payload).status_code, 404)

    def test_cleared_history_changes_revision_and_null_generation_can_start_new_work(self):
        target = self.terminal()
        old = self.command(target)
        self.client.post('/api/clear')
        current = self.command(target)
        self.assertIsNone(current['expected_attempt_id'])
        self.assertGreater(int(current['expected_revision']), int(old['expected_revision']))
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            self.assertEqual(self.send('resume', target, old).status_code, 409)
            result = self.send('resume', target, current)
            self.assertEqual(result.status_code, 202)
            self.assertIsNotNone(result.json['current_attempt_id'])
            enqueue.assert_called_once()

    def test_legacy_and_protocol_writes_share_revision_and_pending_dispatch_guard(self):
        target = self.terminal()
        payload = self.command(target)
        with mock.patch.object(vdl, '_dispatch_download_command'):
            self.assertEqual(self.send('resume', target, payload).status_code, 202)
        self.assertEqual(self.client.post('/api/stop/' + target).status_code, 409)
        vdl.init_db()
        with mock.patch.object(vdl, 'enqueue_download'):
            self.assertEqual(self.client.post('/api/resume/' + target).status_code, 200)
        self.assertGreater(int(vdl.db_get_download(target)['command_revision']), int(payload['expected_revision']))

    def test_current_editable_and_history_snapshots_expose_same_generation(self):
        target = self.terminal()
        row = vdl.db_get_download(target)
        for result in (self.client.get('/api/current-downloads').json[0],
                       self.client.get('/api/downloads/' + target + '/editable-state').json,
                       self.client.get('/api/history').json['items'][0]):
            self.assertEqual(result['command_revision'], row['command_revision'])
            self.assertEqual(result['current_attempt_id'], row['current_attempt_id'])

    def test_missing_expired_receipt_is_final_but_missing_fresh_receipt_is_unknown(self):
        missing = self.command(self.terminal())
        self.assertFalse(self.receipt(missing).json['final'])
        missing['client_mutation_id'] = f'{int((time.time()-90000)*1000)}-{secrets.token_hex(16)}'
        self.assertTrue(self.receipt(missing).json['final'])

    def test_expired_lookup_waits_behind_an_already_admitted_acceptance(self):
        target = self.terminal()
        payload = self.command(target)
        admission, release, lookup_started = threading.Event(), threading.Event(), threading.Event()
        clock = [time.time()]
        clients = [self.authenticated_client(), self.authenticated_client()]
        record = vdl.download_history.record
        def hold(conn, download_id, **kwargs):
            result = record(conn, download_id, **kwargs)
            if kwargs.get('new'):
                admission.set()
                self.assertTrue(release.wait(5))
            return result
        def lookup():
            lookup_started.set()
            return self.receipt(payload, clients[1])
        with mock.patch.object(vdl.download_history, 'record', side_effect=hold), mock.patch.object(vdl.time, 'time', side_effect=lambda: clock[0]), mock.patch.object(vdl, 'enqueue_download'), ThreadPoolExecutor(max_workers=2) as pool:
            accepted = pool.submit(self.send, 'resume', target, payload, clients[0])
            self.assertTrue(admission.wait(5))
            clock[0] += vdl.MUTATION_REPLAY_SECONDS + 1
            checked = pool.submit(lookup)
            self.assertTrue(lookup_started.wait(5))
            release.set()
            first, recovery = accepted.result(5), checked.result(5)
        self.assertEqual(first.status_code, 202)
        self.assertEqual(recovery.status_code, 202)
        self.assertEqual(recovery.json['command']['job_id'], first.json['command']['job_id'])

    def test_worker_failure_after_acceptance_is_reported_by_the_same_job(self):
        from tests.support.fake_ytdlp import FakeYoutubeDL
        self.insert('work', 'https://fixture.invalid/missing')
        vdl.db_update_download('work', status='cancelled')
        payload = self.command('work')
        FakeYoutubeDL.reset()
        with mock.patch.object(vdl.yt_dlp, 'YoutubeDL', FakeYoutubeDL):
            accepted = self.send('resume', 'work', payload)
            self.assertEqual(accepted.status_code, 202)
            self.wait_worker_stopped('work')
        checked = self.receipt(payload)
        self.assertEqual(checked.json['command']['job_id'], accepted.json['command']['job_id'])
        self.assertEqual(checked.json['command']['status'], 'error')
        self.assertEqual(vdl.db_get_download('work')['status'], 'error')
        self.assertEqual(self.client.get('/api/history').json['total'], 2)

    def test_unsupported_sources_and_live_workers_refuse_new_execution(self):
        target = self.terminal()
        vdl._live_worker_ids.add(target)
        try:
            self.assertEqual(self.send('retry', target, self.command(target)).json['mutation']['outcome'], 'rejected')
        finally:
            vdl._live_worker_ids.discard(target)
        with vdl.db() as conn:
            conn.execute("UPDATE downloads SET browser_authenticated=1 WHERE id=?", (target,))
        self.assertEqual(self.send('resume', target, self.command(target)).status_code, 409)
        vdl.db_insert_upload('upload', 'video.mp4', 'Video', 1, self.download_dir)
        self.assertEqual(self.send('retry', 'upload', self.command('upload')).status_code, 409)
        self.assertEqual(self.send('pause', 'missing', self.command(target)).status_code, 404)

    def test_legacy_generation_hint_refuses_old_history_after_new_attempt(self):
        target = self.terminal()
        old = self.command(target)['expected_attempt_id']
        with mock.patch.object(vdl, 'enqueue_download'):
            self.assertEqual(self.client.post('/api/resume/' + target, json={'expected_attempt_id': old}).status_code, 200)
            vdl.db_update_download(target, status='cancelled')
            self.assertEqual(self.client.post('/api/resume/' + target, json={'expected_attempt_id': old}).status_code, 409)

    def test_legacy_resume_refuses_upload_without_creating_an_attempt_or_worker(self):
        vdl.db_insert_upload('upload', 'video.mp4', 'Video', 1, self.download_dir)
        vdl.db_update_download('upload', status='cancelled')
        generation = vdl.db_get_download('upload')['current_attempt_id']
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            response = self.client.post('/api/resume/upload')
            self.assertEqual(response.status_code, 409)
            enqueue.assert_not_called()
        row = vdl.db_get_download('upload')
        self.assertEqual(row['status'], 'cancelled')
        self.assertEqual(row['current_attempt_id'], generation)

    def test_stop_terminal_execution_is_a_correlated_noop_without_stale_flags(self):
        target = self.terminal(status='finished')
        payload = self.command(target)
        with mock.patch.object(vdl, 'request_cancel', wraps=vdl.request_cancel) as cancel:
            response = self.send('stop', target, payload)
            self.assertEqual(response.status_code, 202)
            cancel.assert_not_called()
        self.assertFalse(vdl.is_cancel_requested(target))
        self.assertEqual(vdl.db_get_download(target)['status'], 'finished')
        self.assertEqual(self.receipt(payload).json['command']['status'], 'finished')

    def test_worker_finishing_before_control_dispatch_preserves_outcome_and_flags(self):
        for action in ('pause', 'unpause', 'stop'):
            with self.subTest(action=action):
                target = self.insert('race-' + action)
                if action == 'unpause':
                    vdl.db_update_download(target, status='paused')
                payload = self.command(target)
                dispatch = vdl._dispatch_download_command
                def complete(command_id):
                    vdl.db_update_download(target, status='finished')
                    return dispatch(command_id)
                with mock.patch.object(vdl, '_dispatch_download_command', side_effect=complete), mock.patch.object(vdl, 'request_pause', wraps=vdl.request_pause) as pause, mock.patch.object(vdl, 'request_cancel', wraps=vdl.request_cancel) as cancel:
                    self.assertEqual(self.send(action, target, payload).status_code, 202)
                    pause.assert_not_called()
                    cancel.assert_not_called()
                self.assertFalse(vdl.is_pause_requested(target))
                self.assertFalse(vdl.is_cancel_requested(target))
                self.assertEqual(self.receipt(payload).json['command']['status'], 'finished')

    def test_worker_finishing_during_control_effect_leaves_no_stale_flags(self):
        target = self.insert('race-effect')
        payload = self.command(target)
        request_pause = vdl.request_pause
        def finish_then_pause(download_id):
            vdl.db_update_download(download_id, status='finished')
            request_pause(download_id)
        with mock.patch.object(vdl, 'request_pause', side_effect=finish_then_pause):
            self.assertEqual(self.send('pause', target, payload).status_code, 202)
        self.assertFalse(vdl.is_pause_requested(target))
        self.assertFalse(vdl.is_cancel_requested(target))
        self.assertEqual(self.receipt(payload).json['command']['status'], 'finished')

    def test_crash_after_enqueue_before_dispatch_commit_never_launches_second_job(self):
        class Crash(BaseException):
            pass
        target = self.terminal()
        payload = self.command(target)
        dispatched = []
        def enqueue_then_crash(url, download_id):
            # Model the irreversible dispatch without retaining an actual
            # thread across this test's simulated process restart.
            dispatched.append((url, download_id))
            raise Crash()
        with mock.patch.object(vdl, 'enqueue_download', side_effect=enqueue_then_crash):
            with self.assertRaises(Crash):
                self.send('resume', target, payload)
        self.assertEqual(dispatched, [('https://fixture.invalid/video', target)])
        with vdl.db() as conn:
            command = conn.execute('SELECT * FROM download_commands WHERE mutation_id = ?', (payload['client_mutation_id'],)).fetchone()
            self.assertEqual(command['phase'], 'dispatching')
            job_id = command['id']
            attempt_id = command['attempt_id']
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            replay = self.send('resume', target, payload)
            self.assertEqual(replay.status_code, 202)
            self.assertEqual(replay.json['command']['job_id'], job_id)
            self.assertEqual(replay.json['command']['attempt_id'], attempt_id)
            self.assertEqual(replay.json['command']['status'], 'dispatching')
            enqueue.assert_not_called()
        vdl.init_db()
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            recovered = self.send('resume', target, payload)
            self.assertEqual(recovered.status_code, 202)
            self.assertEqual(recovered.json['command']['job_id'], job_id)
            self.assertEqual(recovered.json['command']['attempt_id'], attempt_id)
            self.assertEqual(recovered.json['command']['status'], 'interrupted')
            self.assertEqual(self.receipt(payload).json['command']['status'], 'interrupted')
            enqueue.assert_not_called()
        self.assertEqual(vdl.db_get_download(target)['status'], 'interrupted')
        with vdl.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM download_attempts WHERE work_id = ?', (target,)).fetchone()[0], 2)

    def test_successor_pause_survives_previous_worker_final_cleanup(self):
        target = self.insert('handoff-pause')
        old_terminal, release_old = threading.Event(), threading.Event()
        new_started, release_new = threading.Event(), threading.Event()
        calls, successor_flags = [], []
        def controlled_worker(_url, download_id, _cookies=None):
            calls.append(download_id)
            if len(calls) == 1:
                vdl.db_update_download(download_id, status='cancelled')
                old_terminal.set()
                if not release_old.wait(5):
                    raise AssertionError('Old worker gate timed out')
            else:
                successor_flags.append(vdl.is_pause_requested(download_id))
                new_started.set()
                if not release_new.wait(5):
                    raise AssertionError('Successor worker gate timed out')
                vdl.db_update_download(download_id, status='cancelled')
        with mock.patch.object(vdl, '_background_download', side_effect=controlled_worker):
            try:
                vdl.enqueue_download('https://fixture.invalid/video', target)
                self.assertTrue(old_terminal.wait(5))
                old_attempt = vdl.db_get_download(target)['current_attempt_id']
                # A previous generation's flag must not leak through Continue.
                vdl.request_pause(target)
                self.assertEqual(self.client.post('/api/resume/' + target).status_code, 200)
                self.assertFalse(vdl.is_pause_requested(target))
                current = vdl.db_get_download(target)
                self.assertNotEqual(current['current_attempt_id'], old_attempt)
                pause = self.command(target)
                self.assertEqual(self.send('pause', target, pause).status_code, 202)
                self.assertTrue(vdl.is_pause_requested(target))
                release_old.set()
                self.assertTrue(new_started.wait(5))
                self.assertEqual(successor_flags, [True])
                self.assertTrue(vdl.is_pause_requested(target))
                self.assertEqual(len(calls), 2)
                self.assertEqual(vdl.db_get_download(target)['current_attempt_id'], current['current_attempt_id'])
            finally:
                release_old.set()
                release_new.set()
                self.wait_worker_stopped(target)

    def test_successor_stop_during_previous_worker_cleanup_cancels_queued_attempt(self):
        target = self.insert('handoff-stop')
        old_terminal, release_old = threading.Event(), threading.Event()
        calls = []
        def controlled_worker(_url, download_id, _cookies=None):
            calls.append(download_id)
            vdl.db_update_download(download_id, status='cancelled')
            old_terminal.set()
            if not release_old.wait(5):
                raise AssertionError('Old worker gate timed out')
        with mock.patch.object(vdl, '_background_download', side_effect=controlled_worker):
            try:
                vdl.enqueue_download('https://fixture.invalid/video', target)
                self.assertTrue(old_terminal.wait(5))
                self.assertEqual(self.client.post('/api/resume/' + target).status_code, 200)
                successor = vdl.db_get_download(target)['current_attempt_id']
                self.assertEqual(self.send('pause', target, self.command(target)).status_code, 202)
                self.assertTrue(vdl.is_pause_requested(target))
                stop = self.command(target)
                self.assertEqual(self.send('stop', target, stop).status_code, 202)
                self.assertEqual(vdl.db_get_download(target)['status'], 'cancelled')
                self.assertFalse(any(job['id'] == target for job in vdl._worker_queue))
                release_old.set()
                self.wait_worker_stopped(target)
                self.assertEqual(calls, [target])
                self.assertFalse(vdl.is_pause_requested(target))
                self.assertFalse(vdl.is_cancel_requested(target))
                self.assertEqual(vdl.db_get_download(target)['current_attempt_id'], successor)
                self.assertEqual(self.receipt(stop).json['command']['status'], 'cancelled')
                with vdl.db() as conn:
                    self.assertEqual(conn.execute('SELECT status FROM download_attempts WHERE id = ?', (successor,)).fetchone()[0], 'cancelled')
            finally:
                release_old.set()
                self.wait_worker_stopped(target)

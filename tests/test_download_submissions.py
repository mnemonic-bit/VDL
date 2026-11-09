"""New-download durable acceptance and recovery through production routes."""
import json
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

import vdl
from tests.support.app_case import AppCase
from tests.support.fake_ytdlp import FakeYoutubeDL


class DownloadSubmissionTest(AppCase):
    def payload(self, **changes):
        result = dict(url='https://fixture.invalid/video',
                      client_mutation_id=f'{int(time.time() * 1000)}-{secrets.token_hex(16)}')
        result.update(changes)
        return result

    def send(self, payload, client=None):
        return (client or self.client).post('/api/download', json=payload)

    def receipt(self, payload, client=None):
        return (client or self.client).get('/api/mutations/' + payload['client_mutation_id'])

    def counts(self):
        with vdl.db() as conn:
            return tuple(conn.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0]
                         for table in ('downloads', 'download_attempts', 'download_commands', 'mutation_receipts'))

    def test_acceptance_has_one_correlated_job_and_history_attempt(self):
        payload = self.payload(format='v360+a1', filename='chosen.webm')
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            response = self.send(payload)
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        result = response.json
        self.assertEqual(result['submission_revision'], '1')
        self.assertEqual(result['mutation'], dict(id=payload['client_mutation_id'], domain='download-submission',
                                                 revision='1', outcome='accepted'))
        self.assertEqual(result['job'], dict(id=result['job']['id'], download_id=result['id'],
                                             attempt_id=result['current_attempt_id'], status='accepted'))
        enqueue.assert_called_once_with(payload['url'], result['id'])
        row = vdl.db_get_download(result['id'])
        self.assertEqual(row['requested_format'], 'v360+a1')
        self.assertEqual(row['requested_filename'], 'chosen')
        self.assertEqual(row['status'], 'starting')
        self.assertIsNone(row['filename'])
        self.assertEqual(self.counts(), (1, 1, 1, 1))
        for snapshot in (self.client.get('/api/current-downloads').json[0],
                         self.client.get('/api/history').json['items'][0],
                         self.client.get('/api/downloads/' + result['id'] + '/editable-state').json):
            self.assertEqual(snapshot['current_attempt_id'], result['current_attempt_id'])
            self.assertEqual(snapshot['job_id'], result['job']['id'])
        self.assertEqual(self.receipt(payload).json['job']['status'], 'dispatched')
        self.assertIn('download.submit', self.client.get('/api/client-capabilities').json['actions'])

    def test_replay_after_lost_response_never_creates_or_enqueues_twice(self):
        payload = self.payload()
        dispatch = vdl._dispatch_download_command
        class ResponseLost(BaseException):
            pass
        def lose(command_id):
            dispatch(command_id)
            raise ResponseLost()
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            with mock.patch.object(vdl, '_dispatch_download_command', side_effect=lose):
                with self.assertRaises(ResponseLost):
                    self.send(payload)
            accepted = self.receipt(payload).json
            replay = self.send(payload).json
            enqueue.assert_called_once()
        self.assertEqual(accepted['id'], replay['id'])
        self.assertEqual(accepted['job'], replay['job'])
        self.assertEqual(self.counts(), (1, 1, 1, 1))

    def test_simultaneous_replay_has_only_one_durable_owner(self):
        payload = self.payload()
        clients = [self.authenticated_client(), self.authenticated_client()]
        barrier = threading.Barrier(2)
        def submit(index):
            barrier.wait()
            return self.send(payload, clients[index])
        with mock.patch.object(vdl, 'enqueue_download') as enqueue, ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, range(2)))
        self.assertEqual([result.status_code for result in results], [202, 202])
        self.assertEqual(results[0].json['job']['id'], results[1].json['job']['id'])
        enqueue.assert_called_once()
        self.assertEqual(self.counts(), (1, 1, 1, 1))

    def test_deliberate_submissions_of_same_url_have_distinct_jobs(self):
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            first = self.send(self.payload()).json
            second = self.send(self.payload()).json
        self.assertNotEqual(first['id'], second['id'])
        self.assertNotEqual(first['job']['id'], second['job']['id'])
        self.assertNotEqual(first['current_attempt_id'], second['current_attempt_id'])
        self.assertEqual(enqueue.call_count, 2)
        self.assertEqual(self.counts(), (2, 2, 2, 2))

    def test_fingerprint_covers_exact_url_options_and_omitted_fields(self):
        payload = self.payload(filename='chosen.webm')
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            self.assertEqual(self.send(payload).status_code, 202)
            for changes in ({'url': payload['url'] + '?signature=changed'}, {'filename': 'chosen.mp4'},
                            {'format': None}, {'extra': True}):
                response = self.send(dict(payload, **changes))
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.json['code'], 'mutation_id_conflict')
            enqueue.assert_called_once()
        self.assertEqual(self.counts(), (1, 1, 1, 1))

    def test_receipt_namespace_is_shared_with_existing_adapters(self):
        payload = self.payload()
        with mock.patch.object(vdl, 'enqueue_download'):
            result = self.send(payload).json
        other = self.client.post('/api/favorite/' + result['id'], json=dict(
            favorite=True, expected_revision='0', client_mutation_id=payload['client_mutation_id']))
        self.assertEqual(other.status_code, 409)
        payload = self.payload()
        self.client.post('/api/favorite/' + result['id'], json=dict(
            favorite=True, expected_revision='0', client_mutation_id=payload['client_mutation_id']))
        self.assertEqual(self.send(payload).json['code'], 'mutation_id_conflict')

    def test_invalid_options_have_recoverable_rejection_without_work(self):
        for changes in ({'url': None}, {'url': 7}, {'url': ''}, {'url': 'file:///secret'},
                        {'url': 'https://name:password@fixture.invalid/video'},
                        {'url': 'https://fixture.invalid/\nsecret'}, {'url': 'https://bad:port/video'},
                        {'format': 7}, {'format': []}, {'format': ''}, {'format': 'bad\nselector'},
                        {'format': 'x' * 4097}, {'filename': '../secret'}, {'filename': None},
                        {'filename': 'x' * 1025}, {'cookies': 'secret'}, {'expected_revision': '0'}):
            with self.subTest(changes=changes), mock.patch.object(vdl, 'enqueue_download') as enqueue:
                payload = self.payload(**changes)
                response = self.send(payload)
                self.assertEqual(response.status_code, 400)
                result = response.json
                self.assertEqual(result['submission_revision'], '0')
                self.assertEqual(result['mutation']['outcome'], 'rejected')
                self.assertIsNone(result['id'])
                self.assertIsNone(result['job'])
                self.assertEqual(self.receipt(payload).json, result)
                self.assertEqual(self.send(payload).json, result)
                enqueue.assert_not_called()
        self.assertEqual(self.counts()[:3], (0, 0, 0))

    def test_rejections_are_actor_scoped_and_do_not_echo_private_options(self):
        payload = self.payload(url='https://name:secret@fixture.invalid/video?token=private')
        response = self.send(payload)
        self.assertNotIn('secret', json.dumps(response.json))
        self.assertNotIn('private', json.dumps(response.json))
        vdl.db_create_user('alice', 'alice-password', 'normal')
        other = self.authenticated_client('alice', 'alice-password')
        self.assertEqual(self.receipt(payload, other).status_code, 404)
        self.assertEqual(self.receipt(payload, other).json,
                         other.get('/api/mutations/' + self.payload()['client_mutation_id']).json)

    def test_body_limits_and_invalid_identifier_cannot_create_work(self):
        cases = [self.client.post('/api/download', json=[]),
                 self.client.post('/api/download', data='invalid', content_type='application/json'),
                 self.client.post('/api/download', data='{}', content_type='text/plain'),
                 self.send(self.payload(url='https://fixture.invalid/' + 'x' * 17000)),
                 self.send(self.payload(client_mutation_id='invalid'))]
        self.assertEqual([response.status_code for response in cases], [400, 400, 415, 413, 400])
        self.assertEqual(self.counts(), (0, 0, 0, 0))

    def test_work_and_attempt_roll_back_if_receipt_insert_fails(self):
        with vdl.db() as conn:
            conn.execute("CREATE TRIGGER fail_submission_receipt BEFORE INSERT ON mutation_receipts BEGIN SELECT RAISE(ABORT, 'injected'); END")
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            with self.assertRaises(vdl.sqlite3.IntegrityError):
                self.send(self.payload())
            enqueue.assert_not_called()
        self.assertEqual(self.counts(), (0, 0, 0, 0))

    def test_restart_before_dispatch_marks_same_job_and_attempt_interrupted(self):
        payload = self.payload()
        with mock.patch.object(vdl, '_dispatch_download_command'):
            accepted = self.send(payload).json
        vdl.init_db()
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            recovered = self.send(payload)
            enqueue.assert_not_called()
        self.assertEqual(recovered.status_code, 202)
        self.assertEqual(recovered.json['job']['id'], accepted['job']['id'])
        self.assertEqual(recovered.json['job']['status'], 'interrupted')
        self.assertEqual(self.receipt(payload).json['job']['status'], 'interrupted')
        self.assertEqual(vdl.db_get_download(accepted['id'])['status'], 'interrupted')
        self.assertEqual(self.client.get('/api/history').json['items'][0]['status'], 'interrupted')
        self.assertEqual(self.counts(), (1, 1, 1, 1))

    def test_crash_after_dispatch_claim_never_enqueues_on_recovery(self):
        payload = self.payload()
        class Crash(BaseException):
            pass
        with mock.patch.object(vdl, 'enqueue_download', side_effect=Crash()):
            with self.assertRaises(Crash):
                self.send(payload)
        accepted = self.receipt(payload).json
        self.assertEqual(accepted['job']['status'], 'dispatching')
        vdl.init_db()
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            recovered = self.send(payload)
            enqueue.assert_not_called()
        self.assertEqual(recovered.json['job']['id'], accepted['job']['id'])
        self.assertEqual(recovered.json['job']['status'], 'interrupted')
        self.assertEqual(self.counts(), (1, 1, 1, 1))

    def test_restart_after_enqueue_does_not_create_replacement_attempt(self):
        payload = self.payload()
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            accepted = self.send(payload).json
            enqueue.assert_called_once()
        vdl.init_db()
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            recovered = self.send(payload)
            enqueue.assert_not_called()
        self.assertEqual(recovered.json['current_attempt_id'], accepted['current_attempt_id'])
        self.assertEqual(recovered.json['job']['id'], accepted['job']['id'])
        self.assertEqual(recovered.json['job']['status'], 'interrupted')
        self.assertEqual(self.counts(), (1, 1, 1, 1))

    def test_dispatch_error_is_accepted_job_error_without_unsafe_replay(self):
        payload = self.payload()
        with mock.patch.object(vdl, 'enqueue_download', side_effect=OSError('secret/path')) as enqueue:
            accepted = self.send(payload)
            replay = self.send(payload)
            enqueue.assert_called_once()
        self.assertEqual(accepted.status_code, 202)
        self.assertEqual(replay.status_code, 202)
        self.assertEqual(replay.json['job']['status'], 'error')
        self.assertNotIn('secret/path', json.dumps(replay.json))
        self.assertEqual(vdl.db_get_download(accepted.json['id'])['status'], 'error')
        self.assertEqual(self.client.get('/api/history').json['items'][0]['status'], 'error')

    def test_restart_after_real_scheduler_ownership_registration_never_launches_second_owner(self):
        payload = self.payload()
        registered, threads = threading.Event(), []
        def vanished_worker(_url, _download_id):
            # Model a process disappearing after the scheduler registers its
            # thread, without running worker outcome or ownership cleanup.
            threads.append(threading.current_thread())
            registered.set()
        with mock.patch.object(vdl, 'background_download', side_effect=vanished_worker) as worker:
            accepted = self.send(payload).json
            self.assertTrue(registered.wait(5))
            threads[0].join(5)
            self.assertFalse(threads[0].is_alive())
            with vdl._worker_condition:
                self.assertIn(accepted['id'], vdl._live_worker_ids)
                self.assertIn(accepted['id'], vdl._worker_hosts)
                self.assertEqual(vdl._active_worker_count, 1)
            # Even after the thread has vanished, recovery cannot claim that
            # the durable dispatch was never attempted or launch another one.
            replay = self.send(payload)
            self.assertEqual(replay.json['job']['id'], accepted['job']['id'])
            self.assertEqual(worker.call_count, 1)
        with vdl._worker_condition:
            vdl._live_worker_ids.clear()
            vdl._worker_hosts.clear()
            vdl._worker_queue.clear()
            vdl._active_worker_count = 0
        vdl.init_db()
        with mock.patch.object(vdl, 'background_download') as worker, mock.patch.object(vdl, 'enqueue_download') as enqueue:
            recovered = self.send(payload)
            worker.assert_not_called()
            enqueue.assert_not_called()
        self.assertEqual(recovered.json['job']['id'], accepted['job']['id'])
        self.assertEqual(recovered.json['job']['status'], 'interrupted')
        self.assertEqual(recovered.json['current_attempt_id'], accepted['current_attempt_id'])
        self.assertEqual(vdl.db_get_download(accepted['id'])['status'], 'interrupted')
        self.assertEqual(self.client.get('/api/history').json['items'][0]['status'], 'interrupted')
        self.assertEqual(self.counts(), (1, 1, 1, 1))

    def test_publish_failure_cannot_hide_committed_acceptance(self):
        payload = self.payload()
        with mock.patch.object(vdl, 'enqueue_download'), mock.patch.object(vdl.event_bus, 'publish', side_effect=RuntimeError('unavailable')):
            accepted = self.send(payload)
        self.assertEqual(accepted.status_code, 202)
        self.assertEqual(self.receipt(payload).json['job']['id'], accepted.json['job']['id'])
        self.assertEqual(self.counts(), (1, 1, 1, 1))

    def test_receipts_never_copy_url_options_or_credentials_into_presentation(self):
        payload = self.payload(url='https://fixture.invalid/video?token=private-secret', filename='private-name', format='private-selector')
        with mock.patch.object(vdl, 'enqueue_download'):
            result = self.send(payload).json
        with vdl.db() as conn:
            stored = conn.execute('SELECT response FROM mutation_receipts').fetchone()[0]
        for forbidden in (payload['url'], 'private-secret', 'private-name', 'private-selector'):
            self.assertNotIn(forbidden, stored)
            self.assertNotIn(forbidden, json.dumps(result))
        self.assertEqual(self.receipt(payload).json['id'], result['id'])

    def test_receipt_replay_and_lookup_require_current_target_access(self):
        alice = vdl.db_create_user('alice', 'alice-password', 'normal')
        bob = vdl.db_create_user('bob', 'bob-password', 'normal')
        client = self.authenticated_client('alice', 'alice-password')
        other = self.authenticated_client('bob', 'bob-password')
        payload = self.payload()
        with mock.patch.object(vdl, 'enqueue_download'):
            result = self.send(payload, client).json
        self.assertEqual(self.receipt(payload, other).status_code, 404)
        with vdl.db() as conn:
            conn.execute("UPDATE downloads SET visibility='private', owner_user_id=? WHERE id=?", (bob['id'], result['id']))
        self.assertEqual(self.receipt(payload, client).status_code, 404)
        self.assertEqual(self.send(payload, client).status_code, 404)
        with vdl.db() as conn:
            conn.execute('UPDATE users SET suspended=1 WHERE id=?', (alice['id'],))
        self.assertEqual(self.receipt(payload, client).status_code, 401)
        self.assertEqual(self.send(payload, client).status_code, 401)

    def test_removed_target_cannot_be_recreated_by_replay(self):
        payload = self.payload()
        with mock.patch.object(vdl, 'enqueue_download'):
            result = self.send(payload).json
        vdl.db_update_download(result['id'], status='cancelled')
        self.assertEqual(self.client.post('/api/remove/' + result['id']).status_code, 200)
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            self.assertEqual(self.send(payload).status_code, 404)
            self.assertEqual(self.receipt(payload).status_code, 404)
            enqueue.assert_not_called()
        self.assertEqual(vdl.db_list_downloads(), [])

    def test_authorization_rechecked_inside_acceptance_transaction(self):
        original = vdl._execute_download_submission
        def revoke(payload):
            with vdl.db() as conn:
                conn.execute("UPDATE users SET session_version=session_version+1 WHERE username='admin'")
            return original(payload)
        with mock.patch.object(vdl, '_execute_download_submission', side_effect=revoke), mock.patch.object(vdl, 'enqueue_download') as enqueue:
            self.assertEqual(self.send(self.payload()).status_code, 401)
            enqueue.assert_not_called()
        self.assertEqual(self.counts(), (0, 0, 0, 0))

    def test_authorization_rechecked_after_acceptance_before_dispatch(self):
        payload = self.payload()
        original = vdl._dispatch_download_command
        def revoke(command_id):
            with vdl.db() as conn:
                conn.execute("UPDATE users SET session_version=session_version+1 WHERE username='admin'")
            return original(command_id)
        with mock.patch.object(vdl, '_dispatch_download_command', side_effect=revoke), mock.patch.object(vdl, 'enqueue_download') as enqueue:
            response = self.send(payload)
            enqueue.assert_not_called()
        self.assertEqual(response.status_code, 202)
        self.assertEqual(vdl.db_get_download(response.json['id'])['status'], 'interrupted')
        self.assertEqual(self.counts(), (1, 1, 1, 1))
        self.assertEqual(self.receipt(payload).status_code, 401)

    def test_shared_quotas_reject_new_work_and_allow_existing_recovery(self):
        payload = self.payload()
        with mock.patch.object(vdl, 'enqueue_download'):
            result = self.send(payload).json
        for limit in ('MUTATION_ACTOR_RECEIPT_LIMIT', 'MUTATION_ACTOR_MINUTE_LIMIT'):
            with mock.patch.object(vdl, limit, 0), mock.patch.object(vdl, 'enqueue_download') as enqueue:
                refused = self.payload()
                response = self.send(refused)
                self.assertEqual(response.status_code, 429)
                self.assertEqual(response.json['code'], 'mutation_limit')
                self.assertEqual(response.json['mutation'], dict(id=refused['client_mutation_id'],
                                 domain='download-submission', revision='0', outcome='rejected'))
                self.assertEqual(response.json['submission_revision'], '0')
                for field in ('id', 'job', 'current_attempt_id'):
                    self.assertIsNone(response.json[field])
                self.assertEqual(self.counts(), (1, 1, 1, 1))
                self.assertEqual(self.send(payload).json['job']['id'], result['job']['id'])
                enqueue.assert_not_called()
        self.assertEqual(self.counts(), (1, 1, 1, 1))

    def test_expiry_and_clock_skew_reject_new_attempts_without_jobs(self):
        for offset in (-vdl.MUTATION_REPLAY_SECONDS - 10, 301):
            payload = self.payload(client_mutation_id=f'{int((time.time()+offset)*1000)}-{secrets.token_hex(16)}')
            response = self.send(payload)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json['mutation']['outcome'], 'rejected')
            self.assertEqual(self.receipt(payload).json, response.json)
        self.assertEqual(self.counts()[:3], (0, 0, 0))

    def test_active_job_keeps_receipt_through_all_shared_cleanup(self):
        payload = self.payload()
        with mock.patch.object(vdl, 'enqueue_download'):
            result = self.send(payload).json
        with vdl.db() as conn:
            conn.execute('UPDATE mutation_receipts SET recorded_at=0')
            conn.execute('UPDATE download_commands SET recorded_at=0')
        self.client.post('/api/favorite/' + result['id'], json=dict(favorite=True, expected_revision='0',
                         client_mutation_id=self.payload()['client_mutation_id']))
        self.assertEqual(self.receipt(payload).status_code, 202)
        self.assertEqual(self.receipt(payload).json['job']['id'], result['job']['id'])
        vdl.db_update_download(result['id'], status='finished')
        with vdl._db_lock, vdl.db() as conn:
            vdl._prune_mutation_receipts(conn, time.time())
        self.assertEqual(self.receipt(payload).status_code, 404)

    def test_expired_missing_receipt_is_final_and_cannot_allocate_again(self):
        payload = self.payload()
        self.assertFalse(self.receipt(payload).json['final'])
        payload = self.payload(client_mutation_id=f'{int((time.time()-90000)*1000)}-{secrets.token_hex(16)}')
        self.assertTrue(self.receipt(payload).json['final'])
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            self.assertEqual(self.send(payload).json['mutation']['outcome'], 'rejected')
            enqueue.assert_not_called()
        self.assertEqual(self.counts()[:3], (0, 0, 0))

    def test_expired_lookup_waits_behind_admitted_submission(self):
        payload = self.payload()
        admission, release, lookup_started = threading.Event(), threading.Event(), threading.Event()
        clients = [self.authenticated_client(), self.authenticated_client()]
        # Keep cookie-signing time behind the frozen admission clock.
        clock = [time.time()]
        record = vdl.download_history.record
        def hold(conn, download_id, **kwargs):
            result = record(conn, download_id, **kwargs)
            if kwargs.get('create'):
                admission.set()
                self.assertTrue(release.wait(5))
            return result
        def lookup():
            lookup_started.set()
            return self.receipt(payload, clients[1])
        with mock.patch.object(vdl.download_history, 'record', side_effect=hold), mock.patch.object(vdl.time, 'time', side_effect=lambda: clock[0]), mock.patch.object(vdl, 'enqueue_download'), ThreadPoolExecutor(max_workers=2) as pool:
            accepted = pool.submit(self.send, payload, clients[0])
            self.assertTrue(admission.wait(5))
            clock[0] += vdl.MUTATION_REPLAY_SECONDS + 1
            checked = pool.submit(lookup)
            self.assertTrue(lookup_started.wait(5))
            release.set()
            first, recovered = accepted.result(5), checked.result(5)
        self.assertEqual(first.status_code, 202)
        self.assertEqual(recovered.status_code, 202)
        self.assertEqual(recovered.json['job']['id'], first.json['job']['id'])

    def test_real_worker_owns_one_attempt_and_replay_does_not_restart(self):
        FakeYoutubeDL.reset()
        FakeYoutubeDL.block_downloads = True
        payload = self.payload()
        try:
            with mock.patch.object(vdl.yt_dlp, 'YoutubeDL', FakeYoutubeDL), mock.patch.object(vdl, 'ffprobe_resolution', return_value='360p'):
                accepted = self.send(payload).json
                self.assertTrue(FakeYoutubeDL.entered.wait(5))
                replay = self.send(payload).json
                self.assertEqual(replay['job']['id'], accepted['job']['id'])
                self.assertEqual(self.counts(), (1, 1, 1, 1))
                with vdl._worker_condition:
                    self.assertIn(accepted['id'], vdl._live_worker_ids)
                    self.assertEqual(vdl._active_worker_count, 1)
                FakeYoutubeDL.release.set()
                self.wait_worker_stopped(accepted['id'])
            checked = self.receipt(payload)
            self.assertEqual(checked.json['job']['status'], 'finished')
            self.assertEqual(self.client.get('/api/history').json['items'][0]['job_id'], accepted['job']['id'])
        finally:
            FakeYoutubeDL.release.set()

    def test_old_submission_recovery_does_not_rewind_a_resumed_attempt(self):
        payload = self.payload()
        with mock.patch.object(vdl, 'enqueue_download'):
            accepted = self.send(payload).json
        vdl.db_update_download(accepted['id'], status='cancelled')
        row = vdl.db_get_download(accepted['id'])
        command = dict(client_mutation_id=self.payload()['client_mutation_id'], expected_revision=row['command_revision'],
                       expected_attempt_id=row['current_attempt_id'])
        with mock.patch.object(vdl, 'enqueue_download'):
            resumed = self.client.post('/api/resume/' + accepted['id'], json=command).json
            recovered = self.send(payload).json
        self.assertEqual(recovered['current_attempt_id'], accepted['current_attempt_id'])
        self.assertEqual(recovered['job']['status'], 'cancelled')
        current = self.client.get('/api/current-downloads').json[0]
        self.assertEqual(current['job_id'], resumed['command']['job_id'])
        self.assertEqual(current['current_attempt_id'], resumed['current_attempt_id'])
        history = self.client.get('/api/history').json['items']
        original = next(item for item in history if item['id'] == accepted['current_attempt_id'])
        self.assertEqual(original['job_id'], accepted['job']['id'])

    def test_legacy_download_submission_still_uses_existing_response(self):
        with mock.patch.object(vdl, 'enqueue_download') as enqueue:
            response = self.send(dict(url='https://fixture.invalid/video', format='v360+a1', filename='legacy.mp4'))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, dict(message='Download started', id=response.json['id']))
        enqueue.assert_called_once_with('https://fixture.invalid/video', response.json['id'])
        self.assertEqual(self.counts(), (1, 1, 0, 0))

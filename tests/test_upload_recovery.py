"""Upload's durable ownership, publication and recovery through production routes."""
import os
import secrets
import threading
import time
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class SimulatedCrash(BaseException):
    pass


class UploadRecoveryTest(AppCase):
    def mutation_id(self, age=0):
        return f'{int((time.time() - age)*1000)}-{secrets.token_hex(16)}'

    def payload(self, **changes):
        return dict(id=secrets.token_hex(16), filename='local.mp4', filesize=5,
                    client_mutation_id=self.mutation_id(), **changes)

    def register(self, payload=None):
        payload = payload or self.payload()
        response = self.client.post('/api/upload', json=payload)
        self.assertEqual(response.status_code, 202, response.json)
        return payload, response.json

    def transfer(self, upload_id):
        with mock.patch.object(vdl, 'inspect_uploaded_video', return_value='720p'):
            return self.client.put('/api/upload/' + upload_id, data=b'video')

    def operation(self, upload_id):
        with vdl.db() as conn:
            return dict(conn.execute('SELECT * FROM upload_operations WHERE id=?', (upload_id,)).fetchone())

    def counts(self):
        with vdl.db() as conn:
            return tuple(conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                         for table in ('downloads','download_attempts','upload_operations','mutation_receipts'))

    def test_identical_registration_and_recovery_share_one_attempt(self):
        payload, result = self.register()
        replay = self.client.post('/api/upload', json=payload)
        self.assertEqual(replay.status_code, 202)
        self.assertEqual(replay.json, result)
        receipt = self.client.get('/api/mutations/' + payload['client_mutation_id'])
        self.assertEqual(receipt.json, result)
        self.assertEqual(self.counts(), (1,1,1,1))
        self.assertEqual(result['mutation']['revision'], '1')
        self.assertEqual(result['upload']['phase'], 'registered')
        self.assertIsNotNone(result['upload']['attempt_id'])

    def test_simultaneous_registration_is_atomic(self):
        payload = self.payload()
        replies = []
        barrier = threading.Barrier(2)
        def register():
            client = self.authenticated_client()
            barrier.wait()
            replies.append(client.post('/api/upload', json=payload))
        threads = [threading.Thread(target=register) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(5)
            self.assertFalse(thread.is_alive())
        self.assertEqual([reply.status_code for reply in replies], [202,202])
        self.assertEqual(self.counts(), (1,1,1,1))

    def test_different_payload_same_mutation_or_resource_conflicts(self):
        payload, original = self.register()
        for changes in ({'filename':'another.mp4'}, {'filesize':6}, {'id':secrets.token_hex(16)},
                        {'filename':'another.mp4','client_mutation_id':self.mutation_id()}):
            response = self.client.post('/api/upload', json={**payload, **changes})
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json['mutation']['outcome'], 'conflicted')
        self.assertEqual(self.counts(), (1,1,1,1))
        self.assertEqual(vdl.db_get_download(payload['id'])['title'], 'local')

    def test_registration_commit_survives_lost_acknowledgement(self):
        payload = self.payload()
        def crash(phase, _operation):
            if phase == 'registered':
                raise SimulatedCrash()
        with mock.patch.object(vdl, '_upload_checkpoint', side_effect=crash):
            with self.assertRaises(SimulatedCrash):
                self.client.post('/api/upload', json=payload)
        self.assertEqual(self.client.post('/api/upload', json=payload).status_code, 202)
        self.assertEqual(self.counts(), (1,1,1,1))

    def test_receipt_insert_failure_rolls_back_resource_attempt_and_journal(self):
        with mock.patch.object(vdl, '_record_upload_receipt', side_effect=vdl.sqlite3.OperationalError('injected')):
            response = self.client.post('/api/upload', json=self.payload())
        self.assertEqual(response.status_code, 500)
        self.assertEqual(self.counts(), (0,0,0,0))

    def test_publication_and_unknown_finalization_have_same_canonical_identity(self):
        payload, result = self.register()
        response = self.transfer(payload['id'])
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json['upload']['phase'], 'published')
        status = self.client.get('/api/upload/' + payload['id'] + '/status').json
        receipt = self.client.get('/api/mutations/' + payload['client_mutation_id']).json
        self.assertEqual(status['upload'], response.json['upload'])
        self.assertEqual(receipt['upload'], status['upload'])
        self.assertEqual(receipt['mutation']['revision'], status['upload']['revision'])
        self.assertEqual(status['download']['filename'], 'local.mp4')
        self.assertEqual(status['download']['status'], 'finished')
        self.assertNotIn(self.download_dir, str(status))
        self.assertEqual(status['upload']['attempt_id'], result['upload']['attempt_id'])
        self.assertEqual(self.client.put('/api/upload/'+payload['id'], data=b'other').status_code, 409)
        self.assertEqual(self.counts(), (1,1,1,1))
        self.assertEqual(os.listdir(self.download_dir), ['local.mp4'])

    def test_two_transfers_cannot_claim_same_upload(self):
        payload, _ = self.register()
        entered, release = threading.Event(), threading.Event()
        replies = []
        def inspect(_path):
            entered.set()
            self.assertTrue(release.wait(5))
            return '720p'
        def transfer():
            replies.append(self.authenticated_client().put('/api/upload/'+payload['id'], data=b'video'))
        with mock.patch.object(vdl, 'inspect_uploaded_video', side_effect=inspect):
            worker = threading.Thread(target=transfer)
            worker.start()
            self.assertTrue(entered.wait(5))
            duplicate = self.client.put('/api/upload/'+payload['id'], data=b'video')
            self.assertEqual(duplicate.status_code, 409)
            status = self.client.get('/api/upload/'+payload['id']+'/status')
            self.assertEqual(status.json['upload']['phase'], 'processing')
            self.assertEqual(status.json['upload']['downloaded_bytes'], 5)
            self.assertEqual(self.client.get('/api/file/'+payload['id']).status_code, 404)
            release.set()
            worker.join(5)
        self.assertEqual(replies[0].status_code, 200)
        self.assertEqual(self.counts(), (1,1,1,1))

    def test_cancel_before_transfer_is_durable_and_replayable(self):
        payload, _ = self.register()
        cancel = {'client_mutation_id':self.mutation_id()}
        first = self.client.post('/api/upload/'+payload['id']+'/cancel', json=cancel)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json['upload']['phase'], 'cancelled')
        self.assertEqual(self.client.post('/api/upload/'+payload['id']+'/cancel', json=cancel).json, first.json)
        self.assertEqual(self.transfer(payload['id']).status_code, 409)
        vdl.init_db()
        status = self.client.get('/api/upload/'+payload['id']+'/status').json
        self.assertEqual(status['upload']['phase'], 'cancelled')
        self.assertEqual(self.counts(), (1,1,1,2))
        self.assertEqual(os.listdir(self.download_dir), [])

    def test_cancel_during_processing_waits_for_actual_cleanup(self):
        payload, _ = self.register()
        entered, release = threading.Event(), threading.Event()
        replies = []
        def inspect(_path):
            entered.set()
            self.assertTrue(release.wait(5))
            return '720p'
        def transfer():
            replies.append(self.authenticated_client().put('/api/upload/'+payload['id'], data=b'video'))
        with mock.patch.object(vdl, 'inspect_uploaded_video', side_effect=inspect):
            worker = threading.Thread(target=transfer)
            worker.start()
            self.assertTrue(entered.wait(5))
            cancel = self.client.post('/api/upload/'+payload['id']+'/cancel', json={'client_mutation_id':self.mutation_id()})
            self.assertEqual(cancel.json['upload']['phase'], 'processing')
            self.assertTrue(cancel.json['upload']['cancel_requested'])
            release.set()
            worker.join(5)
        self.assertEqual(replies[0].status_code, 409)
        self.assertEqual(self.operation(payload['id'])['phase'], 'cancelled')
        self.assertEqual(os.listdir(self.download_dir), [])

    def test_cancel_after_finished_commit_keeps_authoritative_published_file(self):
        payload, _ = self.register()
        entered, release = threading.Event(), threading.Event()
        replies = []
        def checkpoint(phase, _operation):
            if phase == 'published':
                entered.set()
                self.assertTrue(release.wait(5))
        def transfer():
            replies.append(self.transfer_with_client(payload['id']))
        with mock.patch.object(vdl, '_upload_checkpoint', side_effect=checkpoint), \
                mock.patch.object(vdl, 'inspect_uploaded_video', return_value='720p'):
            worker = threading.Thread(target=transfer)
            worker.start()
            self.assertTrue(entered.wait(5))
            stop_result = []
            stopper = threading.Thread(target=lambda: stop_result.append(self.authenticated_client().post(
                '/api/upload/'+payload['id']+'/cancel', json={'client_mutation_id':self.mutation_id()})))
            stopper.start()
            release.set()
            worker.join(5)
            stopper.join(5)
        self.assertEqual(stop_result[0].json['upload']['phase'], 'published')
        self.assertEqual(vdl.db_get_download(payload['id'])['status'], 'finished')
        self.assertTrue(os.path.isfile(vdl.db_get_download(payload['id'])['filename']))

    def transfer_with_client(self, upload_id):
        return self.authenticated_client().put('/api/upload/'+upload_id, data=b'video')

    def test_restart_at_each_publication_boundary_preserves_single_attempt(self):
        for boundary in ('transferring','processing','publishing','linked','published'):
            with self.subTest(boundary=boundary):
                payload, _ = self.register()
                def crash(phase, operation):
                    if phase == boundary and (phase != 'transferring' or operation.get('inode')):
                        raise SimulatedCrash()
                with mock.patch.object(vdl, '_upload_checkpoint', side_effect=crash), \
                        mock.patch.object(vdl, 'inspect_uploaded_video', return_value='720p'):
                    with self.assertRaises(SimulatedCrash):
                        self.client.put('/api/upload/'+payload['id'], data=b'video')
                vdl.init_db()
                operation = self.operation(payload['id'])
                row = vdl.db_get_download(payload['id'])
                self.assertEqual(operation['phase'], 'published' if boundary=='published' else 'failed')
                self.assertEqual(row['status'], 'finished' if boundary=='published' else 'interrupted')
                self.assertFalse(operation['cleanup_pending'])
                with vdl.db() as conn:
                    count = conn.execute('SELECT COUNT(*) FROM download_attempts WHERE work_id=?', (payload['id'],)).fetchone()[0]
                self.assertEqual(count, 1)
        self.assertEqual(os.listdir(self.download_dir), ['local.mp4'])

    def test_restart_of_registered_upload_requires_new_file_selection(self):
        payload, _ = self.register()
        vdl.init_db()
        self.assertEqual(self.operation(payload['id'])['phase'], 'failed')
        self.assertEqual(vdl.db_get_download(payload['id'])['status'], 'interrupted')
        self.assertEqual(self.transfer(payload['id']).status_code, 409)
        replay = self.client.post('/api/upload', json=payload)
        self.assertEqual(replay.json['upload']['phase'], 'failed')
        self.assertEqual(self.counts(), (1,1,1,1))

    def test_replaced_temporary_is_preserved_and_intervention_blocks_removal(self):
        payload, _ = self.register()
        replaced = []
        def inspect(path):
            pinned = path+'.original'
            os.rename(path, pinned)
            replaced.append(pinned)
            with open(path,'wb') as output:
                output.write(b'unrelated')
            raise ValueError('Invalid video')
        with mock.patch.object(vdl, 'inspect_uploaded_video', side_effect=inspect):
            response = self.client.put('/api/upload/'+payload['id'], data=b'video')
        self.assertEqual(response.status_code, 415)
        operation = self.operation(payload['id'])
        self.assertTrue(operation['cleanup_pending'])
        with open(operation['temporary_path'],'rb') as stored:
            self.assertEqual(stored.read(), b'unrelated')
        self.assertEqual(self.client.post('/api/remove/'+payload['id']).status_code, 500)
        self.assertIsNotNone(vdl.db_get_download(payload['id']))
        vdl.init_db()
        self.assertTrue(self.operation(payload['id'])['cleanup_pending'])
        self.assertTrue(os.path.exists(operation['temporary_path']))

    def test_replacement_between_cleanup_check_and_retirement_is_restored(self):
        payload, _ = self.register()
        swapped = []
        def checkpoint(phase, operation):
            if phase == 'before_retire' and not swapped:
                source = operation['source']
                os.rename(source, source+'.original')
                with open(source,'wb') as replacement:
                    replacement.write(b'unrelated')
                swapped.append(source)
        with mock.patch.object(vdl, '_upload_checkpoint', side_effect=checkpoint), \
                mock.patch.object(vdl, 'inspect_uploaded_video', side_effect=ValueError('Invalid')):
            response = self.client.put('/api/upload/'+payload['id'], data=b'video')
        self.assertEqual(response.status_code, 415)
        self.assertTrue(self.operation(payload['id'])['cleanup_pending'])
        with open(swapped[0],'rb') as stored:
            self.assertEqual(stored.read(), b'unrelated')

    def test_registration_validation_and_admission_declines_are_correlated(self):
        for changes, status in (({'filesize':0},400), ({'filename':'../'},400),
                                ({'client_mutation_id':self.mutation_id(25*3600)},409),
                                ({'client_mutation_id':self.mutation_id(-360)},409)):
            payload = {**self.payload(), **changes}
            response = self.client.post('/api/upload', json=payload)
            self.assertEqual(response.status_code, status)
            self.assertEqual(response.json['id'], payload['id'])
            self.assertEqual(response.json['mutation']['id'], payload['client_mutation_id'])
            self.assertEqual(response.json['mutation']['outcome'], 'rejected')
        self.assertEqual(self.counts(), (0,0,0,0))

    def test_shared_quota_blocks_new_upload_but_not_recovery(self):
        payload, _ = self.register()
        with mock.patch.object(vdl, 'MUTATION_ACTOR_RECEIPT_LIMIT', 1):
            declined = self.client.post('/api/upload', json=self.payload())
            self.assertEqual(declined.status_code, 429)
            self.assertEqual(declined.json['mutation']['outcome'], 'rejected')
            self.assertEqual(self.client.post('/api/upload', json=payload).status_code, 202)
        self.assertEqual(self.counts(), (1,1,1,1))

    def test_all_adapters_pruning_retains_active_upload_acceptance(self):
        payload, _ = self.register()
        with vdl._db_lock, vdl.db() as conn:
            conn.execute('UPDATE mutation_receipts SET recorded_at=0')
            vdl._prune_mutation_receipts(conn, time.time())
        self.assertEqual(self.counts(), (1,1,1,1))
        self.assertEqual(self.client.get('/api/mutations/'+payload['client_mutation_id']).status_code, 202)

    def test_expired_missing_receipt_is_final_and_replay_cannot_recreate(self):
        payload = {**self.payload(), 'client_mutation_id':self.mutation_id(25*3600)}
        result = self.client.get('/api/mutations/'+payload['client_mutation_id'])
        self.assertEqual(result.status_code, 404)
        self.assertTrue(result.json['final'])
        self.assertEqual(self.client.post('/api/upload', json=payload).status_code, 409)
        self.assertEqual(self.counts(), (0,0,0,0))

    def test_owner_removal_during_processing_keeps_cleanup_ownership(self):
        owner = vdl.db_create_user('local-owner','owner-password','normal')
        client = self.authenticated_client('local-owner','owner-password')
        payload = self.payload()
        self.assertEqual(client.post('/api/upload',json=payload).status_code,202)
        def inspect(_path):
            vdl.db_delete_user(owner['id'])
            return '720p'
        with mock.patch.object(vdl, 'inspect_uploaded_video', side_effect=inspect):
            response = client.put('/api/upload/'+payload['id'],data=b'video')
        self.assertEqual(response.status_code,401)
        self.assertEqual(os.listdir(self.download_dir),[])
        self.assertFalse(self.operation(payload['id'])['cleanup_pending'])
        self.assertEqual(vdl.db_get_download(payload['id'])['status'],'error')
    def test_expired_lookup_waits_for_already_admitted_upload_registration(self):
        from concurrent.futures import ThreadPoolExecutor
        payload = self.payload()
        admission, release, checking = threading.Event(), threading.Event(), threading.Event()
        clients = [self.authenticated_client(), self.authenticated_client()]
        clock = [time.time()]
        record = vdl.download_history.record
        def hold(conn, download_id, **kwargs):
            result = record(conn, download_id, **kwargs)
            if kwargs.get('create'):
                admission.set()
                self.assertTrue(release.wait(5))
            return result
        def lookup():
            checking.set()
            return clients[1].get('/api/mutations/'+payload['client_mutation_id'])
        with mock.patch.object(vdl.download_history, 'record', side_effect=hold), \
                mock.patch.object(vdl.time, 'time', side_effect=lambda:clock[0]), \
                ThreadPoolExecutor(max_workers=2) as pool:
            submitted = pool.submit(clients[0].post, '/api/upload', json=payload)
            self.assertTrue(admission.wait(5))
            clock[0] += vdl.MUTATION_REPLAY_SECONDS + 1
            recovered = pool.submit(lookup)
            self.assertTrue(checking.wait(5))
            release.set()
            first, receipt = submitted.result(5), recovered.result(5)
        self.assertEqual(first.status_code,202)
        self.assertEqual(receipt.status_code,202)
        self.assertEqual(first.json['upload']['attempt_id'],receipt.json['upload']['attempt_id'])
        self.assertEqual(self.counts(),(1,1,1,1))

    def test_cancel_acceptance_survives_lost_acknowledgement(self):
        payload, _ = self.register()
        cancel = {'client_mutation_id':self.mutation_id()}
        with mock.patch.object(vdl, '_publish_metadata_change', side_effect=SimulatedCrash()):
            with self.assertRaises(SimulatedCrash):
                self.client.post('/api/upload/'+payload['id']+'/cancel',json=cancel)
        receipt = self.client.get('/api/mutations/'+cancel['client_mutation_id'])
        self.assertEqual(receipt.status_code,200)
        self.assertEqual(receipt.json['upload']['phase'],'cancelled')
        replay = self.client.post('/api/upload/'+payload['id']+'/cancel',json=cancel)
        self.assertEqual(replay.json,receipt.json)
        self.assertEqual(self.counts(),(1,1,1,2))
        self.assertEqual(self.transfer(payload['id']).status_code,409)

    def test_registration_replay_uses_captured_directory_after_preferences_change(self):
        payload, result = self.register()
        with mock.patch.object(vdl, '_prepare_download_directory', side_effect=ValueError('Directory unavailable')):
            replay = self.client.post('/api/upload',json=payload)
            self.assertEqual(replay.status_code,202)
            self.assertEqual(replay.json,result)
            fresh = self.client.post('/api/upload',json=self.payload())
            self.assertEqual(fresh.status_code,400)
        self.assertEqual(self.counts(),(1,1,1,1))

    def test_legacy_registration_replay_does_not_prepare_new_directory(self):
        payload = self.payload()
        del payload['client_mutation_id']
        first = self.client.post('/api/upload',json=payload)
        with mock.patch.object(vdl, '_prepare_download_directory', side_effect=ValueError('Directory unavailable')):
            replay = self.client.post('/api/upload',json=payload)
        self.assertEqual(first.status_code,202)
        self.assertEqual(replay.status_code,202)
        self.assertEqual(first.json,replay.json)
        self.assertEqual(self.counts(),(1,1,1,0))

    def command_payload(self, upload_id):
        state = vdl.db_get_download(upload_id)
        return {'client_mutation_id':self.mutation_id(), 'expected_revision':state['command_revision'],
                'expected_attempt_id':state['current_attempt_id']}

    def test_download_command_stop_uses_durable_upload_cancellation(self):
        payload, _ = self.register()
        response = self.client.post('/api/stop/'+payload['id'],json=self.command_payload(payload['id']))
        self.assertEqual(response.status_code,202,response.json)
        operation = self.operation(payload['id'])
        self.assertTrue(operation['cancel_requested'])
        self.assertEqual(operation['phase'],'cancelled')
        self.assertEqual(self.transfer(payload['id']).status_code,409)
        self.assertFalse(vdl.is_cancel_requested(payload['id']))
        self.assertEqual(os.listdir(self.download_dir),[])

    def test_download_command_cannot_control_foreign_public_upload(self):
        payload, _ = self.register()
        vdl.db_create_user('other-uploader','other-password','normal')
        other = self.authenticated_client('other-uploader','other-password')
        response = other.post('/api/stop/'+payload['id'],json=self.command_payload(payload['id']))
        self.assertEqual(response.status_code,404)
        self.assertEqual(self.operation(payload['id'])['phase'],'registered')

    def test_download_stop_after_publication_keeps_final_file(self):
        payload, _ = self.register()
        self.assertEqual(self.transfer(payload['id']).status_code,200)
        response = self.client.post('/api/stop/'+payload['id'],json=self.command_payload(payload['id']))
        self.assertEqual(response.status_code,202,response.json)
        self.assertEqual(self.operation(payload['id'])['phase'],'published')
        self.assertFalse(self.operation(payload['id'])['cancel_requested'])
        with open(vdl.db_get_download(payload['id'])['filename'],'rb') as output:
            self.assertEqual(output.read(),b'video')

    def test_upload_pause_commands_have_definite_unsupported_result(self):
        payload, _ = self.register()
        response = self.client.post('/api/pause/'+payload['id'],json=self.command_payload(payload['id']))
        self.assertEqual(response.status_code,409,response.json)
        self.assertEqual(response.json['mutation']['outcome'],'rejected')
        self.assertFalse(vdl.is_pause_requested(payload['id']))

    def test_collection_ownership_is_derived_without_account_ids(self):
        payload, _ = self.register()
        current = self.client.get('/api/current-downloads').json
        row = next(row for row in current if row['id']==payload['id'])
        self.assertTrue(row['can_manage_upload'])
        self.assertNotIn('owner_user_id',row)
        vdl.db_create_user('upload-observer','observer-password','normal')
        other = self.authenticated_client('upload-observer','observer-password')
        row = next(row for row in other.get('/api/current-downloads').json if row['id']==payload['id'])
        self.assertFalse(row['can_manage_upload'])
        self.assertEqual(self.transfer(payload['id']).status_code,200)
        status = self.client.get('/api/upload/'+payload['id']+'/status').json
        self.assertTrue(status['download']['can_manage_upload'])
        self.assertNotIn('owner_user_id',status['download'])

    def test_adopted_requests_bind_complete_accepted_payload(self):
        payload, original = self.register()
        changed = self.client.post('/api/upload',json={**payload,'unexpected':'changed'})
        self.assertEqual(changed.status_code,400)
        self.assertEqual(changed.json['mutation']['outcome'],'rejected')
        self.assertEqual(self.client.post('/api/upload',json=payload).json,original)
        cancel = {'client_mutation_id':self.mutation_id(), 'expected_revision':'1'}
        first = self.client.post('/api/upload/'+payload['id']+'/cancel',json=cancel)
        self.assertEqual(first.status_code,200)
        altered = self.client.post('/api/upload/'+payload['id']+'/cancel',json={**cancel,'expected_revision':'2'})
        self.assertEqual(altered.status_code,409)
        self.assertEqual(altered.json['mutation']['outcome'],'conflicted')
        extra = self.client.post('/api/upload/'+payload['id']+'/cancel',json={**cancel,'unexpected':'changed'})
        self.assertEqual(extra.status_code,400)
        self.assertEqual(self.client.post('/api/upload/'+payload['id']+'/cancel',json=cancel).json,first.json)
        self.assertEqual(self.counts(),(1,1,1,2))

    def test_restart_preserves_replacement_at_uncommitted_publication_path(self):
        payload, _ = self.register()
        def crash(phase, _operation):
            if phase=='linked':
                raise SimulatedCrash()
        with mock.patch.object(vdl, '_upload_checkpoint', side_effect=crash), \
                mock.patch.object(vdl, 'inspect_uploaded_video', return_value='720p'):
            with self.assertRaises(SimulatedCrash):
                self.client.put('/api/upload/'+payload['id'],data=b'video')
        operation = self.operation(payload['id'])
        os.rename(operation['final_path'],operation['final_path']+'.original')
        with open(operation['final_path'],'wb') as replacement:
            replacement.write(b'unrelated publication')
        vdl.init_db()
        self.assertEqual(self.operation(payload['id'])['phase'],'failed')
        self.assertTrue(self.operation(payload['id'])['cleanup_pending'])
        with open(operation['final_path'],'rb') as preserved:
            self.assertEqual(preserved.read(),b'unrelated publication')
        self.assertFalse(os.path.exists(operation['temporary_path']))
        self.assertEqual(self.client.get('/api/file/'+payload['id']).status_code,404)

    def test_adopted_registration_requires_preallocated_resource_identity(self):
        payload = self.payload()
        del payload['id']
        rejected = self.client.post('/api/upload',json=payload)
        self.assertEqual(rejected.status_code,400)
        self.assertEqual(rejected.json['mutation']['outcome'],'rejected')
        self.assertEqual(self.counts(),(0,0,0,0))
        legacy = self.client.post('/api/upload',json={'filename':'legacy.mp4','filesize':5})
        self.assertEqual(legacy.status_code,202)
        self.assertEqual(len(legacy.json['id']),8)

    def test_normal_processing_ownership_does_not_announce_intervention(self):
        payload, _ = self.register()
        observed = []
        def inspect(_path):
            status = self.client.get('/api/upload/'+payload['id']+'/status')
            observed.append(status.json['upload'])
            return '720p'
        with mock.patch.object(vdl,'inspect_uploaded_video',side_effect=inspect):
            response = self.client.put('/api/upload/'+payload['id'],data=b'video')
        self.assertEqual(response.status_code,200)
        self.assertEqual(observed[0]['phase'],'processing')
        self.assertFalse(observed[0]['recovery_required'])
        self.assertFalse(response.json['upload']['recovery_required'])


    def test_registration_directory_errors_never_expose_physical_paths(self):
        payload = self.payload()
        private_path = '/private-storage/another-account/secret-videos'
        failure = ValueError(f"Download directory is not usable: [Errno 13] Permission denied: '{private_path}'")
        with mock.patch.object(vdl, '_prepare_download_directory', side_effect=failure):
            rejected = self.client.post('/api/upload',json=payload)
        self.assertEqual(rejected.status_code,400)
        self.assertEqual(rejected.json['error'],'Upload directory is unavailable; review Settings')
        self.assertEqual(rejected.json['mutation']['outcome'],'rejected')
        self.assertNotIn(private_path,rejected.get_data(as_text=True))
        receipt = self.client.get('/api/mutations/'+payload['client_mutation_id'])
        self.assertEqual(receipt.status_code,404)
        self.assertNotIn(private_path,receipt.get_data(as_text=True))
        self.assertEqual(self.counts(),(0,0,0,0))

    def test_transfer_directory_errors_are_sanitized_in_response_progress_and_receipt(self):
        payload, _ = self.register()
        private_path = '/private-storage/another-account/secret-videos'
        failure = ValueError(f"Download directory is not usable: [Errno 13] Permission denied: '{private_path}'")
        with mock.patch.object(vdl, '_prepare_download_directory', side_effect=failure):
            rejected = self.client.put('/api/upload/'+payload['id'],data=b'video')
        self.assertEqual(rejected.status_code,400)
        self.assertEqual(rejected.json['error'],'Upload directory is unavailable; review Settings')
        self.assertNotIn(private_path,rejected.get_data(as_text=True))
        row = vdl.db_get_download(payload['id'])
        self.assertEqual(row['status'],'error')
        self.assertEqual(row['progress'],'Upload directory is unavailable; review Settings')
        receipt = self.client.get('/api/mutations/'+payload['client_mutation_id'])
        self.assertEqual(receipt.status_code,202)
        self.assertNotIn(private_path,receipt.get_data(as_text=True))
        self.assertEqual(receipt.json['upload']['phase'],'failed')
        self.assertEqual(os.listdir(self.download_dir),[])

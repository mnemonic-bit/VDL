"""Connection revocation receipts retain only the intended credential identity."""
import json
import secrets
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class ConnectionRevocationTest(AppCase):
    endpoint = '/api/extension/connections/'
    companion_headers = {
        'Origin': 'moz-extension://01234567-89ab-cdef-0123-456789abcdef',
        'X-VDL-Companion-Protocol': '1',
        'X-VDL-Companion-Version': '1.0.0',
    }

    def connection(self, username='admin', label='Firefox private device'):
        actor = vdl.db_get_user_by_username(username)
        connection_id, token = vdl._new_companion_token(actor, label, '1.0.0')
        with vdl.db() as conn:
            row = conn.execute('SELECT * FROM extension_tokens WHERE id = ?', (connection_id,)).fetchone()
        return vdl._connection_snapshot(row), token

    def attempt(self, connection, created=None, **updates):
        body = {'client_mutation_id': f'{int((time.time() if created is None else created) * 1000)}-{secrets.token_hex(16)}',
                'expected_revision': connection['revision'], 'generation': connection['generation']}
        return dict(body, **updates)

    def revoke(self, connection, body, client=None):
        return (client or self.client).delete(self.endpoint + connection['id'], json=body)

    def receipt(self, body, client=None):
        return (client or self.client).get('/api/mutations/' + body['client_mutation_id'])

    def token_status(self, token):
        return vdl.app.test_client().get('/api/extension/status',
            headers=dict(self.companion_headers, Authorization='Bearer ' + token))

    def test_canonical_acknowledgement_revokes_credential_and_recovers_after_removal(self):
        connection, token = self.connection()
        capabilities = self.client.get('/api/client-capabilities').json
        self.assertEqual(capabilities['extension_connection_revocation'], 1)
        self.assertIn('connection.revoke', capabilities['actions'])
        listed = self.client.get(self.endpoint.rstrip('/')).json['connections'][0]
        for name, value in connection.items():
            self.assertEqual(listed[name], value)
        self.assertEqual(self.client.get(self.endpoint + connection['id']).json['connection'], connection)
        self.assertEqual(self.token_status(token).status_code, 200)
        body = self.attempt(connection)
        response = self.revoke(connection, body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(response.json['connection'], dict(connection, status='revoked', revision='1'))
        self.assertEqual(response.json['mutation'], {'id': body['client_mutation_id'],
            'domain': 'extension-connection', 'revision': '1', 'outcome': 'committed'})
        self.assertEqual(self.token_status(token).status_code, 401)
        self.assertEqual(self.client.get(self.endpoint + connection['id']).status_code, 404)
        self.assertEqual(self.client.get(self.endpoint.rstrip('/')).json['connections'], [])
        for recovered in (self.receipt(body), self.revoke(connection, body)):
            self.assertEqual(recovered.status_code, 200)
            self.assertEqual(recovered.json['connection'], response.json['connection'])
            self.assertEqual(recovered.json['mutation'], response.json['mutation'])

    def test_lost_response_and_simultaneous_replays_revoke_only_one_identity(self):
        connection, token = self.connection()
        unrelated, unrelated_token = self.connection(label='Another device')
        body = self.attempt(connection)
        clients = [self.authenticated_client() for _ in range(3)]
        barrier = threading.Barrier(3)
        def execute(client):
            barrier.wait()
            return self.revoke(connection, body, client)
        with ThreadPoolExecutor(max_workers=3) as workers:
            responses = list(workers.map(execute, clients))
        self.assertEqual([response.status_code for response in responses], [200] * 3)
        self.assertEqual(len({json.dumps(response.json['mutation'], sort_keys=True) for response in responses}), 1)
        replacement, replacement_token = self.connection()
        self.assertNotEqual(connection['id'], replacement['id'])
        self.assertNotEqual(connection['generation'], replacement['generation'])
        self.assertEqual(self.revoke(connection, body).status_code, 200)
        for live_token in (replacement_token, unrelated_token):
            self.assertEqual(self.token_status(live_token).status_code, 200)
        self.assertEqual(self.token_status(token).status_code, 401)
        with vdl.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM mutation_receipts').fetchone()[0], 1)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM extension_tokens').fetchone()[0], 2)

    def test_generation_and_revision_conflicts_cannot_revoke_replacement(self):
        connection, token = self.connection()
        for change in ({'generation': 'a' * 32}, {'expected_revision': '1'}):
            body = self.attempt(connection, **change)
            response = self.revoke(connection, body)
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json['mutation']['outcome'], 'conflicted')
            self.assertEqual(response.json['connection'], connection)
            self.assertEqual(self.receipt(body).status_code, 409)
        self.assertEqual(self.token_status(token).status_code, 200)
        body = self.attempt(connection)
        self.assertEqual(self.revoke(connection, body).status_code, 200)
        replacement, replacement_token = self.connection()
        with vdl.db() as conn:
            conn.execute('UPDATE extension_tokens SET id = ? WHERE id = ?', (connection['id'], replacement['id']))
        self.assertEqual(self.revoke(connection, body).json['connection']['generation'], connection['generation'])
        current = self.client.get(self.endpoint + connection['id']).json['connection']
        self.assertEqual(current['generation'], replacement['generation'])
        self.assertEqual(self.revoke(current, self.attempt(connection)).status_code, 409)
        self.assertEqual(self.client.get(self.endpoint + connection['id']).status_code, 200)

    def test_fingerprints_bind_action_target_generation_and_revision(self):
        connection, _token = self.connection()
        other, _other_token = self.connection()
        body = self.attempt(connection)
        self.revoke(connection, body)
        for target, changed in ((connection, dict(body, expected_revision='1')),
                                (connection, dict(body, generation='f' * 32)),
                                (other, body)):
            response = self.revoke(target, changed)
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json['code'], 'mutation_id_conflict')
        reused = self.client.post('/api/extension/pairing-codes',
                                 json={'client_mutation_id': body['client_mutation_id'], 'expected_revision': '0'})
        self.assertEqual(reused.status_code, 409)
        self.assertEqual(self.client.get(self.endpoint + other['id']).status_code, 200)

    def test_revocation_and_receipt_roll_back_together(self):
        connection, token = self.connection()
        body = self.attempt(connection)
        with mock.patch.object(vdl, '_connection_snapshot', wraps=vdl._connection_snapshot) as snapshot:
            snapshot.side_effect = [connection, RuntimeError('injected before receipt commit')]
            with self.assertRaisesRegex(RuntimeError, 'injected'):
                self.revoke(connection, body)
        self.assertEqual(self.token_status(token).status_code, 200)
        self.assertEqual(self.receipt(body).status_code, 404)
        self.assertFalse(self.receipt(body).json['final'])
        self.assertEqual(self.revoke(connection, body).status_code, 200)

    def test_receipts_and_snapshots_never_include_credentials_or_device_metadata(self):
        label = 'private-device-label'
        connection, token = self.connection(label=label)
        body = self.attempt(connection)
        subscriber = vdl.event_bus.subscribe(vdl.db_get_user_by_username('admin')['id'])
        with mock.patch.object(vdl.event_bus, 'publish') as publish:
            acknowledged = self.revoke(connection, body)
            recovered = self.receipt(body)
            replay = self.revoke(connection, body)
            publish.assert_not_called()
        self.assertTrue(subscriber.empty())
        vdl.event_bus.unsubscribe(subscriber)
        for response in (acknowledged, recovered, replay):
            serialized = response.get_data(as_text=True)
            for secret in (label, token, 'token_verifier', 'extension_version', 'last_used_at'):
                self.assertNotIn(secret, serialized)
        with vdl.db() as conn:
            stored = conn.execute('SELECT response, target_id FROM mutation_receipts').fetchone()
        self.assertNotIn(token, str(tuple(stored)))
        self.assertNotIn(label, str(tuple(stored)))

    def test_owner_session_and_current_transaction_authorization(self):
        vdl.db_create_user('connection-other', 'other-password', 'normal')
        other = self.authenticated_client('connection-other', 'other-password')
        connection, token = self.connection()
        body = self.attempt(connection)
        self.assertEqual(self.revoke(connection, body, other).status_code, 404)
        self.assertEqual(other.get(self.endpoint + connection['id']).status_code, 404)
        self.assertEqual(other.get(self.endpoint.rstrip('/')).json['connections'], [])
        with mock.patch.object(vdl, '_tag_actor', return_value=None):
            self.assertEqual(self.revoke(connection, body).status_code, 401)
            self.assertEqual(self.client.get(self.endpoint + connection['id']).status_code, 401)
            self.assertEqual(self.client.get(self.endpoint.rstrip('/')).status_code, 401)
            self.assertEqual(self.receipt(body).status_code, 401)
        self.assertEqual(self.token_status(token).status_code, 200)
        self.revoke(connection, body)
        self.assertEqual(self.receipt(body, other).status_code, 404)
        self.assertEqual(self.revoke(connection, body, other).status_code, 404)
        self.assertEqual(self.receipt(self.attempt(connection), other).json.keys(), self.receipt(body, other).json.keys())

    def test_cached_route_user_cannot_authorize_changed_security_state(self):
        for change in ('suspended', 'session_version', 'owner'):
            with self.subTest(change=change):
                user = vdl.db_create_user('race-' + change, 'race-password', 'normal')
                client = self.authenticated_client(user['username'], 'race-password')
                connection, _token = self.connection(user['username'])
                body = self.attempt(connection)
                original = vdl._tag_actor
                def alter_then_authorize(conn):
                    self.assertEqual(vdl.g.current_user['id'], user['id'])
                    if change == 'owner':
                        conn.execute('UPDATE extension_tokens SET user_id = ? WHERE id = ?',
                                     (vdl.db_get_user_by_username('admin')['id'], connection['id']))
                    elif change == 'suspended':
                        conn.execute('UPDATE users SET suspended = 1 WHERE id = ?', (user['id'],))
                    else:
                        conn.execute('UPDATE users SET session_version = session_version + 1 WHERE id = ?', (user['id'],))
                    return original(conn)
                with mock.patch.object(vdl, '_tag_actor', side_effect=alter_then_authorize):
                    response = self.revoke(connection, body, client)
                self.assertEqual(response.status_code, 404 if change == 'owner' else 401)
                with vdl.db() as conn:
                    self.assertIsNotNone(conn.execute('SELECT 1 FROM extension_tokens WHERE id = ?', (connection['id'],)).fetchone())
                    self.assertIsNone(conn.execute('SELECT 1 FROM mutation_receipts WHERE mutation_id = ?', (body['client_mutation_id'],)).fetchone())

    def test_password_change_suspension_and_account_deletion_fence_recovery(self):
        user = vdl.db_create_user('revocation-account', 'account-password', 'normal')
        client = self.authenticated_client(user['username'], 'account-password')
        connection, _token = self.connection(user['username'])
        body = self.attempt(connection)
        self.revoke(connection, body, client)
        vdl.db_update_user(user['id'], suspended=True)
        self.assertEqual(self.receipt(body, client).status_code, 401)
        vdl.db_update_user(user['id'], suspended=False, password='new-password')
        fresh = self.authenticated_client(user['username'], 'new-password')
        self.assertEqual(self.receipt(body, fresh).status_code, 404)
        self.assertEqual(self.revoke(connection, body, fresh).status_code, 404)
        with vdl.db() as conn:
            conn.execute('DELETE FROM users WHERE id = ?', (user['id'],))
        self.assertEqual(self.receipt(body, fresh).status_code, 401)

    def test_legacy_management_and_companion_self_revocation_preserve_unknown_attempt(self):
        connection, token = self.connection()
        body = self.attempt(connection)
        self.assertEqual(self.client.delete(self.endpoint + connection['id']).status_code, 204)
        self.assertEqual(self.token_status(token).status_code, 401)
        self.assertEqual(self.revoke(connection, body).status_code, 404)
        self.assertEqual(self.receipt(body).status_code, 404)
        self.assertFalse(self.receipt(body).json['final'])
        connection, token = self.connection()
        body = self.attempt(connection)
        response = vdl.app.test_client().delete('/api/extension/token',
            headers=dict(self.companion_headers, Authorization='Bearer ' + token))
        self.assertEqual(response.status_code, 204)
        self.assertEqual(self.revoke(connection, body).status_code, 404)
        self.assertEqual(self.receipt(body).status_code, 404)

    def test_revocation_leaves_already_accepted_download_work_and_pairing_usable(self):
        connection, token = self.connection()
        code = self.client.post('/api/extension/pairing-codes').json['code']
        request_id = str(uuid.uuid4())
        with mock.patch.object(vdl.threading, 'Thread', return_value=mock.Mock()):
            accepted = vdl.app.test_client().post('/api/extension/downloads',
                headers=dict(self.companion_headers, Authorization='Bearer ' + token),
                json={'schema': 1, 'request_id': request_id,
                      'page_url': 'https://video.example/watch/1', 'captured_at': int(time.time()), 'cookies': []})
        self.assertEqual(accepted.status_code, 201, accepted.get_data(as_text=True))
        before = vdl.db_get_download(accepted.json['id'])
        body = self.attempt(connection)
        with mock.patch.object(vdl, 'request_cancel') as cancel:
            self.assertEqual(self.revoke(connection, body).status_code, 200)
            cancel.assert_not_called()
        self.assertEqual(vdl.db_get_download(before['id']), before)
        paired = vdl.app.test_client().post('/api/extension/pair', headers=self.companion_headers,
            json={'code': code, 'origin': 'http://localhost', 'device_label': 'Replacement',
                  'extension_version': '1.0.0', 'protocol_version': 1})
        self.assertEqual(paired.status_code, 201)
        self.assertEqual(self.token_status(paired.json['token']).status_code, 200)
        self.assertEqual(self.revoke(connection, body).status_code, 200)
        self.assertEqual(self.token_status(paired.json['token']).status_code, 200)

    def test_body_validation_age_limits_and_definite_receipts(self):
        connection, token = self.connection()
        self.assertEqual(self.revoke(connection, {'client_mutation_id': 'invalid'}).status_code, 400)
        invalids = [self.attempt(connection, expected_revision=0),
                    self.attempt(connection, expected_revision='01'),
                    self.attempt(connection, generation='bad'),
                    self.attempt(connection, extra='unsupported'),
                    self.attempt(connection, created=time.time() - vdl.MUTATION_REPLAY_SECONDS - 1),
                    self.attempt(connection, created=time.time() + 301)]
        missing = self.attempt(connection)
        missing.pop('generation')
        invalids.append(missing)
        for body in invalids:
            response = self.revoke(connection, body)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json['mutation']['outcome'], 'rejected')
            self.assertEqual(self.receipt(body).status_code, 400)
        for kwargs, expected in (({'json': []}, 400),
                                 ({'data': 'bad', 'content_type': 'application/json'}, 400),
                                 ({'json': {'extra': 'x' * 4096}}, 413),
                                 ({'data': '{}', 'content_type': 'text/plain'}, 415)):
            self.assertEqual(self.client.delete(self.endpoint + connection['id'], **kwargs).status_code, expected)
        self.assertEqual(self.token_status(token).status_code, 200)

    def test_shared_quota_replay_retention_and_expired_absence(self):
        connection, token = self.connection()
        body = self.attempt(connection)
        for limit in ('MUTATION_ACTOR_RECEIPT_LIMIT', 'MUTATION_ACTOR_MINUTE_LIMIT'):
            with mock.patch.object(vdl, limit, 0):
                response = self.revoke(connection, body)
                self.assertEqual(response.status_code, 429)
                self.assertEqual(response.json['code'], 'mutation_limit')
                self.assertNotIn('mutation', response.json)
        self.assertEqual(self.token_status(token).status_code, 200)
        self.assertEqual(self.revoke(connection, body).status_code, 200)
        with mock.patch.object(vdl, 'MUTATION_ACTOR_RECEIPT_LIMIT', 0):
            self.assertEqual(self.revoke(connection, body).status_code, 200)
        replacement, replacement_token = self.connection()
        future = time.time() + vdl.MUTATION_RETENTION_SECONDS + 1
        with mock.patch.object(vdl.time, 'time', return_value=future):
            self.assertEqual(self.revoke(replacement, self.attempt(replacement, expected_revision='1')).status_code, 409)
            absent = self.receipt(body)
            self.assertEqual(absent.status_code, 404)
            self.assertTrue(absent.json['final'])
            self.assertEqual(self.revoke(connection, body).status_code, 404)
            self.assertEqual(self.revoke(replacement, body).status_code, 400)
        self.assertEqual(self.token_status(replacement_token).status_code, 200)

    def test_serialized_expired_absence_waits_for_admitted_revocation(self):
        connection, _token = self.connection()
        body = self.attempt(connection)
        entered = threading.Event()
        release = threading.Event()
        original = vdl._connection_snapshot
        def hold(row, status='connected'):
            if status == 'revoked':
                entered.set()
                self.assertTrue(release.wait(5))
            return original(row, status)
        clients = [self.authenticated_client() for _ in range(2)]
        with mock.patch.object(vdl, '_connection_snapshot', side_effect=hold):
            with ThreadPoolExecutor(max_workers=2) as workers:
                pending = workers.submit(self.revoke, connection, body, clients[0])
                self.assertTrue(entered.wait(5))
                future_time = time.time() + vdl.MUTATION_REPLAY_SECONDS + 1
                with mock.patch.object(vdl.time, 'time', return_value=future_time):
                    checking = workers.submit(self.receipt, body, clients[1])
                    self.assertFalse(checking.done())
                    release.set()
                    self.assertEqual(pending.result().status_code, 200)
                    recovered = checking.result()
        self.assertEqual(recovered.status_code, 200)
        self.assertEqual(recovered.json['mutation']['outcome'], 'committed')

    def test_restart_and_legacy_schema_migration_preserve_generation_and_receipt(self):
        connection, token = self.connection()
        other, other_token = self.connection()
        body = self.attempt(connection)
        self.revoke(connection, body)
        vdl.init_db()
        self.assertEqual(self.client.get(self.endpoint + other['id']).json['connection'], other)
        self.assertEqual(self.receipt(body).json['connection']['status'], 'revoked')
        self.assertEqual(self.token_status(token).status_code, 401)
        self.assertEqual(self.token_status(other_token).status_code, 200)
        with vdl.db() as conn:
            conn.execute('ALTER TABLE extension_tokens DROP COLUMN generation')
            conn.execute('ALTER TABLE extension_tokens DROP COLUMN revision')
        vdl.init_db()
        migrated = self.client.get(self.endpoint + other['id']).json['connection']
        self.assertRegex(migrated['generation'], r'^[0-9a-f]{32}$')
        self.assertEqual(migrated['revision'], '0')
        self.assertEqual(self.token_status(other_token).status_code, 200)
        vdl.init_db()
        self.assertEqual(self.client.get(self.endpoint + other['id']).json['connection'], migrated)

    def test_cross_origin_and_anonymous_requests_cannot_revoke_or_read(self):
        connection, token = self.connection()
        body = self.attempt(connection)
        foreign = self.client.delete(self.endpoint + connection['id'], json=body,
                                    headers={'Origin': 'https://attacker.invalid'})
        self.assertEqual(foreign.status_code, 403)
        anonymous = vdl.app.test_client()
        self.assertEqual(self.revoke(connection, body, anonymous).status_code, 401)
        self.assertEqual(anonymous.get(self.endpoint + connection['id']).status_code, 401)
        self.assertEqual(self.receipt(body, anonymous).status_code, 401)
        self.assertEqual(self.token_status(token).status_code, 200)

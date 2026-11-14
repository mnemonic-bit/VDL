"""Pairing recovery retains non-secret outcomes and fences credential generations."""
import json
from pathlib import Path
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

import vdl
from tests.support.app_case import AppCase


class PairingMutationTest(AppCase):
    endpoint = '/api/extension/pairing-codes'
    companion_headers = {
        'Origin': 'moz-extension://01234567-89ab-cdef-0123-456789abcdef',
        'X-VDL-Companion-Protocol': '1',
        'X-VDL-Companion-Version': '1.0.0',
    }

    def attempt(self, revision='0', generation=None, created=None, **extra):
        payload = {'client_mutation_id': f'{int((time.time() if created is None else created) * 1000)}-{secrets.token_hex(16)}',
                   'expected_revision': revision}
        if generation is not None:
            payload['generation'] = generation
        return dict(payload, **extra)

    def create(self, payload, client=None):
        return (client or self.client).post(self.endpoint, json=payload)

    def invalidate(self, payload, client=None):
        return (client or self.client).delete(self.endpoint + '/current', json=payload)

    def state(self, client=None):
        return (client or self.client).get(self.endpoint + '/current')

    def receipt(self, payload, client=None):
        return (client or self.client).get('/api/mutations/' + payload['client_mutation_id'])

    def consume(self, code):
        return vdl.app.test_client().post('/api/extension/pair', headers=self.companion_headers,
            json={'code': code, 'origin': 'http://localhost', 'device_label': 'Firefox',
                  'extension_version': '1.0.0', 'protocol_version': 1})

    def test_canonical_creation_invalidation_and_capability(self):
        capabilities = self.client.get('/api/client-capabilities').json
        self.assertEqual(capabilities['extension_pairing'], 1)
        self.assertIn('pairing.create', capabilities['actions'])
        self.assertIn('pairing.invalidate', capabilities['actions'])
        self.assertEqual(self.state().json['pairing'], {
            'generation': None, 'status': 'none', 'expires_at': None, 'revision': '0'})
        payload = self.attempt()
        response = self.create(payload)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        created = response.json
        state = created['pairing']
        self.assertRegex(created['code'], r'^VDL1-[A-Za-z0-9_-]{22}$')
        self.assertEqual(created['created_generation'], state['generation'])
        self.assertEqual(created['mutation'], {'id': payload['client_mutation_id'],
            'domain': 'extension-pairing', 'revision': '1', 'outcome': 'committed'})
        self.assertEqual(self.state().json['pairing'], state)
        invalidation = self.attempt(state['revision'], state['generation'])
        invalidated = self.invalidate(invalidation)
        self.assertEqual(invalidated.status_code, 200)
        self.assertEqual(invalidated.json['pairing']['status'], 'invalidated')
        self.assertEqual(invalidated.json['pairing']['revision'], '2')
        self.assertEqual(self.consume(created['code']).status_code, 401)
        self.assertEqual(self.receipt(invalidation).json['mutation']['outcome'], 'committed')

    def test_lost_creation_response_replay_and_receipt_never_recover_plaintext(self):
        payload = self.attempt()
        created = self.create(payload).json
        replay = self.create(payload)
        recovered = self.receipt(payload)
        self.assertEqual(replay.status_code, 201)
        self.assertEqual(replay.json['mutation'], recovered.json['mutation'])
        for result in (replay.json, recovered.json, self.state().json):
            self.assertNotIn('code', result)
            self.assertNotIn(created['code'], json.dumps(result))
            self.assertEqual(result['pairing'], created['pairing'])
        with vdl.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM extension_pairing_state').fetchone()[0], 1)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM mutation_receipts').fetchone()[0], 1)
            receipt = conn.execute('SELECT response FROM mutation_receipts').fetchone()[0]
            self.assertNotIn(created['code'], receipt)
            self.assertNotIn('verifier', receipt)
        for path in Path(self.temp_dir.name).glob('downloads.db*'):
            self.assertNotIn(created['code'].encode(), path.read_bytes())
        state = created['pairing']
        invalidated = self.invalidate(self.attempt(state['revision'], state['generation'])).json['pairing']
        replacement = self.create(self.attempt(invalidated['revision'])).json
        self.assertNotEqual(created['code'], replacement['code'])
        self.assertNotEqual(state['generation'], replacement['pairing']['generation'])

    def test_simultaneous_creation_replays_mint_one_secret(self):
        clients = [self.authenticated_client() for _ in range(2)]
        barrier = threading.Barrier(2)
        payload = self.attempt()
        def execute(client):
            barrier.wait()
            return self.create(payload, client)
        with ThreadPoolExecutor(max_workers=2) as workers:
            responses = list(workers.map(execute, clients))
        self.assertEqual([response.status_code for response in responses], [201, 201])
        self.assertEqual(sum('code' in response.json for response in responses), 1)
        self.assertEqual(responses[0].json['pairing'], responses[1].json['pairing'])
        self.assertEqual(self.state().json['pairing']['revision'], '1')

    def test_old_invalidation_and_old_replay_cannot_revoke_replacement(self):
        first = self.create(self.attempt()).json['pairing']
        invalidation = self.attempt(first['revision'], first['generation'])
        invalidated = self.invalidate(invalidation).json['pairing']
        second = self.create(self.attempt(invalidated['revision'])).json
        replay = self.invalidate(invalidation)
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json['pairing'], second['pairing'])
        stale = self.invalidate(self.attempt(second['pairing']['revision'], first['generation']))
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json['mutation']['outcome'], 'conflicted')
        self.assertEqual(self.consume(second['code']).status_code, 201)
        self.assertEqual(self.state().json['pairing']['status'], 'consumed')
        self.assertEqual(self.receipt(invalidation).json['pairing']['status'], 'consumed')

    def test_replacement_conflicts_old_revision_and_refreshes_create_receipt(self):
        payload = self.attempt()
        first = self.create(payload).json
        replacement = self.client.post(self.endpoint).json
        self.assertNotEqual(first['pairing']['generation'], replacement['pairing']['generation'])
        conflict = self.invalidate(self.attempt('1', first['pairing']['generation']))
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json['pairing'], replacement['pairing'])
        self.assertEqual(self.receipt(payload).json['pairing'], replacement['pairing'])
        self.assertEqual(self.receipt(payload).json['created_generation'], first['pairing']['generation'])
        self.assertEqual(self.consume(first['code']).status_code, 401)
        self.assertEqual(self.consume(replacement['code']).status_code, 201)

    def test_expiry_consumption_and_legacy_invalidation_share_revision(self):
        created = self.create(self.attempt()).json
        with mock.patch.object(vdl.time, 'time', return_value=created['expires_at'] + 1):
            expired = self.state().json['pairing']
            self.assertEqual((expired['status'], expired['revision']), ('expired', '2'))
            self.assertEqual(self.consume(created['code']).status_code, 401)
        unchanged = self.invalidate(self.attempt(expired['revision'], expired['generation']))
        self.assertEqual(unchanged.status_code, 200)
        self.assertEqual(unchanged.json['pairing']['revision'], '2')
        replacement = self.client.post(self.endpoint).json
        self.assertEqual(replacement['pairing']['revision'], '3')
        self.assertEqual(self.client.delete(self.endpoint + '/current').status_code, 204)
        self.assertEqual(self.state().json['pairing']['revision'], '4')
        self.assertEqual(self.client.delete(self.endpoint + '/current').status_code, 204)
        self.assertEqual(self.state().json['pairing']['revision'], '4')

    def test_restart_interrupts_verifier_without_losing_receipt_or_minting_secret(self):
        payload = self.attempt()
        created = self.create(payload).json
        vdl.init_db()
        state = self.state().json['pairing']
        self.assertEqual((state['status'], state['revision']), ('interrupted', '2'))
        self.assertEqual(self.consume(created['code']).status_code, 401)
        for response in (self.receipt(payload), self.create(payload)):
            self.assertEqual(response.status_code, 201)
            self.assertEqual(response.json['pairing'], state)
            self.assertNotIn('code', response.json)
        with vdl.db() as conn:
            self.assertIsNone(conn.execute('SELECT verifier FROM extension_pairing_state').fetchone()[0])

    def test_failed_transaction_rolls_back_verifier_and_receipt_together(self):
        payload = self.attempt()
        original = vdl._create_pairing_code
        def crash(conn, actor, origin, state):
            original(conn, actor, origin, state)
            raise RuntimeError('injected pre-commit failure')
        with mock.patch.object(vdl, '_create_pairing_code', side_effect=crash):
            with self.assertRaises(RuntimeError):
                self.create(payload)
        self.assertEqual(self.state().json['pairing']['status'], 'none')
        missing = self.receipt(payload)
        self.assertEqual(missing.status_code, 404)
        self.assertFalse(missing.json['final'])
        self.assertEqual(self.create(payload).status_code, 201)

    def test_actor_isolation_and_fingerprint_conflict(self):
        payload = self.attempt()
        created = self.create(payload).json
        changed = dict(payload, expected_revision='1')
        conflict = self.create(changed)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json['code'], 'mutation_id_conflict')
        self.assertEqual(self.invalidate(dict(payload, generation=created['created_generation'])).status_code, 409)
        vdl.db_create_user('pairing-other', 'other-password', 'normal')
        other = self.authenticated_client('pairing-other', 'other-password')
        self.assertEqual(self.receipt(payload, other).status_code, 404)
        self.assertEqual(self.state(other).json['pairing']['status'], 'none')
        other_creation = self.create(payload, other)
        self.assertEqual(other_creation.status_code, 201)
        self.assertNotEqual(other_creation.json['code'], created['code'])
        self.assertEqual(self.receipt(payload).json['created_generation'], created['created_generation'])

    def test_authorization_rechecked_inside_transactions_and_recovery(self):
        payload = self.attempt()
        self.create(payload)
        with mock.patch.object(vdl, '_tag_actor', return_value=None):
            self.assertEqual(self.create(self.attempt('1')).status_code, 401)
            self.assertEqual(self.invalidate(self.attempt('1', 'a' * 32)).status_code, 401)
            self.assertEqual(self.state().status_code, 401)
            self.assertEqual(self.receipt(payload).status_code, 401)
        anonymous = vdl.app.test_client()
        self.assertEqual(anonymous.get(self.endpoint + '/current').status_code, 401)
        self.assertEqual(anonymous.post(self.endpoint).status_code, 401)
        self.assertEqual(anonymous.get('/api/mutations/' + payload['client_mutation_id']).status_code, 401)
        self.assertEqual(self.create(self.attempt('1'), anonymous).status_code, 401)
        self.assertEqual(self.client.post(self.endpoint, headers={'Origin': 'https://attacker.invalid'}).status_code, 403)

    def test_suspension_and_password_reset_never_restore_old_credentials(self):
        user = vdl.db_create_user('pairing-account', 'account-password', 'normal')
        client = self.authenticated_client('pairing-account', 'account-password')
        payload = self.attempt()
        created = self.create(payload, client).json
        vdl.db_update_user(user['id'], suspended=True)
        self.assertEqual(self.state(client).status_code, 401)
        self.assertEqual(self.consume(created['code']).status_code, 401)
        vdl.db_update_user(user['id'], suspended=False)
        client = self.authenticated_client('pairing-account', 'account-password')
        self.assertEqual(self.state(client).json['pairing']['status'], 'interrupted')
        self.assertEqual(self.consume(created['code']).status_code, 401)
        second_payload = self.attempt('2')
        second = self.create(second_payload, client).json
        vdl.db_update_user(user['id'], password='changed-password')
        self.assertEqual(self.receipt(second_payload, client).status_code, 401)
        self.assertEqual(self.consume(second['code']).status_code, 401)
        fresh = self.authenticated_client('pairing-account', 'changed-password')
        self.assertEqual(self.receipt(second_payload, fresh).status_code, 404)
        self.assertEqual(self.create(second_payload, fresh).status_code, 404)
        self.assertEqual(self.state(fresh).json['pairing']['status'], 'interrupted')

    def test_token_issuance_rechecks_access_after_consumption(self):
        user = vdl.db_create_user('pairing-race', 'race-password', 'normal')
        client = self.authenticated_client('pairing-race', 'race-password')
        created = self.create(self.attempt(), client).json
        original = vdl._new_companion_token
        def revoke_then_issue(actor, label, version):
            vdl.db_update_user(user['id'], password='changed-password')
            return original(actor, label, version)
        with mock.patch.object(vdl, '_new_companion_token', side_effect=revoke_then_issue):
            self.assertEqual(self.consume(created['code']).status_code, 401)
        with vdl.db() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM extension_tokens').fetchone()[0], 0)

    def test_validation_unknown_fields_age_limits_and_missing_receipts(self):
        self.assertEqual(self.create({'client_mutation_id': 'invalid'}).status_code, 400)
        invalids = [self.attempt(0), self.attempt(extra='unsupported'),
                    self.attempt(created=time.time() - vdl.MUTATION_REPLAY_SECONDS - 1),
                    self.attempt(created=time.time() + 301)]
        for payload in invalids:
            response = self.create(payload)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json['mutation']['outcome'], 'rejected')
            self.assertEqual(self.receipt(payload).status_code, 400)
        for payload in (self.attempt(), self.attempt(generation='bad')):
            self.assertEqual(self.invalidate(payload).status_code, 400)
        for method, path in (('post', self.endpoint), ('delete', self.endpoint + '/current')):
            self.assertEqual(getattr(self.client, method)(path, json=[]).status_code, 400)
            self.assertEqual(getattr(self.client, method)(path, data='bad', content_type='application/json').status_code, 400)
            self.assertEqual(getattr(self.client, method)(path, json={'extra': 'x' * 4096}).status_code, 413)
        old = self.attempt(created=time.time() - vdl.MUTATION_REPLAY_SECONDS - 1)
        self.assertTrue(self.receipt(old).json['final'])
        self.assertEqual(self.state().json['pairing']['status'], 'none')

    def test_shared_quotas_retention_and_accepted_replay(self):
        payload = self.attempt()
        created = self.create(payload).json
        for limit in ('MUTATION_ACTOR_RECEIPT_LIMIT', 'MUTATION_ACTOR_MINUTE_LIMIT'):
            with mock.patch.object(vdl, limit, 0):
                rejected = self.create(self.attempt('1'))
                self.assertEqual(rejected.status_code, 429)
                self.assertEqual(rejected.json['code'], 'mutation_limit')
                self.assertNotIn('mutation', rejected.json)
                replay = self.create(payload)
                self.assertEqual(replay.status_code, 201)
                self.assertNotIn('code', replay.json)
        with mock.patch.object(vdl.time, 'time', return_value=time.time() + vdl.MUTATION_RETENTION_SECONDS + 1):
            self.assertEqual(self.create(self.attempt('0')).status_code, 409)
            self.assertEqual(self.create(payload).status_code, 400)
            self.assertEqual(self.state().json['pairing']['generation'], created['created_generation'])

    def test_pairing_never_broadcasts_credentials_or_receipts(self):
        subscriber = vdl.event_bus.subscribe(vdl.db_get_user_by_username('admin')['id'])
        payload = self.attempt()
        with mock.patch.object(vdl.event_bus, 'publish') as publish:
            created = self.create(payload).json
            self.receipt(payload)
            self.invalidate(self.attempt('1', created['created_generation']))
            publish.assert_not_called()
        self.assertTrue(subscriber.empty())
        vdl.event_bus.unsubscribe(subscriber)

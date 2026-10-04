import json
import hashlib
import ipaddress
from pathlib import Path
import time
import uuid
from unittest import mock
import zipfile

import vdl
from tests.support.app_case import AppCase
from tests.support.fake_ytdlp import FakeYoutubeDL


class BrowserExtensionTest(AppCase):
    companion_headers = {
        'Origin': 'moz-extension://01234567-89ab-cdef-0123-456789abcdef',
        'X-VDL-Companion-Protocol': '1',
        'X-VDL-Companion-Version': '1.0.0',
    }

    def pair(self, label='Firefox test'):
        code_response = self.client.post('/api/extension/pairing-codes')
        self.assertEqual(code_response.status_code, 201)
        code = code_response.get_json()['code']
        response = vdl.app.test_client().post(
            '/api/extension/pair',
            headers=self.companion_headers,
            json={
                'code': code,
                'origin': 'http://localhost',
                'device_label': label,
                'extension_version': '1.0.0',
                'protocol_version': 1,
            },
        )
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        return response.get_json()['token']

    def authorized_headers(self, token):
        return {**self.companion_headers, 'Authorization': f'Bearer {token}'}

    def download_payload(self, **updates):
        payload = {
            'schema': 1,
            'request_id': str(uuid.uuid4()),
            'page_url': 'https://video.example/watch/1?episode=2#fragment',
            'captured_at': int(time.time()),
            'cookies': [{
                'name': 'session',
                'value': 'secret-cookie-value',
                'domain': '.video.example',
                'host_only': False,
                'path': '/watch',
                'secure': True,
                'http_only': True,
                'expires': None,
            }],
        }
        payload.update(updates)
        return payload

    def test_pairing_code_is_shaped_replaced_single_use_and_never_persisted(self):
        first = self.client.post('/api/extension/pairing-codes').get_json()['code']
        second_response = self.client.post('/api/extension/pairing-codes')
        second = second_response.get_json()['code']
        self.assertRegex(second, r'^VDL1-[A-Za-z0-9_-]{22}$')
        self.assertNotEqual(first, second)
        self.assertEqual(second_response.headers['Cache-Control'], 'no-store')

        for code in (first,):
            failed = vdl.app.test_client().post(
                '/api/extension/pair', headers=self.companion_headers,
                json={'code': code, 'origin': 'http://localhost', 'device_label': 'Firefox',
                      'extension_version': '1.0.0', 'protocol_version': 1},
            )
            self.assertEqual(failed.status_code, 401)
            self.assertEqual(failed.get_json()['code'], 'companion_auth_failed')

        wrong_origin = vdl.app.test_client().post(
            '/api/extension/pair', headers=self.companion_headers,
            json={'code': second, 'origin': 'http://127.0.0.1',
                  'device_label': 'Firefox', 'extension_version': '1.0.0',
                  'protocol_version': 1},
        )
        self.assertEqual(wrong_origin.status_code, 401)

        success = vdl.app.test_client().post(
            '/api/extension/pair', headers=self.companion_headers,
            json={'code': second, 'origin': 'http://localhost', 'device_label': 'Firefox',
                  'extension_version': '1.0.0', 'protocol_version': 1},
        )
        self.assertEqual(success.status_code, 201)
        replay = vdl.app.test_client().post(
            '/api/extension/pair', headers=self.companion_headers,
            json={'code': second, 'origin': 'http://localhost', 'device_label': 'Firefox',
                  'extension_version': '1.0.0', 'protocol_version': 1},
        )
        self.assertEqual(replay.status_code, 401)

        token = success.get_json()['token']
        with vdl.db() as connection:
            row = connection.execute('SELECT * FROM extension_tokens').fetchone()
        self.assertNotIn(token.encode(), bytes(row['token_verifier']))
        with open(vdl.DB_PATH, 'rb') as database:
            persisted = database.read()
        self.assertNotIn(second.encode(), persisted)
        self.assertNotIn(token.encode(), persisted)

    def test_local_http_pairing_requires_an_explicit_private_or_shared_cidr(self):
        self.assertEqual(
            vdl._validated_companion_http_networks('192.168.40.0/24'),
            (
                ipaddress.ip_network('127.0.0.0/8'),
                ipaddress.ip_network('192.168.40.0/24'),
            ),
        )
        with self.assertRaises(RuntimeError):
            vdl._validated_companion_http_networks('8.8.8.0/24')
        self.assertIn(
            ipaddress.ip_network('100.96.0.0/24'),
            vdl._validated_companion_http_networks('100.96.0.0/24'),
        )

        denied = vdl.app.test_client()
        login = denied.post(
            '/login', base_url='http://192.168.40.8:5000',
            data={'username': 'admin', 'password': 'test-password'},
        )
        self.assertEqual(login.status_code, 302)
        response = denied.post(
            '/api/extension/pairing-codes',
            base_url='http://192.168.40.8:5000',
            headers={'Origin': 'http://192.168.40.8:5000'},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()['code'], 'pairing_transport_not_allowed')

        networks = vdl._validated_companion_http_networks('192.168.40.0/24')
        with mock.patch.object(vdl, 'COMPANION_HTTP_NETWORKS', networks):
            allowed = denied.post(
                '/api/extension/pairing-codes',
                base_url='http://192.168.40.8:5000',
                headers={'Origin': 'http://192.168.40.8:5000'},
            )
            self.assertEqual(allowed.status_code, 201)
            connections = denied.get(
                '/api/extension/connections',
                base_url='http://192.168.40.8:5000',
            )
            self.assertTrue(connections.get_json()['http_pairing_allowed'])

    def test_token_status_listing_revocation_and_session_invalidation(self):
        token = self.pair('Firefox on laptop')
        status = vdl.app.test_client().get(
            '/api/extension/status', headers=self.authorized_headers(token)
        )
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.get_json()['user']['username'], 'admin')
        self.assertEqual(status.headers['Access-Control-Allow-Origin'], self.companion_headers['Origin'])
        self.assertNotIn('Access-Control-Allow-Credentials', status.headers)

        connections = self.client.get('/api/extension/connections').get_json()
        self.assertEqual(len(connections['connections']), 1)
        connection = connections['connections'][0]
        self.assertNotIn('token_verifier', connection)
        self.assertIsNotNone(connection['last_used_at'])

        admin = vdl.db_get_user_by_username('admin')
        vdl.db_update_user(admin['id'], password='new-test-password')
        rejected = vdl.app.test_client().get(
            '/api/extension/status', headers=self.authorized_headers(token)
        )
        self.assertEqual(rejected.status_code, 401)
        self.assertEqual(rejected.get_json(), {
            'error': 'Companion authentication failed',
            'code': 'companion_auth_failed',
        })

    def test_cors_protocol_media_type_and_body_limits_are_narrow(self):
        preflight = vdl.app.test_client().options(
            '/api/extension/downloads',
            headers={
                'Origin': self.companion_headers['Origin'],
                'Access-Control-Request-Private-Network': 'true',
            },
        )
        self.assertEqual(preflight.status_code, 204)
        self.assertEqual(preflight.headers['Access-Control-Allow-Private-Network'], 'true')
        self.assertNotIn('Access-Control-Allow-Credentials', preflight.headers)
        ordinary = vdl.app.test_client().post(
            '/api/extension/pair',
            headers={**self.companion_headers, 'Origin': 'https://attacker.invalid'},
            json={},
        )
        self.assertEqual(ordinary.status_code, 400)
        incompatible = vdl.app.test_client().get(
            '/api/extension/status',
            headers={**self.companion_headers, 'X-VDL-Companion-Protocol': '2'},
        )
        self.assertEqual(incompatible.status_code, 426)
        self.assertEqual(incompatible.get_json()['supported_protocols'], [1])

        token = self.pair()
        wrong_type = vdl.app.test_client().post(
            '/api/extension/downloads',
            headers=self.authorized_headers(token),
            data='{}', content_type='text/plain',
        )
        self.assertEqual(wrong_type.status_code, 415)
        too_large = vdl.app.test_client().post(
            '/api/extension/downloads',
            headers=self.authorized_headers(token),
            data=b'{' + (b' ' * (256 * 1024)), content_type='application/json',
        )
        self.assertEqual(too_large.status_code, 413)

    def test_private_submission_is_canonical_idempotent_and_resumable(self):
        token = self.pair()
        payload = self.download_payload()
        thread = mock.Mock()
        with mock.patch.object(vdl.threading, 'Thread', return_value=thread) as factory:
            response = vdl.app.test_client().post(
                '/api/extension/downloads',
                headers=self.authorized_headers(token), json=payload,
            )
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        result = response.get_json()
        self.assertEqual(result['action'], 'started')
        self.assertEqual(result['visibility'], 'private')
        row = vdl.db_get_download(result['id'])
        self.assertEqual(row['url'], 'https://video.example/watch/1?episode=2')
        self.assertTrue(row['browser_authenticated'])
        self.assertEqual(row['extension_request_id'], payload['request_id'])
        self.assertEqual(
            factory.call_args.kwargs['args'][2][0]['value'],
            'secret-cookie-value',
        )
        thread.start.assert_called_once()

        with mock.patch.object(vdl.threading, 'Thread') as retry_thread:
            retry = vdl.app.test_client().post(
                '/api/extension/downloads',
                headers=self.authorized_headers(token), json=payload,
            )
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.get_json()['id'], result['id'])
        retry_thread.assert_not_called()

        conflict_payload = self.download_payload(
            request_id=payload['request_id'],
            page_url='https://video.example/watch/other',
            cookies=[],
        )
        conflict = vdl.app.test_client().post(
            '/api/extension/downloads',
            headers=self.authorized_headers(token), json=conflict_payload,
        )
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.get_json()['code'], 'request_id_conflict')

        vdl.db_update_download(result['id'], status='cancelled')
        normal = self.client.post(f"/api/resume/{result['id']}")
        self.assertEqual(normal.status_code, 409)
        self.assertEqual(normal.get_json()['code'], 'fresh_browser_cookies_required')
        resumed_payload = self.download_payload()
        with mock.patch.object(vdl.threading, 'Thread', return_value=mock.Mock()):
            resumed = vdl.app.test_client().post(
                '/api/extension/downloads',
                headers=self.authorized_headers(token), json=resumed_payload,
            )
        self.assertEqual(resumed.status_code, 200)
        self.assertEqual(resumed.get_json()['action'], 'resumed')
        self.assertEqual(resumed.get_json()['id'], result['id'])

    def test_cookie_validation_conversion_and_redaction(self):
        canonical = vdl._canonical_page_url('HTTPS://Bücher.example:443/watch/x?q=1#f')
        self.assertEqual(canonical, 'https://xn--bcher-kva.example/watch/x?q=1')
        cookie_url = 'https://video.example/watch/x?q=1'
        cookies = vdl._validated_cookies(
            self.download_payload(page_url=cookie_url)['cookies'], cookie_url
        )
        buffer = vdl._cookies_to_netscape(cookies)
        contents = buffer.read()
        self.assertIn('#HttpOnly_.video.example\tTRUE\t/watch\tTRUE\t0\tsession\tsecret-cookie-value', contents)
        buffer.truncate()
        self.assertEqual(buffer.tell(), 0)
        self.assertEqual(buffer.read(), '')
        redacted = vdl._redact_sensitive_text(
            'secret-cookie-value at https://video.example/watch?q=secret#part',
            ('secret-cookie-value',),
        )
        self.assertNotIn('secret-cookie-value', redacted)
        self.assertNotIn('q=secret', redacted)
        self.assertNotIn('#part', redacted)

        bad = self.download_payload()
        bad['cookies'][0]['value'] = 'line\nbreak'
        token = self.pair()
        response = vdl.app.test_client().post(
            '/api/extension/downloads',
            headers=self.authorized_headers(token), json=bad,
        )
        self.assertEqual(response.status_code, 400)
        self.assertNotIn('line', response.get_data(as_text=True))

    def test_worker_reuses_and_closes_one_refreshed_in_memory_cookie_jar(self):
        class RotatingCookieYoutubeDL(FakeYoutubeDL):
            buffers = []
            snapshots = []

            def __init__(self, options):
                super().__init__(options)
                jar = options['cookiefile']
                type(self).buffers.append(jar)
                type(self).snapshots.append(jar.read())
                jar.seek(0)

            def __exit__(self, exc_type, exc, traceback):
                if len(type(self).buffers) == 1:
                    jar = self.options['cookiefile']
                    jar.truncate()
                    jar.write(
                        '# Netscape HTTP Cookie File\n'
                        '.video.example\tTRUE\t/\tTRUE\t0\trotated\tnew-value\n'
                    )
                return False

        download_id = self.insert('cookies1', 'https://video.example/watch/1')
        cookies = vdl._validated_cookies(
            self.download_payload()['cookies'],
            'https://video.example/watch/1?episode=2',
        )
        with (
            mock.patch.object(vdl.yt_dlp, 'YoutubeDL', RotatingCookieYoutubeDL),
            mock.patch.object(vdl, 'ffprobe_resolution', return_value='360p'),
        ):
            vdl.background_download(
                'https://video.example/watch/1?episode=2', download_id, cookies
            )
        self.assertGreaterEqual(len(RotatingCookieYoutubeDL.buffers), 2)
        self.assertEqual(
            len({id(buffer) for buffer in RotatingCookieYoutubeDL.buffers}), 1
        )
        self.assertIn('rotated\tnew-value', RotatingCookieYoutubeDL.snapshots[1])
        self.assertTrue(RotatingCookieYoutubeDL.buffers[0].closed)

    def test_xpi_is_public_integrity_checked_and_fixed_path_only(self):
        anonymous = vdl.app.test_client()
        response = anonymous.get('/browser-extension/vdl-companion-firefox.xpi')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, 'application/x-xpinstall')
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')
        response.close()
        self.assertEqual(anonymous.get('/browser-extension/anything.xpi').status_code, 404)

        with zipfile.ZipFile(vdl.COMPANION_XPI_PATH) as archive:
            manifest = json.loads(archive.read('manifest.json'))
            payload = {
                name for name in archive.namelist()
                if not name.endswith('/') and not name.startswith('META-INF/')
            }
            source = {
                path.relative_to(vdl.COMPANION_XPI_PATH.parents[1] / 'src').as_posix()
                for path in (vdl.COMPANION_XPI_PATH.parents[1] / 'src').rglob('*')
                if path.is_file()
            }
            self.assertEqual(payload, source)
            self.assertEqual(manifest['manifest_version'], 3)
            self.assertEqual(manifest['version'], '1.0.2')
            self.assertEqual(manifest['browser_specific_settings']['gecko']['id'],
                             '{9f743f7e-c0b3-4b99-9e58-6434d3c883d4}')
            self.assertEqual(manifest['browser_specific_settings']['gecko']['strict_min_version'], '140.0')
            self.assertEqual(manifest['incognito'], 'not_allowed')
            self.assertEqual(set(manifest['permissions']), {'activeTab', 'cookies', 'storage'})
            self.assertNotIn(
                'upgrade-insecure-requests',
                manifest['content_security_policy']['extension_pages'],
            )
            forbidden = {'tabs', 'scripting', 'webRequest', 'history', 'downloads',
                         'contextualIdentities', 'nativeMessaging'}
            self.assertTrue(forbidden.isdisjoint(manifest['permissions']))
            self.assertNotIn('update_url', json.dumps(manifest))
            for name in payload:
                if name.endswith(('.js', '.html', '.css')):
                    body = archive.read(name).decode('utf-8')
                    self.assertNotIn('eval(', body)
                    self.assertNotRegex(body, r'<script[^>]+src=["\']https?://')

        checksum = hashlib.sha256(Path(vdl.COMPANION_XPI_PATH).read_bytes()).hexdigest()
        self.assertEqual(checksum, vdl._bundled_extension()['sha256'])


if __name__ == '__main__':
    import unittest
    unittest.main()

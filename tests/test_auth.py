import unittest

from werkzeug.security import check_password_hash

import vdl
from tests.support.app_case import AppCase


class AuthenticationTest(AppCase):
    def test_private_pages_and_apis_require_login(self):
        client = vdl.app.test_client()

        page = client.get('/')
        api = client.get('/api/history')
        health = client.get('/api/health')

        self.assertEqual(page.status_code, 302)
        self.assertEqual(page.headers['Location'], '/login')
        self.assertEqual(api.status_code, 401)
        self.assertEqual(api.get_json(), {'error': 'Authentication required'})
        self.assertEqual(health.status_code, 200)

    def test_first_login_sets_the_initial_admin_password_hash(self):
        admin = vdl.db_get_user_by_username('admin')
        with vdl._db_lock, vdl.db() as connection:
            connection.execute(
                "UPDATE users SET password_hash = NULL, "
                "session_version = session_version + 1 WHERE id = ?",
                (admin['id'],),
            )
        client = vdl.app.test_client()

        setup_page = client.get('/login')
        mismatch = client.post('/login', data={
            'username': 'admin',
            'password': 'new-password',
            'password_confirmation': 'different-password',
        })
        response = client.post('/login', data={
            'username': 'admin',
            'password': 'new-password',
            'password_confirmation': 'new-password',
        })

        self.assertIn('Set administrator password', setup_page.get_data(as_text=True))
        self.assertIn('Passwords do not match', mismatch.get_data(as_text=True))
        self.assertEqual(response.status_code, 302)
        stored = vdl.db_get_user_by_username('admin')['password_hash']
        self.assertNotEqual(stored, 'new-password')
        self.assertTrue(check_password_hash(stored, 'new-password'))
        self.assertEqual(client.get('/').status_code, 200)

    def test_login_logout_and_suspension_are_enforced(self):
        vdl.db_create_user('viewer', 'viewer-password', 'normal')
        client = vdl.app.test_client()

        invalid = client.post('/login', data={
            'username': 'viewer', 'password': 'wrong-password',
        })
        signed_in = client.post('/login', data={
            'username': 'viewer', 'password': 'viewer-password',
        })
        signed_out = client.post('/logout')

        self.assertIn('Invalid username or password', invalid.get_data(as_text=True))
        self.assertEqual(signed_in.status_code, 302)
        self.assertEqual(signed_out.headers['Location'], '/login')
        self.assertEqual(client.get('/api/history').status_code, 401)

        viewer = vdl.db_get_user_by_username('viewer')
        vdl.db_update_user(viewer['id'], suspended=True)
        suspended = client.post('/login', data={
            'username': 'viewer', 'password': 'viewer-password',
        })
        self.assertIn('account is suspended', suspended.get_data(as_text=True))

    def test_normal_users_cannot_access_user_administration(self):
        vdl.db_create_user('viewer', 'viewer-password', 'normal')
        client = self.authenticated_client('viewer', 'viewer-password')

        page = client.get('/').get_data(as_text=True)

        self.assertEqual({
            'users_section_visible': 'id="settings-users"' in page,
            'danger_section_visible': 'id="settings-danger"' in page,
            'users_api_status': client.get('/api/users').status_code,
            'clear_preview_api_status': client.get('/api/clear/preview').status_code,
            'clear_api_status': client.post('/api/clear').status_code,
        }, {
            'users_section_visible': False,
            'danger_section_visible': False,
            'users_api_status': 403,
            'clear_preview_api_status': 403,
            'clear_api_status': 403,
        })

    def test_signed_in_user_is_redirected_away_from_login(self):
        response = self.client.get('/login')

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers['Location'], '/')

    def test_renamed_bootstrap_admin_is_not_recreated_on_restart(self):
        admin = vdl.db_get_user_by_username('admin')

        response = self.client.patch(
            f"/api/users/{admin['id']}", json={'username': 'owner'}
        )
        vdl.init_db()

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(vdl.db_get_user_by_username('admin'))
        self.assertIn('admin', vdl.db_get_user_by_username('owner')['roles'])

    def test_admin_can_add_rename_suspend_reset_and_remove_a_user(self):
        listing = self.client.get('/api/users').get_json()
        self.assertEqual(listing['roles'], ['admin', 'normal'])
        self.assertEqual(listing['users'][0]['username'], 'admin')

        created = self.client.post('/api/users', json={
            'username': 'person',
            'name': 'Person Example',
            'password': 'first-password',
            'role': 'normal',
        })
        user = created.get_json()
        stored = vdl.db_get_user_by_username('person')

        self.assertEqual(created.status_code, 201)
        self.assertEqual(user['name'], 'Person Example')
        self.assertNotIn('password_hash', user)
        self.assertTrue(check_password_hash(
            stored['password_hash'], 'first-password'
        ))

        changed = self.client.patch(f"/api/users/{user['id']}", json={
            'username': 'renamed',
            'name': 'Renamed Person',
            'password': 'second-password',
            'role': 'normal',
            'suspended': True,
        })
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(changed.get_json()['name'], 'Renamed Person')
        self.assertTrue(changed.get_json()['suspended'])

        suspended_client = vdl.app.test_client()
        denied = suspended_client.post('/login', data={
            'username': 'renamed', 'password': 'second-password',
        })
        self.assertIn('account is suspended', denied.get_data(as_text=True))

        self.assertEqual(
            self.client.patch(
                f"/api/users/{user['id']}", json={'suspended': False}
            ).status_code,
            200,
        )
        self.assertEqual(
            self.authenticated_client(
                'renamed', 'second-password'
            ).get('/').status_code,
            200,
        )
        self.assertEqual(
            self.client.delete(f"/api/users/{user['id']}").status_code,
            200,
        )
        self.assertIsNone(vdl.db_get_user_by_username('renamed'))

    def test_admin_cannot_remove_suspend_or_demote_the_last_active_admin(self):
        admin = vdl.db_get_user_by_username('admin')

        responses = (
            self.client.delete(f"/api/users/{admin['id']}"),
            self.client.patch(
                f"/api/users/{admin['id']}", json={'suspended': True}
            ),
            self.client.patch(
                f"/api/users/{admin['id']}", json={'role': 'normal'}
            ),
        )

        self.assertEqual([response.status_code for response in responses], [400, 400, 400])
        self.assertIn(
            'active administrator', responses[-1].get_json()['error']
        )

        backup = vdl.db_create_user(
            'backup-admin', 'backup-password', 'admin'
        )
        allowed = self.client.patch(
            f"/api/users/{admin['id']}", json={'role': 'normal'}
        )
        self.assertEqual(allowed.status_code, 200)
        self.assertIn(
            'admin', vdl.db_get_user_by_id(backup['id'])['roles']
        )

    def test_suspended_last_administrator_cannot_be_demoted(self):
        original_admin = vdl.db_get_user_by_username('admin')
        suspended_admin = vdl.db_create_user(
            'backup-admin', 'backup-password', 'admin'
        )
        vdl.db_update_user(suspended_admin['id'], suspended=True)
        with vdl._db_lock, vdl.db() as connection:
            normal_role = connection.execute(
                "SELECT id FROM roles WHERE name = 'normal'"
            ).fetchone()['id']
            connection.execute(
                "DELETE FROM user_roles WHERE user_id = ?",
                (original_admin['id'],),
            )
            connection.execute(
                "INSERT INTO user_roles(user_id, role_id) VALUES (?, ?)",
                (original_admin['id'], normal_role),
            )

        with self.assertRaisesRegex(ValueError, 'active administrator'):
            vdl.db_update_user(suspended_admin['id'], role_name='normal')

    def test_password_reset_invalidates_an_existing_session(self):
        user = vdl.db_create_user('viewer', 'viewer-password', 'normal')
        viewer_client = self.authenticated_client('viewer', 'viewer-password')

        self.client.patch(
            f"/api/users/{user['id']}",
            json={'password': 'replacement-password'},
        )

        self.assertEqual(viewer_client.get('/api/history').status_code, 401)


if __name__ == '__main__':
    unittest.main()

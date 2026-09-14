import unittest
from unittest import mock

import vdl


class PotProviderConfigurationTest(unittest.TestCase):
    def test_empty_value_disables_provider(self):
        self.assertIsNone(vdl._validated_pot_provider_url('  '))

    def test_provider_url_is_normalized(self):
        self.assertEqual(
            vdl._validated_pot_provider_url(
                'http://bgutil-provider:4416/'
            ),
            'http://bgutil-provider:4416',
        )

    def test_non_http_or_credentialed_urls_are_rejected(self):
        invalid_urls = (
            'file:///tmp/provider',
            'http://user:secret@provider:4416',
            'http://provider:4416?token=secret',
            'http://provider:99999',
        )
        for value in invalid_urls:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                vdl._validated_pot_provider_url(value)

    def test_provider_args_merge_without_overwriting_other_args(self):
        original = {
            'extractor_args': {
                'youtube': {'player_client': ['web']},
                'youtubepot-bgutilhttp': {'disable_innertube': ['1']},
            },
        }
        with mock.patch.object(
            vdl,
            'POT_PROVIDER_URL',
            'http://bgutil-provider:4416',
        ):
            merged = vdl.yt_dlp_options(original)

        self.assertEqual(
            merged['extractor_args']['youtube']['player_client'],
            ['web'],
        )
        self.assertEqual(
            merged['extractor_args']['youtubepot-bgutilhttp'],
            {
                'disable_innertube': ['1'],
                'base_url': ['http://bgutil-provider:4416'],
            },
        )
        self.assertNotIn(
            'base_url',
            original['extractor_args']['youtubepot-bgutilhttp'],
        )


if __name__ == '__main__':
    unittest.main()

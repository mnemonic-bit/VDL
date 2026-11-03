import os
import unittest
from unittest import mock

import vdl


class StartupArgumentsTest(unittest.TestCase):
    def test_sigterm_runs_shutdown_checkpoint_and_restores_handler(self):
        installed = []

        def terminate(**_kwargs):
            installed[0][1](vdl.signal.SIGTERM, None)

        with (mock.patch.dict(os.environ, {'FLASK_DEBUG': '0'}),
              mock.patch.object(vdl.signal, 'signal', side_effect=lambda *args: installed.append(args)),
              mock.patch.object(vdl.signal, 'getsignal', return_value='previous-handler'),
              mock.patch.object(vdl, '_should_start_ingest_import', return_value=True),
              mock.patch.object(vdl, 'start_ingest_import'),
              mock.patch.object(vdl, 'start_metadata_backfill'),
              mock.patch.object(vdl, 'start_duplicate_backfill'),
              mock.patch.object(vdl, 'start_asset_generation'),
              mock.patch.object(vdl, 'stop_ingest_import'),
              mock.patch.object(vdl, 'stop_metadata_backfill'),
              mock.patch.object(vdl, 'stop_duplicate_backfill'),
              mock.patch.object(vdl, 'stop_asset_generation') as stop,
              mock.patch.object(vdl.app, 'run', side_effect=terminate),
              mock.patch('builtins.print'),
              self.assertRaises(SystemExit)):
            vdl.main([])
        stop.assert_called_once_with()
        self.assertEqual(installed[-1], (vdl.signal.SIGTERM, 'previous-handler'))

    def test_command_line_port_overrides_environment(self):
        with (
            mock.patch.dict(os.environ, {
                "PORT": "6000",
                "HOST": "127.0.0.2",
                "FLASK_DEBUG": "0",
            }),
            mock.patch("builtins.print") as print_output,
            mock.patch.object(vdl.app, "run") as run,
        ):
            vdl.main(["--port", "7000"])

        print_output.assert_called_once_with(
            f"VDL startup: UI v{vdl.APP_VERSION} | API v{vdl.APP_VERSION}",
            flush=True,
        )
        run.assert_called_once_with(
            host="127.0.0.2",
            port=7000,
            debug=False,
            threaded=True,
        )

    def test_environment_port_remains_the_fallback(self):
        with (
            mock.patch.dict(os.environ, {"PORT": "6100"}),
            mock.patch("builtins.print"),
            mock.patch.object(vdl.app, "run") as run,
        ):
            vdl.main([])

        self.assertEqual(run.call_args.kwargs["port"], 6100)

    def test_invalid_command_line_port_is_rejected(self):
        for value in ("0", "65536", "not-a-port"):
            with (
                self.subTest(value=value),
                mock.patch("sys.stderr"),
                self.assertRaises(SystemExit),
            ):
                vdl.parse_startup_args(["--port", value])


if __name__ == "__main__":
    unittest.main()

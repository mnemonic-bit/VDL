import os
import unittest
from unittest import mock

import vdl


class StartupArgumentsTest(unittest.TestCase):
    def test_command_line_port_overrides_environment(self):
        with (
            mock.patch.dict(os.environ, {
                "PORT": "6000",
                "HOST": "127.0.0.2",
                "FLASK_DEBUG": "0",
            }),
            mock.patch.object(vdl.app, "run") as run,
        ):
            vdl.main(["--port", "7000"])

        run.assert_called_once_with(
            host="127.0.0.2",
            port=7000,
            debug=False,
            threaded=True,
        )

    def test_environment_port_remains_the_fallback(self):
        with (
            mock.patch.dict(os.environ, {"PORT": "6100"}),
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

import contextlib
import http.server
import os
import re
import threading
import time


class FixtureHandler(http.server.SimpleHTTPRequestHandler):
    range_requests = []
    slow_chunk_delay = 0.01

    def log_message(self, _format, *_args):
        pass

    def send_head(self):
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            self.send_error(404, "Fixture not found")
            return None
        source = open(path, "rb")
        size = os.fstat(source.fileno()).st_size
        start, end = 0, size - 1
        range_header = self.headers.get("Range")
        if range_header:
            match = re.fullmatch(r"bytes=(\d+)-(\d*)", range_header)
            if not match:
                source.close()
                self.send_error(416)
                return None
            start = int(match.group(1))
            end = int(match.group(2)) if match.group(2) else end
            end = min(end, size - 1)
            if start > end:
                source.close()
                self.send_error(416)
                return None
            type(self).range_requests.append((self.path, start, end))
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        source.seek(start)
        source._fixture_remaining = end - start + 1  # type: ignore[attr-defined]
        return source

    def copyfile(self, source, outputfile):
        remaining = source._fixture_remaining
        while remaining:
            chunk = source.read(min(16384, remaining))
            if not chunk:
                break
            try:
                outputfile.write(chunk)
                outputfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                break
            remaining -= len(chunk)
            if self.path.startswith("/slow/"):
                time.sleep(self.slow_chunk_delay)


class LocalFixtureServer:
    def __init__(self, directory):
        handler = lambda *args, **kwargs: FixtureHandler(  # noqa: E731
            *args, directory=directory, **kwargs
        )
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    def __enter__(self):
        FixtureHandler.range_requests = []
        self.thread.start()
        return self

    def __exit__(self, *_exc):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)


@contextlib.contextmanager
def fixture_server(directory):
    with LocalFixtureServer(directory) as server:
        yield server

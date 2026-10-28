"""Process-wide media intake control; extractor and playback traffic stay separate."""

from collections import deque
from decimal import Decimal, InvalidOperation
import functools
import re
import subprocess
import threading
import time
import types

from yt_dlp.downloader.common import FileDownloader
from yt_dlp.downloader.http import HttpFD
from yt_dlp.downloader.hls import HlsFD
from yt_dlp.downloader.dash import DashSegmentsFD
from yt_dlp.downloader.ism import IsmFD
from yt_dlp.downloader.external import ExternalFD
from yt_dlp.utils import DownloadError


_RATE_ERROR = 'Maximum total download speed must be a nonnegative Mbps value with at most two decimal places'
_UNSUPPORTED = 'Unsupported media transfer under the total download bandwidth limit; select a native HTTP, HLS, DASH, or ISM format or set the limit to Unlimited'


def canonical_mbps(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError(_RATE_ERROR)
    text = str(value)
    if not re.fullmatch(r'[0-9]+(?:\.[0-9]{1,2})?', text):
        raise ValueError(_RATE_ERROR)
    try:
        number = Decimal(text)
        # Float accounting must remain finite even for arbitrary JSON integers.
        rate = float(number * 125000)
        if not 0 <= rate < float('inf'):
            raise ValueError(_RATE_ERROR)
        return format(number, 'f').rstrip('0').rstrip('.') if '.' in text else str(int(number))
    except (InvalidOperation, OverflowError):
        raise ValueError(_RATE_ERROR) from None


class SharedBandwidth:
    """A FIFO token bucket. Each read gets at most a tenth-second quantum."""

    def __init__(self, *, cancelled=lambda _id: False, paused=lambda _id: False,
                 pause=lambda _id: None, cancel_error=InterruptedError,
                 clock=time.monotonic):
        self.condition = threading.Condition()
        self.clock = clock
        self.cancelled = cancelled
        self.paused = paused
        self.pause = pause
        self.cancel_error = cancel_error
        self.rate = 0
        self.tokens = 0
        self.updated = clock()
        self.generation = 0
        self.waiters = deque()

    def _refill(self):
        now = self.clock()
        self.tokens = min(self.rate, self.tokens + max(0, now - self.updated) * self.rate)
        self.updated = now

    def configure(self, mbps):
        rate = float(Decimal(canonical_mbps(mbps)) * 125000)
        with self.condition:
            self._refill()
            self.tokens = min(self.tokens, rate) if self.rate else rate
            self.rate = rate
            self.generation += 1
            self.condition.notify_all()

    def wake(self):
        with self.condition:
            self.condition.notify_all()

    def check(self, download_id):
        if self.cancelled(download_id):
            raise self.cancel_error()

    def take(self, download_id, requested):
        ticket = object()
        with self.condition:
            self.waiters.append(ticket)
        try:
            while True:
                self.check(download_id)
                if self.paused(download_id):
                    # A paused reader has no reserved allowance or FIFO place.
                    with self.condition:
                        self.waiters.remove(ticket)
                        self.condition.notify_all()
                    self.pause(download_id)
                    with self.condition:
                        self.waiters.append(ticket)
                    continue
                with self.condition:
                    if not self.rate:
                        return requested, self.generation
                    self._refill()
                    size = min(requested, 16384, max(1, int(self.rate / 10)))
                    if self.waiters[0] is ticket and self.tokens >= size:
                        self.tokens -= size
                        return size, self.generation
                    self.condition.wait(min(0.1, max(0.001, (size - self.tokens) / self.rate)))
        finally:
            with self.condition:
                if ticket in self.waiters:
                    self.waiters.remove(ticket)
                self.condition.notify_all()

    def refund(self, count, generation):
        with self.condition:
            if generation == self.generation and self.rate:
                self._refill()
                self.tokens = min(self.rate, self.tokens + count)
                self.condition.notify_all()


class _MediaResponse:
    def __init__(self, response, controller, download_id):
        self.response = response
        self.controller = controller
        self.download_id = download_id

    def __getattr__(self, name):
        return getattr(self.response, name)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.response.close()

    def read(self, size=-1):
        if size == 0:
            return b''
        if size is None or size < 0:
            parts = []
            while True:
                part = self.read(16384)
                if not part:
                    return b''.join(parts)
                parts.append(part)
        parts = []
        remaining = size
        deadline = self.controller.clock() + 0.1
        while remaining:
            allowance, generation = self.controller.take(self.download_id, remaining)
            # If a network read raises, retain its reservation: partial bytes
            # may have arrived before the error and must still count.
            data = self.response.read(allowance)
            self.controller.refund(allowance - len(data), generation)
            parts.append(data)
            remaining -= len(data)
            # Keep FIFO turns and Stop/Pause checks at each small allowance,
            # without making yt-dlp publish progress for every 16 KiB. Bound
            # aggregation time so slow transfers still report live progress.
            if len(data) < allowance or self.controller.clock() >= deadline:
                break
        return b''.join(parts)


def _guarded_popen(base, controller, download_id):
    class GuardedPopen(base):
        stopped = False

        def __init__(self, *args, **kwargs):
            controller.check(download_id)
            if controller.rate:
                raise DownloadError(_UNSUPPORTED)
            self.transfer_error = None
            super().__init__(*args, **kwargs)
            # Some transports block reading a child's stderr instead of waiting
            # on it. A bounded active-process watcher also interrupts that path.
            threading.Thread(target=self._watch_transfer, daemon=True).start()

        def _watch_transfer(self):
            while self.poll() is None:
                try:
                    controller.check(download_id)
                    if controller.rate:
                        raise DownloadError(_UNSUPPORTED)
                except BaseException as exc:
                    self.transfer_error = exc
                    if self.poll() is None:
                        subprocess.Popen.kill(self)
                    return
                with controller.condition:
                    controller.condition.wait(0.1)

        def _check_transfer(self):
            if self.stopped:
                return
            try:
                if self.transfer_error is not None:
                    raise self.transfer_error
                controller.check(download_id)
                if controller.rate:
                    raise DownloadError(_UNSUPPORTED)
            except BaseException:
                self.stopped = True
                if self.poll() is None:
                    subprocess.Popen.kill(self)
                    subprocess.Popen.wait(self)
                raise

        def wait(self, timeout=None):
            deadline = None if timeout is None else time.monotonic() + timeout
            while True:
                self._check_transfer()
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    return super().wait(timeout=0)
                try:
                    result = super().wait(timeout=min(0.1, remaining) if remaining is not None else 0.1)
                    self._check_transfer()
                    return result
                except subprocess.TimeoutExpired:
                    if deadline is not None and time.monotonic() >= deadline:
                        raise

        def communicate(self, input=None, timeout=None):
            deadline = None if timeout is None else time.monotonic() + timeout
            while True:
                self._check_transfer()
                remaining = None if deadline is None else max(0, deadline - time.monotonic())
                try:
                    return super().communicate(input=input, timeout=min(0.1, remaining) if remaining is not None else 0.1)
                except subprocess.TimeoutExpired:
                    input = None
                    if deadline is not None and time.monotonic() >= deadline:
                        raise
    return GuardedPopen


def _guard_external(method, controller, download_id):
    """Give this downloader private process guards without changing shared globals."""
    function = method.__func__
    if 'Popen' not in function.__globals__:
        raise DownloadError(_UNSUPPORTED)
    namespace = dict(function.__globals__)
    namespace['Popen'] = _guarded_popen(namespace['Popen'], controller, download_id)
    guarded = types.FunctionType(function.__code__, namespace, function.__name__,
                                 function.__defaults__, function.__closure__)
    guarded.__kwdefaults__ = function.__kwdefaults__
    return types.MethodType(guarded, method.__self__)


_original_download = FileDownloader.download
_original_external = ExternalFD.real_download


@functools.wraps(_original_download)
def _download(self, *args, **kwargs):
    state = getattr(self.ydl, '_vdl_bandwidth', None)
    if state is None:
        return _original_download(self, *args, **kwargs)
    controller, download_id = state
    # Unknown transports keep their existing Unlimited behavior. Under a cap,
    # trust only readers whose payload boundary we explicitly account for.
    native = type(self) in (HttpFD, HlsFD, DashSegmentsFD, IsmFD) or isinstance(self, HttpFD)
    if not native and not isinstance(self, ExternalFD):
        if controller.rate:
            raise DownloadError(_UNSUPPORTED)
        if 'Popen' in self.real_download.__func__.__globals__:
            self.real_download = _guard_external(self.real_download, controller, download_id)

        def check_unsupported(_progress):
            controller.check(download_id)
            if controller.rate:
                raise DownloadError(_UNSUPPORTED)
        self.add_progress_hook(check_unsupported)
    controller.check(download_id)
    self.ydl._vdl_media_depth += 1
    try:
        return _original_download(self, *args, **kwargs)
    finally:
        self.ydl._vdl_media_depth -= 1


@functools.wraps(_original_external)
def _external_download(self, *args, **kwargs):
    state = getattr(self.ydl, '_vdl_bandwidth', None)
    if state is not None:
        controller, download_id = state
        controller.check(download_id)
        if controller.rate:
            raise DownloadError(_UNSUPPORTED)
        # HLS can delegate directly to real_download after reading its manifest.
        # Guard the external entry itself as well as FileDownloader.download.
        self._call_downloader = _guard_external(self._call_downloader, controller, download_id)
        self._call_process = _guard_external(self._call_process, controller, download_id)
    return _original_external(self, *args, **kwargs)


FileDownloader.download = _download
ExternalFD.real_download = _external_download


def govern_download(ydl, controller, download_id):
    # Test doubles that never open sockets do not implement the transport API.
    if not hasattr(ydl, 'urlopen'):
        return
    ydl._vdl_bandwidth = (controller, download_id)
    ydl._vdl_media_depth = 0
    original_urlopen = ydl.urlopen

    def urlopen(*args, **kwargs):
        response = original_urlopen(*args, **kwargs)
        if ydl._vdl_media_depth:
            return _MediaResponse(response, controller, download_id)
        return response

    ydl.urlopen = urlopen
    missing = object()
    original_options = {key: ydl.params.get(key, missing)
                        for key in ('hls_prefer_native', 'external_downloader')}

    def select_transport():
        # Unlimited must preserve yt-dlp's original compatibility choices.
        # Re-evaluate at both selection boundaries so live changes during
        # extraction or between audio/video transfers also restore defaults.
        if controller.rate:
            ydl.params['hls_prefer_native'] = True
            ydl.params['external_downloader'] = {'default': 'native'}
        else:
            for key, value in original_options.items():
                if value is missing:
                    ydl.params.pop(key, None)
                else:
                    ydl.params[key] = value

    def with_transport_selection(method):
        @functools.wraps(method)
        def transfer(*args, **kwargs):
            select_transport()
            return method(*args, **kwargs)
        return transfer

    select_transport()
    ydl.process_info = with_transport_selection(ydl.process_info)
    ydl.dl = with_transport_selection(ydl.dl)

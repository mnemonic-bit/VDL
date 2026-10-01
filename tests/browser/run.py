#!/usr/bin/env python3
import atexit
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import uuid


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BROWSER_DIR = os.path.dirname(__file__)


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def has_app(python):
    return subprocess.run(
        [python, "-c", "import flask, yt_dlp"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0


def start_fixture(port):
    python = os.environ.get("VDL_PYTHON") or shutil.which("python3")
    env = os.environ.copy()
    env.update({
        "PORT": str(port),
        "DOWNLOADS_DB": os.path.join(BROWSER_DIR, ".fixture-downloads.db"),
        "DOWNLOADS_DIR": os.path.join(BROWSER_DIR, ".fixture-media"),
        "FLASK_DEBUG": "0",
        "PYTHONPATH": ROOT,
    })
    if python and has_app(python):
        os.makedirs(env["DOWNLOADS_DIR"], exist_ok=True)
        process = subprocess.Popen(
            [python, os.path.join(BROWSER_DIR, "fixture_app.py")],
            cwd=ROOT,
            env=env,
        )

        def cleanup():
            process.terminate()
            try:
                process.wait(5)
            except subprocess.TimeoutExpired:
                process.kill()
            for path in (env["DOWNLOADS_DB"], env["DOWNLOADS_DIR"]):
                if os.path.isdir(path):
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    try:
                        os.unlink(path)
                    except FileNotFoundError:
                        pass

        return process, cleanup

    engine = os.environ.get("CONTAINER_ENGINE") or shutil.which("docker") or shutil.which("podman")
    if not engine:
        raise SystemExit(
            "Browser fixture needs Flask/yt-dlp in VDL_PYTHON, or Docker/Podman as a fallback."
        )
    name = "vdl-browser-" + uuid.uuid4().hex[:12]
    image = os.environ.get("VDL_IMAGE", "vdl:local")
    command = [
        engine, "run", "--rm", "--name", name,
        "-p", f"127.0.0.1:{port}:5000",
        "--tmpfs", "/test-state:rw,mode=1777",
        "-e", "PORT=5000", "-e", "DOWNLOADS_DB=/test-state/downloads.db",
        "-e", "DOWNLOADS_DIR=/test-state/media", "-e", "FLASK_DEBUG=0",
        "-v", f"{ROOT}:/workspace:ro", "-w", "/workspace",
        "--entrypoint", "python", image, "tests/browser/fixture_app.py",
    ]
    process = subprocess.Popen(command)

    def cleanup():
        subprocess.run([engine, "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    return process, cleanup


def wait_until_ready(process, base_url):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise SystemExit(f"Browser fixture exited with status {process.returncode}")
        try:
            with urllib.request.urlopen(base_url + "/login", timeout=1) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.1)
    raise SystemExit("Timed out waiting for the browser fixture")


def main():
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    process, cleanup = start_fixture(port)
    atexit.register(cleanup)
    try:
        wait_until_ready(process, base_url)
        env = os.environ.copy()
        env["VDL_BROWSER_BASE_URL"] = base_url
        local_playwright = os.path.join(BROWSER_DIR, "node_modules", ".bin", "playwright")
        playwright = os.environ.get("PLAYWRIGHT_CLI")
        if not playwright and os.path.isfile(local_playwright):
            playwright = local_playwright
        if not playwright and os.path.isfile("/usr/bin/playwright"):
            playwright = "/usr/bin/playwright"
            global_modules = "/usr/lib/node_modules"
            env["NODE_PATH"] = os.pathsep.join(
                filter(None, (env.get("NODE_PATH"), global_modules))
            )
        command = (
            [playwright, "test"] if playwright
            else ["npx", "--no-install", "playwright", "test"]
        )
        command.extend(["--config", "playwright.config.cjs", *sys.argv[1:]])
        return subprocess.run(command, cwd=BROWSER_DIR, env=env).returncode
    finally:
        cleanup()
        atexit.unregister(cleanup)


if __name__ == "__main__":
    raise SystemExit(main())

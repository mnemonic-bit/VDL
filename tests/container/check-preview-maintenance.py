#!/usr/bin/env python3
"""Exercise graceful/abrupt image replacement with retained preview state."""

import argparse
import json
import os
import shutil
import subprocess
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', default=os.environ.get('VDL_IMAGE', 'vdl:local'))
    parser.add_argument('--engine', default=os.environ.get('CONTAINER_ENGINE')
                        or shutil.which('podman') or shutil.which('docker'))
    args = parser.parse_args()
    if not args.engine:
        parser.error('Docker or Podman is required')
    suffix = uuid.uuid4().hex[:12]
    name = 'vdl-preview-maintenance-' + suffix
    volumes = ['vdl-preview-data-' + suffix, 'vdl-preview-media-' + suffix]

    def run(*command, script=None, check=True):
        result = subprocess.run([args.engine, *command], input=script,
                                capture_output=True, text=True)
        if check and result.returncode:
            raise RuntimeError(f'Container command failed: {command}: {result.stderr}')
        return result.stdout.strip()

    mounts = ['-v', volumes[0] + ':/data', '-v', volumes[1] + ':/downloads']

    def offline(script):
        return run('run', '--rm', '-i', '--network', 'none', *mounts,
                   '--entrypoint', 'python', args.image, '-', script=script)

    def start():
        run('run', '--detach', '--name', name, '--network', 'none', *mounts, args.image)
        for _attempt in range(80):
            probe = subprocess.run([args.engine, 'exec', name, 'python', '-c',
                                    "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/api/health',timeout=1)"],
                                   capture_output=True)
            if probe.returncode == 0:
                return
            status = run('inspect', '--format', '{{.State.Running}}', name)
            if status != 'true':
                raise AssertionError(run('logs', name))
            time.sleep(0.1)
        raise AssertionError('Container did not become healthy: ' + run('logs', name))

    def status():
        return json.loads(run('exec', '-i', name, 'python', '-', script="""
import http.cookiejar, json, urllib.parse, urllib.request
cookies = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
base = 'http://127.0.0.1:5000'
with opener.open(urllib.request.Request(base + '/login', data=urllib.parse.urlencode(
    {'username':'admin','password':'preview-restart-password'}).encode(),method='POST')) as response:
    assert not response.url.endswith('/login'), response.read().decode()
with opener.open(base + '/api/preview-maintenance') as response:
    status = json.load(response)
with opener.open(base + '/api/system/logs') as response:
    logs = json.load(response)
print(json.dumps({'status':status,'logs':logs}))
"""))

    def remove():
        run('rm', '--force', name, check=False)

    try:
        for volume in volumes:
            run('volume', 'create', volume)
        offline("""
import os, shutil, subprocess, time
import vdl
vdl.init_db()
vdl.db_set_initial_admin_password(vdl.db_get_initial_admin()['id'], 'preview-restart-password')
source = '/downloads/restart.mp4'
subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=12:d=12',
                '-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-an','-y',source],check=True)
vdl.db_insert_download('restart1','https://fixture.invalid/restart')
vdl.db_update_download('restart1',status='finished',filename=source,output_dir='/downloads')
entry = vdl.db_get_download('restart1')
queue = vdl._get_asset_queue()
legacy = vdl._preview_path(entry,version=vdl._PREVIEW_CACHE_VERSION-1)
shutil.copyfile(source,legacy)
with open(vdl._thumbnail_path(entry),'wb') as output:
    output.write(b'persisted thumbnail')
with vdl._db_lock,vdl.db() as conn:
    conn.execute("INSERT INTO generated_assets(download_id,kind,version,source,state) VALUES (?,'montage',?,?,'ready')",
                 (entry['id'],vdl._PREVIEW_CACHE_VERSION-1,queue._identity(source)))
queue.register(entry)
with vdl._db_lock,vdl.db() as conn:
    conn.execute("UPDATE generated_assets SET retry_at=? WHERE download_id=? AND kind='montage' AND version=?",
                 (time.time()+3600,entry['id'],vdl._PREVIEW_CACHE_VERSION))
""")
        start()
        initial = status()
        assert initial['status']['left'] == 1, initial
        campaign = initial['status']['campaign_id']
        started = initial['status']['started']
        deadline = initial['status']['next_at']
        run('stop', '--time', '10', name)
        paused = json.loads(offline("""
import json,vdl
with vdl.db() as conn:
    row=conn.execute('SELECT * FROM preview_campaigns').fetchone()
    types=[r[0] for r in conn.execute('SELECT event_type FROM system_logs')]
print(json.dumps({'state':row['state'],'left':row['left_count'],'events':types}))
"""))
        assert paused['state'] == 'paused' and paused['left'] == 1, paused
        assert 'paused' in paused['events'], paused
        remove()
        start()
        resumed = status()
        assert resumed['status']['campaign_id'] == campaign, resumed
        assert resumed['status']['started'] == started, resumed
        assert resumed['status']['next_at'] == deadline, resumed
        assert resumed['status']['left'] == 1, resumed
        assert 'resuming' in {row['event_type'] for row in resumed['logs']['items']}, resumed
        run('kill', '--signal', 'KILL', name)
        remove()
        start()
        interrupted = status()
        assert interrupted['status']['campaign_id'] == campaign, interrupted
        assert interrupted['status']['started'] == started, interrupted
        assert interrupted['status']['next_at'] == deadline, interrupted
        assert interrupted['status']['left'] == 1, interrupted
        assert 'interrupted' in {row['event_type'] for row in interrupted['logs']['items']}, interrupted
        assert interrupted['logs']['total'] >= resumed['logs']['total'], interrupted
        run('stop', '--time', '10', name)
        remove()
        offline("""
import shutil,vdl
queue=vdl._get_asset_queue()
entry=vdl.db_get_download('restart1')
queue.delivery(entry,lease=True)
with vdl._db_lock,vdl.db() as conn:
    conn.execute("UPDATE generated_assets SET retry_at=0 WHERE download_id='restart1' AND kind='montage' AND version=?",
                 (vdl._PREVIEW_CACHE_VERSION,))
queue.replace_demand('test','test',1,['restart1'],'restart1')
def generate(kind,source,destination):
    shutil.copyfile(source,destination)
    return True
queue.generate=generate
assert queue.step()
assert queue.maintenance_status()['updated']==1
""")
        start()
        completed = status()
        assert completed['status']['updated'] == 1 and completed['status']['left'] == 0, completed
        assert completed['status']['campaign_id'] == campaign, completed
        attempts = json.loads(offline("""
import json,vdl
with vdl.db() as conn:
    row=conn.execute("SELECT state,attempts FROM generated_assets WHERE download_id='restart1' AND kind='montage' AND version=?",
                     (vdl._PREVIEW_CACHE_VERSION,)).fetchone()
print(json.dumps(dict(row)))
"""))
        assert attempts == {'state': 'ready', 'attempts': 1}, attempts
        print('Preview maintenance retained logs, counters, pacing, retries, and publication across graceful/abrupt container replacements.')
    finally:
        remove()
        for volume in volumes:
            run('volume', 'rm', '--force', volume, check=False)


if __name__ == '__main__':
    main()

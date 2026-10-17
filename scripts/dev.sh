#!/usr/bin/env bash
# Start only this checkout's services; Ctrl-C cleans up their process groups.
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$TASK_ROOT"
if [[ ! -x .venv/bin/python || ! -x node_modules/.bin/next ]]; then
  echo 'Install backend requirements in .venv and run pnpm install first.' >&2
  exit 1
fi
exec .venv/bin/python - <<'PY'
import os
import signal
import socket
import subprocess
import sys
import time

for port in (8787, 3300):
    with socket.socket() as probe:
        try:
            probe.bind(('127.0.0.1', port))
        except OSError:
            sys.exit(f'Port {port} is occupied. Reuse the running service or stop it yourself; no process was killed.')

children = []

def stop(*_):
    for child in children:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
    deadline = time.monotonic() + 5
    for child in children:
        try:
            child.wait(timeout=max(0.01, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()

signal.signal(signal.SIGINT, lambda *_: sys.exit(130))
signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
try:
    children.append(subprocess.Popen(
        ['.venv/bin/python', '-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', '8787'],
        start_new_session=True))
    children.append(subprocess.Popen(
        ['node_modules/.bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3300'],
        start_new_session=True))
    print('FAULTLINE Lab: http://localhost:3300/lab | API: http://127.0.0.1:8787/api/health', flush=True)
    print('Ctrl-C stops both services started by this script.', flush=True)
    while all(child.poll() is None for child in children):
        time.sleep(0.25)
    sys.exit(next((child.returncode for child in children if child.poll() is not None), 1))
finally:
    stop()
PY

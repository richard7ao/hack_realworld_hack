"""Real selected-object crop -> Rodin mesh. Visual assets never change physics manifests."""
from __future__ import annotations
import asyncio
import hashlib
import json
import os
import re
import struct
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse
import cv2
import httpx
import numpy as np
from dotenv import dotenv_values

BASE = 'https://api.hyper3d.com/api/v2'
TIER = 'Gen-2.5-Extreme-Low'
MAX_GLB_BYTES = 100 * 1024 * 1024


def _key():
    values = dotenv_values(Path(__file__).with_name('.env'))
    return os.getenv('HYPER3D_API_KEY') or os.getenv('RODIN_API_KEY') or values.get('HYPER3D_API_KEY') or values.get('RODIN_API_KEY')


def status():
    return {'configured': bool(_key()), 'provider': 'Hyper3D', 'model': TIER,
            'scope': 'Selected object crop; generated visual mesh; declared dimensions; unchanged collision geometry'}


def _relative(job_id):
    if not re.fullmatch(r'mesh_[a-f0-9]{16}', job_id):
        raise ValueError('Invalid reconstruction job ID')
    return f'reconstructions/{job_id}'


def get_job(storage, job_id):
    return storage.load(f'{_relative(job_id)}/job.json')


def begin_job(storage, session, object_id, physical_footprint_m=None):
    """Prepare one crop synchronously while the caller holds session.lock. No upload here."""
    if not _key():
        raise ValueError('Hyper3D API key is not configured')
    if physical_footprint_m is not None:
        if len(physical_footprint_m) != 2 or any(not isinstance(v, (int, float)) or not np.isfinite(v) or not 0 < v <= 5 for v in physical_footprint_m):
            raise ValueError('Physical footprint must contain two positive finite metre dimensions up to 5 m')
        physical_footprint_m = tuple(float(v) for v in physical_footprint_m)
    tracker = session.tracker
    if time.time() - tracker.received_at > 5 or not tracker.frame_ref:
        raise ValueError('Connect a live camera before reconstructing an object')
    if object_id not in tracker.tracks:
        raise ValueError('Select a tracked object first')
    obj = tracker.tracks[object_id].estimate.model_copy(deep=True)
    if not obj.visible or obj.bbox is None:
        raise ValueError('Selected object must be visible in the latest frame')
    if re.search(r'\b(person|people|human|face|man|woman|child|room|scene|background)\b', obj.label, re.I):
        raise ValueError('Select a workcell object, not a person or room')
    frame_ref = tracker.frame_ref
    if not frame_ref.startswith(f'frames/{session.id}/'):
        raise ValueError('Frame does not belong to this camera session')
    frame_bytes = storage.path(frame_ref).read_bytes()
    frame = cv2.imdecode(np.frombuffer(frame_bytes, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError('Captured frame cannot be decoded')
    height, width = frame.shape[:2]
    x, y, w, h = map(int, obj.bbox)
    if min(w, h) < 8 or x < 0 or y < 0 or x+w > width or y+h > height or w*h > width*height*.6:
        raise ValueError('Use a tight selected-object box inside the camera frame')
    if tracker.homography is None:
        raise ValueError('Calibrate the workspace before reconstructing')
    for px, py in ((x,y),(x+w,y),(x,y+h),(x+w,y+h)):
        wx, wy = tracker.project(px, py)
        if not (0 <= wx <= tracker.workspace[0] and 0 <= wy <= tracker.workspace[1]):
            raise ValueError('Selected object box must be inside the calibrated workspace')
    # No padding: pixels outside the user's selected object rectangle are never uploaded.
    ok, encoded = cv2.imencode('.png', frame[y:y+h, x:x+w].copy())
    if not ok:
        raise ValueError('Cannot encode object crop')
    crop = encoded.tobytes()
    crop_hash = hashlib.sha256(crop).hexdigest()
    root = storage.path('reconstructions')
    if root.exists():
        for saved in root.glob('mesh_*/job.json'):
            previous = json.loads(saved.read_text())
            if previous.get('session_id') == session.id and previous.get('status') not in ('SUCCEEDED', 'FAILED'):
                raise ValueError('One reconstruction is already active for this session')
            if (previous.get('session_id') == session.id and previous.get('object_id') == object_id
                    and previous.get('provenance', {}).get('crop_sha256') == crop_hash
                    and previous.get('status') == 'SUCCEEDED'
                    and previous.get('physical_footprint_m') == (list(physical_footprint_m) if physical_footprint_m else None)):
                return previous
    job_id = 'mesh_' + uuid.uuid4().hex[:16]
    relative = _relative(job_id)
    storage.path(relative).mkdir(parents=True, exist_ok=True)
    storage.path(f'{relative}/input.png').write_bytes(crop)
    dimensions = list(obj.dimensions)
    scale_source = 'declared_dimensions'
    if physical_footprint_m:
        short, long = sorted(physical_footprint_m)
        oriented = (long, short) if dimensions[0] >= dimensions[1] else (short, long)
        if tracker.coordinate_frame == 'workcell_m':
            dimensions[:2] = physical_footprint_m
            scale_source = 'measured_footprint'
        else:
            factor = max(dimensions[:2]) / max(oriented)
            dimensions[:2] = [v*factor for v in oriented]
            scale_source = 'measured_footprint_relative'
    job = {'job_id': job_id, 'session_id': session.id, 'camera_session': session.id, 'object_id': object_id, 'label': obj.label,
           'status': 'QUEUED', 'stage': 'Selected crop ready', 'created_at_ms': time.time()*1000,
           'provider': 'hyper3d', 'input_frame_ref': frame_ref, 'bbox': [x,y,w,h],
           'scale_source': scale_source, 'physical_footprint_m': list(physical_footprint_m) if physical_footprint_m else None,
           'metric_scale_verified': bool(physical_footprint_m and tracker.coordinate_frame == 'workcell_m'),
           'height_source': 'declared_or_assumed', 'progress': 'Selected crop ready',
           'model_url': None, 'dimensions': dimensions, 'coordinate_frame': tracker.coordinate_frame,
           'dimension_source': 'existing_declared_or_assumed_object_dimensions',
           'provenance': {'provider': 'Hyper3D', 'model': TIER, 'frame_ref': frame_ref,
                          'bbox': [x,y,w,h], 'crop_sha256': crop_hash,
                          'frame_sha256': hashlib.sha256(frame_bytes).hexdigest(),
                          'crop_pixels': [w,h], 'measured_fields': obj.measured_fields,
                          'assumed_fields': obj.assumed_fields, 'depth_measured': False,
                          'geometry_role': 'visual_only', 'collider_changed': False},
           'error': None}
    storage.save(f'{relative}/job.json', job)
    return job


def _validate_glb(data):
    if len(data) < 20 or len(data) > MAX_GLB_BYTES or data[:4] != b'glTF':
        raise ValueError('Provider did not return a bounded GLB asset')
    version, length = struct.unpack_from('<II', data, 4)
    if version != 2 or length != len(data):
        raise ValueError('Invalid GLB header')
    chunk_length, chunk_type = struct.unpack_from('<II', data, 12)
    if chunk_type != 0x4E4F534A or chunk_length > len(data)-20:
        raise ValueError('Invalid GLB scene metadata')
    document = json.loads(data[20:20+chunk_length])
    for group in ('buffers', 'images'):
        for item in document.get(group, []):
            if item.get('uri') and not item['uri'].startswith('data:'):
                raise ValueError('GLB must contain its textures and buffers')


async def execute_job(storage, job_id, *, client=None, sleep=asyncio.sleep, deadline_seconds=900):
    """Submit exactly once; poll with backoff; never fabricate or automatically resubmit."""
    relative = _relative(job_id)
    job = get_job(storage, job_id)
    if job['status'] != 'QUEUED':
        return job
    def save(state, stage):
        job.update(status=state, stage=stage, progress=stage, updated_at_ms=time.time()*1000)
        storage.save(f'{relative}/job.json', job)
    save('RUNNING', 'Uploading selected object crop')
    owned = client is None
    client = client or httpx.AsyncClient(timeout=60, follow_redirects=False)
    headers = {'Authorization': f'Bearer {_key()}'}
    started = time.monotonic()
    async def post(path, **kwargs):
        response = await client.post(BASE+path, headers=headers, **kwargs)
        response.raise_for_status()
        payload = response.json()
        if payload.get('error'):
            raise ValueError('Hyper3D rejected the request')
        return payload
    try:
        crop = storage.path(f'{relative}/input.png').read_bytes()
        if hashlib.sha256(crop).hexdigest() != job['provenance']['crop_sha256']:
            raise ValueError('Crop integrity check failed')
        response = await post('/rodin', files={'images': ('object.png', crop, 'image/png')},
            data={'tier': TIER, 'mesh_mode': 'Raw', 'geometry_file_format': 'glb',
                  'quality_override': '10000', 'material': 'PBR'})
        task_uuid = response['uuid']
        subscription_key = response['jobs']['subscription_key']
        job['provenance']['provider_task_uuid'] = task_uuid
        job['provenance']['consumed_credits'] = response.get('consumed')
        save('RUNNING', 'Hyper3D generation queued')
        delay = 5
        while time.monotonic()-started < deadline_seconds:
            await sleep(delay)
            try:
                response = await post('/status', json={'subscription_key': subscription_key})
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code != 429:
                    raise
                retry = exc.response.headers.get('Retry-After', '30')
                delay = min(60, max(5, int(retry))) if retry.isdigit() else 30
                continue
            states = [item['status'] for item in response.get('jobs', [])]
            if 'Failed' in states:
                raise ValueError('Hyper3D generation failed')
            if states and all(state == 'Done' for state in states):
                break
            save('RUNNING', 'Hyper3D generating mesh' if 'Generating' in states else 'Hyper3D waiting for worker')
            delay = min(30, delay+5)
        else:
            raise TimeoutError('Hyper3D generation deadline exceeded')
        save('RUNNING', 'Downloading generated mesh')
        response = await post('/download', json={'task_uuid': task_uuid})
        item = next(item for item in response['list'] if item['name'].lower().endswith('.glb'))
        url = item['url']
        parsed = urlparse(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('Invalid provider download URL')
        # Bearer credentials are sent only to the API, never the signed asset URL.
        response = await client.get(url)
        response.raise_for_status()
        data = response.content
        _validate_glb(data)
        storage.path(f'{relative}/model.glb').write_bytes(data)
        job['provenance']['model_sha256'] = hashlib.sha256(data).hexdigest()
        job['provenance']['model_bytes'] = len(data)
        job['model_url'] = f'/api/faultline/assets/{job_id}/model.glb'
        save('SUCCEEDED', 'Generated visual mesh ready')
    except asyncio.CancelledError:
        job['error'] = 'Reconstruction interrupted; provider task may still be running'
        save('FAILED', 'Interrupted')
        raise
    except Exception as exc:
        job['error'] = ('Hyper3D HTTP '+str(exc.response.status_code) if isinstance(exc, httpx.HTTPStatusError)
                        else str(exc) if isinstance(exc, (ValueError, TimeoutError)) else type(exc).__name__)
        save('FAILED', 'Reconstruction failed')
    finally:
        if owned:
            await client.aclose()
    return job


def get_assets(storage, session_id):
    root = storage.path('reconstructions')
    if not root.exists():
        return []
    jobs = [json.loads(path.read_text()) for path in root.glob('mesh_*/job.json')]
    return sorted((job for job in jobs if job.get('camera_session') == session_id),
                  key=lambda job: job['created_at_ms'], reverse=True)

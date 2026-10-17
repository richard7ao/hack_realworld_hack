import asyncio
import json
import struct
from types import SimpleNamespace
import cv2
import httpx
import numpy as np
import pytest
from backend import hyper3d
from backend.capture import Tracker
from backend.models import Calibration
from backend.storage import Storage


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(hyper3d, '_key', lambda: 'test-secret-never-output')
    storage = Storage(tmp_path)
    tracker = Tracker('test')
    # Synthetic image is confined to mocked tests; never submitted to a real service.
    frame = np.full((100, 100, 3), 200, dtype=np.uint8)
    frame[20:40, 20:50] = (10, 50, 100)
    jpeg = cv2.imencode('.jpg', frame)[1].tobytes()
    ref = 'frames/test/00000001.jpg'
    storage.path(ref).parent.mkdir(parents=True)
    storage.path(ref).write_bytes(jpeg)
    tracker.ingest(jpeg, 1, 0, ref)
    tracker.calibrate(Calibration(corners=[(0,0),(100,0),(100,100),(0,100)]))
    tracker.seed('parcel', 'Parcel', (20,20,30,20), (.1,.06,.04))
    return storage, SimpleNamespace(id='test', tracker=tracker)


def glb():
    scene = json.dumps({'asset': {'version': '2.0'}, 'buffers': []}).encode()
    scene += b' ' * (-len(scene)%4)
    return b'glTF' + struct.pack('<II',2,20+len(scene)) + struct.pack('<II',len(scene),0x4E4F534A) + scene


def test_crop_only_selected_rectangle_and_preserve_dimensions(setup):
    storage, session = setup
    job = hyper3d.begin_job(storage, session, 'parcel')
    crop = cv2.imread(str(storage.path(f"reconstructions/{job['job_id']}/input.png")))
    assert crop.shape[:2] == (20,30)
    assert job['dimensions'] == [.1,.06,.04]
    assert job['scale_source'] == 'declared_dimensions'
    assert job['provenance']['depth_measured'] is False
    assert hyper3d.get_assets(storage, 'other-session') == []
    with pytest.raises(ValueError, match='already active'):
        hyper3d.begin_job(storage, session, 'parcel')


@pytest.mark.parametrize('mutation', ['person','fullframe','outside','stale'])
def test_privacy_guards(setup, mutation):
    storage, session = setup
    obj = session.tracker.tracks['parcel'].estimate
    if mutation == 'person': obj.label = 'Person'
    if mutation == 'fullframe': obj.bbox = (0,0,100,100)
    if mutation == 'outside': obj.bbox = (90,90,30,20)
    if mutation == 'stale': session.tracker.received_at = 0
    with pytest.raises(ValueError):
        hyper3d.begin_job(storage, session, 'parcel')
    assert not storage.path('reconstructions').exists()


def test_full_provider_lifecycle_and_no_auth_to_signed_download(setup):
    storage, session = setup
    job = hyper3d.begin_job(storage, session, 'parcel')
    calls = []
    def handle(request):
        calls.append(request)
        if request.url.path.endswith('/rodin'):
            assert b'Gen-2.5-Extreme-Low' in request.content
            assert b'name="images"' in request.content
            return httpx.Response(201,json={'uuid':'task-1','jobs':{'subscription_key':'private-subscription'},'consumed':.5})
        if request.url.path.endswith('/status'):
            return httpx.Response(201,json={'jobs':[{'status':'Done'}]})
        if request.url.path.endswith('/download'):
            return httpx.Response(201,json={'list':[{'name':'model.glb','url':'https://assets.example/model.glb'}]})
        assert 'authorization' not in request.headers
        return httpx.Response(200,content=glb())
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            return await hyper3d.execute_job(storage, job['job_id'],client=client,sleep=lambda _: asyncio.sleep(0))
    result = asyncio.run(run())
    assert result['status'] == 'SUCCEEDED'
    assert result['model_url'].endswith('/model.glb')
    assert len(calls) == 4
    assert 'private-subscription' not in json.dumps(result)
    assert 'test-secret' not in json.dumps(result)


def test_provider_failure_never_creates_placeholder(setup):
    storage, session = setup
    job = hyper3d.begin_job(storage, session, 'parcel')
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(401,json={'error':'Unauthorized'}))) as client:
            return await hyper3d.execute_job(storage,job['job_id'],client=client)
    result = asyncio.run(run())
    assert result['status'] == 'FAILED'
    assert result['error'] == 'Hyper3D HTTP 401'
    assert result['model_url'] is None
    assert not storage.path(f"reconstructions/{job['job_id']}/model.glb").exists()


def test_reject_external_glb_textures():
    scene = json.dumps({'asset':{'version':'2.0'},'images':[{'uri':'https://outside.invalid/a.png'}]}).encode()
    scene += b' ' * (-len(scene)%4)
    data = b'glTF'+struct.pack('<II',2,20+len(scene))+struct.pack('<II',len(scene),0x4E4F534A)+scene
    with pytest.raises(ValueError,match='contain'):
        hyper3d._validate_glb(data)


@pytest.mark.parametrize('metric', [False, True])
def test_measured_footprint_keeps_assumed_height_and_honest_workspace_scale(setup, metric):
    storage, session = setup
    if metric:
        session.tracker.coordinate_frame = 'workcell_m'
    original = session.tracker.tracks['parcel'].estimate.dimensions
    job = hyper3d.begin_job(storage, session, 'parcel', physical_footprint_m=(.04,.14))
    assert job['dimensions'][0]/job['dimensions'][1] == pytest.approx(1/3.5 if metric else 3.5)
    assert job['dimensions'][2] == original[2]
    assert session.tracker.tracks['parcel'].estimate.dimensions == original
    assert job['physical_footprint_m'] == [.04,.14]
    assert job['metric_scale_verified'] is metric
    assert job['scale_source'] == ('measured_footprint' if metric else 'measured_footprint_relative')
    assert max(job['dimensions'][:2]) == pytest.approx(.14 if metric else max(original[:2]))


@pytest.mark.parametrize('footprint', [(0,.1),(-1,.1),(float('nan'),.1),(6,.1)])
def test_invalid_footprint_rejected_before_crop(setup, footprint):
    storage, session = setup
    with pytest.raises(ValueError,match='footprint'):
        hyper3d.begin_job(storage,session,'parcel',physical_footprint_m=footprint)

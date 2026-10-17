import cv2
import numpy as np
import pytest
from backend.capture import Tracker
from backend.models import Calibration


def jpeg(objects):
    frame = np.full((480, 640, 3), 220, dtype=np.uint8)
    for x, y, color in objects:
        cv2.rectangle(frame, (x, y), (x + 50, y + 30), color, -1)
    return cv2.imencode('.jpg', frame)[1].tobytes()


def test_three_unmarked_colour_objects_move_and_hide():
    t = Tracker("test_synthetic_frames")
    t.ingest(jpeg([(100, 100, (20, 30, 210)), (300, 100, (20, 180, 40)), (100, 300, (210, 40, 20))]), 0, 0, "test.jpg")
    t.calibrate(Calibration(corners=[(0, 0), (640, 0), (640, 480), (0, 480)]))
    for name, x, y in [("red", 100, 100), ("green", 300, 100), ("blue", 100, 300)]:
        t.seed(name, name, (x + 3, y + 3, 44, 24))
    scene = t.ingest(jpeg([(230, 200, (20, 30, 210)), (300, 100, (20, 180, 40)), (100, 300, (210, 40, 20))]), 1, 200, "test2.jpg")
    red = scene.objects[0]
    assert red.visible and red.position[0] > 0.35 and red.confidence > 0.8
    assert len(scene.objects) == 3
    hidden = t.ingest(jpeg([(300, 100, (20, 180, 40)), (100, 300, (210, 40, 20))]), 2, 400, "test3.jpg")
    assert not hidden.objects[0].visible


def test_calibration_units_and_stale_frames():
    t = Tracker("s")
    frame = jpeg([])
    t.ingest(frame, 1, 200, "f.jpg")
    t.calibrate(Calibration(corners=[(0, 0), (640, 0), (640, 480), (0, 480)], width=.6, depth=.4))
    assert t.project(320, 240) == pytest.approx((.3, .2))
    assert t.scene().coordinate_frame == "workcell_m"
    with pytest.raises(ValueError, match="STALE_FRAME"):
        t.ingest(frame, 1, 400, "f.jpg")
    with pytest.raises(ValueError):
        t.calibrate(Calibration(corners=[(0, 0)] * 4))

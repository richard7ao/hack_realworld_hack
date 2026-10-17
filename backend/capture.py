"""Selected unmarked-object RGB tracking and planar calibration.

Appearance template matching is intentionally modest: fixed overhead camera,
contrasting objects and manual reseeding when rotation/occlusion defeats tracking.
"""
from __future__ import annotations
import time
import math
from dataclasses import dataclass

import cv2
import numpy as np

from .models import Calibration, ObjectEstimate, ObservedScene


@dataclass
class Track:
    estimate: ObjectEstimate
    template: np.ndarray
    bbox: tuple[int, int, int, int]


class Tracker:
    def __init__(self, session_id):
        self.session_id = session_id
        self.frame = None
        self.frame_ref = None
        self.seq = -1
        self.capture_timestamp = -1
        self.received_at = 0
        self.tracks: dict[str, Track] = {}
        self.calibration: Calibration | None = None
        self.homography = None
        self.workspace = (1.0, 1.0)
        self.coordinate_frame = "workcell_normalized"
        self.camera_source = "laptop_web_rgb"

    def calibrate(self, calibration: Calibration):
        if self.frame is None:
            raise ValueError("Connect camera and capture a frame before calibrating")
        h, w = self.frame.shape[:2]
        points = np.float32(calibration.corners)
        if np.any(points < 0) or np.any(points[:, 0] > w) or np.any(points[:, 1] > h):
            raise ValueError("Workspace corners must lie inside the image")
        if not cv2.isContourConvex(points.astype(np.int32)) or abs(cv2.contourArea(points)) < 400:
            raise ValueError("Select a convex workspace clockwise: top-left, top-right, bottom-right, bottom-left")
        self.workspace = (calibration.width or 1.0, calibration.depth or 1.0)
        width, depth = self.workspace
        self.homography = cv2.getPerspectiveTransform(points, np.float32([[0, 0], [width, 0], [width, depth], [0, depth]]))
        self.calibration = calibration
        self.coordinate_frame = "workcell_m" if calibration.width is not None else "workcell_normalized"
        # Changing coordinate units invalidates old manually supplied geometry.
        self.tracks.clear()

    def project(self, x, y):
        if self.homography is None:
            raise ValueError("Set workspace first")
        point = cv2.perspectiveTransform(np.float32([[[x, y]]]), self.homography)[0, 0]
        return float(point[0]), float(point[1])

    def seed(self, object_id, label, bbox, dimensions=None):
        if self.frame is None or self.homography is None:
            raise ValueError("Camera and workspace calibration are required")
        x, y, width, height = map(int, bbox)
        fh, fw = self.frame.shape[:2]
        if width < 8 or height < 8 or x < 0 or y < 0 or x + width > fw or y + height > fh:
            raise ValueError("Select a box at least 8 pixels wide/high, inside the camera frame")
        if len(self.tracks) >= 12 and object_id not in self.tracks:
            raise ValueError("At most 12 selected objects per workcell")
        template = self.frame[y:y + height, x:x + width].copy()
        px, py = self.project(x + width / 2, y + height / 2)
        if dimensions is None:
            a, b = self.project(x, y), self.project(x + width, y + height)
            dimensions = (max(0.015, abs(b[0] - a[0])), max(0.015, abs(b[1] - a[1])), 0.04)
        obj = ObjectEstimate(id=object_id, label=label, position=(px, py, dimensions[2] / 2), dimensions=dimensions,
                             source="rgb_template_tracker", bbox=(x, y, width, height))
        self.tracks[object_id] = Track(obj, template, (x, y, width, height))
        return obj

    def ingest(self, jpeg: bytes, seq: int, timestamp_ms: float, frame_ref: str):
        if not math.isfinite(timestamp_ms) or timestamp_ms < 0 or not isinstance(seq, int) or seq < 0:
            raise ValueError("INVALID_FRAME_METADATA: finite nonnegative timestamp and integer sequence required")
        if seq <= self.seq or timestamp_ms <= self.capture_timestamp:
            raise ValueError("STALE_FRAME: sequence and capture time must increase")
        if len(jpeg) > 1_500_000:
            raise ValueError("FRAME_TOO_LARGE")
        frame = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is None or frame.shape[0] > 1080 or frame.shape[1] > 1920:
            raise ValueError("INVALID_FRAME: use JPEG at 640×480 or at most 1920×1080")
        if self.frame is not None and frame.shape != self.frame.shape and self.calibration:
            raise ValueError("CAMERA_RESOLUTION_CHANGED: reset camera session and recalibrate")
        self.frame, self.frame_ref = frame, frame_ref
        self.seq, self.capture_timestamp = seq, timestamp_ms
        self.received_at = time.time()
        occupied = np.zeros(frame.shape[:2], np.uint8)
        for track in self.tracks.values():
            template = track.template
            # A constant-colour template has zero normalized correlation variance.
            # Squared error retains colour information for plain unmarked objects.
            texture = float(np.std(cv2.cvtColor(template, cv2.COLOR_BGR2GRAY)))
            method = cv2.TM_CCOEFF_NORMED if texture > 8 else cv2.TM_SQDIFF_NORMED
            scores = cv2.matchTemplate(frame, template, method)
            th, tw = template.shape[:2]
            blocked = cv2.resize(occupied, (scores.shape[1], scores.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
            if method == cv2.TM_SQDIFF_NORMED:
                scores[blocked] = 1
                minimum, _, location, _ = cv2.minMaxLoc(scores)
                confidence = max(0, 1 - minimum)
            else:
                scores[blocked] = -1
                _, maximum, _, location = cv2.minMaxLoc(scores)
                confidence = max(0, maximum)
            x, y = location
            # A second, colour-sensitive check limits matches to unrelated texture.
            patch = frame[y:y + th, x:x + tw]
            colour_error = float(np.mean(np.abs(patch.astype(float).mean(axis=(0, 1)) - template.astype(float).mean(axis=(0, 1)))))
            confidence *= max(0, 1 - colour_error / 100)
            obj = track.estimate
            obj.confidence = round(min(1, confidence), 4)
            obj.visible = confidence >= 0.6
            if obj.visible:
                px, py = self.project(x + tw / 2, y + th / 2)
                obj.position = (px, py, obj.dimensions[2] / 2)
                obj.bbox = (x, y, tw, th)
                track.bbox = (x, y, tw, th)
                occupied[y:y + th, x:x + tw] = 255
            # Retain last estimate when missing; visible:false removes policy certainty.
        return self.scene()

    def scene(self):
        return ObservedScene(session_id=self.session_id, seq=max(0, self.seq), timestamp_ms=self.capture_timestamp,
            coordinate_frame=self.coordinate_frame, workspace=self.workspace,
            camera_source=self.camera_source,
            frame_ref=self.frame_ref, objects=[t.estimate.model_copy(deep=True) for t in self.tracks.values()])

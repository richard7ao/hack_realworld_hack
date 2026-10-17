"""The independent containment check uses the actual pitched/rolled footprint."""
import math
from types import SimpleNamespace

import pytest

from backend.engine import collider_dimensions, inside_destination
from backend.models import Zone


def test_pitch_uses_native_full_box_orientation_for_containment():
    parcel = SimpleNamespace(position=(.5, .5, .1), dimensions=(.2, .1, .05), yaw_rad=0,
        orientation_quaternion=(0, math.sin(math.pi / 4), 0, math.cos(math.pi / 4)))
    assert collider_dimensions(parcel) == pytest.approx((.05, .1, .2))
    narrow_bin = Zone(center=(.5, .5, .1), size=(.08, .12, .3))
    assert inside_destination(parcel, narrow_bin)
    # Identical center and yaw, but a different native rotation cannot be
    # scored as the same footprint merely to turn a failure into a pass.
    parcel.orientation_quaternion = (0, 0, 0, 1)
    assert not inside_destination(parcel, narrow_bin)

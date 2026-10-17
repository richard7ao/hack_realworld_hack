"""Opt-in metric warehouse scenarios. Definitions are never completed results."""
import random

from .kinematics import ArmConfig
from .models import Disturbance, Limits, ObjectEstimate, ObservedScene, Scenario, Task, Zone


def warehouse_cases(count=10, seed=42017):
    if not 1 <= count <= 100:
        raise ValueError("Choose 1 to 100 warehouse cases")
    families = ["clear_aisle", "route_obstruction", "target_displacement", "blocked_pick"]
    cases = []
    for index in range(count):
        rng = random.Random(seed + index)
        family = families[index % len(families)]
        objects = []
        for parcel in range(16):
            x = .65 + (parcel % 4) * .85
            y = .45 + (parcel // 4) * .6
            if parcel == 0:
                x, y = 1.15, 1.2
            objects.append(ObjectEstimate(id=f"parcel_{parcel:02d}", label=f"Warehouse parcel {parcel + 1}",
                position=(x, y, .1), dimensions=(.20 + rng.uniform(-.02, .02), .14, .2),
                confidence=1, source="procedural_warehouse", measured_fields=[],
                assumed_fields=["x", "y", "z", "dimensions", "mass"]))
        scene = ObservedScene(session_id="procedural_warehouse", seq=0, timestamp_ms=0,
            coordinate_frame="workcell_m", sensor_mode="PROCEDURAL", camera_source="procedural_warehouse",
            objects=objects, workspace=(4., 3.))
        racks = [
            Zone(id="rack_west", center=(.16, 1.5, .9), size=(.24, 2.7, 1.8)),
            Zone(id="rack_east", center=(3.84, 1.5, .9), size=(.24, 2.7, 1.8)),
            Zone(id="rack_north", center=(2., 2.86, .9), size=(3.44, .18, 1.8)),
            Zone(id="pallet_south_west", center=(.65, .25, .25), size=(.45, .30, .5)),
            Zone(id="pallet_south_east", center=(3.35, .25, .25), size=(.45, .30, .5)),
        ]
        disturbances = []
        if family == "route_obstruction":
            racks.append(Zone(id="aisle_crate", center=(2.0, 1.05, .4), size=(.30, .48, .8)))
        elif family == "target_displacement":
            disturbances.append(Disturbance(type="MOVE_OBJECT", object_id="parcel_00", after_action_index=1,
                position=(1.15, 1.50 + rng.uniform(0, .12), .1), source="procedural"))
        elif family == "blocked_pick":
            racks.append(Zone(id="blocked_target_cage", center=(1.15, 1.2, .25), size=(.5, .5, .5)))
        arm = ArmConfig()
        cases.append(Scenario(case_id=f"WAREHOUSE-{family}-{seed + index}",
            name=f"4 × 3 m warehouse · {family.replace('_', ' ')} · seed {seed + index}",
            source="procedural", family="warehouse_" + family, seed=seed + index,
            task=Task(target_id="parcel_00"), initial_scene=scene,
            destination=Zone(center=(2.9, 1.05, .1), size=(.55, .50, .30)),
            obstacles=racks, disturbances=disturbances, limits=Limits(max_actions=60, max_sim_seconds=120),
            provenance={"generator": "warehouse_v1", "robot_config": arm.as_dict(),
                "warehouse": {"width_m": 4., "depth_m": 3., "parcel_count": len(objects),
                    "layout": "perimeter racks, central manipulation aisle, outbound pallet"},
                "note": "Procedural rigid-link kinematic simulation, no physical capture, contact dynamics or self-collision model"}))
    return cases

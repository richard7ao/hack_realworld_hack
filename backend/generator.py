"""Seeded definitions, never predeclared outcomes."""
import random
from .models import Disturbance, ObjectEstimate, ObservedScene, Scenario, Task, Zone


def sanity_case(seed=17, family="target_displacement"):
    rng = random.Random(seed)
    target = ObjectEstimate(id="chocolate_A", label="Chocolate parcel", position=(0.28, 0.35, 0.025),
                            dimensions=(0.13, 0.06, 0.04), source="procedural")
    scene = ObservedScene(session_id="procedural", seq=0, timestamp_ms=0, sensor_mode="PROCEDURAL",
        camera_source="procedural", objects=[target,
            ObjectEstimate(id="carton_B", label="Carton", position=(0.55, 0.3, 0.04), source="procedural"),
            ObjectEstimate(id="highlighter_C", label="Slender parcel", position=(0.24, 0.65, 0.02),
                           dimensions=(0.12, 0.035, 0.03), source="procedural")])
    disturbances = []
    if family == "target_displacement":
        disturbances = [Disturbance(type="MOVE_OBJECT", object_id=target.id, after_action_index=1,
                                   position=(0.4 + rng.random() * 0.12, 0.42 + rng.random() * 0.1, 0.025))]
    elif family == "occlusion":
        disturbances = [Disturbance(type="OCCLUDE_OBJECT", object_id=target.id, after_action_index=1)]
    elif family == "obstruction":
        disturbances = [Disturbance(type="ADD_OBSTACLE", after_action_index=1,
                                   obstacle=Zone(id="blocked_target", center=target.position, size=(0.18, 0.12, 0.14)))]
    elif family == "destination_change":
        disturbances = [Disturbance(type="MOVE_DESTINATION", after_action_index=2,
                                   position=(0.78, 0.65 + rng.random() * 0.08, 0.04))]
    elif family == "clutter":
        # A genuine reachable object-position change; no invented friction/slip physics.
        target.yaw_rad = rng.uniform(-1, 1)
        scene.objects[1].position = (0.46, 0.36, 0.04)
    return Scenario(case_id=f"PICK-{family}-{seed}", name=f"{family.replace('_', ' ')} · seed {seed}",
        source="procedural", seed=seed, family=family, task=Task(target_id=target.id),
        initial_scene=scene, disturbances=disturbances,
        provenance={"generator": "picklab_v1", "note": "Procedural symbolic simulation; no physical capture"})


def generate_cases(count=10, seed=42017):
    families = ["target_displacement", "occlusion", "obstruction", "clutter", "destination_change"]
    return [sanity_case(seed + i, families[i % len(families)]) for i in range(count)]


def warehouse_cases(count=10, seed=42017):
    """Separate opt-in larger six-joint workcell; legacy defaults stay unchanged."""
    from .warehouse import warehouse_cases as generate_warehouse
    return generate_warehouse(count=count, seed=seed)

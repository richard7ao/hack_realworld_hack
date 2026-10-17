"""Product environment definitions, separate from execution results."""
from __future__ import annotations


def environment_catalog(native_available=False):
    return [
        {"id": "camera", "name": "Captured workcell", "purpose": "Turn a physical disturbance into a repeatable regression test.",
         "engine": "Cartesian or six-joint kinematics", "fidelity": "Measured RGB planar positions; declared object geometry; simulated manipulation",
         "workspace": "Operator-calibrated tabletop", "units": "normalized or metres", "robot": "Cartesian gripper or metric six-joint arm",
         "case_families": ["physical target displacement", "tracking loss", "operator disturbance"],
         "execution_backends": ["local"], "available": True},
        {"id": "warehouse", "name": "Warehouse floor", "purpose": "Compare policy changes across layout, obstacle and recovery conditions.",
         "engine": "Rigid-link kinematics", "fidelity": "Joint limits, FK/IK and link-obstacle checks; no contact dynamics",
         "workspace": "4 × 3 m; 16 parcels; perimeter racks and pallets", "units": "metres", "robot": "Six-joint arm; interchangeable declared profiles",
         "case_families": ["clear aisle", "route obstruction", "target displacement", "blocked pick"],
         "execution_backends": ["local", "modal_cpu"], "available": True},
        {"id": "physics", "name": "Contact physics", "purpose": "Verify contact, grasp, lift and released placement in a native solver.",
         "engine": "RoboSim Studio / Newton / MuJoCo CPU", "fidelity": "Native rigid-body contacts and measured robot/object poses",
         "workspace": "0.595 × 1.3 m bench; 0.75 m surface height", "units": "metres", "robot": "I2RT YAM; active right 6R arm and two-finger gripper",
         "case_families": ["clean pick", "target displacement"], "execution_backends": ["local"], "available": bool(native_available)},
    ]

"""Independent deterministic evaluator and honest paired release gate."""
from .engine import inside_destination
from .models import CaseResult, GateConfig


def evaluate(env):
    world, case = env.world, env.scenario
    target = next(o for o in world.objects if o.id == case.task.target_id)
    releases = [e for e in env.events if e.kind == "object.released"]
    correctly_released = any(e.data["object_id"] == case.task.target_id and
                             e.data["destination_id"] == case.task.destination_id for e in releases)
    if env.violations:
        return "FAIL", env.violations[0], False
    if world.sim_elapsed_ms > case.limits.max_sim_seconds * 1000:
        return "TIMEOUT", "SIM_TIME_BUDGET", False
    if correctly_released and world.robot.holding_id is None and inside_destination(target, world.destination):
        return "PASS", "CORRECT_ITEM_VERIFIED_IN_DESTINATION", True
    if env.halt_reason == "POLICY_TIMEOUT" or env.truncated:
        return "TIMEOUT", env.halt_reason or "BUDGET_EXCEEDED", False
    if env.halt_reason and env.halt_reason.startswith("POLICY_ERROR"):
        return "UNKNOWN", env.halt_reason, False
    if env.halt_reason == "REQUEST_HELP":
        target_estimate = next((o for o in env.belief_objects if o.id == case.task.target_id), None)
        rejected_before_help = [e.data["result"]["reason"] for e in env.events
            if e.kind == "executor.action_result" and e.data["result"]["status"] == "rejected"]
        blocked_in_observation = target_estimate is not None and any(
            all(abs(target_estimate.position[i] - obstacle.center[i]) <= obstacle.size[i] / 2
                for i in range(3)) for obstacle in env.belief_obstacles)
        appropriate = (target_estimate is None or not target_estimate.visible or target_estimate.confidence < 0.6
                       or blocked_in_observation
                       or bool(rejected_before_help and rejected_before_help[-1] in
                               ("PATH_OBSTRUCTED", "OUT_OF_REACH", "ARM_COLLISION", "UNREACHABLE", "JOINT_LIMIT")))
        return "ESCALATED", "APPROPRIATE_HELP" if appropriate else "UNNECESSARY_HELP", False
    rejected = [e for e in env.events if e.kind == "executor.action_result" and e.data["result"]["status"] == "rejected"]
    return "FAIL", rejected[-1].data["result"]["reason"] if rejected else "GOAL_NOT_SATISFIED", False


def compare_results(baseline: list[CaseResult], candidate: list[CaseResult], config: GateConfig):
    # Case hash prevents comparing different disturbances under the same friendly ID.
    a = {r.scenario_hash: r for r in baseline}
    b = {r.scenario_hash: r for r in candidate}
    keys = sorted(a.keys() & b.keys())
    eligible = [key for key in keys if a[key].verified and b[key].verified and
                a[key].outcome != "UNKNOWN" and b[key].outcome != "UNKNOWN"]
    fixes = [b[k].case_id for k in eligible if a[k].outcome != "PASS" and b[k].outcome == "PASS"]
    regressions = [b[k].case_id for k in eligible if a[k].outcome == "PASS" and b[k].outcome != "PASS"]
    # Candidate violations always block, including cases missing a baseline pair.
    # Repeated trials cannot hide a violation by replacing a dict entry.
    violations = sorted({r.case_id for r in candidate if r.constraint_violations})
    unpaired = sorted({r.case_id for r in candidate if r.scenario_hash not in a})
    unknown_pairs = len(keys) - len(eligible)
    baseline_manifests = {r.policy.model_dump_json() for r in baseline}
    candidate_manifests = {r.policy.model_dump_json() for r in candidate}
    consistent_policies = len(baseline_manifests) <= 1 and len(candidate_manifests) <= 1
    passes = sum(b[k].outcome == "PASS" for k in eligible)
    rate = passes / len(eligible) if eligible else None
    reasons = []
    if violations:
        reasons.append("FORBIDDEN_RULE_VIOLATION")
    if regressions:
        reasons.append("NEW_CRITICAL_REGRESSION")
    if reasons:
        verdict = "BLOCK"
    elif len(eligible) < config.minimum_cases or unpaired or unknown_pairs or not consistent_policies:
        verdict = "INSUFFICIENT_EVIDENCE"
        if len(eligible) < config.minimum_cases:
            reasons.append("MINIMUM_PAIRED_CASES_NOT_MET")
        if unpaired:
            reasons.append("UNPAIRED_CANDIDATE_CASES")
        if unknown_pairs:
            reasons.append("UNKNOWN_OR_UNVERIFIED_RESULT")
        if not consistent_policies:
            reasons.append("MIXED_POLICY_MANIFESTS")
    elif rate < config.completion_threshold:
        verdict = "BLOCK"
        reasons.append("COMPLETION_THRESHOLD_NOT_MET")
    else:
        verdict = "PASS"
    return {"verdict": verdict, "reasons": reasons, "paired_cases": len(keys), "eligible_cases": len(eligible),
            "candidate_passes": passes, "candidate_completion_rate": rate,
            "fixes": fixes, "regressions": regressions, "violations": violations,
            "unpaired_candidate_cases": unpaired, "unknown_pairs": unknown_pairs,
            "config": config.model_dump(), "scope": "simulated symbolic manipulation; not hardware certification"}

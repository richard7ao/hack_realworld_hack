"""Forkbench execution backend, SCAFFOLDING ONLY.

This module is a contract-correct skeleton of the Modal backend that the Forkbench
frontend talks to. It serves the three routes the frontend needs and emits payloads
that match the frozen zod contract in ``src/lib/contract.ts`` exactly. It does NOT
run a robot simulator. Every rollout currently returns a clearly labelled placeholder
result, see ``run_rollout`` below, which is the single function to implement.

Deploy:

    pip install modal
    modal setup                      # one-off authentication
    modal serve modal/app.py         # local dev, hot reloads, prints a temporary URL
    modal deploy modal/app.py        # persistent deployment

Both ``modal serve`` and ``modal deploy`` print the web endpoint URL for ``api``. It
has the shape ``https://<workspace>--forkbench-api-api.modal.run``. Copy whatever the
CLI prints, do not guess it, then set it as ``API_URL`` in the repo root ``.env``
alongside ``DATA_MODE=live``. You can also recover it later with
``modal app list`` and ``modal app history forkbench-api``.
"""

from __future__ import annotations

import os
import random
import time
import uuid
from typing import Callable, Literal, Optional

import modal
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

# ---------------------------------------------------------------------------
# Placeholders the teammate owns. None of these values are measured, they are
# defaults chosen so the endpoint runs. Set them to whatever the real harness needs.
# ---------------------------------------------------------------------------

#: Size of the rollout worker pool. ``Run.concurrency`` is reported from this, and the
#: frontend draws the queue drain against it, so it must match the real pool size.
MAX_CONCURRENCY = 32

#: GPU type for the rollout worker. PLACEHOLDER, pick the one the simulator needs, or
#: delete the ``gpu=`` argument entirely if rollouts run on CPU.
ROLLOUT_GPU: Optional[str] = None

#: Wall-clock ceiling for one rollout, in milliseconds. A rollout that exceeds it is a
#: ``timeout`` failure.
ROLLOUT_TIMEOUT_MS = 20_000

#: CI gate defaults. Wire these to the policy repo's config when that exists.
GATE_THRESHOLD = 0.8
GATE_REGRESSION_TOLERANCE_PP = 2.0

APP_NAME = "forkbench-api"

image = modal.Image.debian_slim().pip_install("fastapi[standard]", "pydantic>=2.0")
app = modal.App(APP_NAME, image=image)

# Run state lives in a Modal Dict so it survives across containers: the container that
# serves GET /runs/{run_id} is usually not the one that ran the rollouts. Keys are
# "<run_id>" for the run skeleton and "<run_id>:sim:<index>" for each rollout. Each
# rollout owns its own key so that concurrent workers never clobber each other with a
# read-modify-write on one shared record. Swap for a Volume or a real database if you
# need run history or queries across runs.
run_state = modal.Dict.from_name("forkbench-run-state", create_if_missing=True)

FailMode = Literal["missed_approach", "grasp_slip", "collision", "dropped_outside", "timeout"]
SimStatus = Literal["queued", "booting", "running", "passed", "failed"]
RunStage = Literal["provisioning", "booting", "rollout", "scoring", "done"]

STAGE_LABEL: dict[RunStage, str] = {
    "provisioning": "Provisioning GPU containers",
    "booting": "Booting simulator instances",
    "rollout": "Running rollouts",
    "scoring": "Scoring rollouts",
    "done": "Scored rollouts",
}


class Contract(BaseModel):
    """Base model for every payload on the wire.

    Fields are snake_case in Python and camelCase in JSON. The contract is frozen, so
    the emitted names must match ``src/lib/contract.ts`` verbatim or the frontend's
    zod parse throws before any component renders.
    """

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Variant(Contract):
    """Domain randomisation applied to one rollout."""

    lighting: float = Field(ge=0, le=1)
    friction: float = Field(ge=0, le=2)
    object_dx: float = Field(ge=-1, le=1)
    object_dy: float = Field(ge=-1, le=1)
    distractors: int = Field(ge=0, le=6)
    camera_jitter: float = Field(ge=0, le=1)


class Metrics(Contract):
    """Per-rollout scalars shown in the inspector."""

    reward: float
    steps: int = Field(ge=0)
    grasp_attempts: int = Field(ge=0)


class Sim(Contract):
    """One rollout.

    ``start_offset_ms`` and ``duration_ms`` are the episode's wall-clock script,
    both relative to the start of the run, not to the start of the episode and not
    absolute timestamps. The client replays the arm motion against them so the grid
    animates smoothly between one second polls.

    ``fail_mode`` and ``fail_at`` must be populated as soon as the failure is detected
    mid-episode, not only once the episode completes. A doomed rollout that reports
    nothing until the end animates as a success and then snaps, which is the single
    most visible way this backend can look broken.
    """

    id: str
    seed: int
    variant: Variant
    status: SimStatus
    start_offset_ms: float = Field(ge=0)
    duration_ms: float = Field(gt=0)
    elbow: Literal[-1, 1]
    fail_mode: Optional[FailMode]
    fail_at: Optional[float] = Field(ge=0, le=1)
    metrics: Metrics


class Policy(Contract):
    """The policy under test."""

    name: str
    commit: str
    branch: str


class Baseline(Contract):
    """The previous green run on the default branch."""

    ref: str
    pass_rate: float = Field(ge=0, le=1)
    n: int = Field(gt=0)


class Gate(Contract):
    """The CI gate. ``baseline`` is null on a first run."""

    metric: Literal["pass_rate"] = "pass_rate"
    threshold: float = Field(ge=0, le=1)
    regression_tolerance_pp: float = Field(ge=0, le=100)
    baseline: Optional[Baseline]


class Progress(Contract):
    """Headline progress line for the run."""

    label: str
    done: int = Field(ge=0)
    total: int = Field(ge=0)


class Run(Contract):
    """A full fan-out evaluation."""

    id: str
    created_at: str
    policy: Policy
    environment_id: str
    environment_name: str
    task: str
    fanout: int = Field(gt=0)
    concurrency: int = Field(gt=0)
    stage: RunStage
    progress: Progress
    sims: list[Sim]
    gate: Gate


class Environment(Contract):
    """One entry in the environment catalogue."""

    id: str
    name: str
    blurb: str
    objects: list[str]
    difficulty: Literal["easy", "medium", "hard"]
    tasks: list[str]


class EnvironmentsResponse(Contract):
    environments: list[Environment]


class CreateRunRequest(Contract):
    environment_id: str = Field(min_length=1)
    task: str = Field(min_length=3, max_length=240)
    fanout: int = Field(ge=1, le=256)


class CreateRunResponse(Contract):
    ok: bool
    run_id: Optional[str]
    error: Optional[str]


class RolloutResult(Contract):
    """What one finished rollout reports back.

    ``start_offset_ms`` is not here on purpose: the scheduler owns it, because only the
    scheduler knows when the rollout actually started relative to run start.
    """

    status: Literal["passed", "failed"]
    duration_ms: float = Field(gt=0)
    fail_mode: Optional[FailMode]
    fail_at: Optional[float] = Field(ge=0, le=1)
    metrics: Metrics


# The catalogue is transcribed from src/lib/sim/environments.ts. Keep the ids stable,
# the frontend links to runs by environment id.
ENVIRONMENTS: list[Environment] = [
    Environment(
        id="kitchen-counter",
        name="Kitchen Counter",
        blurb="Domestic clutter, reflective surfaces and a tight pour zone.",
        objects=["mug", "tray", "kettle", "sponge"],
        difficulty="medium",
        tasks=[
            "Pick up the red mug and place it on the tray",
            "Move the sponge into the sink caddy",
            "Set the kettle back on its base",
        ],
    ),
    Environment(
        id="warehouse-shelf",
        name="Warehouse Shelf",
        blurb="Deep bins, occlusion from neighbouring stock, low overhead light.",
        objects=["tote", "carton", "label", "divider"],
        difficulty="hard",
        tasks=[
            "Pick the labelled carton from the middle bin",
            "Transfer the tote to the outbound chute",
            "Reorient the carton so the label faces out",
        ],
    ),
    Environment(
        id="lab-bench",
        name="Lab Bench",
        blurb="Rigid fixtures, high contrast, millimetre placement tolerance.",
        objects=["pipette", "rack", "beaker", "tip box"],
        difficulty="easy",
        tasks=[
            "Place the pipette back in the rack",
            "Move the beaker to the weighing station",
            "Load a fresh tip from the tip box",
        ],
    ),
    Environment(
        id="cluttered-desk",
        name="Cluttered Desk",
        blurb="Dense distractors, cable tangles and ambiguous grasp affordances.",
        objects=["stapler", "mug", "cables", "notebook"],
        difficulty="hard",
        tasks=[
            "Clear the mug into the tray",
            "Pick up the stapler without snagging the cables",
            "Stack the notebook on the left pile",
        ],
    ),
]

ENVIRONMENTS_BY_ID: dict[str, Environment] = {e.id: e for e in ENVIRONMENTS}


def current_policy() -> Policy:
    """Describe the policy under test.

    PLACEHOLDER. These values are read from the environment with obviously unset
    fallbacks, so nothing here is invented. Wire this to whatever submits the run,
    for example the CI job that builds the policy image.
    """
    return Policy(
        name=os.environ.get("POLICY_NAME", "unset-policy"),
        commit=os.environ.get("POLICY_COMMIT", "unset"),
        branch=os.environ.get("POLICY_BRANCH", "unset"),
    )


def current_gate() -> Gate:
    """Build the CI gate for a new run.

    ``baseline`` is None because this scaffold keeps no run history. Once runs are
    persisted, look up the last passing run on the default branch and fill it in.
    """
    return Gate(
        metric="pass_rate",
        threshold=GATE_THRESHOLD,
        regression_tolerance_pp=GATE_REGRESSION_TOLERANCE_PP,
        baseline=None,
    )


def draw_variant(rng: random.Random, difficulty: str) -> Variant:
    """Draw one domain randomisation, seeded so a run is reproducible.

    The ranges are the contract's ranges. Harder environments are allowed more
    distractors and a wider object offset.
    """
    hardness = {"hard": 1.0, "medium": 0.6}.get(difficulty, 0.3)
    return Variant(
        lighting=rng.uniform(0.2, 0.95),
        friction=rng.uniform(0.35, 1.35),
        object_dx=rng.uniform(-1, 1) * (0.5 + hardness * 0.5),
        object_dy=rng.uniform(-1, 1) * 0.4,
        distractors=rng.randint(0, round(2 + hardness * 4)),
        camera_jitter=rng.uniform(0, 0.9),
    )


# ===========================================================================
#
#   >>> THE ONE FUNCTION TO IMPLEMENT <<<
#
#   Everything else in this file is plumbing that already works. Replace the body
#   of run_rollout with a real simulator rollout and the bench becomes real.
#
#   Contract for the implementation:
#
#   * Load the policy, build the scene for ``environment_id``, apply ``variant`` as
#     domain randomisation, seed every source of randomness from ``seed`` so the same
#     (seed, variant) pair reproduces the same episode, then execute ``task``.
#
#   * Return a RolloutResult:
#       status      "passed" if the task succeeded, otherwise "failed".
#       duration_ms Episode wall-clock in milliseconds, greater than zero. This is
#                   what the frontend replays the arm motion against, so it must be
#                   the real episode length, not the container's total lifetime.
#       fail_mode   None on success. On failure, one of missed_approach, grasp_slip,
#                   collision, dropped_outside, timeout. Nothing else parses.
#       fail_at     None on success. On failure, progress through the episode where
#                   it went wrong, in 0..1, so 0.5 means halfway.
#       metrics     reward (any float), steps (non-negative int), grasp_attempts
#                   (non-negative int).
#
#   * Call ``report(fail_mode, fail_at)`` THE MOMENT a failure is detected, before
#     returning. The frontend polls once per second and animates between polls, so a
#     failure that is only reported at completion makes a doomed rollout animate as a
#     success and then snap. If the detector cannot tell mid-episode, call report as
#     early as it can tell, and say so in a comment.
#
#   * Raising is allowed. The caller records the rollout as a ``timeout`` failure at
#     fail_at 1.0 and keeps the rest of the fan-out going. Prefer returning a real
#     failure where you can, an exception loses the failure mode.
#
# ===========================================================================
def run_rollout(
    seed: int,
    variant: Variant,
    task: str,
    environment_id: str,
    report: Optional[Callable[[FailMode, float], None]] = None,
) -> RolloutResult:
    """Execute one rollout and report its outcome. NOT IMPLEMENTED.

    Args:
        seed: Seed for every random source in the episode.
        variant: Domain randomisation to apply to the scene.
        task: Natural language task string the policy is evaluated on.
        environment_id: Which environment from the catalogue to build.
        report: Call as ``report(fail_mode, fail_at)`` as soon as a failure is
            detected mid-episode. Optional only so the placeholder can ignore it,
            a real implementation should always use it.

    Returns:
        RolloutResult describing the episode.
    """
    # PLACEHOLDER IMPLEMENTATION. No simulator runs here. It sleeps briefly so the
    # frontend has something to animate, then reports a pass with zeroed metrics. The
    # zeros are deliberate: they are obviously not measurements, so nobody mistakes a
    # scaffold run for an eval result. Delete all of this.
    del seed, variant, task, environment_id, report  # unused by the placeholder
    started = time.monotonic()
    time.sleep(2.0)
    elapsed_ms = (time.monotonic() - started) * 1000
    return RolloutResult(
        status="passed",
        duration_ms=max(1.0, elapsed_ms),
        fail_mode=None,
        fail_at=None,
        metrics=Metrics(reward=0.0, steps=0, grasp_attempts=0),
    )


def sim_key(run_id: str, index: int) -> str:
    """Key for one rollout's record in the shared Dict."""
    return f"{run_id}:sim:{index}"


def patch_sim(run_id: str, index: int, **fields: object) -> Sim:
    """Merge fields into one rollout's stored record and return the new record.

    Safe under concurrency because each rollout owns its own key, so two workers never
    write the same entry.
    """
    stored = run_state[sim_key(run_id, index)]
    updated = Sim.model_validate({**stored, **fields})
    run_state[sim_key(run_id, index)] = updated.model_dump(by_alias=True)
    return updated


@app.function(
    gpu=ROLLOUT_GPU,
    max_containers=MAX_CONCURRENCY,
    timeout=max(60, ROLLOUT_TIMEOUT_MS // 1000 + 60),
)
def rollout_worker(run_id: str, index: int, run_started_at: float) -> None:
    """Run one rollout and write its progress into the shared run state.

    This is the Modal side of the scheduler. It owns ``start_offset_ms``, the status
    transitions and the mid-episode failure report. It does not decide anything about
    the episode itself, ``run_rollout`` does.

    Args:
        run_id: Run this rollout belongs to.
        index: Position of this rollout in the fan-out.
        run_started_at: ``time.time()`` at run creation, the origin for all offsets.
    """
    record = Sim.model_validate(run_state[sim_key(run_id, index)])
    environment_id = run_state[run_id]["environmentId"]
    task = run_state[run_id]["task"]

    # The container is already up by the time this line runs, so booting is brief.
    patch_sim(run_id, index, status="booting")
    start_offset_ms = max(0.0, (time.time() - run_started_at) * 1000)
    patch_sim(run_id, index, status="running", startOffsetMs=start_offset_ms)

    def report(fail_mode: FailMode, fail_at: float) -> None:
        """Publish a failure the instant the rollout detects it."""
        patch_sim(run_id, index, failMode=fail_mode, failAt=min(1.0, max(0.0, fail_at)))

    try:
        result = run_rollout(
            seed=record.seed,
            variant=record.variant,
            task=task,
            environment_id=environment_id,
            report=report,
        )
    except Exception:
        # An exception loses the real failure mode, so it is recorded as a timeout at
        # the end of the episode. The rest of the fan-out is unaffected.
        patch_sim(
            run_id,
            index,
            status="failed",
            durationMs=float(ROLLOUT_TIMEOUT_MS),
            failMode="timeout",
            failAt=1.0,
            metrics=Metrics(reward=0.0, steps=0, grasp_attempts=0).model_dump(by_alias=True),
        )
        raise

    patch_sim(
        run_id,
        index,
        status=result.status,
        durationMs=result.duration_ms,
        failMode=result.fail_mode,
        failAt=result.fail_at,
        metrics=result.metrics.model_dump(by_alias=True),
    )


@app.function(timeout=60 * 60)
def execute_run(run_id: str, fanout: int, run_started_at: float) -> None:
    """Fan the rollouts out across the worker pool and advance the run stage.

    Concurrency is bounded by ``max_containers`` on ``rollout_worker``, which is the
    same number reported as ``Run.concurrency``, so the queue the frontend draws is
    the queue that actually exists.
    """
    set_stage(run_id, "booting")
    inputs = [(run_id, index, run_started_at) for index in range(fanout)]
    for _ in rollout_worker.starmap(inputs, order_outputs=False, return_exceptions=True):
        # Each worker has already written its own result. Reaching here only means one
        # more rollout has settled, which is enough to move the run out of booting.
        set_stage(run_id, "rollout")
    set_stage(run_id, "scoring")
    set_stage(run_id, "done")


def set_stage(run_id: str, stage: RunStage) -> None:
    """Record the run's coarse stage. Progress counts are derived at read time."""
    record = dict(run_state[run_id])
    record["stage"] = stage
    run_state[run_id] = record


def assemble_run(run_id: str) -> Run:
    """Rebuild the full Run payload from the run skeleton and its rollout records."""
    try:
        record = dict(run_state[run_id])
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"No run {run_id}") from exc

    sims = [
        Sim.model_validate(run_state[sim_key(run_id, index)])
        for index in range(int(record["fanout"]))
    ]
    done = sum(1 for s in sims if s.status in ("passed", "failed"))
    stage: RunStage = record["stage"]
    label = STAGE_LABEL[stage]
    if stage == "done":
        label = f"Scored {done} rollouts"

    return Run(
        id=record["id"],
        created_at=record["createdAt"],
        policy=Policy.model_validate(record["policy"]),
        environment_id=record["environmentId"],
        environment_name=record["environmentName"],
        task=record["task"],
        fanout=int(record["fanout"]),
        concurrency=int(record["concurrency"]),
        stage=stage,
        progress=Progress(label=label, done=done, total=len(sims)),
        sims=sims,
        gate=Gate.model_validate(record["gate"]),
    )


def create_run(body: CreateRunRequest) -> str:
    """Write a new run and its queued rollouts into shared state, then start them.

    Returns:
        The new run id.
    """
    environment = ENVIRONMENTS_BY_ID.get(body.environment_id)
    if environment is None:
        raise HTTPException(status_code=400, detail=f"Unknown environment {body.environment_id}")

    run_id = f"run-{uuid.uuid4().hex[:10]}"
    run_started_at = time.time()
    concurrency = max(1, min(MAX_CONCURRENCY, body.fanout))

    run_state[run_id] = {
        "id": run_id,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(run_started_at)),
        "policy": current_policy().model_dump(by_alias=True),
        "environmentId": environment.id,
        "environmentName": environment.name,
        "task": body.task,
        "fanout": body.fanout,
        "concurrency": concurrency,
        "stage": "provisioning",
        "gate": current_gate().model_dump(by_alias=True),
    }

    # Variants are drawn up front from one run-level seed so the fan-out is
    # reproducible and so every cell exists, as queued, on the very first poll.
    rng = random.Random(run_id)
    for index in range(body.fanout):
        queued = Sim(
            id=f"sim-{index:03d}",
            seed=rng.getrandbits(31),
            variant=draw_variant(rng, environment.difficulty),
            status="queued",
            # Placeholder timings, overwritten the moment the rollout actually starts.
            # duration_ms must be positive to satisfy the contract even while queued.
            start_offset_ms=0.0,
            duration_ms=float(ROLLOUT_TIMEOUT_MS),
            elbow=1 if rng.random() < 0.5 else -1,
            fail_mode=None,
            fail_at=None,
            metrics=Metrics(reward=0.0, steps=0, grasp_attempts=0),
        )
        run_state[sim_key(run_id, index)] = queued.model_dump(by_alias=True)

    execute_run.spawn(run_id, body.fanout, run_started_at)
    return run_id


web_app = FastAPI(title="Forkbench API (scaffold)")


@web_app.get("/environments", response_model=EnvironmentsResponse)
def get_environments() -> EnvironmentsResponse:
    """Serve the environment catalogue shown on the drop screen."""
    return EnvironmentsResponse(environments=ENVIRONMENTS)


@web_app.post("/runs", response_model=CreateRunResponse)
def post_runs(body: CreateRunRequest) -> CreateRunResponse:
    """Create a run and kick off its rollouts.

    Always answers 200 with ``ok`` set, because the frontend reads the envelope rather
    than the status code.
    """
    try:
        return CreateRunResponse(ok=True, run_id=create_run(body), error=None)
    except HTTPException as exc:
        return CreateRunResponse(ok=False, run_id=None, error=str(exc.detail))


@web_app.get("/runs/{run_id}", response_model=Run)
def get_run(run_id: str) -> Run:
    """Serve the current state of one run. The frontend polls this once per second."""
    return assemble_run(run_id)


@app.function()
@modal.asgi_app()
def api() -> FastAPI:
    """Expose the FastAPI app as a Modal web endpoint."""
    return web_app

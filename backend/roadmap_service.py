import math
from graphlib import TopologicalSorter

from . import ai_service
from .schemas import (
    CareerTarget,
    GenerateRoadmapRequest,
    ReadinessScores,
    RecalculateRoadmapRequest,
    RoadmapData,
    RoadmapResponse,
    WhatIfRequest,
    WhatIfResponse,
    RoadmapEdge
)


WEEKS_PER_MONTH = 4.345

LEVEL_PERCENTAGES = {
    "Basic": 30,
    "Intermediate": 65,
    "Advanced": 100,
}


# ---------- Graph helpers ----------

def dependency_map(roadmap: RoadmapData) -> dict[str, set[str]]:
    dependencies = {node.id: set() for node in roadmap.nodes}

    for edge in roadmap.edges:
        dependencies[edge.target].add(edge.source)

    return dependencies


def validate_career_graph(roadmap: RoadmapData) -> None:
    """Check the overall structure after basic schema validation."""
    nodes = {node.id: node for node in roadmap.nodes}

    if "start" not in nodes or nodes["start"].type != "milestone":
        raise ValueError("The roadmap must contain a start milestone.")

    if "target" not in nodes or nodes["target"].type != "target":
        raise ValueError("The roadmap must contain a target node.")

    if sum(node.type == "target" for node in roadmap.nodes) != 1:
        raise ValueError("The roadmap must contain exactly one target.")

    children = {node_id: set() for node_id in nodes}
    parents = dependency_map(roadmap)

    for edge in roadmap.edges:
        children[edge.source].add(edge.target)

    if parents["start"]:
        raise ValueError("The start milestone cannot have prerequisites.")

    if children["target"]:
        raise ValueError("The target must be the final milestone.")

    def reachable(origin: str, links: dict[str, set[str]]) -> set[str]:
        visited = set()
        pending = [origin]

        while pending:
            current = pending.pop()

            if current in visited:
                continue

            visited.add(current)
            pending.extend(links[current] - visited)

        return visited

    if reachable("start", children) != set(nodes):
        raise ValueError("Every milestone must be reachable from start.")

    if reachable("target", parents) != set(nodes):
        raise ValueError("Every milestone must lead to the target.")


def refresh_statuses(roadmap: RoadmapData) -> RoadmapData:
    """Unlock milestones whose prerequisites are complete."""
    result = roadmap.model_copy(deep=True)
    nodes = {node.id: node for node in result.nodes}
    dependencies = dependency_map(result)

    for node_id in TopologicalSorter(dependencies).static_order():
        node = nodes[node_id]

        if node_id == "start":
            node.status = "completed"
            node.estimated_hours = 0
            continue

        ready = all(
            nodes[parent_id].status == "completed"
            for parent_id in dependencies[node_id]
        )

        if node.type == "target":
            node.status = "completed" if ready else "locked"
            node.estimated_hours = 0
            continue

        # Preserve completed work and self-reported known skills.
        if node.status == "completed":
            continue

        if not ready:
            node.status = "locked"
        elif node.status != "in-progress":
            node.status = "current"

    return result


# ---------- Time calculations ----------

def remaining_hours(roadmap: RoadmapData) -> float:
    return round(
        sum(
            node.estimated_hours
            for node in roadmap.nodes
            if node.status != "completed"
            and node.type not in {"target", "milestone"}
        ),
        2,
    )


def estimated_months(
    roadmap: RoadmapData,
    hours_per_week: float,
) -> int:
    if hours_per_week <= 0:
        raise ValueError("Weekly hours must be greater than zero.")

    hours = remaining_hours(roadmap)

    # The frontend expects a positive timeline.
    return max(
        1,
        math.ceil(hours / (hours_per_week * WEEKS_PER_MONTH)),
    )


# ---------- Readiness calculations ----------

def calculate_readiness(
    roadmap: RoadmapData,
    proof: dict[str, list[int]] | None = None,
    interview_score: float | None = None,
) -> ReadinessScores:
    """
    Calculate preparation estimates from recorded progress.
    These scores are not hiring probabilities.
    """
    proof = proof or {}

    learning_nodes = [
        node
        for node in roadmap.nodes
        if node.type not in {"target", "milestone"}
    ]

    def progress(node) -> float:
        if node.status == "completed":
            return 100.0

        if node.required_level <= 0:
            return 0.0

        return min(
            100.0,
            max(0.0, node.current_level / node.required_level * 100),
        )

    def weight(node) -> float:
        if node.priority == "critical":
            return 2.0
        if node.priority == "optional":
            return 0.5
        return 1.0

    def average(nodes) -> float:
        total_weight = sum(weight(node) for node in nodes)

        if total_weight == 0:
            return 0.0

        return round(
            sum(progress(node) * weight(node) for node in nodes)
            / total_weight,
            1,
        )

    skills = average([
        node for node in learning_nodes
        if node.type in {"skill", "certification"}
    ])

    projects = average([
        node for node in learning_nodes
        if node.type == "project"
    ])

    experience = average([
        node for node in learning_nodes
        if node.type == "experience"
    ])

    interview = average([
        node for node in learning_nodes
        if node.type == "interview"
    ])

    if interview_score is not None:
        interview = round(
            max(0.0, min(100.0, interview_score)),
            1,
        )

    total_proof = 0
    checked_proof = 0

    for node in learning_nodes:
        count = len(node.proof_items)
        total_proof += count

        valid_indexes = {
            index
            for index in proof.get(node.id, [])
            if type(index) is int and 0 <= index < count
        }

        checked_proof += len(valid_indexes)

    proof_score = (
        round(checked_proof / total_proof * 100, 1)
        if total_proof
        else 0.0
    )

    return ReadinessScores(
        overall=average(learning_nodes),
        skills=skills,
        projects=projects,
        experience=experience,
        interview=interview,
        proof=proof_score,
    )

def ensure_paths_to_target(roadmap: RoadmapData) -> RoadmapData:
    """
    Connect terminal roadmap branches to the target node.

    The original roadmap has already passed basic Pydantic
    validation, including cycle detection.
    """

    node_ids = {node.id for node in roadmap.nodes}

    if "target" not in node_ids:
        return roadmap

    # Leave invalid target structures for the graph validator.
    if any(edge.source == "target" for edge in roadmap.edges):
        return roadmap

    nodes_with_children = {
        edge.source
        for edge in roadmap.edges
    }

    new_edges = []

    for node in roadmap.nodes:
        if node.id == "target":
            continue

        # Connect nodes that have no next milestone.
        if node.id not in nodes_with_children:
            new_edges.append(
                RoadmapEdge(
                    source=node.id,
                    target="target",
                )
            )

    if not new_edges:
        return roadmap

    return RoadmapData(
        nodes=roadmap.nodes,
        edges=[*roadmap.edges, *new_edges],
    )


# ---------- Build a new career path ----------

def build_roadmap(
    request: GenerateRoadmapRequest,
) -> RoadmapResponse:

    # Step 1: Generate the roadmap using Gemini.
    roadmap = ai_service.generate_roadmap(request)

    # Step 2: Connect unfinished branches to the target.
    roadmap = ensure_paths_to_target(roadmap)

    # Step 3: Validate the roadmap graph.
    try:
        validate_career_graph(roadmap)

    except ValueError as exc:
        raise ai_service.AIServiceError(
            f"Career graph validation error: {exc}",
            status_code=502,
        ) from None

    # Step 4: Update milestone statuses.
    roadmap = refresh_statuses(roadmap)

    # Step 5: Calculate career timeline.
    target = CareerTarget(
        role=request.target_job,
        industry=request.industry,
        hours_per_week=request.hours_per_week,
        timeline_months=estimated_months(
            roadmap,
            request.hours_per_week,
        ),
    )

    # Step 6: Return the completed roadmap.
    return RoadmapResponse(
        target=target,
        roadmap=roadmap,
        readiness=calculate_readiness(roadmap),
    )


# ---------- Mark a milestone complete or in progress ----------

def update_progress(
    roadmap: RoadmapData,
    target: CareerTarget,
    node_id: str,
    status: str,
    proof: dict[str, list[int]] | None = None,
    interview_score: float | None = None,
) -> RoadmapResponse:
    if status not in {"current", "in-progress", "completed"}:
        raise ValueError("Unsupported progress status.")

    result = refresh_statuses(roadmap)
    nodes = {node.id: node for node in result.nodes}

    node = nodes.get(node_id)

    if node is None:
        raise ValueError("Milestone not found.")

    if node.type in {"target", "milestone"}:
        raise ValueError("This milestone is managed automatically.")

    if node.status == "locked":
        raise ValueError("Complete the prerequisite milestones first.")

    if node.status == "completed" and status != "completed":
        raise ValueError("A completed milestone cannot be reopened here.")

    node.status = status

    if status == "completed":
        node.current_level = node.required_level

    result = refresh_statuses(result)

    return RoadmapResponse(
        target=target.model_copy(deep=True),
        roadmap=result,
        readiness=calculate_readiness(
            result,
            proof,
            interview_score,
        ),
    )


# ---------- Adjust the plan for a known skill ----------

def recalculate_roadmap(
    request: RecalculateRoadmapRequest,
    target: CareerTarget,
    proof: dict[str, list[int]] | None = None,
    interview_score: float | None = None,
) -> RoadmapResponse:
    result = request.roadmap.model_copy(deep=True)

    node = next(
        node for node in result.nodes
        if node.id == request.known_skill_id
    )

    hours_before = remaining_hours(result)

    if node.status != "completed":
        old_level = min(node.current_level, node.required_level)

        # Marking a skill as known can increase, but not reduce,
        # its recorded proficiency.
        new_level = min(
            node.required_level,
            max(old_level, LEVEL_PERCENTAGES[request.level]),
        )

        old_gap = max(0.0, node.required_level - old_level)
        new_gap = max(0.0, node.required_level - new_level)

        if old_gap > 0:
            node.estimated_hours = round(
                node.estimated_hours * new_gap / old_gap,
                2,
            )

        node.current_level = new_level

        if new_gap == 0:
            node.status = "completed"
            node.estimated_hours = 0

    # Keep prerequisite milestones rather than assuming the user
    # has mastered them merely by claiming an advanced skill.
    result = refresh_statuses(result)

    updated_target = target.model_copy(deep=True)
    updated_target.timeline_months = estimated_months(
        result,
        updated_target.hours_per_week,
    )

    return RoadmapResponse(
        target=updated_target,
        roadmap=result,
        readiness=calculate_readiness(
            result,
            proof,
            interview_score,
        ),
        hours_saved=round(
            max(0.0, hours_before - remaining_hours(result)),
            2,
        ),
    )


# ---------- What-if simulation ----------

def simulate_what_if(
    request: WhatIfRequest,
    target: CareerTarget,
    proof: dict[str, list[int]] | None = None,
    interview_score: float | None = None,
) -> WhatIfResponse:
    """
    Preview a different schedule without changing the database.
    Applying the preview will be handled by the API/frontend.
    """
    result = refresh_statuses(request.roadmap)

    months = estimated_months(result, request.hours_per_week)
    hours = remaining_hours(result)

    updated_target = target.model_copy(deep=True)
    updated_target.hours_per_week = request.hours_per_week
    updated_target.timeline_months = months

    if hours == 0:
        note = "All learning milestones are complete."
    elif months <= request.timeline_months:
        note = (
            f"The estimated remaining work fits within your "
            f"{request.timeline_months:g}-month goal."
        )
    else:
        required_weekly_hours = round(
            hours / (request.timeline_months * WEEKS_PER_MONTH),
            1,
        )

        note = (
            f"The estimated remaining work needs about {months} months "
            f"at {request.hours_per_week:g} hours per week. "
            f"Your requested deadline would need approximately "
            f"{required_weekly_hours:g} hours per week."
        )

    return WhatIfResponse(
        target=updated_target,
        roadmap=result,
        readiness=calculate_readiness(
            result,
            proof,
            interview_score,
        ),
        hours_per_week=request.hours_per_week,
        timeline_months=months,
        milestone_count=len(result.nodes),
        critical_path_intact=True,
        note=note,
    )
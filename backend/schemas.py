from graphlib import CycleError, TopologicalSorter
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


# ---------- Shared types ----------

NodeId = Annotated[
    str,
    Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$"),
]

ShortText = Annotated[str, Field(min_length=1, max_length=300)]

Score = Annotated[float, Field(ge=0, le=100)]

SkillLevel = Literal["Basic", "Intermediate", "Advanced"]

NodeStatus = Literal[
    "locked",
    "current",
    "in-progress",
    "completed",
    "optional",
]

NodeType = Literal[
    "milestone",
    "skill",
    "project",
    "interview",
    "experience",
    "certification",
    "target",
]

Priority = Literal["normal", "critical", "optional"]


class Schema(BaseModel):
    model_config = ConfigDict(
        str_strip_whitespace=True,
        allow_inf_nan=False,
    )


# ---------- Profile ----------

class ProfileRequest(Schema):
    skills: list[ShortText] = Field(default_factory=list, max_length=100)

    # Empty string means "Not set" in your frontend.
    levels: dict[NodeId, Literal[
        "", "Basic", "Intermediate", "Advanced"
    ]] = Field(default_factory=dict)


# ---------- Roadmap structure ----------

class RoadmapNode(Schema):
    id: NodeId
    title: ShortText
    type: NodeType = "skill"
    status: NodeStatus = "locked"
    priority: Priority = "normal"

    estimated_hours: float = Field(default=0, ge=0, le=10000)
    current_level: Score = 0
    required_level: Score = 100

    why: str = Field(default="", max_length=5000)
    topics: list[ShortText] = Field(default_factory=list, max_length=50)
    plan: list[str] = Field(default_factory=list, max_length=50)

    next_action: str = Field(default="", max_length=2000)
    project: str = Field(default="", max_length=2000)
    question: str = Field(default="", max_length=3000)

    proof_items: list[ShortText] = Field(
        default_factory=lambda: [
            "GitHub repository",
            "README",
            "Live deployment",
            "Screenshots",
            "Architecture explanation",
            "Interview explanation",
        ],
        max_length=30,
    )

    # An advanced milestone can replace this smaller milestone.
    absorbed_by: NodeId | None = None


class RoadmapEdge(Schema):
    source: NodeId
    target: NodeId


class RoadmapData(Schema):
    nodes: list[RoadmapNode] = Field(min_length=1, max_length=150)
    edges: list[RoadmapEdge] = Field(default_factory=list, max_length=1000)

    @model_validator(mode="after")
    def validate_graph(self):
        ids = [node.id for node in self.nodes]
        known_ids = set(ids)

        if len(ids) != len(known_ids):
            raise ValueError("Each roadmap node must have a unique ID.")

        dependencies = {node_id: set() for node_id in ids}
        seen_edges = set()

        for edge in self.edges:
            if edge.source not in known_ids or edge.target not in known_ids:
                raise ValueError("An edge references a missing roadmap node.")

            if edge.source == edge.target:
                raise ValueError("A milestone cannot depend on itself.")

            pair = (edge.source, edge.target)

            if pair in seen_edges:
                raise ValueError("Duplicate roadmap edges are not allowed.")

            seen_edges.add(pair)
            dependencies[edge.target].add(edge.source)

        try:
            tuple(TopologicalSorter(dependencies).static_order())
        except CycleError:
            raise ValueError(
                "Roadmap dependencies must not form a cycle."
            ) from None

        for node in self.nodes:
            if node.absorbed_by is not None:
                if node.absorbed_by not in known_ids:
                    raise ValueError("absorbed_by references a missing node.")

                if node.absorbed_by == node.id:
                    raise ValueError("A node cannot absorb itself.")

        return self


class CareerTarget(Schema):
    role: ShortText
    industry: str = Field(default="", max_length=200)
    hours_per_week: float = Field(default=10, ge=1, le=80)

    # A calculated timeline can exceed the user's requested deadline.
    timeline_months: float = Field(default=8, gt=0)


class ReadinessScores(Schema):
    overall: Score = 0
    skills: Score = 0
    projects: Score = 0
    experience: Score = 0
    interview: Score = 0
    proof: Score = 0


class RoadmapResponse(Schema):
    target: CareerTarget
    roadmap: RoadmapData
    readiness: ReadinessScores = Field(default_factory=ReadinessScores)
    hours_saved: float = Field(default=0, ge=0)


# ---------- Job analysis and generation ----------

class AnalyzeJobRequest(Schema):
    target_job: str = Field(min_length=3, max_length=300)
    industry: str = Field(default="", max_length=200)
    job_description: str = Field(default="", max_length=30000)
    skills: list[ShortText] = Field(default_factory=list, max_length=100)


class GenerateRoadmapRequest(Schema):
    analysis: dict[str, Any]
    target_job: str = Field(min_length=3, max_length=300)
    industry: str = Field(default="", max_length=200)
    skills: list[ShortText] = Field(default_factory=list, max_length=100)
    hours_per_week: float = Field(default=10, ge=1, le=80)
    timeline_months: float = Field(default=8, ge=1, le=36)


# ---------- Milestone details ----------

class MilestoneDetailsRequest(Schema):
    node_id: NodeId
    title: ShortText
    target_role: ShortText


class MilestoneDetailsResponse(Schema):
    why: str
    topics: list[str]
    plan: list[str]
    estimated_hours: float = Field(ge=0)


# ---------- Progress and rerouting ----------

class ProgressRequest(Schema):
    node_id: NodeId
    status: Literal["current", "in-progress", "completed"]


class RecalculateRoadmapRequest(Schema):
    roadmap: RoadmapData
    known_skill_id: NodeId
    level: SkillLevel

    @model_validator(mode="after")
    def validate_known_skill(self):
        node = next(
            (
                node for node in self.roadmap.nodes
                if node.id == self.known_skill_id
            ),
            None,
        )

        if node is None:
            raise ValueError("The selected skill is missing from the roadmap.")

        if node.type != "skill":
            raise ValueError("Only a skill can be marked as already known.")

        return self


# ---------- What-if simulation ----------

class WhatIfRequest(Schema):
    hours_per_week: float = Field(ge=1, le=80)
    timeline_months: float = Field(ge=1, le=36)
    roadmap: RoadmapData


class WhatIfResponse(RoadmapResponse):
    hours_per_week: float = Field(ge=1, le=80)
    timeline_months: float = Field(gt=0)
    milestone_count: int = Field(ge=0)
    critical_path_intact: bool
    note: str = ""


# ---------- Project generation ----------

class GenerateProjectRequest(Schema):
    node_id: NodeId | None = None
    title: ShortText | None = None
    target_role: ShortText


class ProjectResponse(Schema):
    name: str
    skills: list[str]
    difficulty: str
    estimated_time: str
    portfolio_value: str
    steps: list[str]


# ---------- Interview practice ----------

class InterviewQuestionRequest(Schema):
    type: Literal[
        "Technical",
        "Behavioral",
        "Project",
        "Role-specific",
    ] = "Technical"

    node_id: NodeId | None = None
    title: ShortText | None = None
    target_role: ShortText


class InterviewQuestionResponse(Schema):
    question: str = Field(min_length=1, max_length=5000)


class EvaluateAnswerRequest(Schema):
    question: str = Field(min_length=1, max_length=5000)
    answer: str = Field(min_length=15, max_length=15000)


class EvaluateAnswerResponse(Schema):
    score: Score
    strengths: list[str]
    weaknesses: list[str]
    improved_answer: str


# ---------- Career comparison ----------

class CareerCompareRequest(Schema):
    current_role: ShortText
    other_role: ShortText


class ComparedCareer(Schema):
    role: str
    readiness: Score


class CareerCompareResponse(Schema):
    current: ComparedCareer
    other: ComparedCareer
    shared: list[str]
    additional: list[str]
    note: str


# ---------- Save and load ----------

ProofIndex = Annotated[int, Field(ge=0, strict=True)]


class SaveRoadmapRequest(Schema):
    target: CareerTarget
    readiness: ReadinessScores = Field(default_factory=ReadinessScores)
    roadmap: RoadmapData

    proof: dict[NodeId, list[ProofIndex]] = Field(default_factory=dict)
    profile: ProfileRequest = Field(default_factory=ProfileRequest)

    @model_validator(mode="after")
    def validate_proof(self):
        nodes = {node.id: node for node in self.roadmap.nodes}

        for node_id, indexes in self.proof.items():
            if node_id not in nodes:
                raise ValueError("Proof references a missing milestone.")

            item_count = len(nodes[node_id].proof_items)

            if any(index >= item_count for index in indexes):
                raise ValueError("A proof checkbox index is out of range.")

            if len(indexes) != len(set(indexes)):
                raise ValueError("Proof checkbox indexes must be unique.")

        return self


class SavedRoadmapResponse(SaveRoadmapRequest):
    id: int
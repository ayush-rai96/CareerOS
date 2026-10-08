from copy import deepcopy
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models import CareerRoadmap, InterviewAttempt, UserProfile
from .schemas import (
    EvaluateAnswerRequest,
    EvaluateAnswerResponse,
    ProfileRequest,
    RoadmapResponse,
    SavedRoadmapResponse,
    SaveRoadmapRequest,
)


# Your current frontend has no login.
# Use one shared profile for this local demo.
LOCAL_PROFILE_ID = 1


# ---------- Transaction helper ----------

def commit_changes(db: Session) -> None:
    """Save changes, or roll back if the database rejects them."""
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise


# ---------- Profile ----------

def get_or_create_profile(db: Session) -> UserProfile:
    profile = db.get(UserProfile, LOCAL_PROFILE_ID)

    if profile is not None:
        return profile

    profile = UserProfile(
        id=LOCAL_PROFILE_ID,
        name="Sunny",
        skills=[],
        levels={},
    )

    db.add(profile)

    try:
        db.commit()
    except IntegrityError:
        db.rollback()

        # Another request may have created the profile first.
        existing = db.get(UserProfile, LOCAL_PROFILE_ID)

        if existing is not None:
            return existing

        raise
    except Exception:
        db.rollback()
        raise

    db.refresh(profile)
    return profile


def get_profile_data(db: Session) -> dict[str, Any]:
    profile = get_or_create_profile(db)

    return {
        "skills": deepcopy(profile.skills),
        "levels": deepcopy(profile.levels),
    }


def save_profile(
    db: Session,
    data: ProfileRequest,
) -> UserProfile:
    profile = get_or_create_profile(db)
    values = data.model_dump(mode="json")

    # Assign new JSON values so SQLAlchemy detects the changes.
    profile.skills = deepcopy(values["skills"])
    profile.levels = deepcopy(values["levels"])

    # Keep the active path's profile snapshot in sync.
    roadmap = get_latest_roadmap(db)

    if roadmap is not None:
        roadmap.profile_snapshot = deepcopy(values)

    commit_changes(db)
    return profile


# ---------- Roadmap lookup ----------

def get_latest_roadmap(db: Session) -> CareerRoadmap | None:
    statement = (
        select(CareerRoadmap)
        .where(CareerRoadmap.profile_id == LOCAL_PROFILE_ID)
        .order_by(CareerRoadmap.id.desc())
        .limit(1)
    )

    return db.scalar(statement)


def require_latest_roadmap(db: Session) -> CareerRoadmap:
    roadmap = get_latest_roadmap(db)

    if roadmap is None:
        raise ValueError("No saved career path found. Build a path first.")

    return roadmap


def roadmap_to_dict(record: CareerRoadmap) -> dict[str, Any]:
    """Return the snapshot format expected by the frontend."""
    snapshot = SavedRoadmapResponse.model_validate(
        {
            "id": record.id,
            "target": deepcopy(record.target),
            "readiness": deepcopy(record.readiness),
            "roadmap": deepcopy(record.roadmap),
            "proof": deepcopy(record.proof),
            "profile": deepcopy(record.profile_snapshot),
        }
    )

    return snapshot.model_dump(mode="json")


# ---------- Save a complete path ----------

def save_roadmap(
    db: Session,
    data: SaveRoadmapRequest,
    *,
    analysis: dict[str, Any] | None = None,
    create_new: bool = False,
) -> CareerRoadmap:
    """
    Generation uses create_new=True.
    Saving an existing path updates the latest record.
    """
    profile = get_or_create_profile(db)
    record = None if create_new else get_latest_roadmap(db)

    if record is None:
        record = CareerRoadmap(profile_id=profile.id)
        db.add(record)

    values = data.model_dump(mode="json")

    record.target = deepcopy(values["target"])
    record.readiness = deepcopy(values["readiness"])
    record.roadmap = deepcopy(values["roadmap"])
    record.proof = deepcopy(values["proof"])
    record.profile_snapshot = deepcopy(values["profile"])

    if analysis is not None:
        record.analysis = deepcopy(analysis)

    profile.skills = deepcopy(values["profile"]["skills"])
    profile.levels = deepcopy(values["profile"]["levels"])

    commit_changes(db)
    db.refresh(record)

    return record


# ---------- Save recalculated progress ----------

def update_roadmap(
    db: Session,
    data: RoadmapResponse,
    *,
    profile_data: ProfileRequest | None = None,
) -> CareerRoadmap:
    """
    Save a roadmap after the service recalculates it.
    Preserve proof for milestones that still exist.
    """
    record = require_latest_roadmap(db)

    proof = {}

    for node in data.roadmap.nodes:
        old_indexes = record.proof.get(node.id, [])

        valid_indexes = sorted(
            {
                index
                for index in old_indexes
                if type(index) is int
                and 0 <= index < len(node.proof_items)
            }
        )

        if valid_indexes:
            proof[node.id] = valid_indexes

    if profile_data is None:
        profile_data = ProfileRequest.model_validate(
            record.profile_snapshot
        )

    snapshot = SaveRoadmapRequest(
        target=data.target,
        roadmap=data.roadmap,
        readiness=data.readiness,
        proof=proof,
        profile=profile_data,
    )

    return save_roadmap(db, snapshot)


# ---------- Interview feedback ----------

def save_interview_attempt(
    db: Session,
    request: EvaluateAnswerRequest,
    feedback: EvaluateAnswerResponse,
) -> InterviewAttempt:
    profile = get_or_create_profile(db)

    attempt = InterviewAttempt(
        profile_id=profile.id,
        question=request.question,
        answer=request.answer,
        feedback=feedback.model_dump(mode="json"),
    )

    db.add(attempt)
    commit_changes(db)
    db.refresh(attempt)

    return attempt


def get_interview_history(
    db: Session,
    limit: int = 20,
) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 100))

    statement = (
        select(InterviewAttempt)
        .where(InterviewAttempt.profile_id == LOCAL_PROFILE_ID)
        .order_by(InterviewAttempt.id.desc())
        .limit(limit)
    )

    attempts = db.scalars(statement).all()

    return [
        {
            "id": attempt.id,
            "question": attempt.question,
            "answer": attempt.answer,
            "feedback": deepcopy(attempt.feedback),
            "created_at": attempt.created_at.isoformat() + "Z",
        }
        for attempt in attempts
    ]
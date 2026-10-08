from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def utc_now() -> datetime:
    """Store all database timestamps in UTC."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class UserProfile(Base):
    __tablename__ = "user_profiles"

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        autoincrement=True,
    )

    name: Mapped[str] = mapped_column(
        String(100),
        default="Sunny",
        nullable=False,
    )

    # Example: ["HTML", "CSS", "JavaScript"]
    skills: Mapped[list[str]] = mapped_column(
        JSON,
        default=list,
        nullable=False,
    )

    # Example: {"react": "Intermediate", "js": "Advanced"}
    levels: Mapped[dict[str, str]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=utc_now,
        nullable=False,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=utc_now,
        onupdate=utc_now,
        nullable=False,
    )


class CareerRoadmap(Base):
    __tablename__ = "career_roadmaps"

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        autoincrement=True,
    )

    profile_id: Mapped[int] = mapped_column(
        ForeignKey("user_profiles.id"),
        index=True,
        nullable=False,
    )

    # Role, industry, weekly hours, and timeline.
    target: Mapped[dict[str, Any]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )

    # Gemini's analysis of the target job.
    analysis: Mapped[dict[str, Any]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )

    # Complete graph: {"nodes": [...], "edges": [...]}
    # Each node also contains its progress status.
    roadmap: Mapped[dict[str, Any]] = mapped_column(
        JSON,
        default=lambda: {"nodes": [], "edges": []},
        nullable=False,
    )

    # Overall, skills, projects, experience, interview,
    # and proof readiness scores.
    readiness: Mapped[dict[str, Any]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )

    # Checked proof items for each milestone.
    # Example: {"fintrack": [0, 1, 2]}
    proof: Mapped[dict[str, list[int]]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )

    # Preserve the profile associated with this saved path.
    profile_snapshot: Mapped[dict[str, Any]] = mapped_column(
        JSON,
        default=lambda: {"skills": [], "levels": {}},
        nullable=False,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=utc_now,
        nullable=False,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=utc_now,
        onupdate=utc_now,
        nullable=False,
    )


class InterviewAttempt(Base):
    __tablename__ = "interview_attempts"

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        autoincrement=True,
    )

    profile_id: Mapped[int] = mapped_column(
        ForeignKey("user_profiles.id"),
        index=True,
        nullable=False,
    )

    question: Mapped[str] = mapped_column(
        Text,
        nullable=False,
    )

    answer: Mapped[str] = mapped_column(
        Text,
        nullable=False,
    )

    # Gemini feedback: score, strengths, weaknesses,
    # and an improved answer.
    feedback: Mapped[dict[str, Any]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=utc_now,
        nullable=False,
    )
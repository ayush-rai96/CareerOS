import os
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from . import ai_service, crud, roadmap_service
from .database import BASE_DIR, SessionLocal, engine, get_db, init_db
from .schemas import (
    AnalyzeJobRequest,
    CareerCompareRequest,
    CareerCompareResponse,
    CareerTarget,
    EvaluateAnswerRequest,
    EvaluateAnswerResponse,
    GenerateProjectRequest,
    GenerateRoadmapRequest,
    InterviewQuestionRequest,
    InterviewQuestionResponse,
    MilestoneDetailsRequest,
    MilestoneDetailsResponse,
    ProfileRequest,
    ProgressRequest,
    ProjectResponse,
    RecalculateRoadmapRequest,
    RoadmapData,
    RoadmapResponse,
    SavedRoadmapResponse,
    SaveRoadmapRequest,
    WhatIfRequest,
    WhatIfResponse,
)


# ---------- Application startup ----------

@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        init_db()

        with SessionLocal() as db:
            crud.get_or_create_profile(db)

    except Exception:
        engine.dispose()

        raise RuntimeError(
            "Database startup failed. Check that MySQL is running, "
            "the DB settings in .env are correct, and your MySQL "
            "user can create the database and tables."
        ) from None

    try:
        yield
    finally:
        engine.dispose()


app = FastAPI(
    title="CareerOS API",
    description="Career roadmap generation and progress tracking.",
    version="1.0.0",
    lifespan=lifespan,
)


# ---------- Frontend access ----------

allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://127.0.0.1:5500,http://localhost:5500,"
        "http://127.0.0.1:8000,http://localhost:8000",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


DbSession = Annotated[Session, Depends(get_db)]


# ---------- Safe error responses ----------

@app.exception_handler(ai_service.AIServiceError)
async def handle_ai_error(
    request: Request,
    exc: ai_service.AIServiceError,
):
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.message},
    )


@app.exception_handler(SQLAlchemyError)
async def handle_database_error(
    request: Request,
    exc: SQLAlchemyError,
):
    return JSONResponse(
        status_code=503,
        content={
            "detail": (
                "The database operation failed. "
                "Check your MySQL connection and try again."
            )
        },
    )


# ---------- Internal helpers ----------

def active_roadmap(db: Session):
    record = crud.get_latest_roadmap(db)

    if record is None:
        raise HTTPException(
            status_code=404,
            detail="No saved career path found. Build a path first.",
        )

    return record


def validate_graph(roadmap: RoadmapData) -> None:
    try:
        roadmap_service.validate_career_graph(roadmap)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=str(exc),
        ) from None


def interview_score_for(record) -> float | None:
    score = float(record.readiness.get("interview", 0))

    return score if score > 0 else None


def ai_context(db: Session) -> dict:
    record = crud.get_latest_roadmap(db)

    context = {
        "profile": crud.get_profile_data(db),
    }

    if record is not None:
        context["target"] = record.target
        context["roadmap"] = record.roadmap

    return context


# ---------- Health ----------

@app.get("/api/health")
def health(db: DbSession):
    db.execute(text("SELECT 1"))

    return {
        "status": "ok",
        "database": "connected",
        "gemini_configured": ai_service.gemini_configured(),
        "model": ai_service.get_model_name(),
        "ai_verified": False,
        "message": (
            "Backend is ready. Gemini access is verified "
            "when an AI request succeeds."
        ),
    }


# ---------- Job analysis ----------

@app.post(
    "/api/analyze-job",
    response_model=ai_service.JobAnalysis,
)
def analyze_job(request: AnalyzeJobRequest):
    return ai_service.analyze_job(request)


# ---------- Roadmap generation ----------

@app.post(
    "/api/generate-roadmap",
    response_model=SavedRoadmapResponse,
)
def generate_roadmap(
    request: GenerateRoadmapRequest,
    db: DbSession,
):
    result = roadmap_service.build_roadmap(request)

    profile = ProfileRequest(
        skills=request.skills,
        levels={},
    )

    snapshot = SaveRoadmapRequest(
        target=result.target,
        roadmap=result.roadmap,
        readiness=result.readiness,
        proof={},
        profile=profile,
    )

    record = crud.save_roadmap(
        db,
        snapshot,
        analysis=request.analysis,
        create_new=True,
    )

    return crud.roadmap_to_dict(record)


# ---------- Milestone guidance ----------

@app.post(
    "/api/milestone-details",
    response_model=MilestoneDetailsResponse,
)
def milestone_details(
    request: MilestoneDetailsRequest,
    db: DbSession,
):
    return ai_service.milestone_details(
        request,
        context=ai_context(db),
    )


# ---------- Progress ----------

@app.post(
    "/api/progress",
    response_model=SavedRoadmapResponse,
)
def update_progress(
    request: ProgressRequest,
    db: DbSession,
):
    record = active_roadmap(db)

    roadmap = RoadmapData.model_validate(record.roadmap)
    target = CareerTarget.model_validate(record.target)

    try:
        result = roadmap_service.update_progress(
            roadmap=roadmap,
            target=target,
            node_id=request.node_id,
            status=request.status,
            proof=record.proof,
            interview_score=interview_score_for(record),
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from None

    updated = crud.update_roadmap(db, result)

    return crud.roadmap_to_dict(updated)


# ---------- Known skills and recalculation ----------

@app.post(
    "/api/recalculate-roadmap",
    response_model=RoadmapResponse,
)
def recalculate_roadmap(
    request: RecalculateRoadmapRequest,
    db: DbSession,
):
    record = active_roadmap(db)
    validate_graph(request.roadmap)

    target = CareerTarget.model_validate(record.target)

    result = roadmap_service.recalculate_roadmap(
        request=request,
        target=target,
        proof=record.proof,
        interview_score=interview_score_for(record),
    )

    profile = ProfileRequest.model_validate(
        record.profile_snapshot
    )

    profile.levels[request.known_skill_id] = request.level

    selected_node = next(
        node
        for node in result.roadmap.nodes
        if node.id == request.known_skill_id
    )

    if selected_node.status == "completed":
        existing_names = {
            skill.casefold() for skill in profile.skills
        }

        if selected_node.title.casefold() not in existing_names:
            profile.skills.append(selected_node.title)

    crud.update_roadmap(
        db,
        result,
        profile_data=profile,
    )

    return result


# ---------- What-if preview ----------

@app.post(
    "/api/what-if",
    response_model=WhatIfResponse,
)
def what_if(
    request: WhatIfRequest,
    db: DbSession,
):
    record = active_roadmap(db)
    validate_graph(request.roadmap)

    # Preview only: this endpoint does not save the new schedule.
    return roadmap_service.simulate_what_if(
        request=request,
        target=CareerTarget.model_validate(record.target),
        proof=record.proof,
        interview_score=interview_score_for(record),
    )


# ---------- Portfolio projects ----------

@app.post(
    "/api/generate-project",
    response_model=ProjectResponse,
)
def generate_project(
    request: GenerateProjectRequest,
    db: DbSession,
):
    return ai_service.generate_project(
        request,
        context=ai_context(db),
    )


# ---------- Interview practice ----------

@app.post(
    "/api/interview-question",
    response_model=InterviewQuestionResponse,
)
def interview_question(
    request: InterviewQuestionRequest,
    db: DbSession,
):
    return ai_service.interview_question(
        request,
        context=ai_context(db),
    )


@app.post(
    "/api/evaluate-answer",
    response_model=EvaluateAnswerResponse,
)
def evaluate_answer(
    request: EvaluateAnswerRequest,
    db: DbSession,
):
    feedback = ai_service.evaluate_answer(request)

    crud.save_interview_attempt(
        db,
        request=request,
        feedback=feedback,
    )

    record = crud.get_latest_roadmap(db)

    if record is not None:
        roadmap = RoadmapData.model_validate(record.roadmap)

        updated = RoadmapResponse(
            target=CareerTarget.model_validate(record.target),
            roadmap=roadmap,
            readiness=roadmap_service.calculate_readiness(
                roadmap,
                proof=record.proof,
                interview_score=feedback.score,
            ),
        )

        crud.update_roadmap(db, updated)

    return feedback


@app.get("/api/interview-history")
def interview_history(db: DbSession):
    return crud.get_interview_history(db)


# ---------- Career comparison ----------

@app.post(
    "/api/career-compare",
    response_model=CareerCompareResponse,
)
def compare_careers(
    request: CareerCompareRequest,
    db: DbSession,
):
    profile = ProfileRequest.model_validate(
        crud.get_profile_data(db)
    )

    record = crud.get_latest_roadmap(db)

    roadmap = (
        RoadmapData.model_validate(record.roadmap)
        if record is not None
        else None
    )

    return ai_service.compare_careers(
        request=request,
        profile=profile,
        roadmap=roadmap,
    )


# ---------- Profile ----------

@app.get(
    "/api/profile",
    response_model=ProfileRequest,
)
def get_profile(db: DbSession):
    return crud.get_profile_data(db)


@app.post(
    "/api/profile",
    response_model=ProfileRequest,
)
def save_profile(
    request: ProfileRequest,
    db: DbSession,
):
    profile = crud.save_profile(db, request)

    return {
        "skills": profile.skills,
        "levels": profile.levels,
    }


# ---------- Save and load career paths ----------

@app.post(
    "/api/roadmap/save",
    response_model=SavedRoadmapResponse,
)
def save_roadmap(
    request: SaveRoadmapRequest,
    db: DbSession,
):
    validate_graph(request.roadmap)

    roadmap = roadmap_service.refresh_statuses(
        request.roadmap
    )

    existing = crud.get_latest_roadmap(db)

    interview_score = (
        interview_score_for(existing)
        if existing is not None
        else None
    )

    # Recalculate scores instead of trusting frontend percentages.
    readiness = roadmap_service.calculate_readiness(
        roadmap,
        proof=request.proof,
        interview_score=interview_score,
    )

    snapshot = SaveRoadmapRequest(
        target=request.target,
        roadmap=roadmap,
        readiness=readiness,
        proof=request.proof,
        profile=request.profile,
    )

    record = crud.save_roadmap(db, snapshot)

    return crud.roadmap_to_dict(record)


@app.get(
    "/api/roadmap",
    response_model=SavedRoadmapResponse,
)
def load_roadmap(db: DbSession):
    record = active_roadmap(db)

    return crud.roadmap_to_dict(record)


# ---------- Serve the frontend ----------
# Keep this AFTER all API routes.
# Only frontend/ is exposed, so .env stays private.

FRONTEND_DIR = BASE_DIR / "frontend"

app.mount(
    "/",
    StaticFiles(
        directory=str(FRONTEND_DIR),
        html=True,
    ),
    name="frontend",
)
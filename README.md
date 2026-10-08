# CareerOS — AI-Powered Career Roadmapper

**LLOYD Hackathon 2026**  
**Problem Statement 1: Reverse-Engineered Career Roadmapper**

## What it does

CareerOS is an AI-powered career planning platform that converts a user's specific dream job into a personalized, interactive career roadmap. It analyzes the target role, identifies the required skills and projects, and helps users track their progress toward becoming job-ready.

## Done / Left / Plan

### Done
- Responsive frontend built using HTML, CSS, and JavaScript.
- FastAPI backend with REST API endpoints.
- MySQL database integration using SQLAlchemy.
- Gemini AI integration for job analysis.
- Interactive roadmap visualization code using Cytoscape.js.
- Pydantic schemas for roadmap and API validation.
- Features for milestone progress, project suggestions, interview practice, and career comparison.

### Left
- Complete end-to-end verification of AI-generated roadmaps.
- Test dynamic rerouting, saving, loading, and all advanced features.
- Complete mobile and accessibility testing.
- Deploy the frontend and backend publicly.

### Plan
1. Stabilize AI roadmap generation and validate generated graphs.
2. Test roadmap interactions, progress tracking, and error handling.
3. Deploy the application and configure production environment variables.
4. Test on mobile devices and prepare the final presentation.

## Architecture and why

**Frontend:** HTML, CSS, JavaScript, and Cytoscape.js. These technologies provide a responsive interface and an interactive roadmap graph with zooming, panning, and clickable milestones.

**Backend:** Python and FastAPI. FastAPI handles API requests and connects the frontend with AI and database services.

**AI:** Google Gemini, accessed through the Google GenAI SDK. Gemini analyzes job targets and generates personalized roadmap information.

**Validation:** Pydantic validates generated data, while the roadmap service checks skill dependencies and graph structure.

**Database:** MySQL and SQLAlchemy store career roadmaps, user profiles, progress, and interview attempts.

## What we added

Beyond the core career-roadmap requirements, CareerOS includes code for:

- Career readiness scoring.
- What-if timeline simulation.
- AI-generated project suggestions.
- Interview question generation and answer evaluation.
- Career comparison.
- Milestone progress and proof tracking.
- Saving and loading career paths.

These additions aim to make the platform useful beyond the initial roadmap generation.

## How to run it

### Requirements

- Python
- MySQL Server
- A Gemini API key
- A modern web browser

### Setup

1. Clone the repository.
2. Open the project directory.
3. Create a Python virtual environment.
4. Install dependencies:

```powershell
pip install -r requirements.txt
```

5. Copy `.env.example` to `.env`.
6. Add your own MySQL credentials and Gemini API key.
7. Start MySQL.
8. Run FastAPI from the project root:

```powershell
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8765
```

9. Open `frontend/index.html` using VS Code Live Server on port 5500.

**Backend API documentation:** http://127.0.0.1:8765/docs

**Test login:** Not required for the current local demo. The current implementation uses a shared demo profile and is not a multi-user authenticated system.

**Live URL:** Deployment pending.

## Tools and AI used

- HTML, CSS, JavaScript
- Cytoscape.js
- Python and FastAPI
- Pydantic
- SQLAlchemy and MySQL
- PyMySQL
- Google Gemini API and Google GenAI SDK
- Git and GitHub
- ChatGPT for coding assistance, debugging, and development guidance

CareerOS uses AI to generate recommendations, roadmap content, projects, and interview-related feedback. Users should be informed that these recommendations are AI-generated and may require independent verification.

## Who it is for

CareerOS is designed for college students, fresh graduates, and early-career professionals who want to prepare for specific jobs.

Users can return to update their skills, track milestones, explore alternative career paths, and practise interviews instead of treating the roadmap as a one-time checklist.
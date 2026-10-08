/* ==========================================================
   CareerOS — script.js
   Sections:
   1 Config · 2 State · 3 API · 4 Demo data · 5 Init
   6 Landing · 7 Analysis · 8 Views · 9 Dashboard
   10 Career map · 11 Node panel · 12 Progress & re-routing
   13 What-If · 14 Other pages · 15 Save/Load
   16 Modals & toasts · 17 Utilities
   ========================================================== */


/* ============ 1. CONFIGURATION ============ */
const API_BASE_URL =
  ["localhost", "127.0.0.1"].includes(window.location.hostname)
    ? "http://127.0.0.1:8765"
    : window.location.origin;   // <-- change this to your FastAPI address
const USER_NAME = "Ayush";
const REQUEST_TIMEOUT_MS = 90000;               // Gemini can be slow, so wait up to 90s
const DEMO_SAVE_KEY = "careeros-demo-save";
const DEFAULT_PROOF_ITEMS = ["GitHub repository", "README", "Live deployment", "Screenshots", "Architecture explanation", "Interview explanation"];
const LOAD_STEPS = ["Reading your target role", "Extracting job requirements", "Mapping skill dependencies", "Building your career path"];


/* ============ 2. STATE ============ */
const appState = {
  target: {},
  profile: { skills: [], levels: {} },
  roadmap: { nodes: [], edges: [] },
  readiness: {},
  proof: {},            // { nodeId: [indexes of checked proof items] }
  selectedNode: null,
  filter: "all",
  demoMode: false
};

let cy = null;              // the Cytoscape instance (only exists while the map is open)
let pulseTimer = null;      // makes the current node glow
let currentView = "dashboard";
let isAnalyzing = false;
let lastForm = null;
let lastFocus = null;
let bannerTimer = null;


/* ============ 3. API HELPER ============
   Every request goes through api(). The `endpoints` object below is the ONLY place
   that knows request shapes, and normalizeRoadmap() is the ONLY place that knows
   response shapes. If your backend differs, change them here and nowhere else. */
async function api(path, method = "GET", body) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  let response;
  let responseText;

  try {
    response = await fetch(API_BASE_URL + path, {
      method,
      headers: {
        "Content-Type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });

    responseText = await response.text();

  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        "The request timed out. Please try again."
      );
    }

    throw new Error(
      "Cannot reach FastAPI. Check that the backend is running."
    );

  } finally {
    clearTimeout(timer);
  }

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `The server returned an unexpected response (HTTP ${response.status}). Check the FastAPI terminal.`
    );
  }

  if (!response.ok) {
    const detail = data?.detail;
    let message;

    if (typeof detail === "string") {
      message = detail;

    } else if (Array.isArray(detail)) {
      message = detail.map(item => {
        const field = (item.loc || []).join(".");
        return `${field}: ${item.msg}`;
      }).join("\n");

    } else {
      message = `Request failed (HTTP ${response.status}).`;
    }

    throw new Error(message);
  }

  return data;
}

const endpoints = {
  health: () => api("/api/health"),
  analyze: form => api("/api/analyze-job", "POST", {
    target_job: form.target_job, industry: form.industry,
    job_description: form.job_description, skills: form.skills
  }),
  generateRoadmap: (analysis, form) => api("/api/generate-roadmap", "POST", {
    analysis, target_job: form.target_job, industry: form.industry, skills: form.skills,
    hours_per_week: form.hours_per_week, timeline_months: form.timeline_months
  }),
  milestone: node => api("/api/milestone-details", "POST", { node_id: node.id, title: node.title, target_role: appState.target.role }),
  recalculate: (nodeId, level) => api("/api/recalculate-roadmap", "POST", { roadmap: appState.roadmap, known_skill_id: nodeId, level }),
  whatIf: (hours, months) => api("/api/what-if", "POST", { hours_per_week: hours, timeline_months: months, roadmap: appState.roadmap }),
  project: node => api("/api/generate-project", "POST", { node_id: node ? node.id : null, title: node ? node.title : null, target_role: appState.target.role }),
  question: (type, node) => api("/api/interview-question", "POST", { type, node_id: node ? node.id : null, title: node ? node.title : null, target_role: appState.target.role }),
  evaluate: (question, answer) => api("/api/evaluate-answer", "POST", { question, answer }),
  compare: role => api("/api/career-compare", "POST", { current_role: appState.target.role, other_role: role }),
  progress: (nodeId, status) => api("/api/progress", "POST", { node_id: nodeId, status }),
  saveProfile: profile => api("/api/profile", "POST", profile),
  saveRoadmap: snapshot => api("/api/roadmap/save", "POST", snapshot),
  loadRoadmap: () => api("/api/roadmap")
};

/* Turns whatever the backend sends into the shape the UI expects. */
function normalizeRoadmap(raw) {
  const source = raw && (raw.roadmap || raw);
  if (!source || !Array.isArray(source.nodes) || !Array.isArray(source.edges)) {
    throw new Error("We received an unexpected roadmap format.");
  }
  const seen = new Set();
  const nodes = [];
  source.nodes.forEach(n => {
    if (n.id === undefined || seen.has(String(n.id))) return;   // skip duplicates, Cytoscape would crash
    const id = String(n.id);
    seen.add(id);
    nodes.push({
      ...n, id,
      title: n.title || n.name || id,
      type: n.type || "skill",
      status: n.status || "locked",
      priority: n.priority || "normal",
      estimated_hours: Number(n.estimated_hours) || 0
    });
  });
  if (nodes.length === 0) throw new Error("We received an unexpected roadmap format.");
  const edges = source.edges
    .map(e => ({ source: String(e.source ?? e.from), target: String(e.target ?? e.to) }))
    .filter(e => seen.has(e.source) && seen.has(e.target));      // skip edges pointing at missing nodes
  return {
    target: raw.target || {},
    readiness: raw.readiness || {},
    roadmap: { nodes, edges },
    hoursSaved: raw.hours_saved
  };
}

function applyRoadmap(data) {
  appState.roadmap = data.roadmap;
  appState.target = { ...appState.target, ...data.target };
  appState.readiness = { ...appState.readiness, ...data.readiness };
}


/* ============ 4. DEMO DATA ============
   Only demo mode uses predefined data. Real mode never touches any of this. */
function makeDemoData() {
  const nodes = [
    { id: "start", title: "Current", type: "milestone", status: "completed", priority: "normal", estimated_hours: 0 },
    { id: "js", title: "JavaScript", type: "skill", status: "completed", priority: "critical", estimated_hours: 0 },
    { id: "react-basics", title: "React Basics", type: "skill", status: "in-progress", priority: "normal", estimated_hours: 8, absorbed_by: "react" },
    { id: "react", title: "React", type: "skill", status: "current", priority: "critical", estimated_hours: 10,
      why: "Nearly every FinTech frontend posting asks for React, and it unlocks your main portfolio project.",
      topics: ["Hooks", "Context API", "Reducers", "State architecture"],
      next_action: "Build your FinTech transaction dashboard",
      project: "FinTrack Transaction Dashboard",
      question: "When would you use Context API instead of a state management library?" },
    { id: "ts", title: "TypeScript", type: "skill", status: "locked", priority: "critical", estimated_hours: 20,
      why: "Typed code is the default in FinTech teams.", topics: ["Types & interfaces", "Generics", "Typing React props"] },
    { id: "api", title: "REST APIs", type: "skill", status: "locked", priority: "normal", estimated_hours: 10,
      why: "Dashboards live on live data.", topics: ["fetch", "Error handling", "Auth headers"] },
    { id: "test", title: "Testing", type: "skill", status: "locked", priority: "optional", estimated_hours: 12,
      why: "Nice to have; shows maturity.", topics: ["Unit tests", "Testing Library"] },
    { id: "fintrack", title: "FinTrack Project", type: "project", status: "locked", priority: "critical", estimated_hours: 24,
      why: "Proof that you can build what the job asks for.", project: "FinTrack Transaction Dashboard" },
    { id: "interview", title: "Interview Prep", type: "interview", status: "locked", priority: "normal", estimated_hours: 15,
      question: "Walk me through how you structured state in your last project." },
    { id: "target", title: "Frontend Engineer · FinTech", type: "target", status: "locked", priority: "critical", estimated_hours: 0 }
  ];
  const links = [["start", "js"], ["js", "react-basics"], ["react-basics", "react"], ["js", "ts"], ["react", "api"],
    ["react", "fintrack"], ["ts", "fintrack"], ["api", "fintrack"], ["fintrack", "interview"], ["react", "test"],
    ["test", "interview"], ["interview", "target"]];
  return {
    target: { role: "Frontend Engineer", industry: "FinTech", timeline_months: 8, hours_per_week: 10 },
    readiness: { overall: 64, skills: 72, projects: 55, experience: 40, interview: 30, proof: 62 },
    roadmap: { nodes, edges: links.map(([source, target]) => ({ source, target })) }
  };
}

/* Demo version of "mark known": removes nodes the skill makes unnecessary, reconnects the graph. */
function demoMarkKnown(id) {
  const { nodes, edges } = appState.roadmap;
  const node = findNode(id);
  const absorbedIds = new Set(nodes.filter(n => n.absorbed_by === id).map(n => n.id));
  node.status = "completed";
  const feeders = edges.filter(e => absorbedIds.has(e.target) && !absorbedIds.has(e.source)).map(e => e.source);
  appState.roadmap.nodes = nodes.filter(n => !absorbedIds.has(n.id));
  const newEdges = edges.filter(e => !absorbedIds.has(e.source) && !absorbedIds.has(e.target));
  feeders.forEach(src => {
    if (!newEdges.some(e => e.source === src && e.target === id)) newEdges.push({ source: src, target: id });
  });
  appState.roadmap.edges = newEdges;
  unlockAvailableNodes();
  bumpDemoReadiness(5);
}

function unlockAvailableNodes() {
  appState.roadmap.nodes.forEach(n => {
    if (n.status === "locked" && prerequisitesDone(n.id)) n.status = "current";
  });
}

function bumpDemoReadiness(points) {
  ["overall", "skills", "proof"].forEach(k => {
    appState.readiness[k] = Math.min(100, num(appState.readiness[k]) + points);
  });
}

const demoAI = {
  milestone: node => ({
    why: node.why || `${node.title} appears in several requirements of your target role.`,
    topics: node.topics || ["Core concepts", "Hands-on practice", "Real-world usage"],
    plan: [
      `Day 1–2: Skim the official ${node.title} docs and write down what is new to you.`,
      `Day 3–5: Follow one short tutorial and rebuild it without looking.`,
      `Week 2: Use ${node.title} in a small feature of your own project.`,
      `Week 3: Explain it out loud as if in an interview, then fix the gaps.`
    ],
    estimated_hours: node.estimated_hours
  }),
  project: node => ({
    name: "FinTrack Transaction Dashboard",
    skills: ["React", "TypeScript", "REST API", "Charts"],
    difficulty: "Intermediate",
    estimated_time: "4–6 hours for the first version",
    portfolio_value: "High: shows state management and API work",
    steps: ["Set up the repo and README first", "Fetch transactions from a mock API", "Add filters and a spending chart", "Deploy it and add screenshots"]
  }),
  questions: {
    Technical: ["When would you use Context API instead of a state management library?", "How do you stop a React component re-rendering too often?"],
    Behavioral: ["Tell me about a time you disagreed with a teammate.", "Describe a deadline you almost missed."],
    Project: ["Walk me through the hardest bug in your best project.", "What would you change in your project if you rebuilt it?"],
    "Role-specific": ["How would you display live transaction data safely?", "What makes a FinTech UI trustworthy?"]
  },
  evaluate: answer => {
    const words = answer.trim().split(/\s+/).length;
    return {
      score: Math.min(92, 35 + words * 2),
      strengths: ["You answered the question directly.", words > 30 ? "Good level of detail." : "Clear and concise."],
      weaknesses: words < 40 ? ["Too short. Add a concrete example from your own work."] : ["Add a measurable result to finish strongly."],
      improved_answer: "Start with the decision, give one real example, explain the trade-off you weighed, and end with the outcome."
    };
  },
  compare: role => ({
    current: { role: appState.target.role, readiness: 72 },
    other: { role, readiness: 51 },
    shared: ["JavaScript", "Git", "React", "APIs"],
    additional: ["Node.js", "Databases", "Authentication", "Backend architecture"],
    note: "Demo estimate"
  })
};


/* ============ 5. INITIALIZATION ============ */
const VIEWS = {
  "dashboard":  { title: "Dashboard", icon: "◈", render: renderDashboard },
  "career-map": { title: "Career Map", icon: "◎", render: renderMap },
  "gaps":       { title: "Skill Gaps", icon: "⚑", render: renderGaps },
  "projects":   { title: "Projects", icon: "▣", render: renderProjects },
  "interview":  { title: "Interview", icon: "✎", render: renderInterview },
  "simulator":  { title: "Career Simulator", icon: "⇄", render: renderCompare },
  "profile":    { title: "My Profile", icon: "☺", render: renderProfile },
  "settings":   { title: "Settings", icon: "⚙", render: renderSettings }
};

document.addEventListener("DOMContentLoaded", () => {
  $("#nav").innerHTML = Object.entries(VIEWS)
    .map(([key, v]) => `<button class="nav-item" type="button" data-view="${key}">${v.icon}&nbsp; ${v.title}</button>`).join("");
  wireGlobalEvents();
  initLanding();
  endpoints.health().then(() => setAiStatus("online")).catch(() => setAiStatus("offline"));
});

function wireGlobalEvents() {
  $("#nav").addEventListener("click", e => {
    const key = e.target.dataset.view;
    if (key) showView(key);
  });
  $("#menu-btn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  document.addEventListener("click", e => {          // tapping outside closes the mobile drawer
    const sidebar = $("#sidebar");
    if (sidebar.classList.contains("open") && !sidebar.contains(e.target) && !$("#menu-btn").contains(e.target)) {
      sidebar.classList.remove("open");
    }
  });
  $("#home-btn").addEventListener("click", goHome);
  $("#demo-btn").addEventListener("click", startDemo);
  $("#load-btn").addEventListener("click", loadFromLanding);
  $("#retry").addEventListener("click", () => lastForm && startAnalysis(lastForm));
  $("#to-demo").addEventListener("click", () => { appState.demoMode = true; if (lastForm) startAnalysis(lastForm); });
  $("#load-back").addEventListener("click", () => { $("#loading").hidden = true; });

  $("#node-panel").addEventListener("click", handlePanelClick);
  $("#node-panel").addEventListener("change", handleProofChange);

  $(".map-tools").addEventListener("click", e => { if (e.target.dataset.z) zoomCtl(e.target.dataset.z); });
  $("#whatif-btn").addEventListener("click", openWhatIf);
  $("#map-search").addEventListener("input", e => searchNodes(e.target.value));
  $("#map-search").addEventListener("keydown", e => { if (e.key === "Enter") openFirstSearchHit(); });
  $("#map-filter").addEventListener("change", e => { appState.filter = e.target.value; applyFilter(); });

  document.addEventListener("keydown", handleKeydown);
}

function handleKeydown(e) {
  const modalOpen = $("#modal-root").firstElementChild;
  if (e.key === "Escape") {
    if (modalOpen) closeModal(); else closePanel();
    return;
  }
  if (e.key === "Tab" && modalOpen) {               // keep keyboard focus inside the modal
    const items = [...modalOpen.querySelectorAll("button,input,textarea,select")].filter(el => !el.disabled);
    if (items.length === 0) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

function setAiStatus(state) {
  const labels = { online: "AI Online", demo: "Demo Mode", offline: "Backend offline" };
  $("#ai-status-box").dataset.state = state;
  $("#ai-status").textContent = labels[state];
}


/* ============ 6. LANDING PAGE ============ */
function initLanding() {
  const jobs = ["Frontend Engineer", "AI Engineer", "Full Stack Developer", "Product Designer", "Cybersecurity Analyst"];
  $("#suggest").innerHTML = jobs.map(j => `<button type="button" class="chip">${j}</button>`).join("");
  $("#suggest").addEventListener("click", e => {
    if (e.target.classList.contains("chip")) { $("#job-input").value = e.target.textContent; $("#job-input").focus(); }
  });

  $("#job-form").addEventListener("submit", e => {
    e.preventDefault();
    const form = readJobForm();
    if (form.error) { $("#job-err").textContent = form.error; return; }
    $("#job-err").textContent = "";
    startAnalysis(form);
  });

  // Hero graph tilts with the mouse (desktop only, and only while the landing page is visible)
  const noHover = matchMedia("(pointer:coarse)").matches || matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!noHover) {
    const graph = $("#hero-graph");
    document.addEventListener("mousemove", e => {
      if (!$("#landing-view").classList.contains("active")) return;
      const x = e.clientX / innerWidth - 0.5, y = e.clientY / innerHeight - 0.5;
      graph.style.transform = `perspective(900px) rotateY(${x * 14}deg) rotateX(${-y * 8}deg)`;
    });
  }
}

function readJobForm() {
  const target_job = $("#job-input").value.trim();
  const hours = Number($("#f-hours").value);
  const months = Number($("#f-months").value);
  if (target_job.length < 3) return { error: "Tell us your target job first, for example “Frontend Engineer at a FinTech startup”." };
  if (!(hours >= 1 && hours <= 80)) return { error: "Hours per week should be between 1 and 80." };
  if (!(months >= 1 && months <= 36)) return { error: "Timeline should be between 1 and 36 months." };
  return {
    target_job,
    industry: $("#f-industry").value.trim(),
    hours_per_week: hours,
    timeline_months: months,
    skills: $("#f-skills").value.split(",").map(s => s.trim()).filter(Boolean),
    job_description: $("#f-jd").value.trim()
  };
}

function startDemo() {
  appState.demoMode = true;
  if (!$("#job-input").value.trim()) $("#job-input").value = "Frontend Engineer at a FinTech startup";
  const form = readJobForm();
  if (form.error) { $("#job-err").textContent = form.error; return; }
  startAnalysis(form);
}

function enterApp() {
  $("#landing-view").classList.remove("active");
  $("#app-shell").hidden = false;
  showView("dashboard");
}

function goHome() {
  destroyMap();
  closePanel();
  appState.demoMode = false;
  $("#app-shell").hidden = true;
  $("#landing-view").classList.add("active");
  endpoints.health().then(() => setAiStatus("online")).catch(() => setAiStatus("offline"));
}

async function loadFromLanding() {
  const ok = await loadCareerPath();
  if (ok) enterApp();
}


/* ============ 7. ANALYSIS (loading flow) ============ */
function runLoadingSteps() {
  const list = $("#load-steps");
  let active = 0;
  const paint = () => {
    list.innerHTML = LOAD_STEPS.map((text, i) => {
      const state = i < active ? "done" : i === active ? "now" : "";
      const mark = i < active ? "✓" : i === active ? "●" : "○";
      return `<li class="${state}">${mark} ${text}</li>`;
    }).join("");
  };
  paint();
  const timer = setInterval(() => { if (active < LOAD_STEPS.length - 1) { active++; paint(); } }, 900);
  return {
    finish() { clearInterval(timer); active = LOAD_STEPS.length; paint(); },
    stop() { clearInterval(timer); }
  };
}

async function startAnalysis(form) {
  if (isAnalyzing) return;
  isAnalyzing = true;
  lastForm = form;
  $("#loading").hidden = false;
  $("#load-err").hidden = true;
  $("#load-title").textContent = "Reverse-engineering your career…";
  const steps = runLoadingSteps();

  try {
    let data;
    if (appState.demoMode) {
      await sleep(3000);
      data = makeDemoData();
      data.target.hours_per_week = form.hours_per_week;
      data.target.timeline_months = form.timeline_months;
      unlockAvailableNodes();
      setAiStatus("demo");
    } else {
      const analysis = await endpoints.analyze(form);
      data = normalizeRoadmap(await endpoints.generateRoadmap(analysis, form));
      data.target = { role: form.target_job, industry: form.industry, hours_per_week: form.hours_per_week, timeline_months: form.timeline_months, ...data.target };
      setAiStatus("online");
    }
    appState.target = {};
    appState.readiness = {};
    appState.proof = {};
    appState.profile = { skills: form.skills, levels: {} };
    applyRoadmap(data);

    steps.finish();
    await sleep(500);
    $("#loading").hidden = true;
    enterApp();
  } catch (err) {
    steps.stop();
    $("#load-title").textContent = "Something went wrong";
    $("#load-msg").textContent = err.message;
    $("#load-err").hidden = false;
    if (!appState.demoMode) setAiStatus("offline");
  } finally {
    isAnalyzing = false;
  }
}


/* ============ 8. VIEW SWITCHING ============ */
function showView(name) {
  const view = VIEWS[name];
  if (!view) return;
  currentView = name;
  if (name !== "career-map") destroyMap();
  closePanel();
  $$("#main-content .view").forEach(v => v.classList.remove("active"));
  $(`#${name}-view`).classList.add("active");
  $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  $("#page-title").textContent = view.title;
  const t = appState.target;
  $("#target-pill").hidden = !t.role;
  $("#target-pill").textContent = `TARGET  ${t.role || ""}${t.industry ? " · " + t.industry : ""}`;
  $("#sidebar").classList.remove("open");
  window.scrollTo(0, 0);
  view.render();
}


/* ============ 9. DASHBOARD ============ */
function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function prerequisitesDone(id) {
  return appState.roadmap.edges.filter(e => e.target === id).every(e => findNode(e.source)?.status === "completed");
}

/* The next best action: something already in progress and critical comes first. */
function findNextAction() {
  const open = appState.roadmap.nodes.filter(n => n.status !== "completed" && n.type !== "target");
  const active = open.filter(n => n.status === "current" || n.status === "in-progress");
  const pool = active.length ? active : open.filter(n => prerequisitesDone(n.id));
  const rank = n => (n.priority === "critical" ? 0 : 1);
  return [...pool].sort((a, b) => rank(a) - rank(b))[0] || null;
}

function renderDashboard() {
  const r = appState.readiness, t = appState.target, next = findNextAction();
  const total = appState.roadmap.nodes.length;
  const done = appState.roadmap.nodes.filter(n => n.status === "completed").length;
  const overall = num(r.overall);
  const endDate = new Date();
  endDate.setMonth(endDate.getMonth() + num(t.timeline_months));
  const criticalGaps = appState.roadmap.nodes.filter(n => n.priority === "critical" && n.status !== "completed" && n.type !== "target").length;

  const metric = (label, value) => `
    <div class="card"><span class="muted">${label}</span>
      <div class="metric" data-count="${num(value)}">0%</div>
      <div class="bar"><i data-w="${num(value)}"></i></div></div>`;

  $("#dashboard-view").innerHTML = `
    <h1 style="font-size:34px">${greeting()}, ${USER_NAME}.</h1>
    <p class="muted">${esc(t.role || "Your target role")}${t.industry ? " · " + esc(t.industry) : ""} — ${num(t.timeline_months)} months · ${num(t.hours_per_week)} hrs/week</p>
    <div class="grid">
      <div class="card">
        <span class="muted">Career readiness</span>
        <div class="ring" style="--p:${overall}"><b data-count="${overall}">0%</b></div>
        <p class="muted">You are closer than you think.</p>
      </div>
      <div class="card">
        <span class="muted">Distance to target</span>
        <div class="dist-line"><i data-h="${overall}"></i><b style="bottom:${overall}%">${overall}%</b></div>
        <p class="muted">${100 - overall}% to go · ${criticalGaps} critical gaps left</p>
      </div>
      <div class="card nba">
        <span class="tag critical">NEXT BEST ACTION</span>
        <h2 style="margin:12px 0">${next ? esc(next.next_action || "Work on " + next.title) : "You're job-ready. Time to apply."}</h2>
        <p class="muted">${next ? esc(next.why || "This is the most valuable step on your path right now.") : "Every milestone is complete."}</p>
        <p style="margin:10px 0">${next ? `Estimated: ${next.estimated_hours} hrs · Impact: ${next.priority === "critical" ? "HIGH" : "MEDIUM"}` : ""}</p>
        <button class="btn primary" type="button" id="start-nba">${next ? "Start this →" : "Open career map →"}</button>
      </div>
      ${metric("Skills", r.skills)}${metric("Projects", r.projects)}${metric("Experience", r.experience)}${metric("Interview", r.interview)}
      ${metric("Proof score", r.proof)}
      <div class="card"><span class="muted">Milestones</span><div class="metric">${done} / ${total}</div>
        <p class="muted">Target date: ${endDate.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</p></div>
    </div>`;

  $$("#dashboard-view [data-count]").forEach(el => countUp(el, +el.dataset.count));
  animateBars("#dashboard-view");
  $("#start-nba").addEventListener("click", () => {
    showView("career-map");
    if (next) openNode(next.id);
  });
}


/* ============ 10. CAREER MAP (Cytoscape) ============ */
const STATUS_COLOR = { completed: "#34D399", current: "#22D3EE", "in-progress": "#8B5CF6", locked: "#3a4152", optional: "#626A7A" };

function nodeColor(n) {
  if (n.status === "locked" && n.priority === "critical") return "#F59E0B";   // critical but not started: amber
  return STATUS_COLOR[n.status] || STATUS_COLOR.locked;
}
function nodeLabel(n) {
  const mark = n.status === "completed" ? "✓ " : n.status === "locked" ? "🔒 " : "";
  return mark + n.title;
}
function nodeClasses(n) {
  return [n.type, n.status, n.priority].join(" ");
}
function isOptional(n) {
  return n.priority === "optional" || n.status === "optional";
}

const GRAPH_STYLE = [
  { selector: "node", style: {
      shape: "round-rectangle", width: "label", height: 38, padding: "14px", label: "data(label)",
      color: "#F5F7FA", "font-size": 13, "font-family": "Inter, sans-serif", "text-valign": "center", "text-halign": "center",
      "background-color": "#151923", "border-width": 2, "border-color": "data(color)",
      "underlay-color": "data(color)", "underlay-opacity": 0.15, "underlay-padding": 8, "underlay-shape": "round-rectangle",
      "overlay-opacity": 0, "transition-property": "underlay-opacity", "transition-duration": "0.9s" } },
  { selector: ".project", style: { height: 46, "font-weight": 700 } },
  { selector: ".interview", style: { "border-style": "double", "border-width": 4 } },
  { selector: ".target", style: { height: 58, "font-size": 15, "border-width": 3, "border-color": "#8B5CF6", "underlay-color": "#8B5CF6", "underlay-opacity": 0.45, "underlay-padding": 14 } },
  { selector: ".completed", style: { color: "#9BA3B4" } },
  { selector: ".locked", style: { color: "#626A7A", "underlay-opacity": 0 } },
  { selector: ".optional", style: { "border-style": "dashed" } },
  { selector: ".current", style: { "underlay-opacity": 0.3 } },
  { selector: ".current.glow", style: { "underlay-opacity": 0.65 } },
  { selector: ".hover", style: { "underlay-opacity": 0.7 } },
  { selector: ".changed", style: { "underlay-color": "#FFFFFF", "underlay-opacity": 0.8 } },
  { selector: "edge", style: { width: 2, "line-color": "#2b3142", "target-arrow-color": "#2b3142", "target-arrow-shape": "triangle", "curve-style": "bezier" } },
  { selector: "edge.done", style: { "line-color": "#34D399", "target-arrow-color": "#34D399" } },
  { selector: ".dim", style: { opacity: 0.15 } },
  { selector: ".hidden", style: { display: "none" } },
  { selector: ":selected", style: { "border-color": "#FFFFFF", "underlay-opacity": 0.8 } }
];

function buildElements() {
  const nodes = appState.roadmap.nodes;
  const nodeEls = nodes.map(n => ({ data: { id: n.id, label: nodeLabel(n), color: nodeColor(n) }, classes: nodeClasses(n) }));
  const edgeEls = appState.roadmap.edges.map(e => ({
    data: { id: `${e.source}>${e.target}`, source: e.source, target: e.target },
    classes: findNode(e.source)?.status === "completed" && findNode(e.target)?.status === "completed" ? "done" : ""
  }));
  return [...nodeEls, ...edgeEls];
}

function renderMap() {
  destroyMap();
  $("#map-search").value = "";
  $("#map-filter").value = appState.filter;

  cy = cytoscape({
    container: $("#cy"),
    elements: buildElements(),
    style: GRAPH_STYLE,
    minZoom: 0.25, maxZoom: 2.5, wheelSensitivity: 0.25
  });

  cy.on("tap", "node", ev => openNode(ev.target.id()));
  cy.on("tap", ev => { if (ev.target === cy) closePanel(); });
  cy.on("mouseover", "node", ev => { ev.target.addClass("hover"); $("#cy").style.cursor = "pointer"; });
  cy.on("mouseout", "node", ev => { ev.target.removeClass("hover"); $("#cy").style.cursor = "default"; });

  // Left-to-right on desktop, top-to-bottom on phones
  const vertical = window.innerWidth < 768;
  const layout = cy.layout({
    name: "breadthfirst", directed: true, padding: 40, spacingFactor: 1.2,
    animate: true, animationDuration: 600,
    transform: (node, pos) => (vertical ? pos : { x: pos.y * 1.6, y: pos.x })
  });
  layout.on("layoutstop", () => { if (cy) cy.fit(undefined, 40); });
  layout.run();

  const el = $("#cy");
  el.classList.remove("fade-in");
  void el.offsetWidth;                 // restart the CSS animation
  el.classList.add("fade-in");

  startPulse();
  updateMapLabel();
  applyFilter();
}

function destroyMap() {
  stopPulse();
  if (cy) { cy.destroy(); cy = null; }
}

function startPulse() {
  stopPulse();
  let on = false;
  pulseTimer = setInterval(() => {
    if (!cy) return;
    on = !on;
    cy.nodes(".current").toggleClass("glow", on);
  }, 1000);
}
function stopPulse() { clearInterval(pulseTimer); pulseTimer = null; }

/* Updates colours, labels and classes in place (no re-layout), used after progress changes. */
function syncGraphStyles() {
  if (!cy) return;
  appState.roadmap.nodes.forEach(n => {
    const el = cy.$id(n.id);
    if (el.empty()) return;
    el.data({ label: nodeLabel(n), color: nodeColor(n) });
    el.classes(nodeClasses(n));
  });
  cy.edges().forEach(edge => {
    const both = findNode(edge.data("source"))?.status === "completed" && findNode(edge.data("target"))?.status === "completed";
    edge.toggleClass("done", both);
  });
  updateMapLabel();
  applyFilter();
}

function updateMapLabel() {
  const done = appState.roadmap.nodes.filter(n => n.status === "completed").length;
  $("#map-label").textContent = `CAREER MAP / LIVE · ${done}/${appState.roadmap.nodes.length} DONE`;
}

function applyFilter() {
  if (!cy) return;
  const [key, value] = appState.filter.split(":");
  cy.batch(() => {
    cy.nodes().forEach(el => {
      const n = findNode(el.id());
      const show = appState.filter === "all" || (n && String(n[key]) === value);
      el.toggleClass("hidden", !show);
    });
  });
}

function zoomCtl(action) {
  if (!cy) return;
  const center = { x: cy.width() / 2, y: cy.height() / 2 };
  if (action === "in") cy.animate({ zoom: { level: cy.zoom() * 1.3, renderedPosition: center } }, { duration: 200 });
  if (action === "out") cy.animate({ zoom: { level: cy.zoom() / 1.3, renderedPosition: center } }, { duration: 200 });
  if (action === "fit") cy.animate({ fit: { padding: 40 } }, { duration: 300 });
  if (action === "reset") {
    appState.filter = "all";
    $("#map-filter").value = "all";
    $("#map-search").value = "";
    cy.elements().removeClass("dim");
    applyFilter();
    cy.animate({ fit: { padding: 40 } }, { duration: 300 });
  }
}

function searchNodes(query) {
  if (!cy) return;
  const q = query.toLowerCase().trim();
  cy.elements().removeClass("dim");
  if (!q) return;
  const hits = cy.nodes().filter(n => n.data("label").toLowerCase().includes(q));
  cy.elements().not(hits).addClass("dim");
  if (hits.length) cy.animate({ center: { eles: hits[0] }, zoom: 1.1 }, { duration: 300 });
}

function openFirstSearchHit() {
  if (!cy) return;
  const q = $("#map-search").value.toLowerCase().trim();
  const hit = q && cy.nodes().filter(n => n.data("label").toLowerCase().includes(q))[0];
  if (hit) openNode(hit.id());
}

/* Briefly lights up nodes that just changed. */
function highlightNodes(ids) {
  if (!cy) return;
  ids.forEach(id => cy.$id(id).addClass("changed"));
  setTimeout(() => { if (cy) cy.nodes().removeClass("changed"); }, 2500);
}


/* ============ 11. NODE DETAIL PANEL ============ */
function findNode(id) {
  return appState.roadmap.nodes.find(n => n.id === id);
}

function proofItemsFor(node) { return node.proof_items || DEFAULT_PROOF_ITEMS; }
function proofCount(id) { return (appState.proof[id] || []).length; }

function openNode(id) {
  const node = findNode(id);
  if (!node) return;
  appState.selectedNode = node;
  if (cy) { cy.elements().unselect(); cy.$id(id).select(); }

  const topics = node.topics && node.topics.length
    ? node.topics.map(t => `<span class="tag">${esc(t)}</span>`).join(" ")
    : `<span class="muted">No topics yet. Create a learning plan to ask the AI.</span>`;
  const items = proofItemsFor(node);
  const checked = appState.proof[id] || [];
  const proofList = items.map((item, i) =>
    `<label class="check"><input type="checkbox" data-proof="${i}" ${checked.includes(i) ? "checked" : ""}> ${esc(item)}</label>`).join("");
  const isDone = node.status === "completed";

  $("#node-panel").innerHTML = `
    <button class="icon-btn" type="button" data-action="close" aria-label="Close panel" style="float:right">✕</button>
    <div class="row"><span class="tag ${esc(node.priority)}">${esc(node.priority.toUpperCase())}</span><span class="tag ${esc(node.status)}">${esc(node.status.toUpperCase())}</span></div>
    <h3>${esc(node.title)}</h3>
    <p class="muted">Estimated: ${node.estimated_hours} hours</p>

    <section><h4>Why this matters</h4><p>${esc(node.why || "No explanation yet. Create a learning plan to ask the AI.")}</p></section>
    <section><h4>Learn</h4><div class="row">${topics}</div><br>
      <button class="btn" type="button" data-action="plan">Create learning plan</button></section>
    <section><h4>Build</h4><p>${esc(node.project || "No project yet. Generate one for this skill.")}</p>
      <button class="btn" type="button" data-action="project">Generate project</button></section>
    <section><h4>Prove · <span id="proof-count">${checked.length} / ${items.length}</span> proven</h4>${proofList}</section>
    <section><h4>Interview</h4><p>${esc(node.question || "No question yet. Practice to get one.")}</p>
      <button class="btn" type="button" data-action="interview">Practice interview</button></section>
    <div class="row">${isDone
      ? `<span class="tag completed">✓ Known</span>`
      : `<button class="btn primary" type="button" data-action="known">Mark known</button>
         <button class="btn" type="button" data-action="complete">Mark complete</button>`}</div>`;

  $("#node-panel").classList.add("open");
}

function closePanel() {
  $("#node-panel").classList.remove("open");
  if (cy) cy.elements().unselect();
}

function handlePanelClick(e) {
  const action = e.target.dataset.action;
  const node = appState.selectedNode;
  if (!action || !node) return;
  const button = e.target;
  if (action === "close") closePanel();
  if (action === "known") openKnownModal(node);
  if (action === "complete") completeNode(node);
  if (action === "plan") runAI(button, `Learning plan: ${node.title}`, () => endpoints.milestone(node), () => demoAI.milestone(node));
  if (action === "project") runAI(button, "Project idea", () => endpoints.project(node), () => demoAI.project(node));
  if (action === "interview") startInterview("Role-specific", node);
}

function handleProofChange(e) {
  const node = appState.selectedNode;
  if (!node || e.target.dataset.proof === undefined) return;
  const index = Number(e.target.dataset.proof);
  const list = new Set(appState.proof[node.id] || []);
  e.target.checked ? list.add(index) : list.delete(index);
  appState.proof[node.id] = [...list];
  $("#proof-count").textContent = `${list.size} / ${proofItemsFor(node).length}`;
}

/* Runs an AI call (real or demo), shows the result in a modal, disables the button meanwhile. */
async function runAI(button, title, realCall, demoCall) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Working…";
  try {
    const data = appState.demoMode ? demoCall() : await realCall();
    showResultModal(title, data);
    toast("AI recommendation ready.");
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function showResultModal(title, data) {
  modal(`<h3>${esc(title)}</h3><div class="ai-result">${renderValue(data)}</div><br><button class="btn" type="button" data-close>Close</button>`);
}

/* Shows any JSON (string, list or object) as readable HTML. */
function renderValue(v) {
  if (v === null || v === undefined || v === "") return "";
  if (Array.isArray(v)) {
    return `<ul>${v.map(item => `<li>${typeof item === "object" ? renderValue(item) : esc(item)}</li>`).join("")}</ul>`;
  }
  if (typeof v === "object") {
    return Object.entries(v).map(([key, val]) => `<h4>${esc(key.replace(/_/g, " "))}</h4>${renderValue(val)}`).join("");
  }
  return `<p>${esc(v)}</p>`;
}


/* ============ 12. PROGRESS & DYNAMIC RE-ROUTING ============ */
function remainingHours(nodes) {
  return nodes.filter(n => n.status !== "completed").reduce((sum, n) => sum + num(n.estimated_hours), 0);
}

async function completeNode(node) {
  const oldStatus = node.status;
  node.status = "completed";             // optimistic: update the UI first
  syncGraphStyles();
  try {
    if (appState.demoMode) {
      unlockAvailableNodes();
      bumpDemoReadiness(2);
    } else {
      const res = await endpoints.progress(node.id, "completed");
      if (res && res.readiness) appState.readiness = { ...appState.readiness, ...res.readiness };
      if (res && res.roadmap) applyRoadmap(normalizeRoadmap(res));
    }
    toast("Progress saved.");
    if (cy) { appState.roadmap.nodes.length !== cy.nodes().length ? renderMap() : syncGraphStyles(); }
    openNode(node.id);
  } catch (err) {
    node.status = oldStatus;             // backend failed: put it back
    syncGraphStyles();
    openNode(node.id);
    toast(err.message);
  }
}

function openKnownModal(node) {
  let level = "Intermediate";
  modal(`<h3>How confident are you in ${esc(node.title)}?</h3>
    <div class="seg">${["Basic", "Intermediate", "Advanced"].map(l => `<button class="btn ${l === level ? "on" : ""}" type="button" data-level="${l}">${l}</button>`).join("")}</div>
    <div class="row"><button class="btn primary" type="button" id="confirm-known">Confirm</button><button class="btn" type="button" data-close>Cancel</button></div>`);
  $(".seg").addEventListener("click", e => {
    if (!e.target.dataset.level) return;
    level = e.target.dataset.level;
    $$(".seg .btn").forEach(b => b.classList.toggle("on", b === e.target));
  });
  $("#confirm-known").addEventListener("click", () => { closeModal(); confirmKnown(node, level); });
}

async function confirmKnown(node, level) {
  const before = appState.roadmap.nodes.map(n => ({ id: n.id, title: n.title, status: n.status, estimated_hours: n.estimated_hours }));
  let serverHours;
  try {
    if (appState.demoMode) {
      demoMarkKnown(node.id);
    } else {
      const data = normalizeRoadmap(await endpoints.recalculate(node.id, level));
      applyRoadmap(data);
      serverHours = data.hoursSaved;
    }
  } catch (err) {
    toast(err.message);
    return;
  }

  const stillThere = new Set(appState.roadmap.nodes.map(n => n.id));
  const removed = before.filter(n => !stillThere.has(n.id));
  const changed = appState.roadmap.nodes.filter(n => { const old = before.find(b => b.id === n.id); return old && old.status !== n.status; }).map(n => n.id);
  const saved = serverHours ?? Math.max(0, remainingHours(before) - remainingHours(appState.roadmap.nodes));

  closePanel();
  removed.forEach(n => { if (cy) cy.$id(n.id).animate({ style: { opacity: 0 } }, { duration: 500 }); });
  setTimeout(() => {
    renderMap();
    highlightNodes(changed);
    showRerouteBanner(removed, saved);
  }, removed.length ? 600 : 50);
}

function showRerouteBanner(removed, saved) {
  const banner = $("#saved-banner");
  const names = removed.map(n => esc(n.title)).join(", ");
  banner.innerHTML = `<strong>Roadmap updated.</strong>
    ${names ? `<div class="muted">The ${names} milestone${removed.length > 1 ? "s have" : " has"} been removed.</div>` : ""}
    <div><span class="hours" id="saved-hours">0</span></div><div class="muted">HOURS SAVED</div>`;
  banner.hidden = false;
  countUp($("#saved-hours"), saved, "");
  toast("Skill marked as known.");
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { banner.hidden = true; }, 5500);
}


/* ============ 13. WHAT-IF SIMULATOR ============ */
function openWhatIf() {
  const t = appState.target;
  const hours = Math.min(40, Math.max(2, num(t.hours_per_week) || 10));
  const months = Math.min(24, Math.max(2, num(t.timeline_months) || 8));
  modal(`<h3>What if?</h3><p class="muted">Change your constraints. See how your career path adapts.</p>
    <label class="field">Weekly time: <b id="wi-h-out">${hours}</b> hrs/week<input type="range" id="wi-hours" min="2" max="40" value="${hours}"></label>
    <label class="field">Target timeline: <b id="wi-m-out">${months}</b> months<input type="range" id="wi-months" min="2" max="24" value="${months}"></label>
    <div class="row"><button class="btn primary" type="button" id="wi-run">Simulate</button><button class="btn" type="button" data-close>Cancel</button></div>
    <div id="wi-out"></div>`);
  $("#wi-hours").addEventListener("input", e => { $("#wi-h-out").textContent = e.target.value; });
  $("#wi-months").addEventListener("input", e => { $("#wi-m-out").textContent = e.target.value; });
  $("#wi-run").addEventListener("click", async () => {
    const h = Number($("#wi-hours").value), m = Number($("#wi-months").value);
    let result;
    try { result = await simulate(h, m); } catch (err) { toast(err.message); return; }
    showWhatIfResult(result, m);
  });
}

async function simulate(hours, months) {
  const t = appState.target;
  const nodes = appState.roadmap.nodes;
  if (appState.demoMode) {
    // Demo estimate: fewer hours stretch the timeline, but less than proportionally
    const oldH = num(t.hours_per_week) || 10, oldM = num(t.timeline_months) || 8;
    const newMonths = Math.max(1, Math.round(oldM * Math.pow(oldH / hours, 0.6)));
    const dropIds = hours < oldH ? nodes.filter(isOptional).map(n => n.id) : [];
    return { months: newMonths, hours, before: nodes.length, after: nodes.length - dropIds.length, dropIds, criticalPathIntact: true };
  }
  const raw = await endpoints.whatIf(hours, months);
  const newMonths = raw.timeline_months ?? raw.months;
  if (newMonths === undefined) throw new Error("We received an unexpected response format.");
  const plan = raw.roadmap ? normalizeRoadmap(raw) : null;
  return {
    months: newMonths, hours: raw.hours_per_week ?? hours, before: nodes.length,
    after: raw.milestones ?? raw.milestone_count ?? (plan ? plan.roadmap.nodes.length : null),
    plan, dropIds: [], criticalPathIntact: raw.critical_path_intact === true
  };
}

function showWhatIfResult(r, wantedMonths) {
  const t = appState.target;
  const oldM = num(t.timeline_months), oldH = num(t.hours_per_week);
  const diff = r.months - oldM;
  const diffText = diff === 0 ? "Same timeline" : `${diff > 0 ? "+" : "−"}${Math.abs(diff)} months`;
  const milestoneDiff = r.after !== null && r.after !== undefined ? r.after - r.before : null;
  const deadlineText = r.months <= wantedMonths ? `On track for your ${wantedMonths}-month goal.` : `${r.months - wantedMonths} months past your ${wantedMonths}-month goal.`;
  $("#wi-out").innerHTML = `
    <div class="grid">
      <div class="card"><span class="muted">BEFORE</span><div class="metric">${oldM} mo</div><p>${oldH} hrs/week</p><p class="muted">${r.before} milestones</p></div>
      <div class="card"><span class="muted">AFTER</span><div class="metric">${r.months} mo</div><p>${r.hours} hrs/week</p><p class="muted">${r.after ?? "—"} milestones</p></div>
    </div>
    <p style="margin-top:14px"><b>${diffText}</b>${milestoneDiff ? ` · ${milestoneDiff < 0 ? "−" : "+"}${Math.abs(milestoneDiff)} milestones` : ""}</p>
    <p class="muted">${deadlineText}${r.criticalPathIntact ? " Your critical path remains intact." : ""}</p><br>
    <button class="btn primary" type="button" id="wi-apply">Apply new plan</button>`;
  $("#wi-apply").addEventListener("click", () => { closeModal(); applyWhatIf(r); });
}

function applyWhatIf(r) {
  appState.target.hours_per_week = r.hours;
  appState.target.timeline_months = r.months;
  if (r.plan) {
    applyRoadmap(r.plan);
  } else if (r.dropIds && r.dropIds.length) {
    const drop = new Set(r.dropIds);
    appState.roadmap.nodes = appState.roadmap.nodes.filter(n => !drop.has(n.id));
    appState.roadmap.edges = appState.roadmap.edges.filter(e => !drop.has(e.source) && !drop.has(e.target));
  }
  toast("Career path updated.");
  showView(currentView);
}


/* ============ 14. OTHER PAGES ============ */

/* ---- Skill gaps ---- */
function renderGaps() {
  const pool = appState.roadmap.nodes.filter(n => n.type !== "target" && n.type !== "milestone");
  const critical = pool.filter(n => n.status !== "completed" && n.priority === "critical");
  const moderate = pool.filter(n => n.status !== "completed" && n.priority !== "critical");
  const strong = pool.filter(n => n.status === "completed");

  const card = n => {
    const have = n.current_level ?? (n.status === "completed" ? 100 : (n.status === "current" || n.status === "in-progress") ? 40 : 10);
    const need = n.required_level ?? 100;
    return `<div class="card"><h3>${esc(n.title)}</h3>
      <span class="tag ${esc(n.priority)}">${esc(n.priority)}</span>
      <div class="gap-row"><span>Now</span><div class="bar"><i data-w="${num(have)}"></i></div></div>
      <div class="gap-row"><span>Needed</span><div class="bar"><i class="need" data-w="${num(need)}"></i></div></div>
      <p class="muted" style="margin-top:10px">${n.estimated_hours} hrs · ${esc(n.status)}</p></div>`;
  };
  const group = (title, list) => list.length ? `<h3 class="section-title">${title} (${list.length})</h3><div class="grid">${list.map(card).join("")}</div>` : "";

  $("#gaps-view").innerHTML = `<h2>Skill gaps</h2><p class="muted">Your biggest gaps between today and your target role.</p>
    ${group("Critical", critical)}${group("Moderate", moderate)}${group("Strong", strong)}
    ${pool.length ? "" : `<div class="card" style="margin-top:16px">No gaps to show yet.</div>`}`;
  animateBars("#gaps-view");
}

/* ---- Projects ---- */
function renderProjects() {
  const projects = appState.roadmap.nodes.filter(n => n.type === "project");
  $("#projects-view").innerHTML = `
    <h2>Build your proof</h2><p class="muted">Projects that close your actual career gaps.</p><br>
    <button class="btn primary" type="button" data-gen="1">Generate project</button>
    <div class="grid">${projects.map(n => `
      <div class="card"><h3>${esc(n.title)}</h3>
        <p class="muted">${esc(n.project || "")}</p>
        <p style="margin:8px 0"><span class="tag ${esc(n.status)}">${esc(n.status)}</span> <span class="tag">${n.estimated_hours} hrs</span></p>
        <button class="btn" type="button" data-open="${esc(n.id)}">View project</button></div>`).join("")
      || `<div class="card">No project milestones on your path yet. Generate one to get started.</div>`}</div>`;

  $("#projects-view").onclick = e => {
    if (e.target.dataset.open) { showView("career-map"); openNode(e.target.dataset.open); }
    if (e.target.dataset.gen) runAI(e.target, "Project idea", () => endpoints.project(null), () => demoAI.project(null));
  };
}

/* ---- Interview ---- */
function renderInterview() {
  $("#interview-view").innerHTML = `<h2>Interview lab</h2><p class="muted">Practice what your target role will actually test.</p>
    <div class="grid">${["Technical", "Behavioral", "Project", "Role-specific"].map(type => `
      <div class="card"><h3>${type}</h3><br><button class="btn primary" type="button" data-q="${type}">Start interview</button></div>`).join("")}</div>`;
  $("#interview-view").onclick = e => { if (e.target.dataset.q) startInterview(e.target.dataset.q, null); };
}

let demoQuestionIndex = 0;

async function startInterview(type, node) {
  let question;
  try {
    if (appState.demoMode) {
      const list = demoAI.questions[type] || demoAI.questions.Technical;
      question = (node && node.question) || list[demoQuestionIndex++ % list.length];
    } else {
      question = extractQuestion(await endpoints.question(type, node));
    }
  } catch (err) {
    toast(err.message);
    return;
  }
  modal(`<h4>${esc(type)} question</h4><h3>${esc(question)}</h3>
    <label class="field">Your answer<textarea id="answer" rows="6" placeholder="Type your answer…"></textarea></label>
    <p class="err" id="answer-err"></p>
    <div class="row"><button class="btn primary" type="button" id="submit-answer">Submit</button><button class="btn" type="button" data-close>Close</button></div>
    <div id="eval-out" class="ai-result"></div>`);
  $("#submit-answer").addEventListener("click", () => submitAnswer(question));
}

/* Accepts a plain string, {question}, or {questions:[…]} from the backend. */
function extractQuestion(data) {
  if (typeof data === "string") return data;
  if (data && data.question) return data.question;
  const first = data && Array.isArray(data.questions) ? data.questions[0] : null;
  if (first) return typeof first === "string" ? first : first.question;
  throw new Error("We received an unexpected response format.");
}

async function submitAnswer(question) {
  const answer = $("#answer").value.trim();
  if (answer.length < 15) { $("#answer-err").textContent = "Write at least a couple of sentences so we can score it."; return; }
  $("#answer-err").textContent = "";
  const button = $("#submit-answer");
  button.disabled = true;
  button.textContent = "Scoring…";
  try {
    const r = appState.demoMode ? demoAI.evaluate(answer) : await endpoints.evaluate(question, answer);
    const section = (title, value) => value ? `<h4>${title}</h4>${renderValue(value)}` : "";
    $("#eval-out").innerHTML = `<div class="metric">${num(r.score ?? r.overall_score)}/100</div>
      ${section("Strengths", r.strengths)}${section("Weaknesses", r.weaknesses)}${section("Improved answer", r.improved_answer ?? r.improved)}`;
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
    button.textContent = "Submit again";
  }
}

/* ---- Career switch ---- */
function renderCompare() {
  $("#simulator-view").innerHTML = `<h2>Career switch</h2><p class="muted">Compare your current target with another role.</p>
    <div class="row" style="margin-top:16px;max-width:520px">
      <input id="cmp-role" class="map-input" style="flex:1" value="Full Stack Engineer" aria-label="Role to compare with">
      <button class="btn primary" type="button" id="cmp-go">Compare paths</button>
    </div>
    <div id="cmp-out"></div>`;
  $("#cmp-go").addEventListener("click", runCompare);
}

async function runCompare() {
  const role = $("#cmp-role").value.trim();
  if (!role) { toast("Enter a role to compare with."); return; }
  const button = $("#cmp-go");
  button.disabled = true;
  try {
    const raw = appState.demoMode ? demoAI.compare(role) : await endpoints.compare(role);
    const current = raw.current || raw.from, other = raw.other || raw.to;
    if (!current || !other) {                       // unknown shape: still show something readable
      $("#cmp-out").innerHTML = `<div class="card ai-result" style="margin-top:16px">${renderValue(raw)}</div>`;
      return;
    }
    const readiness = x => num(x.readiness);
    $("#cmp-out").innerHTML = `<div class="grid">
      <div class="card"><h3>${esc(current.role)}</h3><div class="metric">${readiness(current)}%</div><p class="muted">readiness</p></div>
      <div class="card"><h3>${esc(other.role)}</h3><div class="metric">${readiness(other)}%</div><p class="muted">readiness</p>
        <br><button class="btn" type="button" id="explore-path">Explore this path</button></div></div>
      <div class="grid">
        <div class="card"><h4>Shared skills</h4>${(raw.shared || []).map(s => `<span class="tag">${esc(s)}</span>`).join(" ")}</div>
        <div class="card"><h4>Additional skills needed</h4>${(raw.additional || []).map(s => `<span class="tag critical">${esc(s)}</span>`).join(" ")}</div></div>
      ${raw.note ? `<p class="muted" style="margin-top:10px">${esc(raw.note)}</p>` : ""}`;
    $("#explore-path").addEventListener("click", () => exploreRole(other.role));
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

function exploreRole(role) {
  if (appState.demoMode) { toast("Demo mode only includes the Frontend Engineer path."); return; }
  const saved = { ...lastForm };
  goHome();
  $("#job-input").value = role;
  startAnalysis({ ...saved, target_job: role });
}

/* ---- Profile ---- */
function renderProfile() {
  const t = appState.target;
  const skills = appState.roadmap.nodes.filter(n => n.type === "skill");
  const levelOptions = id => ["", "Basic", "Intermediate", "Advanced"]
    .map(l => `<option value="${l}" ${appState.profile.levels[id] === l ? "selected" : ""}>${l || "Not set"}</option>`).join("");

  $("#profile-view").innerHTML = `<h2>My career DNA</h2><p class="muted">What you have, what you can prove, and where you're headed.</p>
    <div class="grid">
      <div class="card"><span class="muted">Target role</span><h3>${esc(t.role || "Not set")}</h3><p class="muted">${esc(t.industry || "")}</p></div>
      <div class="card"><span class="muted">Skills you listed</span><p style="margin-top:8px">${appState.profile.skills.length
        ? appState.profile.skills.map(s => `<span class="tag">${esc(s)}</span>`).join(" ")
        : "None yet. Add them under “Paste a job description or add details” on the start page."}</p></div>
    </div>
    <h3 class="section-title">Skill matrix</h3>
    <div class="grid">${skills.map(n => `
      <div class="card"><h3>${esc(n.title)}</h3>
        <p class="muted">${esc(n.status)} · proof ${proofCount(n.id)}/${proofItemsFor(n).length}</p>
        <label class="field" style="margin-top:10px">Your level
          <select class="map-input" data-skill="${esc(n.id)}">${levelOptions(n.id)}</select></label></div>`).join("")}</div>`;

  $("#profile-view").onchange = async e => {
    const id = e.target.dataset.skill;
    if (!id) return;
    appState.profile.levels[id] = e.target.value;
    try {
      if (!appState.demoMode) await endpoints.saveProfile(appState.profile);
      toast("Profile updated.");
    } catch (err) {
      toast(err.message);
    }
  };
}

/* ---- Settings ---- */
function renderSettings() {
  const t = appState.target;
  $("#settings-view").innerHTML = `<h2>Settings</h2>
    <div class="grid">
      <div class="card"><h3>Your plan</h3>
        <label class="field" style="margin-top:12px">Weekly hours<input id="s-hours" type="number" min="1" max="80" value="${num(t.hours_per_week) || 10}"></label>
        <label class="field">Target timeline (months)<input id="s-months" type="number" min="1" max="36" value="${num(t.timeline_months) || 8}"></label>
        <br><button class="btn primary" type="button" id="s-apply">Update plan</button></div>
      <div class="card"><h3>Career path</h3><p class="muted">Save your current path or load the last saved one.</p><br>
        <div class="row"><button class="btn" type="button" id="s-save">Save career path</button><button class="btn" type="button" id="s-load">Load career path</button></div></div>
      <div class="card"><h3>AI transparency</h3>
        <p>AI-generated recommendations may contain errors. Verify important career information.</p>
        <p class="muted" style="margin-top:8px">You are interacting with CareerOS AI.</p></div>
    </div>`;

  $("#s-save").addEventListener("click", saveCareerPath);
  $("#s-load").addEventListener("click", async () => { if (await loadCareerPath()) showView(currentView); });
  $("#s-apply").addEventListener("click", async () => {
    const hours = Number($("#s-hours").value), months = Number($("#s-months").value);
    if (!(hours >= 1 && hours <= 80) || !(months >= 1 && months <= 36)) { toast("Hours must be 1–80 and months 1–36."); return; }
    try { applyWhatIf(await simulate(hours, months)); } catch (err) { toast(err.message); }
  });
}


/* ============ 15. SAVE / LOAD ============ */
async function saveCareerPath() {
  const snapshot = { target: appState.target, readiness: appState.readiness, roadmap: appState.roadmap, proof: appState.proof, profile: appState.profile };
  try {
    if (appState.demoMode) localStorage.setItem(DEMO_SAVE_KEY, JSON.stringify(snapshot));
    else await endpoints.saveRoadmap(snapshot);
    toast("Career path saved.");
  } catch (err) {
    toast(appState.demoMode ? "Couldn't save in this browser." : err.message);
  }
}

/* Returns true when a path was loaded. */
async function loadCareerPath() {
  try {
    if (appState.demoMode) {
      const raw = localStorage.getItem(DEMO_SAVE_KEY);
      if (!raw) { toast("Nothing saved yet. Save a career path first."); return false; }
      const saved = JSON.parse(raw);
      appState.target = saved.target; appState.readiness = saved.readiness; appState.roadmap = saved.roadmap;
      appState.proof = saved.proof || {}; appState.profile = saved.profile || { skills: [], levels: {} };
    } else {
      const data = normalizeRoadmap(await endpoints.loadRoadmap());
      appState.target = {}; appState.readiness = {};
      applyRoadmap(data);
    }
    toast("Career path loaded.");
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}


/* ============ 16. MODALS & TOASTS ============ */
function modal(html) {
  lastFocus = document.activeElement;
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const bg = root.firstElementChild;
  bg.addEventListener("click", e => {
    if (e.target === bg || e.target.closest("[data-close]")) closeModal();   // click outside, or any close button
  });
  const first = bg.querySelector("button,input,textarea,select");
  if (first) first.focus();
}

function closeModal() {
  $("#modal-root").innerHTML = "";
  if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
}

function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 3200);
}


/* ============ 17. UTILITIES ============ */
function $(selector) { return document.querySelector(selector); }
function $$(selector) { return [...document.querySelectorAll(selector)]; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function num(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }

/* Escapes text before putting it into innerHTML, so backend text can't inject HTML. */
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

/* Counts a number up from 0, e.g. 0% → 64% */
function countUp(el, to, suffix = "%") {
  let value = 0;
  const step = Math.max(1, Math.round(to / 30));
  const tick = () => {
    value = Math.min(to, value + step);
    el.textContent = value + suffix;
    if (value < to) requestAnimationFrame(tick);
  };
  tick();
}

/* Fills progress bars after render, so the width transition plays. */
function animateBars(rootSelector) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $$(`${rootSelector} [data-w]`).forEach(el => { el.style.width = Math.min(100, num(el.dataset.w)) + "%"; });
    $$(`${rootSelector} [data-h]`).forEach(el => { el.style.height = Math.min(100, num(el.dataset.h)) + "%"; });
  }));
}
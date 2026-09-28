/**
 * ST Production House — dashboard runtime.
 *
 * Renders ONLY what the API actually returns. No simulated states: if a
 * request fails, the UI says so and shows the real error code. Works under
 * CSP `script-src 'self'` (external file, no inline handlers, no eval).
 *
 * Contract notes (AGENTS.md):
 *   Rule 1  — every state is real: loading / error / empty are explicit.
 *   Rule 15 — internal director names are never fetched for display and
 *             never rendered; panels use channel branding + opaque agentId.
 *   Rule 17 — the connections panel lists secret field KEYS only; locator
 *             values never reach this file.
 */
(function () {
  "use strict";

  const state = {
    me: null,
    csrfToken: null,
    health: null,
    metrics: null,
    channels: [],
    productions: [],
    activeView: "overview",
  };

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
  }

  function shortHash(value, size) {
    const n = size || 12;
    if (typeof value !== "string" || value.length === 0) return "—";
    return value.length <= n ? value : value.slice(0, n) + "…";
  }

  function jsonPretty(value) {
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }

  function statusPillClass(status) {
    switch (status) {
      case "succeeded": case "published": case "ready": case "healthy": case "active":
      case "EXECUTED": case "AUTHORISED": case "authorized":
        return "ok";
      case "running": case "leased": case "in_production": case "rendering": case "EXECUTING":
      case "pending": case "mfa_pending":
        return "warn";
      case "failed": case "dead_letter": case "BLOCKED": case "REFUSED": case "unhealthy":
        return "bad";
      case "queued": case "planned": case "review": case "OWNER_APPROVAL_REQUIRED":
        return "info";
      default:
        return "";
    }
  }

  function pill(text, cls) {
    return '<span class="pill ' + esc(cls || statusPillClass(text)) + '">' + esc(text) + "</span>";
  }

  function errorBox(message) {
    return '<div class="empty">⚠ ' + esc(message) + "</div>";
  }

  function storageErrorMessage(err) {
    if (err && err.code === "STORAGE_NOT_CONFIGURED") {
      return "Storage is not configured on this server (honest 503) — this panel needs a configured database or demo storage.";
    }
    if (err && (err.code === "SESSION_TOKEN_REQUIRED" || err.code === "INVALID_SESSION_TOKEN" || err.status === 401)) {
      return "Session expired — sign in again.";
    }
    return (err && err.code) || (err && err.message) || "request failed";
  }

  async function api(path, options) {
    const opts = Object.assign({ credentials: "same-origin" }, options || {});
    const method = (opts.method || "GET").toUpperCase();
    if (method !== "GET") {
      opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
      if (state.csrfToken) opts.headers["x-csrf-token"] = state.csrfToken;
      if (opts.body === undefined) opts.body = "{}";
    }
    const res = await fetch(path, opts);
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const err = new Error((body && body.error) || "HTTP_" + res.status);
      err.code = body && body.error;
      err.status = res.status;
      throw err;
    }
    return body;
  }

  // Real durable pipeline stage enum (sql/020 + 024 + 025 CHECK constraint).
  const PIPELINE_STAGES = [
    ["story", "script & beats"],
    ["visual", "scene visuals"],
    ["audio", "voice & sound"],
    ["assembly", "ffmpeg render"],
    ["reels", "short-form"],
    ["packaging", "package"],
    ["qc", "quality gate"],
    ["complete", "published state"],
  ];

  // ------------------------------------------------------------------
  // Boot, auth, shell
  // ------------------------------------------------------------------
  function showLogin() {
    $("app-view").classList.add("hidden");
    $("login-view").classList.remove("hidden");
  }

  function enterApp() {
    $("login-view").classList.add("hidden");
    $("app-view").classList.remove("hidden");
    $("owner-email").textContent = state.me && state.me.email ? state.me.email : "";
    refreshCore().then(function () { showView("overview"); });
  }

  async function refreshCore() {
    const results = await Promise.allSettled([
      api("/api/health"),
      api("/api/metrics"),
      api("/api/channels"),
    ]);
    if (results[1].status === "fulfilled") {
      state.metrics = results[1].value;
    } else if (results[1].reason && results[1].reason.status === 401) {
      state.csrfToken = null;
      showLogin();
      return;
    }
    if (results[0].status === "fulfilled") {
      state.health = results[0].value;
      if (state.health.isDemoStorage === true) {
        $("demo-hint").textContent =
          "Demo storage detected on this server — the repository documentation lists the seeded demo owner credentials.";
      }
    }
    if (results[2].status === "fulfilled") {
      state.channels = (results[2].value && results[2].value.channels) || [];
    }
    renderStoragePill();
    renderMiniStats();
    fillChannelSelects();
    fillDirectorSelects();
  }

  function renderStoragePill() {
    const el = $("storage-pill");
    if (!state.health) { el.textContent = "health unreachable"; el.className = "pill bad"; return; }
    const mode = state.health.storage || "unknown";
    const status = state.health.status || "unknown";
    el.textContent = mode + " · " + status;
    el.className = "pill " + (status === "healthy" ? "ok" : "warn");
  }

  function renderMiniStats() {
    const m = state.metrics;
    $("mini-directors").textContent = m ? String(m.agents ?? "—") : "…";
    $("mini-channels").textContent = m ? String(m.channels ?? "—") : "…";
    $("mini-storage").textContent = state.health ? (state.health.storage || "—") : "…";
  }

  function fillChannelSelects() {
    const options = state.channels.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.displayName) + " (" + esc(c.slug) + ")</option>";
    });
    for (const id of ["prod-channel", "dest-channel"]) {
      const select = $(id);
      if (select) select.innerHTML = options.length > 0 ? options : '<option value="">no channels yet</option>';
    }
  }

  function fillDirectorSelects() {
    // Directors are addressed by opaque agentId, labeled with the channel's
    // PUBLIC display name. Internal names are never fetched or rendered.
    const seen = new Map();
    for (const c of state.channels) {
      if (c.agentId && !seen.has(c.agentId)) seen.set(c.agentId, c.displayName);
    }
    const options = Array.from(seen.entries()).map(function (pair) {
      return '<option value="' + esc(pair[0]) + '">Director ' + esc(pair[0]) + " · " + esc(pair[1]) + "</option>";
    });
    for (const id of ["comm-agent", "memory-agent", "conn-agent"]) {
      const select = $(id);
      if (select) select.innerHTML = options.length > 0 ? options : '<option value="">no directors with channels yet</option>';
    }
  }

  function bindLogin() {
    $("login-form").addEventListener("submit", async function (event) {
      event.preventDefault();
      const button = $("login-btn");
      const errorBoxEl = $("login-error");
      errorBoxEl.textContent = "";
      button.disabled = true;
      try {
        const body = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ email: $("email").value, password: $("password").value }),
        });
        state.me = body.owner;
        state.csrfToken = body.csrfToken || null;
        enterApp();
      } catch (err) {
        errorBoxEl.textContent = String(err.code || err.message || "login failed")
          .toLowerCase().replace(/_/g, " ");
      } finally {
        button.disabled = false;
      }
    });

    $("logout-btn").addEventListener("click", async function () {
      try {
        await api("/api/auth/logout", { method: "POST" });
      } catch (err) {
        // Cookie-session restores have no CSRF material; the logout route
        // fails closed. The UI still returns to the login gate honestly.
      }
      state.me = null;
      state.csrfToken = null;
      showLogin();
    });
  }

  // ------------------------------------------------------------------
  // Sidebar router
  // ------------------------------------------------------------------
  const loaders = {
    overview: loadOverview,
    directors: loadDirectors,
    communication: loadCommunicationView,
    memory: loadMemoryView,
    production: loadProductionView,
    jobs: loadJobs,
    providers: loadProviders,
    quotas: loadQuotas,
    connections: loadConnectionsView,
    publishing: loadPublishing,
    approvals: loadApprovals,
    analytics: loadAnalytics,
    hermes: loadHermes,
    evidence: loadEvidence,
    alerts: loadAlerts,
    settings: loadSettings,
  };

  function showView(name) {
    state.activeView = name;
    for (const section of document.querySelectorAll(".view")) section.hidden = section.id !== "view-" + name;
    for (const item of document.querySelectorAll(".nav-item")) {
      item.classList.toggle("active", item.getAttribute("data-view") === name);
    }
    const loader = loaders[name];
    if (loader) loader().catch(function (err) {
      const main = $("view-" + name);
      if (main) main.insertAdjacentHTML("afterbegin", errorBox(storageErrorMessage(err)));
    });
  }

  function bindNav() {
    for (const item of document.querySelectorAll(".nav-item")) {
      item.addEventListener("click", function () { showView(item.getAttribute("data-view")); });
    }
    const refreshMap = {
      "overview-refresh": "overview", "directors-refresh": "directors",
      "production-refresh": "production", "jobs-refresh": "jobs",
      "providers-refresh": "providers", "publishing-refresh": "publishing",
      "approvals-refresh": "approvals", "analytics-refresh": "analytics",
      "hermes-refresh": "hermes", "evidence-refresh": "evidence",
      "settings-refresh": "settings",
    };
    for (const id of Object.keys(refreshMap)) {
      const el = $(id);
      if (el) el.addEventListener("click", function () { showView(refreshMap[id]); });
    }
    $("release-detail-close").addEventListener("click", function () {
      $("release-detail-panel").classList.add("hidden");
    });
  }

  // ------------------------------------------------------------------
  // Shared renderers
  // ------------------------------------------------------------------
  function renderMetricsStrip() {
    const strip = $("metrics-strip");
    const m = state.metrics;
    if (!m) { strip.innerHTML = errorBox("Metrics unavailable — check the session and the server health."); return; }
    const jobs = m.jobsByStatus || {};
    const running = (jobs.running || 0) + (jobs.leased || 0) + (jobs.queued || 0);
    const failed = (jobs.failed || 0) + (jobs.dead_letter || 0);
    const tiles = [
      ["Registered directors", m.agents, ""],
      ["Channels (live)", m.channels, ""],
      ["Jobs in flight", running, running > 0 ? "warn" : ""],
      ["Jobs failed", failed, failed > 0 ? "bad" : "ok"],
      ["Evidence events", m.evidenceEvents, ""],
      ["Active sessions", m.activeSessions, ""],
      ["Storage mode", m.storage || "—", ""],
      ["Uptime", m.process ? Math.round(m.process.uptimeSeconds / 60) + "m" : "—", ""],
    ];
    strip.innerHTML = tiles.map(function (t) {
      return '<div class="metric"><div class="label">' + esc(t[0]) + '</div><div class="value ' + t[2] + '">' + esc(String(t[1] ?? "—")) + "</div></div>";
    }).join("");
  }

  function channelCard(c) {
    return '<div class="card">' +
      "<h3>" + esc(c.displayName) + "</h3>" +
      '<div class="tagline">' + esc(c.tagline || "—") + "</div>" +
      '<div class="meta">' + pill(c.agentEnabled === false ? "director disabled" : "director enabled", c.agentEnabled === false ? "bad" : "ok") +
      " " + pill((c.releaseCount ?? 0) + " releases", "info") + "</div>" +
      '<div class="row"><span>slug</span><b>' + esc(c.slug) + "</b></div>" +
      '<div class="row"><span>language</span><b>' + esc(c.language || "—") + "</b></div>" +
      '<div class="row"><span>director slot</span><b>' + esc(c.agentId) + "</b></div>" +
      "</div>";
  }

  function renderPipelineStrip() {
    const host = $("pipeline-strip");
    host.innerHTML = PIPELINE_STAGES.map(function (stage, i) {
      const sep = i > 0 ? '<span class="sep">→</span>' : "";
      return sep + '<span class="stage"><b>' + esc(stage[0]) + "</b><span>" + esc(stage[1]) + "</span></span>";
    }).join("");
  }

  // ------------------------------------------------------------------
  // Overview
  // ------------------------------------------------------------------
  async function loadOverview() {
    renderMetricsStrip();
    renderPipelineStrip();
    const cards = $("overview-channels");
    cards.innerHTML = state.channels.length === 0
      ? '<div class="empty">No channels yet — create one to give a director its first universe.</div>'
      : state.channels.map(channelCard).join("");

    // Latest artifacts across the most recent releases (real data only).
    const target = $("overview-artifacts");
    target.innerHTML = '<div class="loading">Loading latest recorded artifacts…</div>';
    try {
      const productions = await api("/api/productions?limit=20");
      state.productions = productions.productions || [];
      if (state.productions.length === 0) {
        target.innerHTML = '<div class="empty">No productions recorded yet. Queue an episode from the Production panel — this list only shows real pipeline output.</div>';
        return;
      }
      const details = await Promise.allSettled(
        state.productions.slice(0, 8).map(function (p) { return api("/api/productions/" + encodeURIComponent(p.id)); })
      );
      const rows = [];
      for (const result of details) {
        if (result.status !== "fulfilled") continue;
        const release = result.value.release || {};
        for (const artifact of result.value.artifacts || []) rows.push({ release: release, artifact: artifact });
      }
      if (rows.length === 0) {
        target.innerHTML = '<div class="empty">No artifacts recorded yet — pipeline runs will attach real, hash-verified artifacts here (ffprobe state shown honestly).</div>';
        return;
      }
      target.innerHTML = rows.map(artifactRow).join("");
    } catch (err) {
      target.innerHTML = errorBox(storageErrorMessage(err));
    }
  }

  function artifactRow(entry) {
    const a = entry.artifact;
    const r = entry.release || {};
    return '<div class="row-item">' +
      '<span class="title">' + esc(a.kind) + (a.stage ? " · " + esc(a.stage) : "") + "</span>" +
      '<span class="sub">' + esc(r.title || "release " + shortHash(a.releaseId)) + "</span>" +
      '<span class="sub">mode ' + esc(a.generationMode || "unknown") + "</span>" +
      pill(a.ffprobeVerified === true ? "ffprobe verified" : "ffprobe unverified", a.ffprobeVerified === true ? "ok" : "warn") +
      '<span class="spacer"></span>' +
      '<span class="sha" title="SHA-256">' + esc(shortHash(a.sha256)) + "</span>" +
      '<span class="sub">' + esc(a.sizeBytes != null ? Math.round(a.sizeBytes / 1024) + " KB" : "size —") + "</span>" +
      "</div>";
  }

  // ------------------------------------------------------------------
  // Directors
  // ------------------------------------------------------------------
  async function loadDirectors() {
    $("directors-agent-count").textContent = state.metrics ? String(state.metrics.agents ?? "—") : "…";
    const host = $("directors-cards");
    host.innerHTML = state.channels.length === 0
      ? '<div class="empty">No channels yet — each director gets its public brand through a channel.</div>'
      : state.channels.map(function (c) {
          return channelCard(c) .replace("</div>", '<div class="actions"><button data-channel="' + esc(c.id) + '">Open detail</button></div></div>');
        }).join("");
    for (const button of host.querySelectorAll("button[data-channel]")) {
      button.addEventListener("click", function () { loadChannelDetail(button.getAttribute("data-channel")); });
    }
    $("directors-channel-detail").innerHTML = "";
  }

  async function loadChannelDetail(channelId) {
    const host = $("directors-channel-detail");
    host.innerHTML = '<div class="loading">Loading channel detail…</div>';
    try {
      const detail = await api("/api/channels/" + encodeURIComponent(channelId));
      const releases = detail.releases || [];
      const destinations = detail.destinations || [];
      host.innerHTML =
        '<div class="panel" style="margin-top:14px;">' +
        '<h2>' + esc(detail.displayName) + " — detail</h2>" +
        '<div class="chips">' + pill(detail.agentEnabled === false ? "director disabled" : "director enabled", detail.agentEnabled === false ? "bad" : "ok") + "</div>" +
        "<h2>Releases</h2>" +
        (releases.length === 0
          ? '<div class="empty">No releases planned for this channel yet.</div>'
          : '<div class="list">' + releases.map(releaseRow).join("") + "</div>") +
        "<h2>Publishing destinations</h2>" +
        (destinations.length === 0
          ? '<div class="empty">No destinations configured — publishing accounts panel can add them.</div>'
          : destinations.map(destinationRow).join("")) +
        "</div>";
    } catch (err) {
      host.innerHTML = errorBox(storageErrorMessage(err));
    }
  }

  // ------------------------------------------------------------------
  // Director communication
  // ------------------------------------------------------------------
  async function loadCommunicationView() {
    if (state.channels.length === 0) {
      $("comm-thread").innerHTML = '<div class="empty">No directors with channels yet.</div>';
      $("comm-form").classList.add("hidden");
      return;
    }
    $("comm-form").classList.remove("hidden");
    await loadConversation();
  }

  async function loadConversation() {
    const agentId = $("comm-agent").value;
    const host = $("comm-thread");
    if (!agentId) { host.innerHTML = '<div class="empty">Pick a director to open its persistent window.</div>'; return; }
    host.innerHTML = '<div class="loading">Loading window…</div>';
    try {
      const data = await api("/api/directors/" + encodeURIComponent(agentId) + "/conversation");
      const messages = data.messages || [];
      host.innerHTML = (messages.length === 0
        ? '<div class="empty">Window is open and empty — record the first message below. Recording never triggers production or publishing.</div>'
        : messages.map(function (msg) {
            return '<div class="bubble"><div class="head">' +
              '<span class="who">' + esc(msg.sender) + "</span>" + pill(msg.kind, "info") +
              '<span class="when">' + esc(fmtDate(msg.createdAt)) + "</span></div>" +
              '<div class="body">' + esc(msg.body) + "</div></div>";
          }).join(""));
    } catch (err) {
      host.innerHTML = errorBox(storageErrorMessage(err));
    }
  }

  // ------------------------------------------------------------------
  // Director memory
  // ------------------------------------------------------------------
  async function loadMemoryView() {
    if (state.channels.length === 0) {
      $("memory-list").innerHTML = '<div class="empty">No directors with channels yet.</div>';
      return;
    }
    await loadMemory();
  }

  async function loadMemory() {
    const agentId = $("memory-agent").value;
    const host = $("memory-list");
    if (!agentId) { host.innerHTML = '<div class="empty">Pick a director to read its isolated memory.</div>'; return; }
    host.innerHTML = '<div class="loading">Loading memory…</div>';
    try {
      const data = await api("/api/directors/" + encodeURIComponent(agentId) + "/memory");
      const entries = data.entries || [];
      host.innerHTML = entries.length === 0
        ? '<div class="empty">Memory is empty for this director — categories fill as the universe bible, characters and identities are authored.</div>'
        : entries.map(function (entry) {
            return '<div class="card"><h3>' + esc(entry.category) + "</h3>" +
              '<pre class="detail-pre">' + esc(jsonPretty(entry.content)) + "</pre>" +
              '<div class="row"><span>updated</span><b>' + esc(fmtDate(entry.updatedAt)) + "</b></div></div>";
          }).join("");
    } catch (err) {
      host.innerHTML = errorBox(storageErrorMessage(err));
    }
  }

  // ------------------------------------------------------------------
  // Production
  // ------------------------------------------------------------------
  function releaseRow(r) {
    return '<div class="row-item">' +
      '<span class="title">' + esc(r.title) + "</span>" +
      '<span class="sub">S' + esc(r.season) + "E" + esc(r.episode) + "</span>" +
      '<span class="sub">' + esc(r.channelName || r.channelSlug || "") + "</span>" +
      pill(r.status) +
      '<span class="spacer"></span>' +
      '<button data-release="' + esc(r.id) + '">Detail</button>' +
      "</div>";
  }

  async function loadProductionView() {
    $("release-detail-panel").classList.add("hidden");
    const host = $("production-list");
    host.innerHTML = '<div class="loading">Loading productions…</div>';
    try {
      const productions = await api("/api/productions?limit=100");
      state.productions = productions.productions || [];
      host.innerHTML = state.productions.length === 0
        ? '<div class="empty">No productions yet. Queue an episode above — one planned release per (channel, season, episode) slot, enforced by the database.</div>'
        : '<div class="list">' + state.productions.map(releaseRow).join("") + "</div>";
      for (const button of host.querySelectorAll("button[data-release]")) {
        button.addEventListener("click", function () { loadReleaseDetail(button.getAttribute("data-release")); });
      }
    } catch (err) {
      host.innerHTML = errorBox(storageErrorMessage(err));
    }
  }

  async function loadReleaseDetail(releaseId) {
    const panel = $("release-detail-panel");
    const host = $("release-detail");
    panel.classList.remove("hidden");
    host.innerHTML = '<div class="loading">Loading release detail…</div>';
    try {
      const data = await api("/api/productions/" + encodeURIComponent(releaseId));
      const release = data.release || {};
      const events = data.events || [];
      const artifacts = data.artifacts || [];
      $("release-detail-title").textContent = release.title + " — S" + release.season + "E" + release.episode;

      const latestByStage = new Map();
      for (const event of events) latestByStage.set(event.stage, event);
      const stageChips = PIPELINE_STAGES.map(function (stage) {
        const event = latestByStage.get(stage[0]);
        return '<span class="stage"><b>' + esc(stage[0]) + "</b><span>" +
          (event ? esc(event.status) : "not run") + "</span></span>";
      }).join('<span class="sep">→</span>');

      let destinationsHtml = '<div class="empty">Loading destinations…</div>';
      host.innerHTML =
        '<div class="chips">' + pill(release.status) + "</div>" +
        "<h2>Pipeline stages (durable events)</h2>" +
        '<div class="pipeline">' + stageChips + "</div>" +
        "<h2>Pipeline events</h2>" +
        (events.length === 0
          ? '<div class="empty">No pipeline events recorded — run the pipeline to produce real stages.</div>'
          : '<div class="thread">' + events.slice().reverse().map(function (event) {
              return '<div class="bubble"><div class="head">' + esc(event.stage) + "</div>" +
                '<div class="body">' + esc(event.status) + " · " + esc(fmtDate(event.createdAt)) +
                (event.detail ? "\n" + esc(jsonPretty(event.detail)) : "") + "</div></div>";
            }).join("") + "</div>") +
        "<h2>Artifacts</h2>" +
        (artifacts.length === 0
          ? '<div class="empty">No media yet — ffprobe verification pending. Artifacts appear here only after real pipeline stages write them.</div>'
          : artifacts.map(function (a) { return artifactRow({ release: release, artifact: a }); }).join("")) +
        '<div id="release-actions"></div>';

      const actions = $("release-actions");
      const canRun = release.status !== "published" && release.status !== "cancelled";
      actions.innerHTML =
        (canRun ? '<div class="form-row"><button id="run-release" class="btn-primary">Run pipeline now</button>' +
          '<span class="muted">Claims the queued job with a legal lease and executes the real stage executors.</span></div>' : "") +
        '<div class="form-row" id="publish-row"></div>';
      const runButton = $("run-release");
      if (runButton) {
        runButton.addEventListener("click", async function () {
          runButton.disabled = true;
          try {
            await api("/api/productions/" + encodeURIComponent(releaseId) + "/run", { method: "POST" });
            await loadReleaseDetail(releaseId);
          } catch (err) {
            host.insertAdjacentHTML("afterbegin", errorBox(storageErrorMessage(err)));
            runButton.disabled = false;
          }
        });
      }
      // Publish intent (Rule 7 gate is server-side).
      try {
        const channelDetail = await api("/api/channels/" + encodeURIComponent(release.channelId));
        const destinations = channelDetail.destinations || [];
        const publishRow = $("publish-row");
        if (destinations.length === 0) {
          publishRow.innerHTML = '<span class="muted">Publishing needs a configured destination with public attribution (add one under Publishing Accounts).</span>';
        } else {
          publishRow.innerHTML =
            '<select id="publish-destination">' +
            destinations.map(function (d) {
              return '<option value="' + esc(d.id) + '">' + esc(d.platform) + " · " + esc(d.handle) + "</option>";
            }).join("") + "</select>" +
            '<button id="publish-release" class="btn-primary">Record publish intent</button>' +
            '<span class="muted">Owner-gated intent + evidence only; live platform calls remain pending.</span>';
          $("publish-release").addEventListener("click", async function () {
            const button = $("publish-release");
            button.disabled = true;
            try {
              await api("/api/productions/" + encodeURIComponent(releaseId) + "/publish", {
                method: "POST",
                body: JSON.stringify({ destinationId: $("publish-destination").value }),
              });
              await loadReleaseDetail(releaseId);
            } catch (err) {
              host.insertAdjacentHTML("afterbegin", errorBox(storageErrorMessage(err)));
              button.disabled = false;
            }
          });
        }
      } catch { destinationsHtml = ""; }
    } catch (err) {
      host.innerHTML = errorBox(storageErrorMessage(err));
    }
  }

  // ------------------------------------------------------------------
  // Active jobs
  // ------------------------------------------------------------------
  async function loadJobs() {
    const chips = $("jobs-by-status");
    const host = $("jobs-list");
    const jobs = (state.metrics && state.metrics.jobsByStatus) || {};
    const keys = Object.keys(jobs);
    chips.innerHTML = keys.length === 0
      ? '<div class="empty">No jobs recorded yet.</div>'
      : keys.map(function (k) { return pill(k + " · " + jobs[k], "info"); }).join("");
    host.innerHTML = '<div class="loading">Loading job runs…</div>';
    try {
      const runs = await api("/api/content-runs?limit=50");
      const list = runs.runs || [];
      host.innerHTML = list.length === 0
        ? '<div class="empty">No package runs recorded yet.</div>'
        : '<div class="list">' + list.map(function (run) {
            const provenance = run.provenance || {};
            return '<div class="row-item">' +
              '<span class="title">' + esc(shortHash(run.packageTaskId, 14)) + "</span>" +
              pill(run.readiness || "pending") +
              '<span class="sub">orchestrator ' + esc(run.orchestrator || "—") + "</span>" +
              '<span class="sub">provider calls ' + esc(String(provenance.providerCalls ?? "—")) + "</span>" +
              '<span class="sub">media ' + esc(provenance.mediaStatus || "—") + "</span>" +
              '<span class="spacer"></span>' +
              '<span class="sub">' + esc(run.reasonCode || "") + "</span>" +
              "</div>";
          }).join("") + "</div>";
    } catch (err) {
      host.innerHTML = errorBox(storageErrorMessage(err));
    }
  }

  // ------------------------------------------------------------------
  // Providers / quotas / connections
  // ------------------------------------------------------------------
  async function loadProviders() {
    const host = $("providers-list");
    host.innerHTML = '<div class="loading">Loading governed catalog…</div>';
    try {
      const data = await api("/api/providers/catalog");
      const providers = data.providers || [];
      host.innerHTML = providers.length === 0
        ? '<div class="empty">Provider catalog is empty.</div>'
        : providers.map(function (p) {
            const fields = (p.fields || []).map(function (f) {
              return '<span class="plat ' + (f.kind === "secret" ? "" : "on") + '">' + esc(f.key) + " · " + esc(f.kind) + "</span>";
            }).join("");
            const caps = (p.capabilities || []).map(function (c) { return '<span class="plat">' + esc(c) + "</span>"; }).join("");
            return '<div class="card"><h3>' + esc(p.displayName) + "</h3>" +
              '<div class="meta">' + pill(p.category, "info") + pill("auth: " + p.authType, "") + "</div>" +
              '<div class="row"><span>credential fields</span></div><div class="platforms">' + fields + "</div>" +
              '<div class="row"><span>capabilities</span></div><div class="platforms">' + caps + "</div>" +
              '<div class="row"><span>official credential URL</span><b><a href="' + esc(p.credentialUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(shortHash(p.credentialUrl, 34)) + "</a></b></div>" +
              "</div>";
          }).join("");
    } catch (err) {
      host.innerHTML = errorBox(storageErrorMessage(err));
    }
  }

  async function loadQuotas() {
    const host = $("quotas-body");
    const jobs = (state.metrics && state.metrics.jobsByStatus) || {};
    const keys = Object.keys(jobs);
    host.innerHTML =
      '<p class="muted">Provider quota windows and rate-limit budgets are enforced server-side (quota state lives with the credential broker and the owner-operations service). This control-plane server does not expose a quota read route yet, so no numbers are invented here.</p>' +
      "<h2>Real queue pressure (current snapshot)</h2>" +
      (keys.length === 0
        ? '<div class="empty">No jobs recorded — queue pressure is zero right now.</div>'
        : '<div class="chips">' + keys.map(function (k) { return pill(k + " · " + jobs[k], "info"); }).join("") + "</div>");
  }

  async function loadConnectionsView() {
    if (state.channels.length === 0) {
      $("connections-list").innerHTML = '<div class="empty">No directors with channels yet.</div>';
      return;
    }
    await loadConnections();
  }

  async function loadConnections() {
    const agentId = $("conn-agent").value;
    const host = $("connections-list");
    if (!agentId) { host.innerHTML = '<div class="empty">Pick a director to list its provider bindings.</div>'; return; }
    host.innerHTML = '<div class="loading">Loading connections…</div>';
    try {
      const data = await api("/api/connections/directors/" + encodeURIComponent(agentId));
      const items = data.items || [];
      host.innerHTML = items.length === 0
        ? '<div class="empty">No provider bindings for this director yet — slots stay unconfigured until the owner binds secret-manager locators.</div>'
        : '<div class="list">' + items.map(function (c) {
            const secretKeys = (c.secretFieldKeys || []).map(function (k) {
              return '<span class="plat" title="locator value never serializes">⚿ ' + esc(k) + "</span>";
            }).join("");
            return '<div class="row-item">' +
              '<span class="title">' + esc(c.providerKey) + "</span>" +
              pill(c.kind, "info") + pill(c.status || "unknown") +
              '<span class="sub">' + esc(c.credentialLabel || "no label") + "</span>" +
              '<span class="platforms">' + (secretKeys || '<span class="plat">no secret fields</span>') + "</span>" +
              '<span class="spacer"></span>' +
              '<span class="sub">config keys: ' + esc(Object.keys(c.configFields || {}).join(", ") || "—") + "</span>" +
              "</div>";
          }).join("") + "</div>";
    } catch (err) {
      host.innerHTML = errorBox(storageErrorMessage(err));
    }
  }

  // ------------------------------------------------------------------
  // Publishing accounts
  // ------------------------------------------------------------------
  function destinationRow(d) {
    return '<div class="row-item">' +
      pill(d.platform, "info") +
      '<span class="title">' + esc(d.handle) + "</span>" +
      (d.isPrimary ? pill("primary", "ok") : "") +
      '<span class="sub">attribution: ' + esc(d.publicAttribution) + "</span>" +
      '<span class="spacer"></span>' +
      '<span class="sub">' + esc(fmtDate(d.createdAt)) + "</span>" +
      "</div>";
  }

  async function loadPublishing() {
    const host = $("publishing-list");
    if (state.channels.length === 0) {
      host.innerHTML = '<div class="empty">No channels yet — destinations attach to channels.</div>';
      return;
    }
    host.innerHTML = '<div class="loading">Loading destinations…</div>';
    try {
      const details = await Promise.allSettled(
        state.channels.map(function (c) { return api("/api/channels/" + encodeURIComponent(c.id)); })
      );
      const groups = [];
      for (let i = 0; i < details.length; i++) {
        if (details[i].status !== "fulfilled") continue;
        const detail = details[i].value;
        const destinations = detail.destinations || [];
        groups.push(
          "<h2>" + esc(detail.displayName) + "</h2>" +
          (destinations.length === 0
            ? '<div class="empty">No destinations for this channel yet.</div>'
            : '<div class="list">' + destinations.map(destinationRow).join("") + "</div>")
        );
      }
      host.innerHTML = groups.join("") || '<div class="empty">Destination data unavailable.</div>';
    } catch (err) {
      host.innerHTML = errorBox(storageErrorMessage(err));
    }
  }

  // ------------------------------------------------------------------
  // Approvals / analytics / alerts
  // ------------------------------------------------------------------
  async function loadApprovals() {
    const host = $("approvals-body");
    host.innerHTML = '<div class="loading">Loading approval queue…</div>';
    try {
      const data = await api("/api/control/approvals");
      const approvals = data.approvals || [];
      host.innerHTML = approvals.length === 0
        ? '<div class="empty">Approval queue is empty — nothing is waiting on the owner right now.</div>'
        : '<div class="list">' + approvals.map(function (a) {
            return '<div class="row-item">' +
              pill(a.status || "pending", "info") +
              '<span class="title">' + esc(a.destination || "—") + "</span>" +
              '<span class="sub">' + esc(a.artifactKind || "artifact") + " · " + esc(shortHash(a.artifactSha256)) + "</span>" +
              '<span class="sub">' + esc(a.captionSnapshot || "") + "</span>" +
              '<span class="spacer"></span>' +
              '<span class="sub">expires ' + esc(fmtDate(a.approvalExpiresAt)) + "</span>" +
              "</div>";
          }).join("") + "</div>";
    } catch (err) {
      host.innerHTML = errorBox(storageErrorMessage(err));
    }
  }

  async function loadAnalytics() {
    const host = $("analytics-body");
    renderMetricsStrip();
    const jobs = (state.metrics && state.metrics.jobsByStatus) || {};
    const keys = Object.keys(jobs);
    host.innerHTML =
      "<h2>Operational counters (live from /api/metrics)</h2>" +
      '<div class="metrics-strip" style="margin-bottom:12px;">' + $("metrics-strip").innerHTML + "</div>" +
      "<h2>Jobs by status</h2>" +
      (keys.length === 0
        ? '<div class="empty">No jobs recorded yet.</div>'
        : '<div class="chips">' + keys.map(function (k) { return pill(k + " · " + jobs[k], "info"); }).join("") + "</div>") +
      '<p class="muted">Platform performance analytics (full-precision records, sql/027) are ingested and read through the owner-operations service; this control-plane server exposes operational counters only. Nothing is extrapolated.</p>';
  }

  async function loadAlerts() {
    $("alerts-body").innerHTML =
      '<div class="empty">No alert feed is mounted on this control-plane server yet. The durable alert queue lives in the resilience layer and is not exposed over HTTP here — when the route ships, this panel reads it directly. No alerts are invented in the meantime.</div>';
  }

  // ------------------------------------------------------------------
  // Hermes
  // ------------------------------------------------------------------
  async function loadHermes() {
    const overviewHost = $("hermes-overview");
    const authorityHost = $("hermes-authority");
    const decisionsHost = $("hermes-decisions");
    overviewHost.innerHTML = '<div class="loading">Loading decision layer…</div>';
    try {
      const overview = await api("/api/hermes/overview");
      const tiles = [
        ["Last decision #", overview.lastDecisionNumber ?? 0, ""],
        ["Blocked refusals", overview.blockedRefusals ?? 0, (overview.blockedRefusals ?? 0) > 0 ? "bad" : ""],
        ["Pending owner approval", overview.pendingOwnerApproval ?? 0, (overview.pendingOwnerApproval ?? 0) > 0 ? "warn" : ""],
      ];
      const outcomes = Object.entries(overview.decisions || {});
      for (const pair of outcomes) tiles.push(["Outcome · " + pair[0], pair[1], ""]);
      overviewHost.innerHTML = tiles.map(function (t) {
        return '<div class="metric"><div class="label">' + esc(t[0]) + '</div><div class="value ' + t[2] + '">' + esc(String(t[1])) + "</div></div>";
      }).join("") +
      (Object.keys(overview.byCategory || {}).length === 0 ? "" :
        '<div class="chips" style="grid-column:1/-1;">' +
        Object.entries(overview.byCategory).map(function (pair) { return pill(pair[0] + " · " + pair[1], "info"); }).join("") + "</div>");
    } catch (err) {
      overviewHost.innerHTML = errorBox(storageErrorMessage(err));
    }

    try {
      const authority = await api("/api/hermes/authority");
      const matrix = authority.matrix || {};
      authorityHost.innerHTML = Object.keys(matrix).length === 0
        ? '<div class="empty">Authority matrix is empty.</div>'
        : Object.entries(matrix).map(function (pair) {
            return pill(pair[0] + " → " + pair[1], pair[1] === "PROHIBITED" ? "bad" : pair[1] === "AUTONOMOUS" ? "ok" : "warn");
          }).join("") +
          '<p class="muted" style="width:100%;">' + esc(authority.note || "") + "</p>";
    } catch (err) {
      authorityHost.innerHTML = errorBox(storageErrorMessage(err));
    }

    try {
      const decisions = await api("/api/hermes/decisions?limit=20");
      const list = decisions.decisions || [];
      decisionsHost.innerHTML = list.length === 0
        ? '<div class="empty">No decisions recorded yet — the manager records every action, refusal and escalation here.</div>'
        : list.map(function (d) {
            return '<div class="bubble"><div class="head">' +
              '<span class="who">#' + esc(d.decisionNumber) + " " + esc(d.action) + "</span>" +
              pill(d.outcome) + pill(d.authority, "info") + pill(d.category || "—", "") +
              '<span class="when">' + esc(fmtDate(d.createdAt)) + "</span></div>" +
              '<div class="body">' + esc(d.reason || "") +
              (d.reasonCode ? "\nreasonCode: " + esc(d.reasonCode) : "") +
              (d.errorCode ? "\nerrorCode: " + esc(d.errorCode) : "") + "</div></div>";
          }).join("");
    } catch (err) {
      decisionsHost.innerHTML = errorBox(storageErrorMessage(err));
    }
  }

  // ------------------------------------------------------------------
  // Evidence
  // ------------------------------------------------------------------
  async function loadEvidence() {
    const host = $("evidence-list");
    host.innerHTML = '<div class="loading">Loading evidence ledger…</div>';
    try {
      const events = await api("/api/evidence");
      const list = Array.isArray(events) ? events : [];
      const latest = list.slice(-100).reverse();
      host.innerHTML = list.length === 0
        ? '<div class="empty">Ledger is empty — every verified action will append a hash-chained row here.</div>'
        : '<p class="muted">Showing latest ' + latest.length + " of " + list.length + " events (append-only, hash-chained).</p>" +
          '<div class="thread">' + latest.map(function (event) {
            return '<div class="bubble"><div class="head">' +
              '<span class="who">' + esc(event.kind) + "</span>" + pill(event.classification, "info") +
              '<span class="when">' + esc(fmtDate(event.occurredAt)) + "</span></div>" +
              '<div class="body">subject ' + esc(event.subjectId) +
              '\n<span class="sha">prev ' + esc(shortHash(event.previousHash, 10)) + " ← event " + esc(shortHash(event.eventHash, 10)) + "</span>" +
              (Object.keys(event.payload || {}).length > 0 ? "\n" + esc(jsonPretty(event.payload)) : "") +
              "</div></div>";
          }).join("") + "</div>";
    } catch (err) {
      host.innerHTML = errorBox(storageErrorMessage(err));
    }
  }

  // ------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------
  async function loadSettings() {
    const ownerHost = $("settings-owner");
    const sessionsHost = $("sessions-list");
    try {
      const me = await api("/api/auth/me");
      state.me = me;
      ownerHost.innerHTML =
        '<div class="cards"><div class="card"><h3>Owner</h3>' +
        '<div class="row"><span>email</span><b>' + esc(me.email) + "</b></div>" +
        '<div class="row"><span>role</span><b>' + esc(me.role) + "</b></div>" +
        '<div class="row"><span>status</span><b>' + pill(me.status) + "</b></div>" +
        '<div class="row"><span>MFA</span><b>' + pill(me.mfaEnabled ? "enabled" : "not enrolled", me.mfaEnabled ? "ok" : "warn") + "</b></div>" +
        "</div></div>";
    } catch (err) {
      ownerHost.innerHTML = errorBox(storageErrorMessage(err));
    }
    try {
      const sessions = await api("/api/auth/sessions");
      const list = Array.isArray(sessions) ? sessions : [];
      sessionsHost.innerHTML = list.length === 0
        ? '<div class="empty">No other active sessions.</div>'
        : '<div class="list">' + list.map(function (s) {
            return '<div class="row-item">' +
              '<span class="title">' + esc(shortHash(s.id, 14)) + "</span>" +
              pill(s.mfaAssuranceLevel || "basic", "info") +
              '<span class="sub">created ' + esc(fmtDate(s.createdAt)) + "</span>" +
              '<span class="sub">last seen ' + esc(fmtDate(s.lastSeenAt)) + "</span>" +
              '<span class="spacer"></span>' +
              '<button data-revoke="' + esc(s.id) + '">Revoke</button>' +
              "</div>";
          }).join("") + "</div>";
      for (const button of sessionsHost.querySelectorAll("button[data-revoke]")) {
        button.addEventListener("click", async function () {
          button.disabled = true;
          try {
            await api("/api/auth/sessions/" + encodeURIComponent(button.getAttribute("data-revoke")), { method: "DELETE" });
            await loadSettings();
          } catch (err) {
            sessionsHost.insertAdjacentHTML("afterbegin", errorBox(storageErrorMessage(err)));
          }
        });
      }
    } catch (err) {
      sessionsHost.innerHTML = errorBox(storageErrorMessage(err));
    }
  }

  // ------------------------------------------------------------------
  // Form bindings
  // ------------------------------------------------------------------
  function bindForms() {
    $("comm-load").addEventListener("click", loadConversation);
    $("memory-load").addEventListener("click", loadMemory);
    $("conn-load").addEventListener("click", loadConnections);

    $("comm-form").addEventListener("submit", async function (event) {
      event.preventDefault();
      const agentId = $("comm-agent").value;
      const errorEl = $("comm-error");
      errorEl.textContent = "";
      try {
        await api("/api/directors/" + encodeURIComponent(agentId) + "/conversation", {
          method: "POST",
          body: JSON.stringify({
            sender: $("comm-sender").value,
            kind: $("comm-kind").value,
            body: $("comm-body").value,
          }),
        });
        $("comm-body").value = "";
        await loadConversation();
      } catch (err) {
        errorEl.textContent = storageErrorMessage(err);
      }
    });

    $("production-form").addEventListener("submit", async function (event) {
      event.preventDefault();
      const errorEl = $("production-error");
      errorEl.textContent = "";
      try {
        await api("/api/productions", {
          method: "POST",
          body: JSON.stringify({
            channelId: $("prod-channel").value,
            title: $("prod-title").value,
            season: Number($("prod-season").value),
            episode: Number($("prod-episode").value),
          }),
        });
        $("prod-title").value = "";
        await loadProductionView();
      } catch (err) {
        errorEl.textContent = storageErrorMessage(err);
      }
    });

    $("destination-form").addEventListener("submit", async function (event) {
      event.preventDefault();
      const errorEl = $("destination-error");
      errorEl.textContent = "";
      try {
        await api("/api/channels/" + encodeURIComponent($("dest-channel").value) + "/destinations", {
          method: "POST",
          body: JSON.stringify({
            platform: $("dest-platform").value,
            handle: $("dest-handle").value,
            isPrimary: $("dest-primary").checked,
            publicAttribution: $("dest-attribution").value,
          }),
        });
        $("dest-handle").value = "";
        $("dest-attribution").value = "";
        $("dest-primary").checked = false;
        await loadPublishing();
      } catch (err) {
        errorEl.textContent = storageErrorMessage(err);
      }
    });
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  bindNav();
  bindForms();
  bindLogin();
  (async function boot() {
    try {
      state.me = await api("/api/auth/me");
      enterApp();
    } catch {
      showLogin();
    }
  })();
  setInterval(function () {
    if (state.me && document.getElementById("app-view") && !$("app-view").classList.contains("hidden")) {
      refreshCore();
    }
  }, 30000);
})();

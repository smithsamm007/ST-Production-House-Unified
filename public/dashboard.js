/**
 * ST Production House — dashboard runtime.
 * Renders ONLY what the API actually returns. No simulated states: if a
 * request fails, the UI says so. Works under CSP `script-src 'self'`.
 */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  function setPill(el, text, cls) {
    el.textContent = text;
    el.className = "pill" + (cls ? " " + cls : "");
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, Object.assign({ credentials: "same-origin" }, options || {}));
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const error = new Error((body && body.error) || "HTTP_" + res.status);
      error.code = body && body.error;
      throw error;
    }
    return body;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  async function loadHealth() {
    try {
      const data = await fetchJson("/api/health");
      setPill($("health-status"), data.status === "healthy" ? "healthy" : data.status, data.status === "healthy" ? "ok" : "warn");
      $("health-storage").textContent = data.storage || "unknown";
      $("health-time").textContent = data.timestamp ? new Date(data.timestamp).toLocaleString() : "—";
    } catch (err) {
      setPill($("health-status"), "unreachable", "bad");
      $("health-storage").textContent = "—";
      $("health-time").textContent = String(err.message || err);
    }
  }

  async function loadReady() {
    try {
      const res = await fetch("/api/ready", { credentials: "same-origin" });
      const data = await res.json().catch(function () { return {}; });
      const db = data.database && data.database.status ? data.database.status : "unknown";
      $("ready-db").textContent = db;
      setPill($("ready-status"), res.ok ? "ready" : "not ready", res.ok ? "ok" : "bad");
    } catch (err) {
      $("ready-db").textContent = "—";
      setPill($("ready-status"), "unreachable", "bad");
    }
  }

  async function loadMetrics() {
    const panel = $("metrics-panel");
    try {
      const data = await fetchJson("/api/metrics");
      const items = [];
      const push = function (k, v) { items.push("<li><span>" + escapeHtml(k) + "</span><span>" + escapeHtml(v) + "</span></li>"); };
      push("Storage", data.storage || "unknown");
      push("Agents registered", data.agents != null ? data.agents : "—");
      push("Channels", data.channels != null ? data.channels : "—");
      push("Evidence events", data.evidenceEvents != null ? data.evidenceEvents : "—");
      push("Active sessions", data.activeSessions != null ? data.activeSessions : "—");
      const jobs = data.jobsByStatus || {};
      const jobKeys = Object.keys(jobs);
      if (jobKeys.length === 0) {
        push("Jobs", "none queued yet");
      } else {
        for (const status of jobKeys) push("Jobs · " + status, jobs[status]);
      }
      if (data.process) {
        push("Uptime", data.process.uptimeSeconds + "s");
        push("RSS memory", data.process.memoryRssMb + " MB");
        push("Node", data.process.nodeVersion || "—");
      }
      $("metrics-list").innerHTML = items.join("");
      panel.hidden = false;
    } catch (err) {
      const authError = err.code === "SESSION_TOKEN_REQUIRED" || err.code === "INVALID_SESSION_TOKEN";
      panel.hidden = authError;
      if (!authError) {
        $("metrics-list").innerHTML =
          "<li><span>Metrics unavailable</span><span>" + escapeHtml(String(err.message || err)) + "</span></li>";
        panel.hidden = false;
      }
    }
  }

  function bindLogin() {
    $("login-form").addEventListener("submit", async function (event) {
      event.preventDefault();
      const button = $("login-btn");
      const errorBox = $("login-error");
      errorBox.textContent = "";
      button.disabled = true;
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: $("email").value, password: $("password").value })
        });
        const body = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(body.error || "HTTP_" + res.status);
        $("auth-area").innerHTML = '<div class="muted">Signed in. Metrics below are live from /api/metrics.</div>';
        await loadMetrics();
      } catch (err) {
        errorBox.textContent = String(err.message || err).replace(/_/g, " ").toLowerCase();
      } finally {
        button.disabled = false;
      }
    });
  }

  bindLogin();
  loadHealth();
  loadReady();
  loadMetrics();
  setInterval(loadHealth, 30000);
  setInterval(loadReady, 30000);
})();

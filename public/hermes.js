/**
 * ST Production House — dashboard runtime (Hermes Command Center).
 * Renders ONLY what /api/hermes actually returns. No simulated states.
 */
(function () {
  "use strict";

  function el(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
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

  function outcomePillClass(outcome) {
    if (outcome === "EXECUTED") return "ok";
    if (outcome === "FAILED") return "bad";
    if (outcome === "BLOCKED" || outcome === "OWNER_APPROVAL_REQUIRED") return "warn";
    return "";
  }

  async function loadHermes() {
    const panel = el("hermes-panel");
    const overviewList = el("hermes-overview-list");
    const decisionsList = el("hermes-decisions-list");
    try {
      const [overview, decisions] = await Promise.all([
        fetchJson("/api/hermes/overview"),
        fetchJson("/api/hermes/decisions?limit=8"),
      ]);

      const rows = [];
      const push = function (k, v) { rows.push("<li><span>" + escapeHtml(k) + "</span><span>" + escapeHtml(v) + "</span></li>"); };
      const outcomeCounts = overview.decisions || {};
      const outcomeKeys = Object.keys(outcomeCounts);
      if (outcomeKeys.length === 0) {
        push("Decisions", "none recorded yet");
      } else {
        for (const outcome of outcomeKeys) push("Decisions · " + outcome, outcomeCounts[outcome]);
      }
      push("Security refusals (BLOCKED)", overview.blockedRefusals != null ? overview.blockedRefusals : 0);
      push("Awaiting owner approval", overview.pendingOwnerApproval != null ? overview.pendingOwnerApproval : 0);
      push("Last decision #", overview.lastDecisionNumber != null ? "#" + overview.lastDecisionNumber : "—");
      overviewList.innerHTML = rows.join("");

      const items = [];
      for (const decision of decisions.decisions || []) {
        items.push(
          "<li class=\"hermes-decision\">" +
            "<div class=\"kv\"><span>#" + escapeHtml(decision.decisionNumber) + " · " + escapeHtml(decision.action) + "</span>" +
            "<span class=\"pill " + outcomePillClass(decision.outcome) + "\">" + escapeHtml(decision.outcome) + "</span></div>" +
            "<div class=\"muted\">" + escapeHtml(decision.reason) + "</div>" +
            "<div class=\"muted\">director: " + escapeHtml(decision.directorId) +
              " · authority: " + escapeHtml(decision.authority) +
              (decision.reasonCode ? " · " + escapeHtml(decision.reasonCode) : "") + "</div>" +
          "</li>"
        );
      }
      decisionsList.innerHTML = items.join("") || "<li class=\"muted\">No decisions recorded yet.</li>";
      panel.hidden = false;
    } catch (err) {
      const authError = err.code === "SESSION_TOKEN_REQUIRED" || err.code === "INVALID_SESSION_TOKEN";
      panel.hidden = authError;
      if (!authError) {
        overviewList.innerHTML = "<li><span>Hermes command center unavailable</span><span>" +
          escapeHtml(String(err.message || err)) + "</span></li>";
        decisionsList.innerHTML = "";
        panel.hidden = false;
      }
    }
  }

  document.addEventListener("DOMContentLoaded", loadHermes);
  if (document.readyState !== "loading") loadHermes();
})();

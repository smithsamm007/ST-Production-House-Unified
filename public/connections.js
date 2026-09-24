/**
 * ST Production House — dashboard runtime (additions for Secrets & Connections).
 * Loaded after dashboard.js; renders ONLY what the API returns.
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

  async function loadProviderCatalog() {
    const panel = el("connections-panel");
    const list = el("providers-list");
    try {
      const data = await fetchJson("/api/providers/catalog");
      const items = [];
      for (const provider of data.providers || []) {
        const secretFields = (provider.fields || []).filter(function (f) { return f.kind === "secret"; });
        const configFields = (provider.fields || []).filter(function (f) { return f.kind === "config"; });
        const fieldLabel = function (f) { return f.key + (f.required ? "*" : ""); };
        items.push(
          "<li class=\"provider\">" +
            "<div class=\"provider-head\"><strong>" + escapeHtml(provider.displayName) + "</strong>" +
            "<span class=\"muted\">" + escapeHtml(provider.category) + " · " + escapeHtml(provider.authType || "—") + "</span></div>" +
            (provider.credentialUrl
              ? "<div class=\"muted\">Credential page: <a href=\"" + escapeHtml(provider.credentialUrl) + "\" target=\"_blank\" rel=\"noopener noreferrer\">" + escapeHtml(provider.credentialUrl) + "</a></div>"
              : "") +
            "<div class=\"muted\">Secrets (stored as opaque locators): " +
              (secretFields.length ? secretFields.map(fieldLabel).map(escapeHtml).join(", ") : "none") + "</div>" +
            "<div class=\"muted\">Configuration: " +
              (configFields.length ? configFields.map(fieldLabel).map(escapeHtml).join(", ") : "none") + "</div>" +
          "</li>"
        );
      }
      list.innerHTML = items.join("") || "<li class=\"muted\">No providers in the catalog.</li>";
      panel.hidden = false;
    } catch (err) {
      const authError = err.code === "SESSION_TOKEN_REQUIRED" || err.code === "INVALID_SESSION_TOKEN";
      panel.hidden = authError;
      if (!authError) {
        list.innerHTML = "<li class=\"muted\">Provider catalog unavailable: " + escapeHtml(String(err.message || err)) + "</li>";
        panel.hidden = false;
      }
    }
  }

  document.addEventListener("DOMContentLoaded", loadProviderCatalog);
  if (document.readyState !== "loading") loadProviderCatalog();
})();

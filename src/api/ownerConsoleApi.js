/**
 * Owner Console endpoint helpers.
 *
 * Every function maps to a real, mounted Express route. Nothing here invents a
 * response: when a capability has no backend route it is simply NOT exposed and
 * the screen reports UNAVAILABLE (see `BACKEND_GAPS`).
 *
 * Authorization is always the backend's session + CSRF contract; this module
 * never decides what the Owner may do.
 */

/** Capabilities the Day 2 console could not connect, with the exact gap. */
export const BACKEND_GAPS = Object.freeze({
  jobList:
    "No GET /api/jobs collection route exists; the console reads job counts from /api/metrics only.",
  jobControl:
    "No per-job pause/resume/cancel route is mounted for the console (queue control is /api/control/*), so job actions stay disabled.",
  mediaSlots:
    "Canonical media slots are console demo constructs; artifacts live at GET /api/productions/:id (artifacts[]).",
  providerQuota:
    "No provider latency/quota telemetry route exists; only GET /api/providers/catalog metadata is available.",
  ownerAvailability:
    "Owner availability is not persisted by any backend route; the toggle is disabled rather than faked.",
  delegationPolicies:
    "Delegation policy toggles have no backend route; the matrix is a read-only blueprint.",
  connectionWrite:
    "Connection slots are read-only here: writes need /api/connections/directors/:agentId with an opaque secret locator from a secret manager.",
  approvalDecision:
    "Approval decisions are Day 3/Day 4 scope; Day 2 reads GET /api/publishing-approvals/requests only.",
  memoryCharter:
    "Creative charters are not persisted; only GET /api/directors/:agentId/memory categories are durable.",
});

/**
 * @typedef {Object} OwnerIdentity
 * @property {string} id
 * @property {string} email
 * @property {string} role
 * @property {string} status
 * @property {boolean} [mfaEnabled]
 * @property {string|null} [csrfToken]
 * @property {{ id: string }|null} [session]
 */

/** @param {import("./client.js").OwnerApiClient} client */
export function createOwnerConsoleApi(client) {
  return {
    /* ------------------------------------------------------------- session */
    /** @returns {Promise<{owner: OwnerIdentity, csrfToken: string, session: any}>} */
    async login(email, password) {
      const payload = await client.post("/api/auth/login", { email, password });
      const csrfToken = typeof payload?.csrfToken === "string" ? payload.csrfToken : null;
      client.setCsrfToken(csrfToken);
      return payload;
    },
    /** Session restoration: the server is the only authority on identity. */
    async me() {
      const owner = await client.get("/api/auth/me");
      client.setCsrfToken(owner?.csrfToken ?? null);
      return owner;
    },
    async logout() {
      try {
        return await client.post("/api/auth/logout", undefined);
      } finally {
        client.clearCsrfToken();
      }
    },
    async verifyTotp(totpCode) {
      return client.post("/api/auth/mfa/verify", { totpCode });
    },
    listSessions() {
      return client.get("/api/auth/sessions");
    },
    revokeOtherSessions() {
      return client.del("/api/auth/sessions/other");
    },

    /* -------------------------------------------------------------- health */
    health() {
      return client.get("/api/health");
    },
    ready() {
      return client.get("/api/ready");
    },
    metrics() {
      return client.get("/api/metrics");
    },

    /* ----------------------------------------------------------- directors */
    listAgents() {
      return client.get("/api/agents");
    },
    listChannels() {
      return client.get("/api/channels");
    },
    createChannel({ slug, displayName, tagline, language, agentId }) {
      return client.post("/api/channels", { slug, displayName, tagline, language, agentId });
    },

    /* ----------------------------------------------------------- schedules */
    listDirectorSchedules() {
      return client.get("/api/scheduling/directors");
    },
    saveDirectorSchedule(agentId, schedule) {
      return client.put(`/api/scheduling/directors/${encodeURIComponent(agentId)}`, schedule);
    },
    runDirectorSchedule(agentId) {
      return client.post(`/api/scheduling/directors/${encodeURIComponent(agentId)}/run`, {});
    },

    /* ---------------------------------------------------------- production */
    listProductions() {
      return client.get("/api/productions");
    },
    createProduction({ channelId, title, season, episode }) {
      return client.post("/api/productions", { channelId, title, season, episode });
    },
    runProduction(releaseId) {
      return client.post(`/api/productions/${encodeURIComponent(releaseId)}/run`, {});
    },

    /* ----------------------------------------------------------- approvals */
    listApprovals() {
      return client.get("/api/publishing-approvals/requests");
    },

    /* --------------------------------------------------------- connections */
    listConnections(agentId) {
      return client.get(`/api/connections/directors/${encodeURIComponent(agentId)}`);
    },
    providerCatalog() {
      return client.get("/api/providers/catalog");
    },

    /* ------------------------------------------------------------ evidence */
    listEvidence() {
      return client.get("/api/evidence");
    },

    /* -------------------------------------------------------------- hermes */
    hermesOverview() {
      return client.get("/api/hermes/overview");
    },
    hermesDecisions(limit = 50) {
      return client.get(`/api/hermes/decisions?limit=${encodeURIComponent(limit)}`);
    },

    /* -------------------------------------------------------------- memory */
    listMemory(agentId) {
      return client.get(`/api/directors/${encodeURIComponent(agentId)}/memory`);
    },

    /* ------------------------------------------------------- communication */
    listMessages(agentId) {
      return client.get(`/api/director-comm/${encodeURIComponent(agentId)}/messages`);
    },
    sendMessage(agentId, { body, kind, clientMessageId }) {
      return client.post(`/api/director-comm/${encodeURIComponent(agentId)}/messages`, {
        body,
        kind,
        clientMessageId,
      });
    },
  };
}

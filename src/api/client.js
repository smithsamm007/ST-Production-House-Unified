/**
 * ST Production House — shared Owner Console API client.
 *
 * ONE client for every console screen. It owns:
 *   - same-origin routing (the console is served by the same Express process,
 *     so there is no hardcoded backend port in browser code);
 *   - session cookies (`credentials: "same-origin"`);
 *   - the per-session CSRF token used by the existing double-submit contract
 *     (`x-csrf-token`). The token is held in memory only — never localStorage,
 *     never a cookie this code writes, never logged;
 *   - JSON serialization and the repository's structured error contract
 *     (`{ error: "CODE" }` or `{ code, message }`);
 *   - typed failure classification for 401/403/404/409/422/429/5xx, network
 *     loss and caller cancellation.
 *
 * RETRY POLICY: nothing is retried automatically. Publishing, approvals,
 * account connections, job transitions and Director messages are not
 * idempotent from the console's point of view, so `get()` accepts an explicit
 * `{ retry: 1 }` that callers must opt into for read-only refreshes.
 */

/** Failure classes the UI can branch on without parsing strings. */
export const API_FAILURE_KINDS = Object.freeze([
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "validation",
  "rate_limited",
  "unavailable",
  "server",
  "network",
  "aborted",
  "unknown",
]);

/**
 * A structured API failure.
 *
 * `status` is the HTTP status (0 when no response was received) and `code` is
 * the stable machine code from the server's error contract. Messages are
 * intentionally generic: no cookie, token or provider payload is ever copied
 * into an error object.
 */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string|null, kind?: string, details?: unknown }} [options]
   */
  constructor(message, { status = 0, code = null, kind = "unknown", details = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.kind = API_FAILURE_KINDS.includes(kind) ? kind : "unknown";
    this.details = details;
  }

  /** Whether a caller MAY offer a retry (never applied automatically). */
  get retryable() {
    return (
      this.kind === "network" ||
      this.kind === "rate_limited" ||
      this.kind === "server" ||
      this.kind === "unavailable"
    );
  }
}

/** Map an HTTP status + server code onto a failure kind. */
export function classifyFailure(status, code = null) {
  if (code === "MFA_ASSURANCE_REQUIRED") return "forbidden";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 400 || status === 413 || status === 422) return "validation";
  if (status === 429) return "rate_limited";
  if (status === 501 || status === 503) return "unavailable";
  if (status >= 500) return "server";
  if (status >= 200 && status < 300) return "unknown";
  return "unknown";
}

/** Extract the stable machine code from the server's documented error body. */
export function extractErrorCode(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.error === "string") return payload.error;
  if (typeof payload.code === "string") return payload.code;
  return null;
}

/** Human-readable, secret-free description of a console API failure. */
export function describeFailure(error) {
  if (!(error instanceof ApiError)) {
    return "The console could not complete the request.";
  }
  switch (error.kind) {
    case "unauthorized":
      return "Owner authentication is required. Sign in again; nothing was changed.";
    case "forbidden":
      return error.code === "MFA_ASSURANCE_REQUIRED"
        ? "This action needs a high-assurance (MFA verified) session."
        : "The backend refused this request (authorization or CSRF check failed).";
    case "not_found":
      return "The requested record does not exist on the backend.";
    case "conflict":
      return "The backend rejected this state change as a conflict; reload and retry.";
    case "validation":
      return `The backend rejected the request payload${error.code ? ` (${error.code})` : ""}.`;
    case "rate_limited":
      return "The backend rate limit was reached. Wait and retry manually.";
    case "unavailable":
      return `The backend capability is unavailable${error.code ? ` (${error.code})` : ""}.`;
    case "server":
      return "The backend returned a server error.";
    case "network":
      return "The backend could not be reached (network unavailable).";
    case "aborted":
      return "The request was cancelled.";
    default:
      return "The console could not complete the request.";
  }
}

export class OwnerApiClient {
  /**
   * @param {{ baseUrl?: string, fetchImpl?: typeof fetch|null, onUnauthorized?: (() => void)|null }} [options]
   */
  constructor({ baseUrl = "", fetchImpl = null, onUnauthorized = null } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/$/, "");
    this.fetchImpl =
      fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    this.onUnauthorized = typeof onUnauthorized === "function" ? onUnauthorized : null;
    /** @type {string|null} in-memory only */
    this.csrfToken = null;
  }

  /** Store the per-session CSRF token returned by login / auth-me. */
  setCsrfToken(token) {
    this.csrfToken = typeof token === "string" && token.length > 0 ? token : null;
    return this.csrfToken;
  }

  clearCsrfToken() {
    this.csrfToken = null;
  }

  /**
   * Perform one request. Never retried here.
   * @param {string} path
   * @param {{ method?: string, body?: unknown, signal?: AbortSignal|null, headers?: Record<string,string> }} [options]
   */
  async request(path, { method = "GET", body, signal = null, headers = {} } = {}) {
    if (!this.fetchImpl) {
      throw new ApiError("No fetch implementation is available.", { kind: "network" });
    }
    const url = `${this.baseUrl}${path}`;
    /** @type {Record<string,string>} */
    const outgoing = { Accept: "application/json", ...headers };
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
    if (body !== undefined) outgoing["Content-Type"] = "application/json";
    if (mutating && this.csrfToken) outgoing["x-csrf-token"] = this.csrfToken;

    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        credentials: "same-origin",
        headers: outgoing,
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error && (error.name === "AbortError" || error.code === "ABORT_ERR")) {
        throw new ApiError("Request cancelled.", { kind: "aborted" });
      }
      throw new ApiError("Network request failed.", { kind: "network" });
    }

    const contentType = response.headers?.get?.("content-type") || "";
    let payload = null;
    if (response.status !== 204 && response.status !== 205) {
      if (contentType.includes("application/json")) {
        payload = await response.json().catch(() => null);
      } else {
        const text = await response.text().catch(() => "");
        payload = text ? { error: null, message: text.slice(0, 200) } : null;
      }
    }

    if (!response.ok) {
      const code = extractErrorCode(payload);
      const error = new ApiError(
        `Request failed with HTTP ${response.status}.`,
        { status: response.status, code, kind: classifyFailure(response.status, code) }
      );
      if (error.kind === "unauthorized" && this.onUnauthorized) {
        try {
          this.onUnauthorized();
        } catch {
          // A UI callback must never mask the API failure.
        }
      }
      throw error;
    }

    return payload;
  }

  /** Read-only GET. `retry: 1` opts into exactly one retry for idempotent reads. */
  async get(path, { retry = 0, signal = null, headers = {} } = {}) {
    let attempt = 0;
    for (;;) {
      try {
        return await this.request(path, { method: "GET", signal, headers });
      } catch (error) {
        const canRetry =
          attempt < retry &&
          error instanceof ApiError &&
          (error.kind === "network" || error.kind === "server");
        if (!canRetry) throw error;
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
      }
    }
  }

  post(path, body, options = {}) {
    return this.request(path, { ...options, method: "POST", body });
  }

  put(path, body, options = {}) {
    return this.request(path, { ...options, method: "PUT", body });
  }

  patch(path, body, options = {}) {
    return this.request(path, { ...options, method: "PATCH", body });
  }

  del(path, options = {}) {
    return this.request(path, { ...options, method: "DELETE" });
  }
}

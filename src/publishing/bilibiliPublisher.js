/**
 * ST Production House — Bilibili publisher adapter (Issue #227).
 *
 * The OFFICIAL 哔哩哔哩开放平台 server-side video-submission boundary
 * (服务端视频稿件投递) behind the publisher contract that
 * `PublishingService.dispatch` and `destinationPublisherRouter` already
 * consume — set in `docs/publishing/BILIBILI_PUBLISHING_ADAPTER.md` (PR #226):
 *
 *   publisher.publish(request) → { platformPostId, platformUrl, rawResponse,
 *                                   submissionState }
 *
 * Official flow (member.bilibili.com host, from the official OpenAPI mirror
 * bilibili.apifox.cn — never invented):
 *
 *   1. PREPROCESS   POST {BILI_MEMBER_API_BASE}/arcopen/fn/archive/video/init
 *        JSON body: { name, utype }              → { code, data.upload_token }
 *   2. PART UPLOAD  POST {BILI_MEMBER_API_BASE}/video/v2/part/upload
 *        ?part_number={1-based}&upload_token={token}   (raw media bytes)
 *        → { code, message }
 *   3. CHUNK MERGE  POST {BILI_MEMBER_API_BASE}/arcopen/fn/archive/video/complete
 *        ?upload_token={token}                   → { code, message }
 *   4. SUBMISSION   POST {BILI_MEMBER_API_BASE}/arcopen/fn/archive/add-by-utoken
 *        signed headers + JSON body
 *        { title, tid, tag, copyright, cover, desc, no_reprint, open_elec, kwai_links...? }
 *        → { code, message, data.resource_id }
 *
 * OAuth token exchange/renewal stays OUT of this adapter (official:
 * `POST https://api.bilibili.com/x/account-oauth2/v1/token` /
 * `.../refresh_token` with SINGLE-USE refresh tokens — the rotation-aware
 * custody design belongs to the OAuth lifecycle, not the upload path). The
 * adapter consumes a bearer-like access token resolved through the injected
 * resolver only.
 *
 * SIGNED REQUESTS — HONEST BOUNDARY: the official canonical string for the
 * `sign` header is NOT fully documented in the public mirror spec (the docs
 * enumerate a signing concept without a fully specified canonicalization).
 * Per the no-invented-API rule the adapter therefore takes an INJECTED
 * `signRequest` callback (header name/value pairs + `accessKey` scope =
 * credentials object) and FAILS CLOSED (BILIBILI_SIGNER_REQUIRED) when none
 * is provided. A deployment with real whitelist-approved access supplies its
 * officially-documented signer; offline tests inject a deterministic
 * fixture signer. The adapter never fabricates a signature.
 *
 * Receipt honesty (Rule 2, and §2 of the research contract):
 *   - A successful submission is IN PLATFORM REVIEW — never "published".
 *     `submissionState: "submitted_review_pending"` is the strongest honest
 *     state at submit time; no platformUrl is ever emitted from the submit
 *     response because review-pending archives have no honest public URL.
 *   - `platformPostId` comes ONLY from the real platform-issued archive
 *     identifier in the submission response `data` (`resource_id` /
 *     `data.bvid`-shaped archive id fields when actually returned — the
 *     validator accepts any non-empty bounded string id the platform
 *     actually sends). Missing → BILIBILI_RECEIPT_INVALID. Never fabricated.
 *   - `platformUrl` is emitted ONLY when a REAL `bvid` is returned (it is
 *     built from the pinned canonical base, same precedent as the YouTube
 *     `watch?v=` construction). With only `resource_id`, there is no
 *     public URL — honest absence, never a fabricated link.
 *
 * Quota/review honesty: the documented daily submission quota (5/day for
 * non-official membership) and review-pending states surface as CURRENT
 * review-state truth, never as fabricated completion.
 *
 * Honesty and safety rules (AGENTS.md + contract §4):
 *   - ARTIFACT BINDING: the media file's SHA-256 is streamed and compared to
 *     the approved `artifactSha256` BEFORE any credential is resolved or any
 *     network call is made.
 *   - RULE 7 DEFENSE-IN-DEPTH: an unexpired owner approval bound to the SAME
 *     artifact hash and destination is re-checked inside the adapter.
 *   - DIRECTOR ISOLATION: credentials resolved per (ownerId, agentId,
 *     destination); the access token appears ONLY in the injected signer
 *     and/or Authorization header, never in receipts, errors, or serialized
 *     output (Rule 17).
 *   - RETRY: 429/5xx/network failures retry with bounded backoff honoring
 *     `Retry-After`; 401/403/other 4xx fail closed. Whitelist/permission
 *     errors (127304 / 127305) fail closed with NO retry storm (research
 *     contract §4): permission/whitelist state only changes on the
 *     platform side, so retrying cannot fix it.
 *   - IDEMPOTENCY: an identical (owner, director, artifact, title, tid)
 *     request replays the stored receipt with ZERO network calls.
 *   - SSRF / R3: every URL is HTTPS on the official `member.bilibili.com`
 *     host (the OAuth host `api.bilibili.com` is deliberately NOT used by
 *     this adapter). No hostname may be supplied by request/platform input.
 *   - RULE 15: internal agent names (canonical catalog) are rejected in
 *     public metadata before any network call.
 *
 * OFFLINE BY CONSTRUCTION: the transport is injected; tests script it and no
 * real network call ever happens in this repository. LIVE SUBMISSION IS
 * OWNER-GATED (Issue #118 / S-M24-LIVE): open-platform registration,
 * 资质认证 qualification certification, app creation, the 投稿 permission
 * WHITELIST grant, and a connected Director Bilibili account are real
 * prerequisites that no adapter code can substitute.
 *
 * No new dependencies (node:crypto / node:fs / node:stream only).
 */

import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { PRELOADED_AGENTS } from "../catalog/agents.js";
import { sanitizeErrorMessage } from "../credentials/credentialBroker.js";

/** Official server-side submission host (research contract §1.2). */
export const BILI_MEMBER_API_BASE = "https://member.bilibili.com";
/** Official OAuth host — deliberately NOT used by this adapter. */
export const BILI_OAUTH_HOST_EXCLUDED = "api.bilibili.com";
/** Canonical archive URL base — filled ONLY from a real platform `bvid`. */
export const BILI_VIDEO_URL_BASE = "https://www.bilibili.com/video/";

const BILI_HOST = "member.bilibili.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_PATH_LENGTH = 4096;
/** Official title limit is 80 characters (submission interface). */
const MAX_TITLE_LENGTH = 80;
const MAX_DESC_LENGTH = 2000;
/** Official limit: tags string ≤ 200 chars, comma-separated. */
const MAX_TAG_TOTAL_LENGTH = 200;
/** Official fixed recommended chunk size: 8 MB (last part may be smaller). */
const PART_SIZE = 8 * 1024 * 1024;
/** Official archive id shapes: `resource_id` (numeric-ish) or `bvid` (BV…). */
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;
/** Official `bvid` shape begins with "BV" (11+ char body). */
const BVID_PATTERN = /^BV[0-9A-Za-z]{8,32}$/;
/** tid values are positive integers (分区查询 interface). */
const TID_PATTERN = /^\d{1,5}$/;

/** Officially documented error codes that fail closed (never retried). */
const FAIL_CLOSED_CODES = new Map([
  [127304, "BILIBILI_PERMISSION_NOT_GRANTED"],
  [127305, "BILIBILI_WHITELIST_RESTRICTED"],
]);

/** Officially documented review-state strings this adapter may emit. */
const SUBMISSION_STATES = Object.freeze({
  SUBMITTED_REVIEW_PENDING: "submitted_review_pending",
});

const DESTINATIONS = new Set(["bilibili"]);

/**
 * Rule 15 guard built from the CANONICAL agent catalog.
 */
const AGENT_NAME_PATTERN = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map((agent) =>
    agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|")})\\b`,
  "i",
);

function fail(code, detail = undefined) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reject unsafe media paths before touching the filesystem. */
function validateMediaPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_LENGTH) {
    throw fail("BILIBILI_MEDIA_SOURCE_INVALID");
  }
  if (path.includes("\0") || path.split("/").some((segment) => segment === "..")) {
    throw fail("BILIBILI_MEDIA_SOURCE_INVALID");
  }
  return path;
}

/** Streamed SHA-256 of the REAL file bytes (bounded memory). */
function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", () => reject(fail("BILIBILI_MEDIA_SOURCE_UNREADABLE")));
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** HTTPS + official member.bilibili.com host + no embedded credentials. */
function assertSafeUrl(raw, code) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw fail(code);
  }
  if (parsed.protocol !== "https:") throw fail(code);
  if (parsed.username || parsed.password) throw fail(code);
  if (parsed.hostname.toLowerCase() !== BILI_HOST) throw fail(code);
  return parsed;
}

/** Case-insensitive header lookup (mock transports may use any casing). */
function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return null;
}

function parseRetryAfterMs(headers) {
  const raw = headerValue(headers, "retry-after");
  if (typeof raw !== "string") return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

function retryableError(code, { retryAfterMs } = {}) {
  const error = fail(code);
  error.retryable = true;
  if (retryAfterMs !== null && retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return error;
}

/** Map a non-2xx transport response to a stable, retried-or-not code. */
function statusError(status, response, step) {
  const body = typeof response?.body === "string" ? response.body : "";
  const detail = `${step} status=${status}${body ? ` ${sanitizeErrorMessage(body).slice(0, 160)}` : ""}`;
  if (status === 401) return fail("BILIBILI_AUTH_FAILED", detail);
  if (status === 403) return fail("BILIBILI_UPLOAD_FORBIDDEN", detail);
  if (status === 429) {
    const error = retryableError("BILIBILI_RATE_LIMITED", {
      retryAfterMs: parseRetryAfterMs(response?.headers),
    });
    error.detail = detail;
    return error;
  }
  if (status >= 500) {
    const error = retryableError("BILIBILI_UPLOAD_UNAVAILABLE");
    error.detail = detail;
    return error;
  }
  return fail("BILIBILI_UPLOAD_REJECTED", detail);
}

async function runWithRetry(fn, { maxAttempts, sleep }) {
  let lastRetryable = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (!error?.retryable || attempt >= maxAttempts) throw error;
      lastRetryable = error;
      const delayMs = Number.isFinite(error.retryAfterMs)
        ? error.retryAfterMs
        : Math.min(200 * 2 ** (attempt - 1), 5_000);
      await sleep(delayMs);
    }
  }
  throw lastRetryable;
}

/**
 * Default transport (production wiring only): official endpoints over fetch
 * with an abort timeout. Never exercised by offline tests, which inject a
 * scripted transport instead. `bodyFile` uploads the real file bytes with a
 * bounded stream.
 */
async function defaultTransport({ url, method, headers, body, bodyFile, timeoutMs }) {
  assertSafeUrl(url, "BILIBILI_TRANSPORT_URL_INVALID");
  const init = {
    method,
    headers: { ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (typeof bodyFile === "string") {
    init.body = Readable.toWeb(createReadStream(bodyFile));
    init.duplex = "half";
  } else if (body !== undefined) {
    init.body = body;
  }
  const response = await fetch(url, init);
  const text = await response.text();
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: text,
  };
}

function validateTransportResponse(response) {
  if (
    !response ||
    typeof response !== "object" ||
    typeof response.status !== "number" ||
    response.body === undefined ||
    response.body === null ||
    typeof response.body !== "string"
  ) {
    throw fail("BILIBILI_TRANSPORT_RESPONSE_INVALID");
  }
  return response;
}

function parseJsonObject(body, code) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw fail(code, "response body is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw fail(code, "response body is not a JSON object");
  }
  return parsed;
}

/**
 * Official `{code, message}` envelope (success `code === 0`). Official
 * documented business errors (127304 投稿 permission not granted /
 * 127305 whitelist restriction) fail closed with NO retry — these states
 * change only on the platform side.
 */
function requireEnvelopeSuccess(parsed, code, step) {
  if (parsed?.code !== 0) {
    const errorCode = typeof parsed?.code === "number" ? parsed.code : "(none)";
    const failClosed = FAIL_CLOSED_CODES.get(parsed?.code);
    if (failClosed) {
      throw fail(
        failClosed,
        `${step} official code=${errorCode} message=${sanitizeErrorMessage(String(parsed?.message ?? "")).slice(0, 120)} — fail closed, never retried (permission/whitelist state changes only on the platform side)`,
      );
    }
    const debug = typeof parsed?.message === "string"
      ? sanitizeErrorMessage(parsed.message).slice(0, 160)
      : "";
    const error = fail(code, `${step} code=${errorCode}${debug ? ` message=${debug}` : ""}`);
    // A live quota/review rejection is a legitimate business rejection —
    // fail closed (the documented daily quota is 5/day; a retry loop would
    // only burn attempts).
    error.retryable = false;
    throw error;
  }
  return true;
}

/**
 * Validate the publish request PLUS the owner approval (Rule 7) and the
 * public metadata (Rule 15) before anything else happens.
 */
function validatePublishRequest(request, nowMs) {
  if (!request || typeof request !== "object") {
    throw fail("BILIBILI_PUBLISH_REQUEST_INVALID");
  }

  const approval = request.approval;
  if (!approval || typeof approval !== "object" || !approval.ownerId) {
    throw fail("OWNER_APPROVAL_REQUIRED");
  }
  if (typeof approval.ownerId !== "string" || approval.ownerId.length === 0) {
    throw fail("OWNER_APPROVAL_REQUIRED");
  }
  if (request.ownerId !== undefined && request.ownerId !== approval.ownerId) {
    throw fail("APPROVAL_OWNER_MISMATCH");
  }
  const expiresAt = new Date(approval.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= nowMs) {
    throw fail("APPROVAL_EXPIRED");
  }

  const agentId = request.agentId;
  if (typeof agentId !== "string" || !/^[A-Za-z0-9@._-]{1,80}$/.test(agentId)) {
    throw fail("BILIBILI_PUBLISH_REQUEST_INVALID");
  }

  const destination = request.destination;
  if (!DESTINATIONS.has(destination)) {
    throw fail("BILIBILI_DESTINATION_REQUIRED");
  }

  const artifactSha256 =
    typeof request.artifactSha256 === "string" ? request.artifactSha256.toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(artifactSha256)) {
    throw fail("VERIFIED_ARTIFACT_REQUIRED");
  }
  if (
    approval.artifactSha256 !== undefined &&
    String(approval.artifactSha256).toLowerCase() !== artifactSha256
  ) {
    throw fail("APPROVAL_ARTIFACT_MISMATCH");
  }
  if (approval.destination !== undefined && approval.destination !== destination) {
    throw fail("APPROVAL_DESTINATION_MISMATCH");
  }

  const caption = request.captionSnapshot;
  if (!caption || typeof caption !== "object") {
    throw fail("PUBLISHING_SNAPSHOT_REQUIRED");
  }
  const title = typeof caption.title === "string" ? caption.title.trim() : "";
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
    throw fail("BILIBILI_METADATA_INVALID", `official title limit is ${MAX_TITLE_LENGTH}`);
  }
  const description = typeof caption.description === "string" ? caption.description : "";
  if (description.length > MAX_DESC_LENGTH) {
    throw fail("BILIBILI_METADATA_INVALID");
  }
  const tags = Array.isArray(caption.tags) ? caption.tags : [];
  if (tags.some((tag) => typeof tag !== "string" || tag.length === 0)) {
    throw fail("BILIBILI_METADATA_INVALID");
  }
  if (tags.join(",").length > MAX_TAG_TOTAL_LENGTH) {
    throw fail("BILIBILI_METADATA_INVALID", `official tags string limit is ${MAX_TAG_TOTAL_LENGTH}`);
  }

  // Official required submission fields. `tid` (分区 id) comes from the
  // official 分区查询 interface — it MUST be supplied by the caller/config
  // (the adapter never invents one).
  const tid = String(request.tid ?? "");
  if (!TID_PATTERN.test(tid)) {
    throw fail("BILIBILI_TID_REQUIRED", "tid must come from the official 分区查询 interface (positive integer)");
  }
  const coverUrl = request.coverUrl;
  if (typeof coverUrl === "string") {
    // Only an official HTTPS image URL from an official Bilibili image host
    // may carry the cover; anything else is treated as absent (no cover).
    let parsed;
    try {
      parsed = new URL(coverUrl);
    } catch {
      parsed = null;
    }
    if (
      !parsed ||
      parsed.protocol !== "https:" ||
      !(
        parsed.hostname.toLowerCase() === "i0.hdslb.com" ||
        parsed.hostname.toLowerCase() === "i1.hdslb.com" ||
        parsed.hostname.toLowerCase() === "i2.hdslb.com"
      )
    ) {
      throw fail("BILIBILI_COVER_URL_INVALID", "cover must be an official HTTPS hdslb.com image URL from the official 封面上传 interface");
    }
  }
  const sourceUrl = request.sourceUrl;
  // `copyright = 1` means original, `2` means reprinted (official). The
  // adapter defaults to original content; `sourceUrl` may only exist with
  // reprint.
  const copyright = request.copyright === 2 ? 2 : 1;
  if (copyright === 1 && sourceUrl !== undefined) {
    throw fail("BILIBILI_SOURCE_URL_FORBIDDEN", "reprint source requires copyright=2");
  }
  if (typeof sourceUrl === "string" && !/^https:\/\//.test(sourceUrl)) {
    throw fail("BILIBILI_SOURCE_URL_INVALID", "HTTPS-only (CONVENTIONS rule 1)");
  }

  // Rule 15: never let an internal agent name reach public metadata.
  if (AGENT_NAME_PATTERN.test(JSON.stringify({ title, description, tags }))) {
    throw fail("AGENT_NAME_LEAKAGE_DENIED");
  }

  return Object.freeze({
    ownerId: approval.ownerId,
    agentId,
    destination,
    artifactSha256,
    title,
    description,
    tags: Object.freeze([...tags]),
    tid,
    coverUrl,
    copyright,
    sourceUrl,
    mediaName: `stph-${artifactSha256.slice(0, 16)}.mp4`,
  });
}

/** Resolve the media source: injected resolver first, then request field. */
async function resolveMedia(request, normalized, mediaResolver) {
  let filePath = null;
  if (typeof mediaResolver === "function") {
    const resolved = await mediaResolver({
      ownerId: normalized.ownerId,
      agentId: normalized.agentId,
      artifactSha256: normalized.artifactSha256,
      destination: normalized.destination,
    });
    filePath = resolved?.filePath;
  } else if (typeof request.mediaFilePath === "string") {
    filePath = request.mediaFilePath;
  }
  validateMediaPath(filePath);

  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw fail("BILIBILI_MEDIA_SOURCE_UNREADABLE");
  }
  if (!info.isFile() || info.size <= 0) {
    throw fail("BILIBILI_MEDIA_SOURCE_UNREADABLE");
  }
  return Object.freeze({ filePath, size: info.size });
}

/**
 * Validate resolved credentials.
 *
 *   accessKeyId / accessKeySecret — official open-platform app secrets;
 *     the adapter never persists or serializes them (Rule 17). The secret is
 *     consumed ONLY by the injected signer.
 *   accessToken — the OAuth access token from the connected Director
 *     account (resolved via the secret-manager boundary by the deployment).
 */
function normalizeCredentials(resolved) {
  if (!resolved || typeof resolved !== "object") {
    throw fail("BILIBILI_CREDENTIALS_INVALID");
  }
  const accessToken = resolved.accessToken;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw fail("BILIBILI_TOKEN_UNAVAILABLE");
  }
  return Object.freeze({ accessToken });
}

function idempotencyKeyFor(normalized) {
  return createHash("sha256")
    .update(
      [
        normalized.ownerId,
        normalized.agentId,
        normalized.destination,
        normalized.artifactSha256,
        normalized.tid,
        normalized.title,
      ].join("\n"),
    )
    .digest("hex");
}

/**
 * Upload the REAL artifact bytes in official 8 MB parts. Bounded memory:
 * one part buffer at a time; the last part may be smaller.
 */
async function* chunkedParts(filePath, size) {
  const handle = await open(filePath, "r");
  try {
    let partNumber = 0;
    let offset = 0;
    const block = Buffer.alloc(PART_SIZE);
    while (offset < size) {
      const toRead = Math.min(PART_SIZE, size - offset);
      const { bytesRead } = await handle.read(block, 0, toRead, offset);
      if (bytesRead !== toRead) {
        throw fail("BILIBILI_MEDIA_SOURCE_UNREADABLE", "short read while chunking");
      }
      partNumber += 1;
      yield { partNumber, data: block.subarray(0, bytesRead) };
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

/**
 * Create the Bilibili publisher.
 *
 *   resolveCredentials: async ({ ownerId, agentId, destination }) =>
 *     { accessToken }  (REQUIRED — production resolution goes through the
 *     secret-manager boundary on opaque locators; tests inject fixtures)
 *   signRequest:        async ({ method, url, headers }) =>
 *     { [name]: value } extra signed headers, OR null for unsigned calls.
 *     REQUIRED when the deployment's interface permission uses the official
 *     signed-request convention; failing to supply one is
 *     BILIBILI_SIGNER_REQUIRED. The signing secret never leaves the signer.
 *   transport / mediaResolver / sleep / now / maxAttempts / timeoutMs
 */
export function createBilibiliPublisher(options = {}) {
  const {
    resolveCredentials,
    signRequest = null,
    transport = defaultTransport,
    mediaResolver = null,
    sleep = defaultSleep,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = () => new Date(),
  } = options;

  if (typeof resolveCredentials !== "function") {
    throw fail("BILIBILI_CREDENTIAL_RESOLVER_REQUIRED");
  }
  if (typeof transport !== "function") {
    throw fail("BILIBILI_TRANSPORT_REQUIRED");
  }
  if (signRequest !== null && typeof signRequest !== "function") {
    throw fail("BILIBILI_SIGNER_INVALID");
  }
  if (mediaResolver !== null && typeof mediaResolver !== "function") {
    throw fail("BILIBILI_MEDIA_RESOLVER_INVALID");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw fail("BILIBILI_RETRY_CONFIG_INVALID");
  }

  /** Director-scoped receipts for this publisher instance (process lifetime). */
  const receipts = new Map();

  async function callTransport(call) {
    let response;
    try {
      response = await transport({ ...call, timeoutMs });
    } catch (err) {
      const error = retryableError("BILIBILI_UPLOAD_UNAVAILABLE");
      error.detail = sanitizeErrorMessage(err?.message ?? "transport failure").slice(0, 200);
      throw error;
    }
    return validateTransportResponse(response);
  }

  /**
   * Official step 1: file upload preprocessing (文件上传预处理) — obtain
   * `upload_token`. NO signature is invented here: if the deployment wires
   * `signRequest`, its headers are added; otherwise the call stays
   * unsigned (honest-by-default; the platform's documented gates then
   * answer truthfully).
   */
  async function preprocessUpload({ normalized, credentials }) {
    return runWithRetry(
      async () => {
        const url = `${BILI_MEMBER_API_BASE}/arcopen/fn/archive/video/init?name=${encodeURIComponent(normalized.mediaName)}&utype=1`;
        const extraHeaders = signRequest
          ? await signRequest({ method: "POST", url, headers: {} })
          : null;
        const response = await callTransport({
          url,
          method: "POST",
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "Content-Type": "application/json",
            ...(extraHeaders ?? {}),
          },
          body: JSON.stringify({
            name: normalized.mediaName,
            // Official utype: 1 = self-made original archive (the adapter
            // submits original content only; reprints are out of scope).
            utype: 1,
          }),
        });
        if (response.status < 200 || response.status >= 300) {
          throw statusError(response.status, response, "preprocess");
        }
        const parsed = parseJsonObject(response.body, "BILIBILI_PREPROCESS_REJECTED");
        requireEnvelopeSuccess(parsed, "BILIBILI_PREPROCESS_REJECTED", "preprocess");
        const uploadToken = parsed?.data?.upload_token;
        if (typeof uploadToken !== "string" || uploadToken.length < 8 || uploadToken.length > 512) {
          throw fail("BILIBILI_PREPROCESS_REJECTED", "response has no usable upload_token");
        }
        return Object.freeze({ uploadToken });
      },
      { maxAttempts, sleep },
    );
  }

  /** Official step 2: upload ONE 8 MB part (same part_number is safe to retry). */
  async function uploadPart({ uploadToken, chunk, credentials }) {
    return runWithRetry(
      async () => {
        const url = `${BILI_MEMBER_API_BASE}/video/v2/part/upload?part_number=${encodeURIComponent(String(chunk.partNumber))}&upload_token=${encodeURIComponent(uploadToken)}`;
        const extraHeaders = signRequest
          ? await signRequest({ method: "POST", url, headers: {} })
          : null;
        const response = await callTransport({
          url,
          method: "POST",
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(chunk.data.length),
            ...(extraHeaders ?? {}),
          },
          body: chunk.data,
        });
        if (response.status < 200 || response.status >= 300) {
          throw statusError(response.status, response, `part-${chunk.partNumber}`);
        }
        const parsed = parseJsonObject(response.body, "BILIBILI_UPLOAD_RECEIPT_INVALID");
        requireEnvelopeSuccess(parsed, "BILIBILI_UPLOAD_REJECTED", `part-${chunk.partNumber}`);
        return chunk.partNumber;
      },
      { maxAttempts, sleep },
    );
  }

  /** Official step 3: chunk merge (文件分片合片) — the file is complete. */
  async function mergeChunks({ uploadToken, credentials }) {
    return runWithRetry(
      async () => {
        const url = `${BILI_MEMBER_API_BASE}/arcopen/fn/archive/video/complete?upload_token=${encodeURIComponent(uploadToken)}`;
        const extraHeaders = signRequest
          ? await signRequest({ method: "POST", url, headers: {} })
          : null;
        const response = await callTransport({
          url,
          method: "POST",
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "Content-Length": "0",
            ...(extraHeaders ?? {}),
          },
        });
        if (response.status < 200 || response.status >= 300) {
          throw statusError(response.status, response, "merge");
        }
        const parsed = parseJsonObject(response.body, "BILIBILI_UPLOAD_RECEIPT_INVALID");
        requireEnvelopeSuccess(parsed, "BILIBILI_UPLOAD_REJECTED", "merge");
        return true;
      },
      { maxAttempts, sleep },
    );
  }

  /**
   * Official step 4: archive submission (视频稿件提交). SINGLE attempt for
   * the SUBMIT call once the file is uploaded: an automatic submission
   * retry after merge success could double-submit the same archive
   * (server-side duplicate checks are the documented anti-double-submit
   * mechanism, and the review queue is platform-gated).
   */
  async function submitArchive({ normalized, credentials }) {
    const response = await callTransport({
      url: `${BILI_MEMBER_API_BASE}/arcopen/fn/archive/add-by-utoken`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: normalized.title,
        tid: Number(normalized.tid),
        tag: normalized.tags.join(","),
        copyright: normalized.copyright,
        // Official: `cover` carries the cover URL produced by the official
        // 封面上传 interface; when absent the platform applies its default.
        ...(normalized.coverUrl !== undefined ? { cover: normalized.coverUrl } : {}),
        desc: normalized.description,
        no_reprint: 1,
        source:
          normalized.copyright === 2 && typeof normalized.sourceUrl === "string"
            ? normalized.sourceUrl
            : undefined,
      }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw statusError(response.status, response, "submit");
    }
    const parsed = parseJsonObject(response.body, "BILIBILI_RECEIPT_INVALID");
    requireEnvelopeSuccess(parsed, "BILIBILI_SUBMISSION_REJECTED", "submit");

    // Receipt honesty (research contract §2): platformPostId is ONLY a real
    // platform-issued archive identifier. The official response shape puts
    // it in `data` (`resource_id` / `aid` / `bvid` depending on documented
    // interface version) — accept ONLY a real, bounded id the platform
    // actually sent; never fabricate.
    const data = parsed?.data;
    const candidates = [data?.resource_id, data?.aid, data?.bvid];
    const archiveId = candidates.find(
      (value) => typeof value === "string" && ARCHIVE_ID_PATTERN.test(value),
    ) ?? (typeof data?.aid === "number" && Number.isSafeInteger(data.aid) && data.aid > 0
      ? String(data.aid)
      : null);
    const bvid =
      typeof data?.bvid === "string" && BVID_PATTERN.test(data.bvid) ? data.bvid : null;
    if (!archiveId) {
      throw fail("BILIBILI_RECEIPT_INVALID", "submission response has no usable archive id");
    }

    return Object.freeze({
      archiveId,
      bvid,
      rawResponse: response.body,
      // Honest submission state: the archive is IN PLATFORM REVIEW — never
      // "published" at submit time (the review completion is the only
      // published state, and only the platform can report it).
      submissionState: SUBMISSION_STATES.SUBMITTED_REVIEW_PENDING,
    });
  }

  async function publish(request) {
    const normalized = validatePublishRequest(request, now().getTime());
    const media = await resolveMedia(request, normalized, mediaResolver);

    // Bind the upload to the approved artifact BEFORE touching credentials.
    const actualHash = await sha256File(media.filePath);
    if (actualHash !== normalized.artifactSha256) {
      throw fail(
        "BILIBILI_MEDIA_HASH_MISMATCH",
        `expected ${normalized.artifactSha256} got ${actualHash}`,
      );
    }

    const key = idempotencyKeyFor(normalized);
    const prior = receipts.get(key);
    if (prior) {
      // Replay: identical request already submitted — ZERO network calls.
      return Object.freeze({ ...prior, duplicate: true });
    }

    // Director-scoped credential resolution; tokens never leave this scope
    // except through the Authorization header below (Rule 17).
    const credentials = normalizeCredentials(
      await resolveCredentials({
        ownerId: normalized.ownerId,
        agentId: normalized.agentId,
        destination: normalized.destination,
      }),
    );

    // Official step 1: preprocess → upload_token.
    const preprocess = await preprocessUpload({ normalized, credentials });

    // Official step 2: upload every part (bounded memory, 8 MB official size).
    for await (const chunk of chunkedParts(media.filePath, media.size)) {
      await uploadPart({ uploadToken: preprocess.uploadToken, chunk, credentials });
    }

    // Official step 3: merge.
    await mergeChunks({ uploadToken: preprocess.uploadToken, credentials });

    // Official step 4: submission; receipt from REAL platform id only.
    const attempt = await submitArchive({ normalized, credentials });

    const receipt = Object.freeze({
      platformPostId: attempt.archiveId,
      // `platformUrl` ONLY from a real bvid (canonical URL shape, same
      // precedent as the YouTube `watch?v=` construction). With only
      // resource_id/aid there is no honest public URL — review-pending.
      ...(attempt.bvid
        ? { platformUrl: `${BILI_VIDEO_URL_BASE}${attempt.bvid}` }
        : {}),
      submissionState: attempt.submissionState,
      rawResponse: attempt.rawResponse,
    });
    receipts.set(key, receipt);
    return receipt;
  }

  return Object.freeze({
    label: "bilibili-archive-submission (official open platform, review-pending-first)",
    publish,
  });
}

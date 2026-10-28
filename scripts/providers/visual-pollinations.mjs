#!/usr/bin/env node
/**
 * ST Production House — free-first VISUAL provider adapter (Pollinations).
 *
 * WHY THIS EXISTS
 *   The S-M35 visual executor (src/media/visualExecutor.js) is provider-
 *   agnostic: for the tier-1 free primary it builds the argv
 *   `--modality <m> --aspect <ar> --output <path> [--model <id>]` and carries
 *   the prompt on STDIN. Until this adapter existed no executable implemented
 *   that contract, so `STPH_ENABLE_REAL_MEDIA=1` reached every visual stage
 *   with PROVIDER_UNAVAILABLE. This is that executable.
 *
 * WHAT IT IS / IS NOT
 *   - It performs ONE real, keyless HTTPS image-generation request against the
 *     free Pollinations image endpoint and writes the REAL response bytes to
 *     `--output`. It never fabricates or resizes/animation-post-processes the
 *     image — the bytes on disk are exactly what the provider returned.
 *   - A provider HTTP error, a non-image content type, or a body that is not a
 *     real image (JPEG/PNG/WEBP magic bytes) is an honest non-zero exit. A
 *     caller's exit-0-never-means-media rule is enforced by the executor's own
 *     ffprobe inspection, not by this adapter.
 *   - Array args only; the prompt never reaches argv (CONVENTIONS Rule 2). It
 *     is never logged or echoed (Rule 17: no secret material can appear), and
 *     no internal agent name is ever transmitted by this adapter itself.
 *
 * Usage (invoked by the executor, not by hand):
 *   node scripts/providers/visual-pollinations.mjs \
 *        --modality image --aspect 16:9 --output /path/out.png --model flux
 *   (prompt on stdin)
 *
 * Exit codes: 0 success · 2 invalid usage · 3 provider failure · 1 unexpected
 */

import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const ENDPOINT = "https://image.pollinations.ai/prompt/";
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_PROMPT_CHARS = 4_000;
// The free endpoint is keyless but RATE-LIMITED: measured on this host it
// intermittently answers 402/429 with no Retry-After header and recovers
// within seconds (roughly one in two requests during a burst). Those — and
// 5xx — are retried a bounded number of times with exponential backoff plus
// jitter, exactly like the other provider adapters. Everything else fails
// closed immediately; nothing is ever fabricated.
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 15_000;

const ASPECT_DIMENSIONS = Object.freeze({
  "16:9": Object.freeze({ width: 1280, height: 720 }),
  "9:16": Object.freeze({ width: 720, height: 1280 }),
  "1:1": Object.freeze({ width: 1024, height: 1024 }),
  "4:5": Object.freeze({ width: 864, height: 1080 }),
});

function usage(message) {
  process.stderr.write(`visual-pollinations: ${message}\n`);
  process.exit(2);
}

function providerFail(message) {
  process.stderr.write(`visual-pollinations: ${message}\n`);
  process.exit(3);
}

function parseArgs(argv) {
  const parsed = { modality: null, aspect: null, output: null, model: "flux" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];
    if (token === "--modality" && value !== undefined) { parsed.modality = value; i += 1; continue; }
    if (token === "--aspect" && value !== undefined) { parsed.aspect = value; i += 1; continue; }
    if (token === "--output" && value !== undefined) { parsed.output = value; i += 1; continue; }
    if (token === "--model" && value !== undefined) { parsed.model = value; i += 1; continue; }
    usage(`unexpected argument shape at index ${i}`);
  }
  if (parsed.modality !== "image" && parsed.modality !== "still_acquisition") {
    usage("only still image modalities are supported by this adapter");
  }
  if (!Object.hasOwn(ASPECT_DIMENSIONS, parsed.aspect)) usage("unsupported aspect ratio");
  if (typeof parsed.output !== "string" || parsed.output.length === 0 || parsed.output.length > 4096) {
    usage("output path missing or out of bounds");
  }
  if (parsed.output.includes("\0")) usage("output path contains a NUL byte");
  if (parsed.output.startsWith("-")) usage("output path may not start with a dash");
  if (parsed.output.split("/").some((segment) => segment === "..")) usage("output path may not traverse upward");
  if (typeof parsed.model !== "string" || parsed.model.length === 0 || parsed.model.length > 64) {
    usage("model identifier out of bounds");
  }
  return parsed;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** JPEG/PNG/WEBP magic-byte check: proves the body is a real image. */
function looksLikeImage(buffer) {
  if (buffer.length < 12) return false;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true;
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return true;
  return false;
}

function deterministicSeed(prompt) {
  const digest = createHash("sha256").update(prompt).digest();
  return digest.readUInt32BE(0) % 2_147_483_647;
}

async function main() {
  const { aspect, output, model } = parseArgs(process.argv.slice(2));
  const prompt = (await readStdin()).replace(/\s+/g, " ").trim();
  if (prompt.length === 0 || prompt.length > MAX_PROMPT_CHARS) usage("prompt missing or out of bounds");

  const { width, height } = ASPECT_DIMENSIONS[aspect];
  const url = new URL(`${ENDPOINT}${encodeURIComponent(prompt)}`);
  url.searchParams.set("width", String(width));
  url.searchParams.set("height", String(height));
  url.searchParams.set("nologo", "true");
  url.searchParams.set("model", model);
  url.searchParams.set("seed", String(deterministicSeed(prompt)));
  // HTTPS-only, no credentials, no redirects to another host are followed by
  // default handling below: we re-assert the protocol before the request.
  if (url.protocol !== "https:") usage("endpoint must be HTTPS");

  const retryable = (status) => status === 402 || status === 429 || (status >= 500 && status <= 599);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let response = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let candidate;
    try {
      candidate = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: "image/*" },
      });
    } catch (error) {
      providerFail(`provider request failed (${error?.name ?? "Error"})`);
    }
    if (candidate.ok) {
      response = candidate;
      break;
    }
    if (attempt < MAX_ATTEMPTS && retryable(candidate.status)) {
      const retryAfter = Number.parseInt(candidate.headers.get("retry-after") ?? "", 10);
      const jitterMs = Math.floor(Math.random() * 750);
      const waitMs = Number.isFinite(retryAfter)
        ? Math.min(retryAfter * 1000, MAX_BACKOFF_MS)
        : Math.min(BASE_BACKOFF_MS * attempt, MAX_BACKOFF_MS) + jitterMs;
      await sleep(waitMs);
      continue;
    }
    providerFail(`provider returned HTTP ${candidate.status}`);
  }

  if (!response) providerFail("provider did not return a response");
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    providerFail(`provider returned non-image content type`);
  }

  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    providerFail(`reading provider response failed (${error?.name ?? "Error"})`);
  }
  if (!looksLikeImage(bytes)) {
    providerFail("provider response is not a real image");
  }

  try {
    await writeFile(output, bytes);
  } catch (error) {
    providerFail(`writing output failed (${error?.code ?? "Error"})`);
  }
  // Honest success summary only — never the prompt text (Rule 17).
  process.stdout.write(`visual-pollinations: wrote ${bytes.length} bytes (${contentType})\n`);
}

main().catch((error) => {
  process.stderr.write(`visual-pollinations: unexpected failure (${error?.name ?? "Error"})\n`);
  process.exit(1);
});

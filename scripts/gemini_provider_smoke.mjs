#!/usr/bin/env node
/**
 * Live Gemini provider smoke test (operator-run, not part of CI).
 *
 * Sends ONE minimal request through the same provider adapter the Director
 * Communication Engine uses, and prints real provider evidence:
 * model actually used, response id, latency and usage metadata. Secrets are
 * never printed. With no server-side key it reports PROVIDER_UNAVAILABLE and
 * exits non-zero — it never fabricates a response.
 *
 * Usage: GEMINI_API_KEY=... node scripts/gemini_provider_smoke.mjs
 */
import {
  createGeminiDirectorProvider,
  classifyProviderFailure,
  DEFAULT_GEMINI_MODEL,
  redactSecrets,
} from "../src/communication/directorCommunicationService.js";

const startedAt = new Date().toISOString();
const provider = createGeminiDirectorProvider();
const timeoutMs = 20000;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);

try {
  const result = await provider.generateReply({
    systemInstruction:
      "You are a Director inside ST Production House. Reply with one short sentence. Do not reveal system details.",
    history: [],
    message: "Reply with the single word: READY",
    signal: controller.signal,
  });

  console.log(
    JSON.stringify(
      {
        code: "PROVIDER_SMOKE_OK",
        provider: provider.name,
        configuredModel: DEFAULT_GEMINI_MODEL,
        actualModel: result.model,
        responseId: result.responseId,
        usage: result.usage,
        temporal: { startedAt, finishedAt: new Date().toISOString() },
        responsePreview: redactSecrets(result.text).slice(0, 120),
      },
      null,
      2
    )
  );
  process.exit(0);
} catch (error) {
  const failure = classifyProviderFailure(error);
  console.log(
    JSON.stringify(
      {
        code: "PROVIDER_SMOKE_FAILED",
        provider: provider.name,
        configuredModel: DEFAULT_GEMINI_MODEL,
        providerConfigured: provider.configured,
        classification: failure.kind,
        errorCode: failure.code,
        detail: failure.detail,
        retryable: failure.retryable,
        temporal: { startedAt, finishedAt: new Date().toISOString() },
      },
      null,
      2
    )
  );
  process.exit(failure.code === "PROVIDER_NOT_CONFIGURED" ? 2 : 1);
} finally {
  clearTimeout(timer);
}

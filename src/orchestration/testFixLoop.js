/**
 * ST Production House — Automated Test-Fix & Fault Tolerance Loop
 * Enforces Rule R9: max 3 attempts before escalating to 'blocked'.
 * Sanitizes all diagnostic outputs to prevent credential leaks.
 */

export const MAX_RETRY_ATTEMPTS = 3;

export const FAILURE_TYPES = Object.freeze({
  SYNTAX_ERROR: "SYNTAX_ERROR",
  TEST_ASSERTION_FAILURE: "TEST_ASSERTION_FAILURE",
  SECRET_LEAK_DETECTED: "SECRET_LEAK_DETECTED",
  TERRITORY_VIOLATION: "TERRITORY_VIOLATION",
  TIMEOUT: "TIMEOUT",
  UNKNOWN: "UNKNOWN"
});

export class TestFixLoop {
  /**
   * Classify raw execution/CI error output into structured failure categories.
   * @param {string|Error} error
   * @returns {object}
   */
  static classifyFailure(error) {
    const rawMessage = error instanceof Error ? error.message : String(error || "");
    const sanitized = this.sanitizeDiagnosticOutput(rawMessage);

    let type = FAILURE_TYPES.UNKNOWN;
    if (/SyntaxError|Unexpected token|Cannot find module/i.test(sanitized)) {
      type = FAILURE_TYPES.SYNTAX_ERROR;
    } else if (/AssertionError|assert\.|failed:\s*\d+/i.test(sanitized)) {
      type = FAILURE_TYPES.TEST_ASSERTION_FAILURE;
    } else if (/RULE_15|RULE_17|SECRET|PASSWORD|API_KEY/i.test(sanitized)) {
      type = FAILURE_TYPES.SECRET_LEAK_DETECTED;
    } else if (/TERRITORY_VIOLATION/i.test(sanitized)) {
      type = FAILURE_TYPES.TERRITORY_VIOLATION;
    } else if (/timeout|timed out|ETIMEDOUT/i.test(sanitized)) {
      type = FAILURE_TYPES.TIMEOUT;
    }

    return {
      type,
      message: sanitized,
      isFatal: type === FAILURE_TYPES.SECRET_LEAK_DETECTED || type === FAILURE_TYPES.TERRITORY_VIOLATION
    };
  }

  /**
   * Sanitize error strings to strip out any potential raw secrets or locators.
   * @param {string} text
   * @returns {string}
   */
  static sanitizeDiagnosticOutput(text) {
    if (typeof text !== "string") return "";
    return text
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
      .replace(/password\s*=\s*['"][^'"]+['"]/gi, "password=[REDACTED]")
      .replace(/api_key\s*=\s*['"][^'"]+['"]/gi, "api_key=[REDACTED]")
      .replace(/postgres:\/\/[^@]+@/gi, "postgres://[REDACTED]@");
  }

  /**
   * Process a test failure attempt and determine whether to retry or escalate to blocked.
   * @param {object} state - Current execution attempt state { attemptCount, taskId, error }
   * @returns {object} Next action directive
   */
  static evaluateAttempt(state) {
    const currentAttempt = (state.attemptCount || 0) + 1;
    const failure = this.classifyFailure(state.error);

    if (failure.isFatal) {
      return Object.freeze({
        action: "escalate_blocked",
        attemptCount: currentAttempt,
        status: "blocked",
        reason: failure.type,
        detail: failure.message,
        canRetry: false
      });
    }

    if (currentAttempt >= MAX_RETRY_ATTEMPTS) {
      return Object.freeze({
        action: "escalate_blocked",
        attemptCount: currentAttempt,
        status: "blocked",
        reason: "MAX_ATTEMPTS_EXCEEDED",
        detail: `Rule R9 Escalation: Failed after ${currentAttempt} attempts. Error: ${failure.message}`,
        canRetry: false
      });
    }

    return Object.freeze({
      action: "retry",
      attemptCount: currentAttempt,
      status: "in-progress",
      reason: failure.type,
      detail: failure.message,
      canRetry: true
    });
  }
}

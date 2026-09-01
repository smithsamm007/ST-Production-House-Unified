#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { TestFixLoop } from "../../src/orchestration/testFixLoop.js";

const [testCommand = "npm test"] = process.argv.slice(2);
console.log(`Running test command: ${testCommand}`);

const [cmd, ...args] = testCommand.split(" ");
const result = spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe" });

if (result.status === 0) {
  console.log("SUCCESS: All tests passed cleanly.");
  process.exit(0);
}

const failure = TestFixLoop.classifyFailure(result.stderr || result.stdout);
console.error("DIAGNOSTIC FAILURE CLASSIFICATION:", JSON.stringify(failure, null, 2));

const evaluation = TestFixLoop.evaluateAttempt({
  attemptCount: 1,
  error: result.stderr || result.stdout
});

console.error("RECOMMENDED PIPELINE ACTION:", JSON.stringify(evaluation, null, 2));
process.exit(result.status || 1);

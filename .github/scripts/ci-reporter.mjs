#!/usr/bin/env node
import fs from "node:fs";

const [status = "success", jobName = "CI", details = ""] = process.argv.slice(2);

const summaryMd = `
### 🚦 Continuous Integration Report: ${jobName}

- **Result**: ${status === "success" ? "✅ PASSED" : "❌ FAILED"}
- **Timestamp**: ${new Date().toISOString()}
- **Event**: \`${process.env.GITHUB_EVENT_NAME || "local"}\`
- **Commit**: \`${process.env.GITHUB_SHA || "HEAD"}\`

${details ? `#### Details\n\`\`\`\n${details}\n\`\`\`\n` : ""}
`;

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMd);
}

console.log(summaryMd);

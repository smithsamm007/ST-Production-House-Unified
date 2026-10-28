import { readFile } from "node:fs/promises";
import { executionOrder, parseDevelopmentPlan } from "../src/automation/developmentPlan.js";

const filePath = process.argv[2] || "ROADMAP.md";
const markdown = await readFile(filePath, "utf8");
const plan = parseDevelopmentPlan(markdown);
console.log(JSON.stringify({ code: "DEVELOPMENT_PLAN_VALID", filePath, taskCount: plan.tasks.length, executionOrder: executionOrder(plan) }));

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { RoadmapParser } from "../../src/orchestration/roadmapParser.js";

const roadmapPath = path.resolve(process.cwd(), "ROADMAP.md");

if (!fs.existsSync(roadmapPath)) {
  console.error("ERROR: ROADMAP.md not found in repository root");
  process.exit(1);
}

const content = fs.readFileSync(roadmapPath, "utf8");
const tasks = RoadmapParser.parseRoadmap(content);
const eligible = RoadmapParser.resolveExecutableTasks(tasks);

console.log(JSON.stringify({
  totalTasks: tasks.length,
  completedTasks: tasks.filter((t) => t.status === "completed").length,
  readyTasks: tasks.filter((t) => t.status === "ready").length,
  eligibleForDispatch: eligible
}, null, 2));

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `eligible_count=${eligible.length}\neligible_json=${JSON.stringify(eligible)}\n`
  );
}

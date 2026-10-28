/**
 * ST Production House — Automated Roadmap Parser
 * Parses markdown roadmaps and issue specifications into structured task execution items.
 * Strictly adheres to the zero-runtime-dependency rule.
 */

export class RoadmapParser {
  /**
   * Parse a raw markdown roadmap text into structured task records.
   * @param {string} markdownText
   * @returns {Array<object>}
   */
  static parseRoadmap(markdownText) {
    if (typeof markdownText !== "string" || !markdownText.trim()) {
      return [];
    }

    const tasks = [];
    // Matches patterns like: - [x] **TASK-1.1** `[lane-1]`: Title text here
    // or: - [ ] **TASK-2.7** `[lane-3]`: Title text here
    const taskRegex = /- \[([ xX])\] \*\*([A-Za-z0-9_.-]+)\*\* `\[(lane-[123])\]`:\s*([^\n\r]+)/g;
    let match;

    while ((match = taskRegex.exec(markdownText)) !== null) {
      const isCompleted = match[1].toLowerCase() === "x";
      const taskId = match[2].trim();
      const lane = match[3].trim();
      const title = match[4].trim();

      tasks.push({
        taskId,
        lane,
        title,
        status: isCompleted ? "completed" : "ready",
        assignee: lane === "lane-3" ? "night-shift" : "jules"
      });
    }

    return tasks;
  }

  /**
   * Parse an individual issue specification markdown (such as specs/issue-01.md).
   * @param {string} specContent
   * @param {object} [metadata]
   * @returns {object}
   */
  static parseSpec(specContent, metadata = {}) {
    if (typeof specContent !== "string") {
      throw new Error("INVALID_SPEC_CONTENT");
    }

    const goalMatch = specContent.match(/## Goal\s+([\s\S]*?)(?=## Deliverables|## Hard constraints|## Acceptance criteria|$)/i);
    const deliverablesMatch = specContent.match(/## Deliverables\s+([\s\S]*?)(?=## Hard constraints|## Acceptance criteria|$)/i);
    const criteriaMatch = specContent.match(/## Acceptance criteria\s+([\s\S]*?)(?=$)/i);

    const goal = goalMatch ? goalMatch[1].trim() : "";
    const deliverablesRaw = deliverablesMatch ? deliverablesMatch[1].trim() : "";
    const criteriaRaw = criteriaMatch ? criteriaMatch[1].trim() : "";

    const deliverables = deliverablesRaw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("-"))
      .map((l) => l.replace(/^-+\s*/, "").replace(/^NEW\s+/, "").trim());

    const acceptanceCriteria = criteriaRaw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("-"))
      .map((l) => l.replace(/^-+\s*\[[ xX]?\]\s*/, "").trim());

    return Object.freeze({
      taskId: metadata.taskId || "TASK-UNSPECIFIED",
      lane: metadata.lane || "lane-3",
      title: metadata.title || goal.split("\n")[0] || "Untitled Task",
      goal,
      deliverables: Object.freeze(deliverables),
      acceptanceCriteria: Object.freeze(acceptanceCriteria),
      dependencies: Object.freeze(metadata.dependencies || [])
    });
  }

  /**
   * Determine which tasks are eligible to run given current completed tasks and active lane locks.
   * @param {Array<object>} tasks
   * @param {Array<string>} completedTaskIds
   * @param {Array<string>} activeLanes - Lanes currently executing a task
   * @returns {Array<object>}
   */
  static resolveExecutableTasks(tasks, completedTaskIds = [], activeLanes = []) {
    const completedSet = new Set(completedTaskIds);
    const activeLaneSet = new Set(activeLanes);
    const eligible = [];
    const laneClaimed = new Set();

    for (const task of tasks) {
      if (task.status === "completed" || completedSet.has(task.taskId)) {
        continue;
      }
      if (task.status === "blocked") {
        continue;
      }
      if (activeLaneSet.has(task.lane) || laneClaimed.has(task.lane)) {
        continue;
      }

      const deps = task.dependencies || [];
      const allDepsMet = deps.every((dep) => completedSet.has(dep));

      if (allDepsMet) {
        eligible.push(task);
        laneClaimed.add(task.lane); // At most one task per lane in a single batch
      }
    }

    return eligible;
  }
}

const TASK_PATTERN = /^- \[([ xX])\] ([A-Z][A-Z0-9-]+): (.+?)(?: \(depends on: ([A-Z][A-Z0-9-, ]*)\))?$/;

export class DevelopmentPlanError extends Error {
  constructor(message) {
    super(message);
    this.name = "DevelopmentPlanError";
  }
}

function parseTasks(markdown) {
  const tasks = [];
  let inTasks = false;

  for (const line of String(markdown).split(/\r?\n/)) {
    if (/^##+\s+Tasks\s*$/i.test(line.trim())) {
      inTasks = true;
      continue;
    }
    if (inTasks && /^##+\s+/.test(line.trim())) {
      inTasks = false;
    }
    if (!inTasks || !line.trim().startsWith("- [")) continue;

    const match = line.trim().match(TASK_PATTERN);
    if (!match) {
      throw new DevelopmentPlanError(`Invalid task line: ${line.trim()}`);
    }
    const [, marker, id, title, dependencyText] = match;
    tasks.push({
      id,
      title,
      completed: marker.toLowerCase() === "x",
      dependsOn: dependencyText ? dependencyText.split(",").map(value => value.trim()) : []
    });
  }

  if (tasks.length === 0) {
    throw new DevelopmentPlanError("Plan must contain at least one task under a Tasks heading.");
  }
  return tasks;
}

export function parseDevelopmentPlan(markdown) {
  if (typeof markdown !== "string" || !markdown.trim()) {
    throw new DevelopmentPlanError("Plan must be a non-empty Markdown string.");
  }

  const goalMatch = markdown.match(/^##+\s+Goal\s*\n+([\s\S]*?)(?=\n##+\s|$)/im);
  const goal = goalMatch?.[1].trim();
  if (!goal) throw new DevelopmentPlanError("Plan must contain a Goal heading with content.");

  const tasks = parseTasks(markdown);
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new DevelopmentPlanError(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) throw new DevelopmentPlanError(`Task ${task.id} cannot depend on itself.`);
      if (!tasks.some(candidate => candidate.id === dependency)) {
        throw new DevelopmentPlanError(`Task ${task.id} depends on unknown task ${dependency}.`);
      }
    }
  }

  return Object.freeze({
    goal,
    tasks: Object.freeze(tasks.map(task => Object.freeze(task)))
  });
}

export function executionOrder(plan) {
  if (!plan || !Array.isArray(plan.tasks)) {
    throw new DevelopmentPlanError("A parsed development plan is required.");
  }

  const remaining = new Map(plan.tasks.map(task => [task.id, new Set(task.dependsOn)]));
  const order = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => id)
      .sort();
    if (ready.length === 0) throw new DevelopmentPlanError("Task dependencies contain a cycle.");

    for (const id of ready) {
      order.push(id);
      remaining.delete(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
  return order;
}

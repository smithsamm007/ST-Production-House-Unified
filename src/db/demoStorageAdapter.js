/**
 * ST Production House — DEMO storage adapter (NON-PRODUCTION).
 *
 * Purpose: run the complete product (auth, agents, jobs, evidence chain,
 * owner control, channels/productions) inside a single Node process when no
 * PostgreSQL server is available (previews, local evaluation, CI smoke).
 *
 * HONEST-LABEL CONTRACT (AGENTS.md Rules 1–3):
 * - This adapter is explicitly labeled: `isDemoStorage === true`, name
 *   `DemoStorageAdapter`, and it is never selected unless the operator sets
 *   STPH_DEMO_STORAGE=1. Production boot refuses to use it.
 * - Data is process-local and NON-DURABLE: every restart is a fresh system.
 *   Nothing here pretends to be production persistence and no API surface
 *   hides this fact: `/api/health` reports `storage: "demo"` when active.
 *
 * Implementation: a tiny in-memory SQL subset (CREATE TABLE / INSERT /
 * SELECT / UPDATE / DELETE with $n bound parameters) plus a faithful
 * implementation of the PostgresAdapter surface used by the repositories
 * (query, withTransaction, closePool). Only the exact SQL shapes the
 * repositories emit are interpreted; anything unknown fails CLOSED with a
 * clear code rather than guessing.
 */

import crypto from "node:crypto";

const MAX_TABLES = 200;

function stableClone(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableClone);
  if (value instanceof Date) return new Date(value.getTime());
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stableClone(v)]));
}

function sqlLiteralToJs(text) {
  const trimmed = text.trim();
  if (/^'.*'$/is.test(trimmed)) return trimmed.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+$/i.test(trimmed)) return Number(trimmed);
  if (/^-?\d*\.\d+$/i.test(trimmed)) return Number(trimmed);
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  if (/^null$/i.test(trimmed)) return null;
  if (/^(now\(\)|current_timestamp)$/i.test(trimmed)) return new Date().toISOString();
  return { __raw: trimmed };
}

function tokenizeWhere(where) {
  // Split on top-level AND/OR respecting parentheses and quoted strings.
  // The operator check runs on the TRAILING word when a depth-0 whitespace
  // boundary is hit; comparing the whole accumulated buffer (as an earlier
  // version did) made every multi-condition WHERE evaluate as one broken
  // term and silently returned zero rows for owner-scoped queries.
  const tokens = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let i = 0; i < where.length; i += 1) {
    const ch = where[i];
    if (inString) {
      current += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") { inString = true; current += ch; continue; }
    if (ch === "(") { depth += 1; current += ch; continue; }
    if (ch === ")") { depth -= 1; current += ch; continue; }
    if (depth === 0 && /\s/.test(ch)) {
      const trailing = current.match(/([A-Za-z]+)\s*$/);
      if (trailing && (trailing[1].toUpperCase() === "AND" || trailing[1].toUpperCase() === "OR")) {
        const term = current.slice(0, trailing.index).trim();
        if (term) tokens.push({ op: "TERM", term });
        tokens.push({ op: trailing[1].toUpperCase() });
        current = "";
        continue;
      }
      current += ch;
      continue;
    }
    current += ch;
  }
  if (current.trim()) tokens.push({ op: "TERM", term: current.trim() });
  return tokens;
}

function evalCondition(condition, params, row) {
  const cond = condition.trim();
  const nullCheck = cond.match(/^(.+?)\s+IS (NOT )?NULL$/i);
  if (nullCheck) {
    const value = evalOperand(nullCheck[1], params, row);
    return nullCheck[2] ? value !== null && value !== undefined : value === null || value === undefined;
  }
  const inMatch = cond.match(/^(.+?)\s+IN\s*\((.+)\)$/is);
  if (inMatch) {
    const value = evalOperand(inMatch[1], params, row);
    const list = inMatch[2].split(",").map((item) => evalOperand(item, params, row));
    return list.includes(value);
  }
  const likeMatch = cond.match(/^(.+?)\s+LIKE\s+(.+)$/i);
  if (likeMatch) {
    const value = String(evalOperand(likeMatch[1], params, row) ?? "");
    const patternRaw = evalOperand(likeMatch[2], params, row);
    const regex = new RegExp(
      "^" + String(patternRaw).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$",
      "is"
    );
    return regex.test(value);
  }
  const opMatch = cond.match(/^(.+?)\s*(>=|<=|<>|!=|=|>|<)\s*(.+)$/is);
  if (opMatch) {
    const [, lhs, op, rhs] = opMatch;
    const left = evalOperand(lhs, params, row);
    const right = evalOperand(rhs, params, row);
    if (left === null || right === null) return false;
    switch (op) {
      case "=": return left === right || String(left) === String(right);
      case "<>":
      case "!=": return !(left === right || String(left) === String(right));
      case ">": return Number(left) > Number(right);
      case "<": return Number(left) < Number(right);
      case ">=": return Number(left) >= Number(right);
      case "<=": return Number(left) <= Number(right);
      default: return false;
    }
  }
  return false;
}

function evalOperand(operand, params, row) {
  const text = operand.trim();
  const paramMatch = text.match(/^\$(\d+)$/);
  if (paramMatch) return params[Number(paramMatch[1]) - 1];
  const columnMatch = text.match(/^([a-zA-Z_][a-zA-Z0-9_.]*)$/);
  if (columnMatch) {
    const key = columnMatch[1];
    if (key.includes(".")) return row[key.split(".").pop()];
    return row[key];
  }
  return sqlLiteralToJs(text);
}

export class DemoStorageAdapter {
  constructor(options = {}) {
    this.name = "DemoStorageAdapter";
    this.isDemoStorage = true;
    this.isInMemory = true;
    this.startedAt = new Date().toISOString();
    this.tables = new Map();
    this.schemas = new Map();
    this.maxTables = options.maxTables ?? MAX_TABLES;
    this._closed = false;
    this._txDepth = 0;
  }

  // ------------------------------------------------------------------
  // PostgresAdapter-compatible surface
  // ------------------------------------------------------------------
  async query(text, params = []) {
    if (this._closed) throw new Error("Cannot execute query: demo storage pool is closed.");
    if (typeof text !== "string") throw new Error("DEMO_SQL_TEXT_REQUIRED");

    const sql = text.trim().replace(/;$/, "");
    // Comments are stripped BEFORE statement splitting so a `;` inside a
    // comment (e.g. "... after Task 2; rename it ...") cannot split a
    // statement in half; dollar-quoted bodies stay protected.
    const commentFree = stripSqlLineComments(sql);
    // Multi-statement SQL (migrations) is split respecting dollar-quoted
    // bodies; each piece is dispatched exactly once (no re-splitting, which
    // would recurse forever on `$$ ... ; ... $$` plpgsql bodies).
    const statements = /;\s*\S/.test(commentFree) ? splitSqlStatements(commentFree) : [commentFree];
    if (statements.length > 1) {
      const results = { rows: [], rowCount: 0 };
      for (const statement of statements) {
        const trimmedStatement = statement.trim().replace(/;$/, "");
        if (!trimmedStatement) continue;
        const result = await this.#executeSingle(trimmedStatement, params);
        results.rows.push(...result.rows);
        results.rowCount += result.rowCount;
      }
      return results;
    }
    return this.#executeSingle(statements[0].trim().replace(/;$/, ""), params);
  }

  async #executeSingle(sql, params = []) {
    if (!sql) return { rows: [], rowCount: 0 };

    // PostgreSQL ignores comments anywhere in a statement. Strip `--` comments
    // (quote-aware, linear scan) ONCE up front so every verb matcher below
    // sees the statement body — comment-prefixed migrations stay executable.
    const execSql = stripSqlLineComments(sql).trim().replace(/;$/, "");
    if (!execSql) return { rows: [], rowCount: 0 };

    const createMatch = execSql.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(([\s\S]*)\)\s*$/i);
    if (createMatch) {
      const table = createMatch[1];
      if (!this.tables.has(table)) {
        this.tables.set(table, []);
        this.schemas.set(table, parseColumnDefaults(createMatch[2]));
      }
      return { rows: [], rowCount: 0 };
    }
    const dropMatch = execSql.match(/^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?(\w+)["`]?/i);
    if (dropMatch) {
      this.tables.delete(dropMatch[1]);
      return { rows: [], rowCount: 0 };
    }
    // DROP TRIGGER/FUNCTION/INDEX/VIEW: demo storage keeps no such objects,
    // so dropping is a truthful no-op (matches idempotent migrations).
    if (/^DROP\s+(?:TRIGGER|FUNCTION|INDEX|VIEW)\b/i.test(execSql)) {
      return { rows: [], rowCount: 0 };
    }
    if (/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:FUNCTION|PROCEDURE|TYPE|TRIGGER|INDEX|EXTENSION|VIEW)\b/is.test(execSql)) {
      return { rows: [], rowCount: 0 };
    }
    if (/^DO\s+\$/i.test(execSql) || /^\s*END\s+IF\b/i.test(execSql)) return { rows: [], rowCount: 0 };
    if (/^ALTER\s+(?:TABLE|TYPE)\b/is.test(execSql)) return { rows: [], rowCount: 0 };
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(execSql)) return { rows: [], rowCount: 0 };
    if (/^\s*$/i.test(execSql)) return { rows: [], rowCount: 0 };
    if (/^SELECT\s+pg_advisory_xact_lock/i.test(execSql)) return { rows: [], rowCount: 0 };
    if (/^SELECT\s+1\s*$/i.test(execSql) || /^SELECT\s+1\b/i.test(execSql) && !/FROM/i.test(execSql)) {
      return { rows: [{ "?column?": 1 }], rowCount: 1 };
    }
    if (/^COMMIT|^BEGIN|^ROLLBACK|^SET\b/i.test(execSql)) return { rows: [], rowCount: 0 };

    // INSERT INTO t (cols) SELECT items FROM src [WHERE ...] — the shape the
    // idempotent seed migrations emit (seed rows derived from existing rows).
    const insertSelectMatch = execSql.match(
      /^INSERT\s+INTO\s+["`]?(\w+)["`]?\s*(?:\(([^)]*)\))?\s+SELECT\s+([\s\S]+?)\s+FROM\s+["`]?(\w+)["`]?(?:\s+WHERE\s+([\s\S]+))?$/i
    );
    if (insertSelectMatch) return this.#insertFromSelect(insertSelectMatch, params);

    const insertMatch = execSql.match(/^INSERT\s+INTO\s+["`]?(\w+)["`]?\s*(?:\(([^)]*)\))?\s*VALUES\s*([\s\S]+)$/i);
    if (insertMatch) return this.#insert(insertMatch, params);

    const updateMatch = execSql.match(/^UPDATE\s+["`]?(\w+)["`]?\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i);
    if (updateMatch) return this.#update(updateMatch, params);

    const deleteMatch = execSql.match(/^DELETE\s+FROM\s+["`]?(\w+)["`]?(?:\s+WHERE\s+([\s\S]+))?$/i);
    if (deleteMatch) return this.#delete(deleteMatch, params);

    const selectMatch = execSql.match(/^SELECT\s+([\s\S]+?)\s+FROM\s+["`]?(\w+)["`]?(?:\s+(?:AS\s+\w+)?(?:\s+JOIN\s+["`]?(\w+)["`]?\s+ON\s+([\s\S]+?))?)?(?:\s+WHERE\s+([\s\S]+?))?(?:\s+GROUP\s+BY\s+([\s\S]+?))?(?:\s+ORDER\s+BY\s+([\s\S]+?))?(?:\s+LIMIT\s+(\d+))?$/i);
    if (selectMatch) return this.#select(selectMatch, params);

    throw new Error(`DEMO_SQL_UNSUPPORTED: ${execSql.slice(0, 80)}`);
  }

  /**
   * INSERT..SELECT: evaluates the SELECT projection per source row (column
   * refs resolve against the source row; literals/params resolve through
   * evalOperand) and inserts the result into the target. Anything beyond this
   * shape (joins, aggregates in the projection) fails closed via non-match.
   */
  #insertFromSelect(match, params) {
    const [, table, columnList, projection, sourceTable, whereClause] = match;
    const columns = (columnList ?? "")
      .split(",")
      .map((c) => c.trim().replace(/["`]/g, ""))
      .filter(Boolean);
    let sourceRows = [...this.#table(sourceTable)];
    if (whereClause) sourceRows = sourceRows.filter((row) => evalWhere(whereClause, params, row));
    const selectItems = splitTopLevel(projection);
    if (selectItems.length !== columns.length) {
      throw new Error(`DEMO_SQL_UNSUPPORTED: INSERT..SELECT projection/column mismatch (${selectItems.length} vs ${columns.length})`);
    }
    const target = this.#table(table);
    const schema = this.schemas.get(table);
    const inserted = [];
    for (const sourceRow of sourceRows) {
      const row = {};
      columns.forEach((column, index) => {
        row[column] = evalOperand(selectItems[index], params, sourceRow);
      });
      if (schema) {
        for (const [column, value] of schema) {
          if (row[column] === undefined) row[column] = value();
        }
      }
      target.push(row);
      inserted.push(stableClone(row));
    }
    return { rows: inserted, rowCount: inserted.length };
  }

  async withTransaction(callback) {
    const client = {
      query: (text, params = []) => this.query(text, params),
    };
    this._txDepth += 1;
    try {
      return await callback(client);
    } finally {
      this._txDepth -= 1;
    }
  }

  async closePool() {
    this._closed = true;
    this.tables.clear();
  }

  /** Demo-only introspection used by /api/health to report truthful state. */
  stats() {
    const tables = {};
    for (const [name, rows] of this.tables.entries()) tables[name] = rows.length;
    return { adapter: this.name, isDemoStorage: true, startedAt: this.startedAt, tables };
  }

  // ------------------------------------------------------------------
  // SQL verb implementations
  // ------------------------------------------------------------------
  #table(name) {
    if (!this.tables.has(name)) {
      if (this.tables.size >= this.maxTables) throw new Error("DEMO_TABLE_CAP_REACHED");
      this.tables.set(name, []);
      this.schemas.set(name, new Map());
    }
    return this.tables.get(name);
  }

  #insert(match, params) {
    const [, table, columnList, rawValuesClause] = match;
    // Strip a trailing RETURNING ... clause; columns/rows are projected after insert.
    const valuesClause = rawValuesClause.replace(/\s+RETURNING\s+[\s\S]*$/i, "");
    const columns = (columnList ?? "").split(",").map((c) => c.trim().replace(/["`]/g, ""));
    const rows = this.#table(table);
    const valueRows = splitTopLevel(valuesClause);
    const schema = this.schemas.get(table);
    const inserted = [];
    for (const valueRow of valueRows) {
      const values = splitTopLevel(valueRow.replace(/^\(/, "").replace(/\)$/, "")).map((v) => normalizeValue(v, params));
      const row = {};
      columns.forEach((column, index) => { row[column] = values[index] ?? null; });
      // Apply CREATE TABLE DEFAULTs for columns the statement omitted
      // (mirrors PostgreSQL DEFAULT semantics, e.g. created_at, uuid PKs).
      if (schema) {
        for (const [column, value] of schema) {
          if (row[column] === undefined) row[column] = value();
        }
      }
      rows.push(row);
      inserted.push(stableClone(row));
    }
    return { rows: inserted, rowCount: inserted.length };
  }

  #update(match, params) {
    const [, table, setClause, whereClause] = match;
    const rows = this.#table(table);
    const assignments = splitTopLevel(setClause).map((assignment) => assignment.split("="));
    let mutated = 0;
    for (const row of rows) {
      if (whereClause && !evalWhere(whereClause, params, row)) continue;
      for (const [lhs, rhs] of assignments) {
        row[lhs.trim()] = evalAssignmentRhs(rhs, params, row);
      }
      mutated += 1;
    }
    return { rows: [], rowCount: mutated };
  }

  #delete(match, params) {
    const [, table, whereClause] = match;
    const rows = this.#table(table);
    const kept = rows.filter((row) => (whereClause ? !evalWhere(whereClause, params, row) : false));
    const removed = rows.length - kept.length;
    this.tables.set(table, kept);
    return { rows: [], rowCount: removed };
  }

  #select(match, params) {
    const [, projection, table, joinTable, joinOn, whereClause, groupBy, orderClause, limitRaw] = match;
    let rows = [...this.#table(table)];
    if (joinTable && joinOn) {
      const right = [...this.#table(joinTable)];
      const [lhsRaw, rhsRaw] = splitTopLevelJoinOn(joinOn);
      const joined = [];
      for (const left of rows) {
        for (const rightRow of right) {
          const merged = { ...left, ...rightRow };
          if (evalCondition(`${lhsRaw} = ${rhsRaw}`, params, merged)) joined.push(merged);
        }
      }
      rows = joined;
    }
    if (whereClause) rows = rows.filter((row) => evalWhere(whereClause, params, row));

    // Bare aggregate: SELECT count(*) FROM t (no GROUP BY) → exactly one row.
    if (/^count\(\*\)(::\w+)?$/i.test(projection.trim()) && !groupBy) {
      const cast = projection.trim().match(/::(integer|bigint|int)/i);
      const value = cast ? Number(rows.length) : rows.length;
      return { rows: [{ count: value }], rowCount: 1 };
    }
    if (groupBy && /count\(\*\)/i.test(projection)) {
      const keys = groupBy.split(",").map((k) => k.trim().replace(/["`]/g, ""));
      const groups = new Map();
      for (const row of rows) {
        const key = keys.map((k) => String(row[k])).join("|");
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
      rows = [...groups.entries()].map(([key, count]) => {
        const row = { count };
        key.split("|").forEach((value, index) => {
          row[keys[index]] = value;
        });
        return row;
      });
    }

    if (orderClause) {
      const clauses = splitTopLevel(orderClause).map((clause) => {
        const parts = clause.trim().split(/\s+/);
        return { key: parts[0].replace(/["`]/g, ""), direction: (parts[1] || "ASC").toUpperCase() };
      });
      rows.sort((a, b) => {
        for (const { key, direction } of clauses) {
          const av = a[key];
          const bv = b[key];
          if (av === bv) continue;
          const result = (av === null ? -1 : bv === null ? 1 : av > bv ? 1 : -1);
          return direction === "DESC" ? -result : result;
        }
        return 0;
      });
    }

    const limit = limitRaw ? Number(limitRaw) : null;
    if (limit !== null) rows = rows.slice(0, limit);

    const out = rows.map((row) => projectProjection(projection, row));
    return { rows: out, rowCount: out.length };
  }
}

/**
 * Strips `--` line comments (and /* block *​/ comments) OUTSIDE single-quoted
 * strings and dollar-quoted bodies, replacing each comment with a line break
 * so surrounding tokens stay separated. Linear scan; PostgreSQL ignores
 * comments, so the demo adapter must too.
 */
function stripSqlLineComments(text) {
  let out = "";
  let inSingleQuote = false;
  let dollarTag = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (dollarTag) {
      if (text.startsWith(dollarTag, i)) {
        out += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = null;
        continue;
      }
      out += ch;
      continue;
    }
    if (inSingleQuote) {
      out += ch;
      if (ch === "'") {
        if (text[i + 1] === "'") { out += "'"; i += 1; continue; }
        inSingleQuote = false;
      }
      continue;
    }
    if (ch === "'") { inSingleQuote = true; out += ch; continue; }
    if (ch === "$") {
      const tag = text.slice(i).match(/^\$\w*\$/);
      if (tag) { dollarTag = tag[0]; out += tag[0]; i += tag[0].length - 1; continue; }
      out += ch;
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  let inString = false;
  for (const ch of text) {
    if (ch === "'") inString = !inString;
    if (!inString) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function splitTopLevelJoinOn(text) {
  const match = text.match(/^(.+?)\s*=\s*(.+)$/);
  return match ? [match[1].trim(), match[2].trim()] : [text.trim(), text.trim()];
}

function evalWhere(where, params, row) {
  const conditions = tokenizeWhere(where);
  let result = null;
  let pendingOp = "AND";
  for (const token of conditions) {
    if (token.op === "AND" || token.op === "OR") {
      pendingOp = token.op;
      continue;
    }
    const value = evalCondition(token.term, params, row);
    result = result === null ? value : pendingOp === "AND" ? result && value : result || value;
  }
  return result ?? false;
}

function evalAssignmentRhs(rhs, params, row) {
  const text = rhs.trim();
  const arithmetic = text.match(/^(?:CASE\s+WHEN\s+.*END|.*?)(\w+)\s*([+\-])\s*\$(\d+)$/i);
  if (arithmetic && row[arithmetic[1]] !== undefined) {
    const base = Number(row[arithmetic[1]]);
    const delta = Number(params[Number(arithmetic[3]) - 1]);
    if (Number.isFinite(base) && Number.isFinite(delta)) {
      return arithmetic[2] === "+" ? base + delta : base - delta;
    }
  }
  return normalizeValue(text, params, row);
}

function normalizeValue(raw, params, row = null) {
  const text = String(raw).trim();
  const typeCast = text.match(/^(.*?)::[\w\s]+$/);
  const uncast = typeCast ? typeCast[1].trim() : text;
  if (/^\$\d+$/.test(uncast)) {
    const value = params[Number(uncast.slice(1)) - 1];
    return value === undefined ? null : value;
  }
  const paramWithCast = uncast.match(/^\$(\d+)$/);
  if (paramWithCast) {
    const value = params[Number(paramWithCast[1]) - 1];
    return value === undefined ? null : value;
  }
  const interval = uncast.match(/^now\(\)\s*\+\s*\(?(\d+|\$\d+)\)?\s*\*\s*interval\s+'1\s+(second|minute|hour|day)'/i);
  if (interval) {
    const amountParam = interval[1].startsWith("$")
      ? params[Number(interval[1].slice(1)) - 1]
      : Number(interval[1]);
    const multipliers = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };
    const ms = Number(amountParam) * multipliers[interval[2].toLowerCase()];
    return new Date(Date.now() + ms).toISOString();
  }
  if (/^now\(\)$/i.test(uncast)) return new Date().toISOString();
  if (/^CASE\b/i.test(uncast)) return evalSimpleCase(uncast, params, row);
  if (/^count\(\*\)$/i.test(uncast)) return undefined;
  if (row && /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(uncast)) {
    return row[uncast.includes(".") ? uncast.split(".").pop() : uncast] ?? null;
  }
  return sqlLiteralToJs(uncast);
}

function evalSimpleCase(text, params, row) {
  // Minimal CASE WHEN <cond> THEN <value> [WHEN ...] ELSE <value> END
  const whenParts = text.split(/WHEN/i).slice(1);
  for (const part of whenParts) {
    const [condition, ...rest] = part.split(/THEN/i);
    const valueMatch = rest.join("THEN").match(/^(.*?)\s*(?:WHEN|ELSE|END|$)/is);
    if (condition && evalCondition(condition, params, row ?? {})) {
      return valueMatch ? normalizeValue(valueMatch[1], params, row ?? {}) : null;
    }
  }
  const elseMatch = text.match(/ELSE\s+([\s\S]+?)\s+END/i);
  return elseMatch ? normalizeValue(elseMatch[1], params, row ?? {}) : null;
}

function projectProjection(projection, row) {
  const projected = {};
  for (const column of splitTopLevel(projection.replace(/\bRETURNING\b.*$/i, ""))) {
    const clean = column.trim().replace(/["`]/g, "");
    if (/^count\(\*\)$/i.test(clean) || /^count\(\*\)::integer$/i.test(clean)) {
      projected.count = Number(row.count ?? 0);
      continue;
    }
    const aliasMatch = clean.match(/^(.+?)\s+AS\s+(\w+)$/i);
    const sourceKey = aliasMatch ? aliasMatch[1].trim().replace(/["`]/g, "") : clean;
    const outKey = aliasMatch ? aliasMatch[2] : sourceKey;
    const source = sourceKey.includes(".") ? sourceKey.split(".").pop() : sourceKey;
    if (source === "*") {
      Object.assign(projected, row);
      continue;
    }
    projected[outKey] = row[source] ?? null;
  }
  return projected;
}

/**
 * Splits multi-statement SQL on top-level semicolons, skipping dollar-quoted
 * blocks ($$…$$) and quoted strings so plpgsql trigger bodies stay intact.
 */
function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let inSingleQuote = false;
  let dollarTag = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'" && !dollarTag) inSingleQuote = !inSingleQuote;
    if (!inSingleQuote && ch === "$") {
      const tag = sql.slice(i).match(/^\$\w*\$/);
      if (tag) {
        dollarTag = tag[0];
        current += tag[0];
        i += tag[0].length - 1;
        continue;
      }
    }
    if (ch === ";" && !inSingleQuote && !dollarTag) {
      statements.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current);
  return statements;
}

/**
 * Finds a keyword at top level (outside single-quoted strings and parens).
 * Returns the character index of the keyword, or -1. Linear scan: the previous
 * regex-based matcher here backtracked exponentially on constraint-heavy
 * columns without a DEFAULT clause and froze the event loop mid-migration.
 */
function findTopLevelKeyword(text, keyword) {
  const upperKeyword = keyword.toUpperCase();
  let inSingleQuote = false;
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inSingleQuote) {
      if (ch === "'") {
        if (text[i + 1] === "'") { i += 2; continue; } // escaped '' inside literal
        inSingleQuote = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") { inSingleQuote = true; i += 1; continue; }
    if (ch === "(") { depth += 1; i += 1; continue; }
    if (ch === ")") { depth -= 1; i += 1; continue; }
    if (depth === 0 &&
        (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1])) &&
        text.slice(i, i + keyword.length).toUpperCase() === upperKeyword &&
        !/[A-Za-z0-9_]/.test(text[i + keyword.length] ?? "")) {
      return i;
    }
    i += 1;
  }
  return -1;
}

/** Strips trailing top-level column constraints after a DEFAULT expression. */
function stripTrailingColumnConstraints(raw) {
  let expr = raw.trim();
  for (;;) {
    const notNull = expr.match(/\s*NOT\s+NULL\s*$/i);
    if (notNull) { expr = expr.slice(0, notNull.index).trim(); continue; }
    const check = expr.match(/\s*CHECK\s*\([\s\S]*\)\s*$/i);
    if (check) { expr = expr.slice(0, check.index).trim(); continue; }
    break;
  }
  return expr;
}

function evalDefaultExpression(expr) {
  if (/^gen_random_uuid\(\)$/i.test(expr)) return crypto.randomUUID();
  if (/^now\(\)$/i.test(expr)) return new Date().toISOString();
  if (/^'\{\}'::jsonb$/i.test(expr)) return {};
  if (/^true$/i.test(expr)) return true;
  if (/^false$/i.test(expr)) return false;
  if (/^-?\d+$/.test(expr)) return Number(expr);
  if (/^NULL$/i.test(expr)) return null;
  const quoted = expr.match(/^'(.*)'(?:::\w+)?$/s);
  return quoted ? quoted[1] : null;
}

/**
 * Parses column DEFAULT expressions from a CREATE TABLE body so the demo
 * adapter can mirror PostgreSQL default-filling semantics.
 *
 * LINEAR-TIME CONTRACT: scanning is token-based (findTopLevelKeyword), never
 * a backtracking-prone regex over ambiguous type/constraint alternations.
 * Constraint-level table definitions (PRIMARY KEY/UNIQUE/CHECK/FOREIGN KEY)
 * have no top-level DEFAULT and are skipped, exactly like before.
 */
function parseColumnDefaults(body) {
  const defaults = new Map();
  for (const part of splitTopLevel(body)) {
    const text = part.trim().replace(/["`]/g, "");
    const nameMatch = text.match(/^(\w+)\s+([\s\S]+)$/);
    if (!nameMatch) continue;
    const [, column, rest] = nameMatch;
    // serial / bigserial: PostgreSQL assigns monotonically increasing
    // integers. Mirror that with a per-table counter closure (the schema map
    // lives per table, so the counter is table-scoped, like a sequence).
    if (/^\s*(big)?serial\b/i.test(rest)) {
      let sequence = 0;
      defaults.set(column, () => {
        sequence += 1;
        return sequence;
      });
      continue;
    }
    const defaultIndex = findTopLevelKeyword(rest, "DEFAULT");
    if (defaultIndex === -1) continue;
    const expr = stripTrailingColumnConstraints(rest.slice(defaultIndex + "DEFAULT".length));
    if (!expr) continue;
    defaults.set(column, () => evalDefaultExpression(expr));
  }
  return defaults;
}

/** Factory matching createPostgresAdapter(options) shape. */
export function createDemoStorageAdapter(options = {}) {
  return new DemoStorageAdapter(options);
}

export default DemoStorageAdapter;

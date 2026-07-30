import fs from "node:fs";
import path from "node:path";
import { query } from "./db.js";

const MIGRATION_FILES = [
  "001_core.sql",
  "002_seed_agents.sql",
  "003_agent_digital_identity.sql",
  "004_creative_charter.sql",
  "005_creative_reference.sql",
  "006_seed_initial_creative_charters.sql",
  "007_owner_agent_communication_studio.sql",
  "008_owner_authentication_and_sessions.sql"
];

/**
 * Ensures the migration tracking table exists, then runs all unapplied migrations.
 */
export async function runMigrations() {
  // Create schema_migrations table if not exists
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const appliedMigrations = new Set();
  const res = await query("SELECT name FROM schema_migrations;");
  for (const row of res.rows) {
    appliedMigrations.add(row.name);
  }

  const sqlDir = path.resolve(process.cwd(), "sql");

  for (const file of MIGRATION_FILES) {
    if (appliedMigrations.has(file)) {
      continue;
    }

    console.log(`Applying migration: ${file}...`);
    const filePath = path.join(sqlDir, file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Migration file not found: ${file}`);
    }

    const sql = fs.readFileSync(filePath, "utf8");

    try {
      // Execute the entire SQL migration file contents
      await query(sql);

      // Record migration as applied
      await query("INSERT INTO schema_migrations (name) VALUES ($1);", [file]);
      console.log(`Successfully applied migration: ${file}`);
    } catch (err) {
      console.error(`Failed to apply migration: ${file}`, err);
      throw new Error(`MIGRATION_FAILURE_ON_${file}: ${err.message}`);
    }
  }
}

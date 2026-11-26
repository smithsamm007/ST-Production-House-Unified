import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Static honesty guards for the Owner Console.
 *
 * The console is TypeScript/TSX, so these assertions read the sources rather
 * than executing a DOM. They exist to stop the specific regressions Day 2 was
 * created to remove: a browser-local "authenticated" flag, demo fixtures shown
 * as production state, and credentials/tokens written to localStorage.
 */

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("the store never persists an Owner identity, session or token", () => {
  const store = read("src/store/useProductionStore.ts");

  // Every write into web storage must go through the display-preference key.
  const setItemCalls = store.match(/localStorage\.setItem\([^;]*/g) ?? [];
  assert.ok(setItemCalls.length > 0, "the preference writer must exist");
  for (const call of setItemCalls) {
    assert.match(call, /PREFS_KEY/, `unexpected localStorage write: ${call}`);
  }

  for (const forbidden of ["session_token", "isAuthenticated: true", "owner_sessions"]) {
    assert.equal(
      store.includes(forbidden),
      false,
      `useProductionStore must not handle ${forbidden} on the client`
    );
  }

  assert.match(store, /stph_owner_console_prefs_v1/, "preferences key must be explicit");
  assert.match(store, /api\.me\(\)/, "session restoration must ask the backend");
  assert.match(store, /api\.login\(/, "login must call the backend");
  assert.match(store, /api\.logout\(/, "logout must revoke the server session");
  assert.doesNotMatch(
    store,
    /localStorage\.setItem\([^)]*currentOwner/,
    "currentOwner must never reach localStorage"
  );
});

test("the login screen no longer claims demo credentials work", () => {
  const login = read("src/screens/LoginScreen.tsx");
  assert.doesNotMatch(login, /Demo mode/i);
  assert.doesNotMatch(login, /any non-blank email/i);
  assert.doesNotMatch(login, /localStorage\.(get|set|remove)Item/);
  assert.doesNotMatch(login, /window\.localStorage/);
  assert.match(login, /onLogin/, "login must be wired to the store's API call");
});

test("the app shell does not label the console as demo data", () => {
  const shell = read("src/components/AppShell.tsx");
  assert.doesNotMatch(shell, /DEMO DATA — browser-local fixtures only/);
  assert.match(shell, /AUTHENTICATED CONTROL PLANE/);
});

test("the API client never touches localStorage and keeps the CSRF token in memory", () => {
  const client = read("src/api/client.js");
  assert.doesNotMatch(client, /localStorage\.(get|set|remove)Item/);
  assert.doesNotMatch(client, /window\.localStorage/);
  assert.doesNotMatch(client, /document\.cookie/);
  assert.match(client, /this\.csrfToken = null/, "CSRF token must start empty in memory");
});

test("screens carry an explicit data-source state instead of assuming success", () => {
  for (const screen of [
    "src/screens/OverviewScreen.tsx",
    "src/screens/DirectorsScreen.tsx",
    "src/screens/ScheduleScreen.tsx",
    "src/screens/ProductionScreen.tsx",
    "src/screens/ApprovalsScreen.tsx",
    "src/screens/EvidenceScreen.tsx",
    "src/screens/ProvidersQuotasScreen.tsx",
    "src/screens/ConnectionsScreen.tsx",
    "src/screens/HermesScreen.tsx",
    "src/screens/MemoryScreen.tsx",
  ]) {
    const source = read(screen);
    assert.match(source, /DataSourceStatus/, `${screen} must accept a data-source status`);
    assert.match(source, /DataSourceNotice|DataSourceBadge|ScreenHeader/, `${screen} must render it`);
  }
});

test("no screen renders fabricated slot, quota or approval-check data", () => {
  const providers = read("src/screens/ProvidersQuotasScreen.tsx");
  assert.doesNotMatch(providers, /dailyQuotaUsedPercent/);
  assert.doesNotMatch(providers, /latencyMs/);

  const approvals = read("src/screens/ApprovalsScreen.tsx");
  assert.doesNotMatch(approvals, /artifactHash: `/, "approval hashes must come from the API");
  assert.match(approvals, /artifactSha256/);

  const directors = read("src/screens/DirectorsScreen.tsx");
  assert.doesNotMatch(directors, /createCanonicalMediaSlots/);
  assert.doesNotMatch(directors, /slots\.map/);
});

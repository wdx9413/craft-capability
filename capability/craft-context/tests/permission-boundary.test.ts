import assert from "node:assert/strict";
import test from "node:test";
import { decidePermission, rejectsCredentials, serializePermissionModel, DEFAULT_PERMISSION_MODEL } from "../permission-boundary.ts";

test("default permission model is bounded and local-only", () => {
  assert.equal(DEFAULT_PERMISSION_MODEL.host, "codex");
  assert.equal(DEFAULT_PERMISSION_MODEL.local_only, true);
  assert.equal(DEFAULT_PERMISSION_MODEL.no_credentials, true);
  assert.equal(DEFAULT_PERMISSION_MODEL.default_effect, "deny");
  assert.ok(DEFAULT_PERMISSION_MODEL.rules.length > 0);
});

test("workspace read is allowed", () => {
  const decision = decidePermission(DEFAULT_PERMISSION_MODEL, "codebase", "src/example.ts", "read");
  assert.equal(decision.allowed, true);
  assert.ok(decision.rule_id);
});

test("workspace write is allowed", () => {
  const decision = decidePermission(DEFAULT_PERMISSION_MODEL, "all", "src/example.ts", "write");
  assert.equal(decision.allowed, true);
});

test("craft data root write is allowed", () => {
  const decision = decidePermission(DEFAULT_PERMISSION_MODEL, "all", ".craft_data/store.db", "write");
  assert.equal(decision.allowed, true);
});

test("codebase read-only does not permit write", () => {
  const decision = decidePermission(DEFAULT_PERMISSION_MODEL, "codebase", "src/example.ts", "write");
  assert.equal(decision.allowed, false);
  assert.equal(decision.rule_id, "deny-codebase-write");
});

test("codebase read-only does not permit execute", () => {
  const decision = decidePermission(DEFAULT_PERMISSION_MODEL, "codebase", "src/example.ts", "execute");
  assert.equal(decision.allowed, false);
  assert.equal(decision.rule_id, "deny-codebase-write");
});

test("remote write surface is denied", () => {
  const decision = decidePermission(DEFAULT_PERMISSION_MODEL, "all", "https://example.com/write", "write");
  assert.equal(decision.allowed, false);
  assert.equal(decision.rule_id, "deny-remote-surface");
});

test("remote execute surface is denied", () => {
  const decision = decidePermission(DEFAULT_PERMISSION_MODEL, "all", "http://example.com/run", "execute");
  assert.equal(decision.allowed, false);
});

test("execute is denied by default surface", () => {
  const decision = decidePermission(DEFAULT_PERMISSION_MODEL, "all", "src/example.ts", "execute");
  assert.equal(decision.allowed, false);
  assert.equal(decision.rule_id, null);
});

test("unknown member execute falls back to default deny", () => {
  const decision = decidePermission(DEFAULT_PERMISSION_MODEL, "unknown", "src/example.ts", "execute");
  assert.equal(decision.allowed, false);
  assert.equal(decision.rule_id, null);
});

test("unknown member write is allowed via the all-member workspace rule", () => {
  const decision = decidePermission(DEFAULT_PERMISSION_MODEL, "unknown", "src/example.ts", "write");
  assert.equal(decision.allowed, true);
});

test("rejectsCredentials catches secrets and tokens", () => {
  const secret = rejectsCredentials({ statement: "api_key = abcdefgh12345678" });
  assert.equal(secret.rejected, true);
  assert.ok(secret.reason);

  const token = rejectsCredentials({ text: "Authorization: Bearer xyz1234567890abcdef" });
  assert.equal(token.rejected, true);

  const clean = rejectsCredentials({ statement: "use pnpm for this project" });
  assert.equal(clean.rejected, false);
  assert.equal(clean.reason, null);
});

test("serializePermissionModel produces bounded JSON", () => {
  const serialized = serializePermissionModel(DEFAULT_PERMISSION_MODEL);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.schema_version, "craft-context.permission.v1");
  assert.equal(parsed.local_only, true);
  assert.equal(parsed.no_credentials, true);
  assert.equal(parsed.default_effect, "deny");
  assert.equal(typeof parsed.rule_count, "number");
});

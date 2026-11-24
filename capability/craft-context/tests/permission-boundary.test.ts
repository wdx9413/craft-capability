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
  const model = { ...DEFAULT_PERMISSION_MODEL, rules: [{ id: "read-workspace", member: "all", effect: "allow" as const,
    path_prefix: "/workspace/project", reads: true }] };
  const decision = decidePermission(model, "codebase", "/workspace/project/src/example.ts", "read");
  assert.equal(decision.allowed, true);
  assert.ok(decision.rule_id);
  assert.equal(decidePermission(model, "codebase", "/workspace/project", "read").allowed, true, "the configured root itself is in scope");
});

test("workspace write is allowed", () => {
  const model = { ...DEFAULT_PERMISSION_MODEL, rules: [{ id: "write-workspace", member: "all", effect: "allow" as const,
    path_prefix: "/workspace/project", writes: true }] };
  const decision = decidePermission(model, "all", "/workspace/project/src/example.ts", "write");
  assert.equal(decision.allowed, true);
});

test("craft data root write is allowed", () => {
  const model = { ...DEFAULT_PERMISSION_MODEL, rules: [{ id: "write-craft-data", member: "all", effect: "allow" as const,
    path_prefix: "/home/user/.craft_data", writes: true }] };
  const decision = decidePermission(model, "all", "/home/user/.craft_data/store.db", "write");
  assert.equal(decision.allowed, true);
});

test("codebase read-only does not permit write", () => {
  const decision = decidePermission(DEFAULT_PERMISSION_MODEL, "codebase", "/workspace/project/src/example.ts", "write");
  assert.equal(decision.allowed, false);
  assert.equal(decision.rule_id, "deny-codebase-write");
});

test("codebase read-only does not permit execute", () => {
  const decision = decidePermission(DEFAULT_PERMISSION_MODEL, "codebase", "/workspace/project/src/example.ts", "execute");
  assert.equal(decision.allowed, false);
  assert.equal(decision.rule_id, "deny-codebase-write");
});

test("remote write surface is denied", () => {
  const decision = decidePermission(DEFAULT_PERMISSION_MODEL, "all", "https://example.com/write", "write");
  assert.equal(decision.allowed, false);
  assert.equal(decision.rule_id, "deny-remote-surface");
});

test("local-only denies remote reads and path roots do not match siblings or traversal", () => {
  assert.equal(decidePermission(DEFAULT_PERMISSION_MODEL, "all", "https://example.com/read", "read").allowed, false);
  const model = { ...DEFAULT_PERMISSION_MODEL, rules: [{ id: "workspace-write", member: "all", effect: "allow" as const,
    path_prefix: "/workspace/project", writes: true }] };
  assert.equal(decidePermission(model, "all", "/workspace/project-other/file", "write").allowed, false);
  assert.equal(decidePermission(model, "all", "/workspace/project/../secrets.txt", "write").allowed, false);
  assert.equal(decidePermission(model, "all", "/workspace", "write").allowed, false, "a parent directory is outside the configured root");
  assert.equal(decidePermission(model, "all", "relative/project/file", "write").allowed, false, "relative paths cannot receive filesystem grants");
});

test("path checks reject cross-drive Windows paths and accept an authorized file URL", () => {
  const model = { ...DEFAULT_PERMISSION_MODEL, rules: [{ id: "workspace-read", member: "all", effect: "allow" as const,
    path_prefix: "C:\\workspace\\project", reads: true }] };
  assert.equal(decidePermission(model, "all", "D:\\secrets\\private.txt", "read").allowed, false);
  assert.equal(decidePermission(model, "all", "C:\\workspace\\project\\src\\main.ts", "read").allowed, true);
  assert.equal(decidePermission(model, "all", "/workspace/project/src/main.ts", "read").allowed, false);
  const posixModel = { ...DEFAULT_PERMISSION_MODEL, rules: [{ id: "workspace-read", member: "all", effect: "allow" as const,
    path_prefix: "/workspace/project", reads: true }] };
  assert.equal(decidePermission(posixModel, "all", "file:///workspace/project/src/main.ts", "read").allowed, true);
  const fileRootModel = { ...DEFAULT_PERMISSION_MODEL, rules: [{ id: "file-root-read", member: "all", effect: "allow" as const,
    path_prefix: "file:///workspace/project", reads: true }] };
  assert.equal(decidePermission(fileRootModel, "all", "/workspace/project/src/main.ts", "read").allowed, true);
  const noLocalOnly = { ...DEFAULT_PERMISSION_MODEL, local_only: false, rules: [{ id: "unc-read", member: "all", effect: "allow" as const,
    path_prefix: "\\\\server\\share", reads: true }] };
  assert.equal(decidePermission(noLocalOnly, "all", "\\\\server\\share\\src\\main.ts", "read").allowed, true);
  const malformedFileUrl = { ...DEFAULT_PERMISSION_MODEL, local_only: false, rules: [{ id: "file-read", member: "all", effect: "allow" as const,
    path_prefix: "/workspace/project", reads: true }] };
  assert.equal(decidePermission(malformedFileUrl, "all", "file://%invalid", "read").allowed, false);
  assert.equal(decidePermission(DEFAULT_PERMISSION_MODEL, "all", "//server/share/private.txt", "read").allowed, false);
  assert.equal(decidePermission(DEFAULT_PERMISSION_MODEL, "all", "\\\\server\\share\\private.txt", "read").allowed, false);
  const localOnlyAllowByDefault = { ...DEFAULT_PERMISSION_MODEL, default_effect: "allow" as const, rules: [] };
  assert.equal(decidePermission(localOnlyAllowByDefault, "all", "file://server/share/private.txt", "read").allowed, false,
    "file URLs that resolve to UNC shares are remote surfaces");
});

test("explicit remote policy still uses default deny and explicit rules use default reasons", () => {
  const remoteAllowedModel = { ...DEFAULT_PERMISSION_MODEL, local_only: false, default_effect: "allow" as const, rules: [] };
  assert.deepEqual(decidePermission(remoteAllowedModel, "all", "https://example.com/read", "read"),
    { allowed: true, rule_id: null, reason: "no matching rule" });
  const noReasonModel = { ...DEFAULT_PERMISSION_MODEL, rules: [{ id: "no-reason", member: "all", effect: "allow" as const,
    path_prefix: "/workspace/project", writes: true }] };
  assert.deepEqual(decidePermission(noReasonModel, "all", "/workspace/project/a.ts", "write"),
    { allowed: true, rule_id: "no-reason", reason: "allowed by rule" });
  const operationMismatch = { ...DEFAULT_PERMISSION_MODEL, rules: [{ id: "write-only", member: "all", effect: "allow" as const,
    path_prefix: "/workspace/project", writes: true }] };
  assert.equal(decidePermission(operationMismatch, "all", "/workspace/project/a.ts", "read").allowed, false);
  const noDenyReason = { ...DEFAULT_PERMISSION_MODEL, rules: [{ id: "deny", member: "all", effect: "deny" as const,
    path_prefix: "/workspace/project", writes: true }] };
  assert.deepEqual(decidePermission(noDenyReason, "all", "/workspace/project/a.ts", "write"),
    { allowed: false, rule_id: "deny", reason: "denied by rule" });
});

test("default model grants no path access without runtime-provided roots", () => {
  assert.equal(decidePermission(DEFAULT_PERMISSION_MODEL, "all", "/workspace/project/a.ts", "read").allowed, false);
  assert.equal(decidePermission(DEFAULT_PERMISSION_MODEL, "all", "/workspace/project/a.ts", "write").allowed, false);
});

test("a pathless allow rule does not grant access", () => {
  const model = { ...DEFAULT_PERMISSION_MODEL, rules: [{ id: "unsafe", member: "all", effect: "allow" as const, writes: true }] };
  assert.equal(decidePermission(model, "all", "/workspace/project/a.ts", "write").allowed, false);
  const whitespaceRoot = { ...DEFAULT_PERMISSION_MODEL, rules: [{ id: "empty-root", member: "all", effect: "allow" as const,
    path_prefix: " ", writes: true }] };
  assert.equal(decidePermission(whitespaceRoot, "all", "/workspace/project/a.ts", "write").allowed, false);
  const globalDeny = { ...DEFAULT_PERMISSION_MODEL, rules: [{ id: "global-deny", member: "all", effect: "deny" as const,
    path_prefix: " ", writes: true }] };
  assert.deepEqual(decidePermission(globalDeny, "all", "/workspace/project/a.ts", "write"),
    { allowed: false, rule_id: "global-deny", reason: "denied by rule" });
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

test("unknown member write falls back to default deny", () => {
  const decision = decidePermission(DEFAULT_PERMISSION_MODEL, "unknown", "src/example.ts", "write");
  assert.equal(decision.allowed, false);
  assert.equal(decision.rule_id, null);
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

  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.deepEqual(rejectsCredentials(cyclic), { rejected: true, reason: "payload cannot be safely serialized" });
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

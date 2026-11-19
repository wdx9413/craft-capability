import assert from "node:assert/strict";
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";
import {
  CRAFT_NOTES_LOCATION_USE_THRESHOLD,
  CraftNotesLocationRegistry,
  canonicalizeNotePath,
  notePathSeed,
  type CraftNotesLocationRecord,
} from "../craft-notes-location.ts";
import { openStore } from "./store.ts";

type Json = Record<string, unknown>;

async function fixture() {
  const opened = await openStore("craft-notes-location-");
  const registry = new CraftNotesLocationRegistry(opened.store);
  registry.registerDevice({ id: "local", name: "Local", device_kind: "local", host_kind: "local", device_note: "本地设备" });
  return { ...opened, registry };
}

const results = (value: unknown): CraftNotesLocationRecord[] => (value as Json).results as CraftNotesLocationRecord[];
const items = (value: unknown): CraftNotesLocationRecord[] => (value as Json).items as CraftNotesLocationRecord[];
const record = (value: unknown): CraftNotesLocationRecord => value as CraftNotesLocationRecord;

test("recording a directory observes it until repeated use promotes it", async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "billing");
    const first = record(f.registry.record({ path, description: "billing service root" }));
    assert.equal(first.useCount, 1);
    assert.equal(first.status, "observed");
    assert.equal(first.hostKind, "local");
    const windows = record(f.registry.record({ path: "C:/projects/archive/../ledger", description: "ledger service" }));
    assert.equal(windows.path, "C:\\projects\\ledger");
    assert.equal(results(f.registry.resolve({ path: "C:\\projects\\ledger" }))[0]?.id, windows.id);
    const unc = record(f.registry.record({ path: "\\\\build-host\\share\\repo", description: "remote build" }));
    assert.equal(unc.path, "\\\\build-host\\share\\repo");
    for (let use = 2; use < CRAFT_NOTES_LOCATION_USE_THRESHOLD; use += 1) {
      const next = record(f.registry.record({ path, description: "billing service root" }));
      assert.equal(next.useCount, use);
      assert.equal(next.status, "observed");
    }
    const promoted = record(f.registry.record({ path, description: "billing service root" }));
    assert.equal(promoted.useCount, CRAFT_NOTES_LOCATION_USE_THRESHOLD);
    assert.equal(promoted.status, "promoted");
    const other = record(f.registry.record({ path: join(f.root, "ledger"), description: "ledger service" }));
    assert.equal(other.status, "observed");
  } finally {
    await f.close();
  }
});

test("device metadata registration, filtering, health and disable rules", async () => {
  const f = await fixture();
  try {
    const device = f.registry.registerDevice({
      id: "edge-01", name: "Edge node", device_kind: "container", host_kind: "cloud",
      location: "eu-west", tags: ["ci", "build", "ci"], health: "degraded", device_note: "欧洲构建节点",
    });
    assert.equal(device.deviceKind, "container");
    assert.equal(device.hostKind, "cloud");
    assert.deepEqual(device.tags, ["ci", "build", "ci"]);
    assert.equal(device.health, "degraded");
    assert.equal(f.registry.device("edge-01")!.id, "edge-01");
    assert.equal(f.registry.device("missing"), null);
    const auto = f.registry.registerDevice({ device_note: "自动编号设备" });
    assert.match(auto.id, /^device_/u);
    assert.equal(auto.name, null);
    assert.equal(auto.location, null);
    assert.equal(auto.lastSeenAt, null);
    const filtered = items(f.registry.listDevices({ device_kind: "container", host_kind: "cloud", status: "active" }));
    assert.equal(filtered.length, 1);
    assert.equal(items(f.registry.listDevices({ device_kind: null, host_kind: null, status: null })).length >= 3, true);
    assert.equal(items(f.registry.listDevices({ status: "disabled" })).length, 0);
    const healthy = f.registry.reportDeviceHealth("edge-01", "healthy");
    assert.equal(healthy.health, "healthy");
    assert.throws(() => f.registry.reportDeviceHealth("missing", "healthy"), /Unknown device/u);
    const disabled = f.registry.disableDevice("edge-01");
    assert.equal(disabled.status, "disabled");
    assert.equal(disabled.health, "offline");
    assert.equal(f.registry.enableDevice("edge-01").status, "active");
    assert.throws(() => f.registry.disableDevice("missing"), /Unknown device/u);
    assert.throws(() => f.registry.registerDevice({ id: "bad id", device_note: "x" }), /device_id/u);
    assert.throws(() => f.registry.registerDevice({ id: "no-note" } as never), /device_note is required/u);
    assert.throws(() => f.registry.registerDevice({ id: "blank", device_note: "   " }), /device_note is required/u);
  } finally {
    await f.close();
  }
});

test("reactivation requires a confirmed device note and disabled devices gain no places", async () => {
  const f = await fixture();
  try {
    f.registry.registerDevice({ id: "edge-02", device_kind: "ssh", host_kind: "cloud", device_note: "远程构建节点" });
    f.registry.disableDevice("edge-02");
    assert.throws(() => f.registry.registerDevice({ id: "edge-02", status: "active", device_note: "" }), /reactivated/u);
    assert.throws(() => f.registry.record({ path: "/srv/app", description: "app", device_id: "edge-02" }), /not active/u);
    f.registry.notes.revoke({ id: f.store.list("craft_note", 10, r => r.subject_key === "edge-02")[0]!.id as string,
      expected_version: Number(f.store.list("craft_note", 10, r => r.subject_key === "edge-02")[0]!.version), revoked_by: "u", reason: "r" });
    assert.throws(() => f.registry.enableDevice("edge-02"), /confirmed Device Note/u);
  } finally {
    await f.close();
  }
});

test("path canonicalization keeps one place for equivalent spellings", async () => {
  const f = await fixture();
  try {
    const one = record(f.registry.record({ path: "/opt/codex", description: "codex cli", concept_kind: "rule", rationale: "CLI entry point" }));
    assert.equal(one.concept_kind, "rule");
    assert.equal(one.rationale, "CLI entry point");
    const two = record(f.registry.observe({ path: "/opt/codex/", description: "later title" }));
    assert.equal(two.description, "codex cli");
    assert.equal(two.concept_kind, "rule");
    const canonical = canonicalizeNotePath("/opt/codex/");
    assert.equal(canonical, canonicalizeNotePath("/opt/codex"));
    assert.equal(canonical.endsWith("/"), false);
    assert.throws(() => canonicalizeNotePath("  "), /non-empty/u);
    assert.throws(() => canonicalizeNotePath("relative"), /absolute path/u);
    assert.equal(canonicalizeNotePath("C:\\work\\app\\"), "C:\\work\\app");
  } finally {
    await f.close();
  }
});

test("explicit promote, resolve by description and reverse lookup", async () => {
  const f = await fixture();
  try {
    f.registry.record({ path: "C:\\tmp\\noise", description: "billing service root" });
    assert.equal(results(f.registry.resolve({ description: "billing service" })).length, 0);
    const promoted = record(f.registry.record({ path: "C:\\projects\\billing", description: "billing service root" }));
    const forced = record(f.registry.promote({ id: promoted.id }));
    assert.equal(forced.status, "promoted");
    const byDescription = f.registry.resolve({ description: "billing service" });
    assert.equal((byDescription as Json).kind, "by_description");
    assert.equal(results(byDescription).length, 1);
    assert.equal(results(byDescription)[0]!.path, "C:\\projects\\billing");
    const byPath = f.registry.resolve({ path: "C:\\projects\\billing" });
    assert.equal((byPath as Json).kind, "by_path");
    assert.equal(results(byPath)[0]!.description, "billing service root");
    assert.equal(results(f.registry.resolve({ description: "nonexistent concept" })).length, 0);
    assert.throws(() => f.registry.resolve({}), /requires description or path/u);
    assert.throws(() => f.registry.promote({ id: "missing" }), /Unknown craft_notes_location/u);
    assert.equal(record(f.registry.promote({ id: promoted.id, concept_kind: "term", rationale: "promoted" })).concept_kind, "term");
  } finally {
    await f.close();
  }
});

test("input validation rejects malformed paths, hosts and device identities", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.registry.record({ path: "relative/path", description: "x" }), /absolute path/u);
    assert.throws(() => f.registry.record({ path: "C:relative/path", description: "x" }), /absolute path/u);
    assert.throws(() => f.registry.record({ path: "C:\\x", description: "" }), /non-empty string/u);
    assert.throws(() => f.registry.record({ path: "C:\\x", description: "x", host_kind: "mars" }), /local or cloud/u);
    assert.throws(() => f.registry.record({ path: "C:\\x", description: "x", device_id: "Bad Device!" }), /device_id/u);
    assert.throws(() => f.registry.record({ path: "C:\\x", description: "x", device_kind: "toaster" }), /device_kind/u);
    assert.throws(() => f.registry.record({ path: "C:\\x", description: "x".repeat(501) }), /500 characters/u);
    assert.throws(() => f.registry.record({ path: "C:\\x", description: "x", repo_identity: [] }), /must be an object/u);
    assert.equal(record(f.registry.record({ path: "C:\\x", description: "x", repo_identity: { remote_url: "" } })).repoIdentity, null);
    assert.throws(() => f.registry.record({ path: "C:\\x", description: "x", repo_identity: { remote_url: "https://user:pass@github.com/a/b" } }), /credentials/u);
    assert.throws(() => f.registry.record({ path: "C:\\x", description: "x", repo_identity: { remote_url: `https://github.com/${"a".repeat(500)}` } }), /500 characters/u);
    assert.throws(() => f.registry.record({ path: "C:\\x", description: "x", repo_identity: { remote_url: "https://github.com/a/b", commit: "xyz" } }), /hexadecimal/u);
    assert.throws(() => f.registry.list({ limit: 0 }), /limit must be an integer/u);
    assert.throws(() => f.registry.list({ limit: 1001 }), /limit must be an integer/u);
    assert.throws(() => f.registry.listDevices({ device_kind: "toaster" }), /device_kind/u);
    assert.throws(() => f.registry.listDevices({ host_kind: "mars" }), /local or cloud/u);
    assert.throws(() => f.registry.listDevices({ status: "paused" as never }), /active or disabled/u);
    assert.equal(f.registry.registerDevice({ id: "tags", device_note: "x", tags: [""] }).tags.length, 1);
    assert.throws(() => f.registry.listDevices({ device_kind: "toaster" }), /device_kind/u);
    assert.throws(() => f.registry.registerDevice({ id: "health", device_note: "x", health: "sick" as never }), /healthy, degraded or offline/u);
    assert.equal(f.registry.registerDevice({ id: "status", device_note: "x", status: "paused" as never }).status, "active");
  } finally {
    await f.close();
  }
});

test("cloud host entries are listed separately with limits", async () => {
  const f = await fixture();
  try {
    const cloud = record(f.registry.record({ path: "/cloud/vm1", description: "cloud build vm", host_kind: "cloud" }));
    assert.equal(cloud.hostKind, "cloud");
    f.registry.promote({ id: cloud.id });
    assert.equal(items(f.registry.list({ host_kind: "cloud" })).length, 1);
    assert.equal(items(f.registry.list({ host_kind: "local" })).length, 0);
    assert.equal(items(f.registry.list({ host_kind: "cloud", limit: 1 })).length, 1);
    assert.equal(items(f.registry.list({ host_kind: "cloud", limit: null })).length, 1);
    assert.equal(items(f.registry.list({ status: "promoted", device_id: "local" })).length, 1);
    assert.equal(items(f.registry.list({ status: "observed" })).length, 0);
    assert.equal(items(f.registry.list()).length, 1);
  } finally {
    await f.close();
  }
});

test("observe reinforces use without rewriting meaning and promotes after real usage", async () => {
  const f = await fixture();
  try {
    const path = "C:\\projects\\billing";
    f.registry.observe({ path, description: "billing service root" });
    const second = record(f.registry.observe({ path, description: "a later task title" }));
    assert.equal(second.description, "billing service root");
    assert.equal(second.useCount, 2);
    const third = record(f.registry.observe({ path }));
    assert.equal(third.status, "promoted");
    assert.equal(results(f.registry.resolve({ description: "billing service" })).length, 1);
    const seed = record(f.registry.observe({ path: "/opt/nameless" }));
    assert.equal(seed.description, "nameless");
    const seeded = record(f.registry.observe({ path: "/opt/with-description", description: "described" }));
    assert.equal(seeded.description, "described");
  } finally {
    await f.close();
  }
});

test("withdrawal stops recall, survives later use and needs an explicit promote", async () => {
  const f = await fixture();
  try {
    const rec = record(f.registry.observe({ path: "C:\\projects\\old", description: "legacy billing service" }));
    f.registry.promote({ id: rec.id });
    assert.equal(results(f.registry.resolve({ description: "billing service" })).length, 1);
    const revoked = record(f.registry.revoke({ id: rec.id, revoked_by: "user:alex", reason: "project moved" }));
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revokedBy, "user:alex");
    assert.equal(results(f.registry.resolve({ description: "billing service" })).length, 0);
    assert.equal(record(f.registry.observe({ path: "C:\\projects\\old" })).status, "revoked");
    assert.equal(items(f.registry.list({ status: "revoked" })).length, 1);
    assert.throws(() => f.registry.revoke({ id: rec.id, revoked_by: "user:alex", reason: "" }), /reason must be a non-empty string/u);
    assert.throws(() => f.registry.revoke({ id: rec.id, revoked_by: "", reason: "x" }), /must name the operator/u);
    assert.throws(() => f.registry.revoke({ id: rec.id, revoked_by: "a\nb", reason: "x" }), /single line/u);
    assert.throws(() => f.registry.revoke({ id: rec.id, revoked_by: "a".repeat(121), reason: "x" }), /single line/u);
    assert.throws(() => f.registry.revoke({ id: "missing", revoked_by: "u", reason: "r" }), /Unknown craft_notes_location/u);
    assert.equal(record(f.registry.promote({ id: rec.id })).status, "promoted");
    assert.equal(record(f.registry.revoke({ id: rec.id, revoked_by: "u", reason: "r", concept_kind: "term", rationale: "why" })).concept_kind, "term");
  } finally {
    await f.close();
  }
});

test("relocation keeps identity and use and refuses conflicts or cross-device moves", async () => {
  const f = await fixture();
  try {
    const rec = record(f.registry.observe({ path: "C:\\projects\\billing", description: "billing service root" }));
    f.registry.observe({ id: rec.id, path: "C:\\projects\\billing" });
    const moved = record(f.registry.relocate({ id: rec.id, path: "D:\\work\\billing" }));
    assert.equal(moved.path, "D:\\work\\billing");
    assert.equal(moved.useCount, 2);
    assert.equal(results(f.registry.resolve({ path: "C:\\projects\\billing" })).length, 0);
    const other = record(f.registry.observe({ path: "C:\\projects\\ledger", description: "ledger service" }));
    assert.throws(() => f.registry.relocate({ id: other.id, path: "D:\\work\\billing" }), /already describes/u);
    assert.throws(() => f.registry.relocate({ id: other.id, path: "D:\\work\\billing", device_id: "build-01" }), /another device/u);
    assert.throws(() => f.registry.relocate({ id: "missing", path: "D:\\x" }), /Unknown craft_notes_location/u);
    assert.throws(() => f.registry.relocate({ id: rec.id, path: "relative" }), /absolute path/u);
    const same = record(f.registry.relocate({ id: rec.id, path: "D:\\work\\billing", device_id: "local" }));
    assert.equal(same.path, "D:\\work\\billing");
  } finally {
    await f.close();
  }
});

test("two devices with one path are two places and recall stays device-scoped", async () => {
  const f = await fixture();
  try {
    f.registry.registerDevice({ id: "laptop", name: "Laptop", device_kind: "local", host_kind: "local", device_note: "主力开发机" });
    f.registry.registerDevice({ id: "build-01", name: "Build", device_kind: "ssh", host_kind: "cloud", location: "us-east", device_note: "远程构建机" });
    const laptop = record(f.registry.record({ path: "C:\\work\\billing", description: "billing checkout", device_id: "laptop", device_kind: "local", promote: true }));
    const server = record(f.registry.record({ path: "C:\\work\\billing", description: "billing checkout", device_id: "build-01", device_kind: "ssh", promote: true }));
    assert.notEqual(laptop.id, server.id);
    assert.equal(laptop.deviceId, "laptop");
    assert.equal(server.deviceKind, "ssh");
    assert.equal(results(f.registry.resolve({ path: "C:\\work\\billing" })).length, 2);
    assert.deepEqual(results(f.registry.resolve({ path: "C:\\work\\billing", device_id: "laptop" })).map(item => item.deviceId), ["laptop"]);
    assert.deepEqual(results(f.registry.resolve({ description: "billing", device_id: "build-01" })).map(item => item.deviceId), ["build-01"]);
    assert.deepEqual(items(f.registry.list({ device_id: "build-01" })).map(item => item.deviceId), ["build-01"]);
    assert.equal(results(f.registry.resolve({ description: "billing", limit: 1 })).length, 1);
  } finally {
    await f.close();
  }
});

test("repository identity unifies checkouts across devices and never stores credentials", async () => {
  const f = await fixture();
  try {
    const repo = { remote_url: "https://github.com/acme/billing.git", commit: "abc1234" };
    f.registry.registerDevice({ id: "laptop", device_kind: "local", host_kind: "local", device_note: "主力开发机" });
    f.registry.registerDevice({ id: "build-01", device_kind: "ssh", host_kind: "cloud", location: "us-east", device_note: "远程构建机" });
    f.registry.record({ path: "C:\\work\\billing", description: "billing monorepo", device_id: "laptop", repo_identity: repo, promote: true });
    f.registry.record({ path: "/srv/billing", description: "billing monorepo", device_id: "build-01", repo_identity: repo, promote: true });
    const recalled = results(f.registry.resolve({ description: "billing", repo_identity: { remote_url: "https://github.com/acme/billing" } }));
    assert.deepEqual(recalled.map(item => item.deviceId).sort(), ["build-01", "laptop"]);
    assert.equal(recalled[0]!.repoIdentity!.remoteUrl, repo.remote_url);
    assert.equal(recalled[0]!.repoIdentity!.commit, "abc1234");
    assert.throws(() => f.registry.record({ path: "C:\\work\\x", description: "x", repo_identity: { remote_url: "https://user:pass@github.com/acme/x.git" } }), /credentials/u);
    const emptyRepo = record(f.registry.record({ path: "C:\\work\\y", description: "y", repo_identity: { remote_url: "" } }));
    assert.equal(emptyRepo.repoIdentity, null);
  } finally {
    await f.close();
  }
});

test("legacy location rows migrate once without losing identity or audit fields", async () => {
  const f = await openStore("craft-notes-legacy-");
  try {
    const legacy = {
      id: "legacy-location", device_id: "local", path: "/work/billing", description: "billing service",
      status: "promoted", use_count: 4, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
      revoked_by: null, revoked_reason: null,
    };
    f.store.save("file_dir_desc", legacy.id, legacy);
    const source = f.store.find("file_dir_desc", legacy.id);
    new CraftNotesLocationRegistry(f.store);
    const migrated = f.store.find("craft_notes_location", legacy.id)!;
    for (const field of ["id", "device_id", "path", "description", "status", "use_count", "revoked_by", "revoked_reason"]) {
      assert.deepEqual(migrated[field], source![field], field);
    }
    const firstCopy = f.store.find("craft_notes_location", legacy.id);
    new CraftNotesLocationRegistry(f.store);
    assert.deepEqual(f.store.find("craft_notes_location", legacy.id), firstCopy);
  } finally {
    await f.close();
  }
});

test("sparse stored rows read back with stable defaults", async () => {
  const f = await fixture();
  try {
    f.store.save("craft_notes_location", "sparse", {
      id: "sparse", path: "/work/sparse", description: "sparse",
    });
    const item = items(f.registry.list()).find(entry => entry.id === "sparse")!;
    assert.equal(item.deviceId, "local");
    assert.equal(item.deviceKind, "local");
    assert.equal(item.hostKind, "local");
    assert.equal(item.repoIdentity, null);
    assert.equal(item.useCount, 0);
    assert.equal(item.status, "observed");
    assert.equal(item.lastUsedAt, null);
    assert.equal(item.revokedBy, null);
    assert.equal(item.revokedReason, null);
    assert.equal(item.concept_kind, null);
    assert.equal(item.rationale, null);
    f.store.save("craft_notes_location", "legacy", {
      id: "legacy", device_id: "ghost", path: "/work/legacy", description: "legacy", status: "revoked",
      repo_identity: {}, use_count: 2, revoked_by: "u", revoked_reason: "r", concept_kind: "term", rationale: "why",
    });
    const legacy = items(f.registry.list({ status: "revoked" })).find(entry => entry.id === "legacy")!;
    assert.equal(legacy.status, "revoked");
    assert.equal(legacy.revokedBy, "u");
    assert.equal(legacy.revokedReason, "r");
    assert.equal(legacy.concept_kind, "term");
    assert.equal(legacy.rationale, "why");
    assert.equal(legacy.repoIdentity, null);
    assert.equal(results(f.registry.resolve({ description: "legacy" })).length, 0);
  } finally {
    await f.close();
  }
});

test("term matching requires every query word and ignores empty queries", async () => {
  const f = await fixture();
  try {
    const entry = record(f.registry.record({ path: "/opt/billing", description: "Billing Service Root", promote: true }));
    assert.equal(results(f.registry.resolve({ description: "billing service" }))[0]?.id, entry.id);
    assert.equal(results(f.registry.resolve({ description: "billing missing" })).length, 0);
    assert.throws(() => f.registry.resolve({ description: "   " }), /non-empty/u);
    assert.equal(results(f.registry.resolve({ description: "BILLING" })).length, 1);
  } finally {
    await f.close();
  }
});

test("implicit local device stays recallable without an explicit device row", async () => {
  const opened = await openStore("craft-notes-implicit-");
  try {
    const registry = new CraftNotesLocationRegistry(opened.store);
    const rec = record(registry.record({ path: join(opened.root, "project"), description: "local project" }));
    registry.promote({ id: rec.id });
    assert.equal(results(registry.resolve({ description: "local project" })).length, 1);
    assert.equal(registry.device("local"), null);
  } finally {
    await opened.close();
  }
});

test("sparse location rows and non-object repo identities take documented fallbacks", async () => {
  const f = await fixture();
  try {
    f.store.save("craft_notes_location", "legacy-array-repo", {
      id: "legacy-array-repo", device_id: "local", path: "/work/array", description: "array repo",
      status: "promoted", repo_identity: [], use_count: 1,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    });
    const entry = items(f.registry.list()).find(item => item.id === "legacy-array-repo")!;
    assert.equal(entry.repoIdentity, null);
    f.store.save("craft_notes_location", "legacy-null-fields", {
      id: "legacy-null-fields", device_id: "local", path: "/work/null", description: "null fields",
      status: "observed", repo_identity: { remote_url: "https://example.com/a" }, use_count: 0,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    });
    const sparse = items(f.registry.list()).find(item => item.id === "legacy-null-fields")!;
    assert.equal(sparse.lastUsedAt, null);
    assert.equal(sparse.revokedBy, null);
    assert.equal(sparse.revokedReason, null);
    f.store.save("craft_notes_location", "legacy-invalid-kind", {
      id: "legacy-invalid-kind", device_id: "local", device_kind: "toaster", path: "/work/kind", description: "kind",
      status: "unknown", repo_identity: null, use_count: 1,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    });
    const invalid = items(f.registry.list()).find(item => item.id === "legacy-invalid-kind")!;
    assert.equal(invalid.deviceKind, "local");
    assert.equal(invalid.status, "observed");
  } finally {
    await f.close();
  }
});

test("device metadata fallbacks cover unknown kinds, sparse payloads and repo-less resolve", async () => {
  const f = await fixture();
  try {
    f.store.save("device", "sparse-device", { id: "sparse-device" });
    const sparse = f.registry.device("sparse-device")!;
    assert.equal(sparse.name, null);
    assert.equal(sparse.deviceKind, "local");
    assert.equal(sparse.hostKind, "local");
    assert.equal(sparse.location, null);
    assert.deepEqual(sparse.tags, []);
    assert.equal(sparse.health, "healthy");
    assert.equal(sparse.lastSeenAt, null);
    assert.equal(sparse.status, "active");
    f.store.save("device", "weird-device", {
      id: "weird-device", device_kind: "toaster", host_kind: "cloud", name: "Weird", location: "nowhere",
      tags: "not-an-array", health: "degraded", status: "disabled", created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z", last_seen_at: "2026-01-02T00:00:00.000Z",
    });
    const weird = f.registry.device("weird-device")!;
    assert.equal(weird.deviceKind, "local");
    assert.equal(weird.hostKind, "cloud");
    assert.deepEqual(weird.tags, []);
    assert.equal(weird.status, "disabled");
    assert.throws(() => f.registry.record({ path: "/work/disabled", description: "x", device_id: "weird-device" }), /not active/u);
    const itemsList = items(f.registry.listDevices());
    assert.equal(itemsList.some(item => item.id === "weird-device"), true);
    const sorted = items(f.registry.listDevices()).map(item => item.id);
    assert.equal(sorted.includes("weird-device"), true);
    f.registry.record({ path: "/work/no-repo", description: "no repo", promote: true });
    assert.equal(results(f.registry.resolve({ description: "no repo", repo_identity: { remote_url: "https://example.com/missing" } })).length, 0);
    assert.equal(results(f.registry.resolve({ path: "/work/no-repo", repo_identity: { remote_url: "https://example.com/missing" } })).length, 1);
    f.store.save("craft_notes_location", "legacy-non-object-repo", {
      id: "legacy-non-object-repo", device_id: "local", path: "/work/non-object", description: "non object",
      status: "promoted", repo_identity: "string", use_count: 2,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(items(f.registry.list()).find(item => item.id === "legacy-non-object-repo")!.repoIdentity, null);
  } finally {
    await f.close();
  }
});

test("sparse existing rows exercise every device and counter default", async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "sparse-existing");
    f.store.save("craft_notes_location", "sparse-existing", { id: "sparse-existing", path, description: "sparse existing" });
    assert.equal(record(f.registry.record({ path, description: "recorded" })).status, "observed");
    const observed = record(f.registry.observe({ path, description: "observed", concept_kind: null, rationale: null }));
    assert.equal(observed.useCount, 2);
    assert.equal(observed.status, "observed");
    const revokedPath = join(f.root, "sparse-revoked");
    f.store.save("craft_notes_location", "sparse-revoked", { id: "sparse-revoked", path: revokedPath, status: "revoked" });
    assert.equal(record(f.registry.record({ path: revokedPath, description: "again" })).status, "revoked");
    f.store.save("craft_notes_location", "sparse-relocate", { id: "sparse-relocate", path: join(f.root, "sparse-relocate") });
    assert.equal(record(f.registry.relocate({ id: "sparse-relocate", path: join(f.root, "relocated") })).deviceId, "local");
    const rootSeed = record(f.registry.observe({ path: "D:\\" }));
    assert.equal(rootSeed.description, "D:\\");
    assert.throws(() => f.registry.record({ path: "/work/number-device", description: "x", device_id: 42 as never }), /device_id must be a string/u);
    assert.throws(() => f.registry.record({ path: 42 as never, description: "x" }), /path must be a non-empty string/u);
    assert.throws(() => f.registry.record({ path: "", description: "x" }), /path must be a non-empty string/u);
    assert.throws(() => f.registry.record({ path: "/work/blank-repo", description: "x", repo_identity: { remote_url: "   " } }), /non-empty string/u);
    const blankPath = join(f.root, "blank-repo");
    f.store.save("craft_notes_location", "blank-repo", {
      id: "blank-repo", device_id: "local", path: blankPath, description: "blank",
      status: "promoted", repo_identity: { remote_url: "   " }, use_count: 1,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(items(f.registry.list()).find(item => item.id === "blank-repo")!.repoIdentity, null);
    assert.equal(results(f.registry.resolve({ path: blankPath, device_id: "local" })).length, 1);
    assert.equal(results(f.registry.resolve({ description: "blank", repo_identity: { remote_url: "https://example.com/x" } })).length, 0);
    assert.equal(items(f.registry.list({ device_id: "local" })).some(item => item.id === "sparse-existing"), true);
  } finally {
    await f.close();
  }
});

test("device sorting covers newer and older timestamps", async () => {
  const f = await fixture();
  try {
    f.store.save("device", "older", {
      id: "older", device_note: "older", updated_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z",
    });
    f.store.save("device", "newer", {
      id: "newer", device_note: "newer", updated_at: "2026-02-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z",
    });
    const ids = items(f.registry.listDevices()).map(item => item.id);
    assert.equal(ids.indexOf("newer") < ids.indexOf("older"), false);
    assert.equal(ids.indexOf("older") < ids.indexOf("newer"), true);
  } finally {
    await f.close();
  }
});

test("place listing sorts by use count and recency", async () => {
  const f = await fixture();
  try {
    f.store.save("craft_notes_location", "low", {
      id: "low", device_id: "local", path: "/work/low", description: "low", status: "observed", use_count: 1,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    });
    f.store.save("craft_notes_location", "high-old", {
      id: "high-old", device_id: "local", path: "/work/high-old", description: "high old", status: "observed", use_count: 5,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    });
    f.store.save("craft_notes_location", "high-new", {
      id: "high-new", device_id: "local", path: "/work/high-new", description: "high new", status: "observed", use_count: 5,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-02-01T00:00:00.000Z",
    });
    const ids = items(f.registry.list()).map(item => item.id);
    assert.equal(ids[0], "high-new");
    assert.equal(ids.indexOf("high-old") < ids.indexOf("low"), true);
  } finally {
    await f.close();
  }
});

test("observation and resolve defaults cover sparse and revoked paths", async () => {
  const f = await fixture();
  try {
    f.store.save("craft_notes_location", "no-use", { id: "no-use", path: "/work/no-use", description: "no use" });
    const observed = record(f.registry.observe({ path: "/work/no-use", description: "observed", concept_kind: "term", rationale: "why" }));
    assert.equal(observed.useCount, 1);
    f.store.save("craft_notes_location", "seed-repo", { id: "seed-repo", path: "/work/seed-repo" });
    const seeded = record(f.registry.observe({ path: "/work/seed-repo", repo_identity: { remote_url: "https://example.com/a.git" } }));
    assert.equal(seeded.repoIdentity!.remoteUrl, "https://example.com/a.git");
    f.store.save("craft_notes_location", "revoked-local", {
      id: "revoked-local", device_id: "local", path: "/work/revoked-local", description: "revoked local",
      status: "promoted", use_count: 9, updated_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z",
    });
    f.registry.revoke({ id: "revoked-local", revoked_by: "u", reason: "r" });
    assert.equal(results(f.registry.resolve({ path: "/work/revoked-local" })).length, 0);
    f.registry.disableDevice("local");
    assert.equal(results(f.registry.resolve({ path: "/work/revoked-local" })).length, 0);
    f.registry.enableDevice("local");
    f.registry.disableDevice("local");
    assert.equal(results(f.registry.resolve({ path: "/work/revoked-local", device_id: "local" })).length, 0);
    f.registry.enableDevice("local");
    f.store.save("craft_notes_location", "equal-use-a", {
      id: "equal-use-a", device_id: "local", path: "/work/equal-a", description: "equal", status: "promoted", use_count: 9,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    });
    const equalUse = record(f.registry.record({ path: "/work/equal-use", description: "equal", promote: true }));
    f.store.save("craft_notes_location", "equal-use-b", {
      id: "equal-use-b", device_id: "local", path: "/work/equal-b", description: "equal", status: "promoted", use_count: 9,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
    });
    const equalIds = items(f.registry.list()).filter(item => item.useCount === 9).map(item => item.id);
    assert.equal(equalIds.length >= 2, true);
    assert.equal(items(f.registry.list()).some(item => item.id === equalUse.id), true);
  } finally {
    await f.close();
  }
});

test("promote reports a vanished entry instead of returning a stale row", () => {
  const stored = { id: "entry", path: "/work/entry", description: "entry", status: "observed" };
  let lookups = 0;
  const store = {
    find: () => (lookups++ === 0 ? stored : null),
    save: () => stored,
    list: () => [],
  };
  const registry = new CraftNotesLocationRegistry(store as never);
  assert.throws(() => registry.promote({ id: "entry" }), /disappeared/u);
});

test("sparse rows drive every predicate default through a minimal store", () => {
  const base = resolvePath("/work");
  const at = (name: string) => join(base, name);
  const rows = new Map<string, Record<string, unknown>>();
  const saves: string[] = [];
  const store = {
    find: (kind: string, id: string) => kind === "device" ? null : rows.get(id) ?? null,
    save: (kind: string, id: string, payload: Record<string, unknown>) => {
      if (kind === "craft_notes_location") { rows.set(id, payload); saves.push(id); }
      return payload;
    },
    list: (kind: string, _limit: number, predicate?: (row: Record<string, unknown>) => boolean) => {
      if (kind !== "craft_notes_location") return [];
      const all = [...rows.values()];
      return predicate ? all.filter(row => predicate(row)) : all;
    },
  };
  const registry = new CraftNotesLocationRegistry(store as never);
  rows.set("sparse", { id: "sparse", path: at("sparse"), description: "sparse", status: "observed" });
  const recorded = record(registry.record({ path: at("sparse"), description: "sparse" }));
  assert.equal(recorded.useCount, 1);
  const revoked = record(registry.record({ path: at("sparse"), description: "sparse" }));
  assert.equal(revoked.useCount, 2);
  rows.set("revoked", { id: "revoked", path: at("revoked"), description: "revoked", status: "revoked" });
  assert.equal(record(registry.record({ path: at("revoked"), description: "still revoked" })).status, "revoked");
  const observed = record(registry.observe({ path: at("sparse"), description: "observed" }));
  assert.equal(observed.useCount, 3);
  const seeded = record(registry.observe({ path: at("seeded") }));
  assert.equal(seeded.description, "seeded");
  rows.set("relocatable", { id: "relocatable", path: at("relocatable"), description: "relocatable" });
  assert.equal(record(registry.relocate({ id: "relocatable", path: at("moved") })).deviceId, "local");
  rows.set("promoted-local", {
    id: "promoted-local", device_id: "local", path: at("promoted"), description: "promoted local",
    status: "promoted", use_count: 2, updated_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z",
  });
  rows.set("revoked-local", { id: "revoked-local", device_id: "local", path: at("revoked-local"), description: "revoked local", status: "revoked", use_count: 1 });
  assert.equal(results(registry.resolve({ description: "promoted local" })).length, 1);
  assert.equal(results(registry.resolve({ description: "revoked local" })).length, 0);
  assert.equal(results(registry.resolve({ path: at("promoted") })).length, 1);
  assert.equal(results(registry.resolve({ path: at("revoked-local") })).length, 1);
  rows.set("repo-empty", {
    id: "repo-empty", device_id: "local", path: at("repo-empty"), description: "repo empty",
    status: "promoted", repo_identity: {}, use_count: 1,
  });
  assert.equal(results(registry.resolve({ description: "repo empty", repo_identity: { remote_url: "https://example.com/none" } })).length, 0);
  rows.set("tie-old", { id: "tie-old", device_id: "local", path: at("tie-old"), description: "tie", status: "observed", use_count: 1, updated_at: "2026-01-01T00:00:00.000Z" });
  rows.set("tie-new", { id: "tie-new", device_id: "local", path: at("tie-new"), description: "tie", status: "observed", use_count: 1, updated_at: "2026-02-01T00:00:00.000Z" });
  rows.set("no-device", { id: "no-device", path: at("no-device"), description: "no device", status: "promoted", use_count: 1 });
  const observedNoDevice = record(registry.observe({ path: at("no-device"), description: "no device" }));
  assert.equal(observedNoDevice.useCount, 2);
  rows.set("no-use-count", { id: "no-use-count", path: at("no-use-count"), description: "no use count" });
  assert.equal(record(registry.observe({ path: at("no-use-count") })).useCount, 1);
  rows.set("no-device", { id: "no-device", path: at("no-device"), description: "no device", status: "promoted", use_count: 2 });
  assert.equal(results(registry.resolve({ description: "no device" })).length, 1);
  assert.equal(results(registry.resolve({ description: "no device", device_id: "local" })).length, 1);
  assert.equal(results(registry.resolve({ path: at("no-device"), device_id: "local" })).length, 1);
  assert.equal(results(registry.resolve({ path: at("no-device") })).length, 1);
  rows.set("conflict-target", { id: "conflict-target", path: at("conflict"), description: "conflict" });
  rows.set("conflict-source", { id: "conflict-source", path: at("conflict-source"), description: "conflict source" });
  assert.throws(() => registry.relocate({ id: "conflict-source", path: at("conflict") }), /already describes/u);
  const ordered = items(registry.list()).map(item => item.id);
  assert.equal(ordered.indexOf("tie-new") < ordered.indexOf("tie-old"), true);
  assert.equal(saves.length > 0, true);
});

test("device listing sorts older payloads after newer ones through a minimal store", () => {
  const devices = [
    { id: "old", updated_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" },
    { id: "new", updated_at: "2026-02-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" },
  ];
  const store = {
    find: () => null,
    save: () => ({}),
    list: (kind: string) => kind === "device" ? devices : [],
  };
  const registry = new CraftNotesLocationRegistry(store as never);
  assert.deepEqual(items(registry.listDevices()).map(item => item.id), ["old", "new"]);
});

test("path seed text falls back to the path for a filesystem root", () => {
  assert.equal(notePathSeed("/"), "/");
  assert.equal(notePathSeed("C:\\"), "C:\\");
  assert.equal(notePathSeed("/opt/codex"), "codex");
  assert.equal(notePathSeed("C:\\work\\app"), "app");
});

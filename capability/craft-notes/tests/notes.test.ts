import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { CraftNotesRegistry, noteSeedText } from "../craft-note-lifecycle.ts";
import { CraftNotesLocationRegistry } from "../craft-notes-location.ts";
import { openStore } from "./store.ts";

async function fixture(): Promise<Awaited<ReturnType<typeof openStore>> & { notes: CraftNotesRegistry }> {
  const opened = await openStore();
  const notes = new CraftNotesRegistry(opened.store);
  notes.createDevice({ id: "local", note: "本地开发设备" });
  return { ...opened, notes };
}

test("device notes reject missing text, credentials, bad ids and oversized values", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.notes.createDevice({ id: "laptop" }), /note must be a non-empty string/u);
    assert.throws(() => f.notes.createDevice({ id: "laptop", note: "api_key=abcdefgh" }), /credential/u);
    assert.throws(() => f.notes.createDevice({ id: "laptop", note: "sk-abcdefghijklmnopqrst" }), /credential/u);
    assert.throws(() => f.notes.createDevice({ id: "Bad ID", note: "设备" }), /device_id/u);
    assert.throws(() => f.notes.createDevice({ id: "laptop", note: "x".repeat(501) }), /500 characters/u);
    assert.throws(() => f.notes.createDevice({ id: "laptop", description: "" }), /note/u);
    assert.throws(() => f.notes.createDevice({ id: "laptop", note: "  " }), /note/u);
    const first = f.notes.createDevice({ id: "Laptop", description: "  主   力   设备  " });
    assert.equal(first.subject_key, "laptop");
    assert.equal(first.text, "主 力 设备");
    assert.equal(first.version, 1);
    assert.equal(first.verified_at !== null, true);
    const second = f.notes.createDevice({ id: "laptop", note: "更新后的设备" });
    assert.equal(second.id, first.id);
    assert.equal(second.version, 2);
    assert.equal(typeof second.created_at, "string");
  } finally {
    await f.close();
  }
});

test("disabled devices need a note before reactivation and keep their disabled status otherwise", async () => {
  const f = await fixture();
  try {
    const disabled = f.notes.createDevice({ id: "laptop", note: "停用设备", status: "disabled" });
    assert.equal(disabled.status, "confirmed");
    assert.equal(f.store.find("device", "laptop")!.status, "disabled");
    assert.throws(() => f.notes.createDevice({ id: "laptop", status: "active" }), /non-empty/u);
    assert.throws(() => f.notes.createDevice({ id: "laptop", note: "x", status: "active" }), /setDeviceStatus/u);
    const location = new CraftNotesLocationRegistry(f.store);
    const reactivated = location.setDeviceStatus("laptop", "active");
    assert.equal(reactivated.status, "active");
    assert.equal(f.store.find("device", "laptop")!.status, "active");
    f.notes.createDevice({ id: "laptop", note: "再次停用", status: "disabled" });
    const stillDisabled = f.notes.createDevice({ id: "laptop", note: "仍停用" });
    assert.equal(f.store.find("device", "laptop")!.status, "disabled");
    assert.equal(stillDisabled.version, Number(f.store.find("craft_note", stillDisabled.id)!.version));
    location.setDeviceStatus("laptop", "active");
    const enabled = f.notes.createDevice({ id: "laptop", note: "重新启用" });
    assert.equal(f.store.find("device", "laptop")!.status, "active");
    assert.equal(enabled.text, "重新启用");
  } finally {
    await f.close();
  }
});

test("custom note text validators run before persistence", async () => {
  const opened = await openStore();
  const seen: string[] = [];
  const notes = new CraftNotesRegistry(opened.store, value => {
    seen.push(value);
    if (value.includes("blocked")) throw new Error("blocked text");
  });
  try {
    assert.throws(() => notes.createDevice({ id: "local", note: "blocked device" }), /blocked text/u);
    assert.equal(opened.store.find("device", "local"), null);
    notes.createDevice({ id: "local", note: "allowed" });
    assert.equal(seen.at(-1), "allowed");
    assert.throws(() => notes.observeDirectory({ path: "/work/blocked", pin: true }), /blocked text/u);
  } finally {
    await opened.close();
  }
});

test("directory notes require an active device with a confirmed device note", async () => {
  const opened = await openStore();
  const notes = new CraftNotesRegistry(opened.store);
  try {
    assert.throws(() => notes.observeDirectory({ path: "/work/app", pin: true }), /active device/u);
    notes.createDevice({ id: "local", note: "设备" });
    const deviceNote = notes.resolve({ device_id: "local" }).items[0]!;
    const revoked = notes.revoke({ id: deviceNote.id, expected_version: deviceNote.version, revoked_by: "u", reason: "r" });
    assert.equal(revoked.status, "revoked");
    assert.throws(() => notes.observeDirectory({ path: "/work/app", pin: true }), /active device/u);
    assert.throws(() => notes.observeDirectory({ path: "relative/path", pin: true }), /absolute path/u);
    assert.throws(() => notes.observeDirectory({ path: "  ", pin: true }), /path must be/u);
    notes.createDevice({ id: "local", note: "恢复设备" });
    const windows = notes.observeDirectory({ path: "C:\\Work\\App\\", device_id: "local", pin: true });
    assert.equal((windows.note as { subject_key: string }).subject_key, "local:C:\\Work\\App\\");
    const unc = notes.observeDirectory({ path: "\\\\server\\share\\app\\", device_id: "local", pin: true });
    assert.equal((unc.note as { subject_key: string }).subject_key, "local:\\\\server\\share\\app\\");
  } finally {
    await opened.close();
  }
});

test("usage evidence gates candidate promotion and ignores revoked entries", async () => {
  const f = await fixture();
  try {
    const path = "/work/app";
    const first = f.notes.observeDirectory({ path, device_id: "local", task_id: "t1", session_id: "s1", outcome: "completed" });
    assert.equal(first.eligible, false);
    assert.equal(first.reason, "awaiting_async_qualification");
    assert.equal(first.session_count, 1);
    const pending = first.note as { id: string; version: number };
    assert.throws(() => f.notes.confirm({ id: pending.id, expected_version: pending.version }), /asynchronous qualification/u);
    assert.throws(() => f.notes.observeDirectory({ path, device_id: "local", task_id: "t2" }), /usage evidence/u);
    assert.throws(() => f.notes.observeDirectory({ path, device_id: "local", task_id: "t2", session_id: "s2", outcome: "failed" }), /usage evidence/u);
    f.notes.observeDirectory({ path, device_id: "local", task_id: "t2", session_id: "s1", outcome: "completed" });
    const third = f.notes.observeDirectory({ path, device_id: "local", task_id: "t3", session_id: "s2", outcome: "completed" });
    assert.equal(third.eligible, false);
    assert.equal(third.reason, "awaiting_async_qualification");
    const qualification = f.notes.qualifyCandidates();
    assert.equal(qualification.qualified, 1);
    assert.equal(qualification.items[0]!.status, "qualified");
    assert.equal("text" in qualification.items[0]!, false);
    const note = third.note as { id: string; status: string; version: number };
    assert.equal(note.status, "candidate");
    assert.equal(f.notes.candidateList({ device_id: "local" }).items.length, 1);
    assert.equal(f.notes.candidateList({ device_id: "other" }).items.length, 0);
    const reviewCandidate = f.notes.list({ status: "candidate" }).items.find(item => item.id === note.id)!;
    const confirmed = f.notes.confirm({ id: note.id, expected_version: reviewCandidate.version });
    assert.equal(confirmed.status, "confirmed");
    assert.throws(() => f.notes.confirm({ id: note.id, expected_version: note.version }), /stale Note/u);
    const confirmedAgain = f.notes.confirm({ id: note.id, expected_version: confirmed.version, note: "reviewed text" });
    assert.equal(confirmedAgain.text, "reviewed text");
    const revoked = f.notes.revoke({ id: note.id, expected_version: confirmedAgain.version, revoked_by: "user", reason: "gone" });
    assert.equal(revoked.status, "revoked");
    assert.throws(() => f.notes.confirm({ id: note.id, expected_version: revoked.version }), /revoked Note/u);
    const blocked = f.notes.observeDirectory({ path, device_id: "local", pin: true });
    assert.equal(blocked.reason, "revoked");
    assert.equal((blocked.note as { status: string }).status, "revoked");
    assert.throws(() => f.notes.revoke({ id: "missing", expected_version: 1, revoked_by: "u", reason: "r" }), /Unknown craft_note/u);
    assert.throws(() => f.notes.revoke({ id: note.id, expected_version: 0, revoked_by: "u", reason: "r" }), /expected_version/u);
  } finally {
    await f.close();
  }
});

test("Notes qualification is durable, idempotent and never confirms a candidate", async () => {
  const f = await fixture();
  try {
    const args = { path: "/work/async", device_id: "local", task_id: "task-1", session_id: "session-1", outcome: "completed" };
    const first = f.notes.observeDirectory(args);
    const firstNote = first.note as { id: string; version: number; status: string };
    const retry = f.notes.observeDirectory(args);
    assert.equal((retry.note as { version: number }).version, firstNote.version);
    f.notes.observeDirectory({ ...args, task_id: "task-2", session_id: "session-1" });
    f.notes.observeDirectory({ ...args, task_id: "task-3", session_id: "session-2" });
    const current = f.notes.list({ status: "candidate" }).items.find(item => item.id === firstNote.id)!;

    const qualified = f.notes.qualifyCandidates({ limit: 1 });
    assert.deepEqual(qualified, {
      processed: 1,
      qualified: 1,
      waiting: 0,
      rejected: 0,
      items: [{ note_id: firstNote.id, status: "qualified", reason: "threshold_met_review_required" }],
    });
    assert.equal(f.store.find("craft_note", firstNote.id)!.qualification_status, "qualified");
    assert.equal(f.store.find("craft_note", firstNote.id)!.status, "candidate");
    assert.equal(f.notes.resolve({ path: "/work/async" }).items.some(item => item.id === firstNote.id), false);

    const again = f.notes.qualifyCandidates();
    assert.equal(again.processed, 0);
    const duplicate = f.notes.observeDirectory(args);
    assert.equal(duplicate.eligible, false);
    assert.equal(duplicate.duplicate, true);
    const reviewCandidate = f.notes.list({ status: "candidate" }).items.find(item => item.id === firstNote.id)!;
    assert.ok(reviewCandidate.version > current.version);
    assert.equal(f.notes.confirm({ id: firstNote.id, expected_version: reviewCandidate.version }).status, "confirmed");
  } finally {
    await f.close();
  }
});

test("duplicate observations on legacy candidates tolerate missing evidence lists", async () => {
  const f = await fixture();
  try {
    const args = { path: "/work/legacy-candidate", task_id: "task-legacy", session_id: "session-legacy", outcome: "completed" };
    const observed = f.notes.observeDirectory(args).note as { id: string };
    f.store.save("craft_note", observed.id, { ...f.store.find("craft_note", observed.id), evidence_refs: null });
    const retried = f.notes.observeDirectory(args);
    assert.equal(retried.evidence_count, 0);
    assert.equal((retried.note as { status: string }).status, "candidate");
  } finally {
    await f.close();
  }
});

test("reusing an observation id with different note or scope data is a conflict", async () => {
  const f = await fixture();
  try {
    const args = { path: "/work/intent", device_id: "local", task_id: "intent-task", session_id: "intent-session", outcome: "completed", note: "first note", project_id: "project:first" };
    const first = f.notes.observeDirectory(args);
    assert.equal((first.note as { text: string }).text, "first note");
    assert.throws(() => f.notes.observeDirectory({ ...args, note: "different note" }), (error: unknown) =>
      error instanceof Error && (error as Error & { code?: string }).code === "CRAFT_NOTES_OBSERVATION_CONFLICT");
    assert.throws(() => f.notes.observeDirectory({ ...args, project_id: "project:other" }), /different input/u);
    assert.equal((f.store.find("craft_note", (first.note as { id: string }).id)!.text), "first note");
    assert.equal(f.store.list("craft_note_usage", 100, row => row.subject_key === "local:/work/intent").length, 1);
  } finally {
    await f.close();
  }
});

test("event creation and candidate write commit atomically across duplicate observers", async () => {
  const f = await fixture();
  const originalSave = f.store.save.bind(f.store);
  try {
    const args = { path: "/work/atomic", device_id: "local", task_id: "atomic-task", session_id: "atomic-session", outcome: "completed" };
    let failCandidateWrite = true;
    f.store.save = ((kind: string, id: string, payload: Record<string, unknown>, version?: number) => {
      const saved = originalSave(kind, id, payload as never, version);
      if (failCandidateWrite && kind === "craft_note" && payload.subject_key === "local:/work/atomic") {
        failCandidateWrite = false;
        throw new Error("candidate write failed");
      }
      return saved;
    }) as typeof f.store.save;
    assert.throws(() => f.notes.observeDirectory(args), /candidate write failed/u);
    assert.equal(f.store.list("craft_note_usage", 100, row => row.subject_key === "local:/work/atomic").length, 0);
    assert.equal(f.store.list("craft_note", 100, row => row.subject_key === "local:/work/atomic").length, 0);

    f.store.save = originalSave;
    const otherObserver = new CraftNotesRegistry(f.store);
    const results = await Promise.all([
      Promise.resolve().then(() => f.notes.observeDirectory(args)),
      Promise.resolve().then(() => otherObserver.observeDirectory(args)),
    ]);
    assert.equal(results.filter(result => result.duplicate === true).length, 1);
    assert.equal(f.store.list("craft_note_usage", 100, row => row.subject_key === "local:/work/atomic").length, 1);
    assert.equal(f.store.list("craft_note", 100, row => row.subject_key === "local:/work/atomic").length, 1);
  } finally {
    f.store.save = originalSave;
    await f.close();
  }
});

test("confirmed and revoked transitions serialize with an expected-version check", async () => {
  const f = await fixture();
  try {
    const note = f.notes.resolve({ device_id: "local" }).items[0]!;
    const competing = new CraftNotesRegistry(f.store);
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => f.notes.confirm({ id: note.id, expected_version: note.version })),
      Promise.resolve().then(() => competing.revoke({ id: note.id, expected_version: note.version, revoked_by: "worker", reason: "concurrent decision" })),
    ]);
    assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(result => result.status === "rejected").length, 1);
    const current = f.store.find("craft_note", note.id)!;
    assert.equal(Number(current.version), note.version + 1);
    assert.ok(current.status === "confirmed" || current.status === "revoked");
  } finally {
    await f.close();
  }
});

test("confirm and revoke roll back state when storage fails after the write", async () => {
  const f = await fixture();
  const originalSave = f.store.save.bind(f.store);
  try {
    const note = f.notes.resolve({ device_id: "local" }).items[0]!;
    let fail = true;
    f.store.save = ((kind: string, id: string, payload: Record<string, unknown>, version?: number) => {
      const saved = originalSave(kind, id, payload as never, version);
      if (fail && kind === "craft_note" && id === note.id) {
        fail = false;
        throw new Error("injected storage failure");
      }
      return saved;
    }) as typeof f.store.save;

    assert.throws(() => f.notes.revoke({ id: note.id, expected_version: note.version, revoked_by: "worker", reason: "failure" }), /injected storage failure/u);
    const afterFailure = f.store.find("craft_note", note.id)!;
    assert.equal(afterFailure.status, "confirmed");
    assert.equal(Number(afterFailure.version), note.version);

    fail = true;
    assert.throws(() => f.notes.confirm({ id: note.id, expected_version: note.version }), /injected storage failure/u);
    const afterConfirmFailure = f.store.find("craft_note", note.id)!;
    assert.equal(afterConfirmFailure.status, "confirmed");
    assert.equal(Number(afterConfirmFailure.version), note.version);
  } finally {
    f.store.save = originalSave;
    await f.close();
  }
});

test("expired qualifications require async review and refresh the review window", async () => {
  const f = await fixture();
  try {
    const note = f.notes.observeDirectory({ path: "/work/qualification-expiry", pin: true }).note as { id: string };
    f.notes.qualifyCandidates();
    const stale = f.store.find("craft_note", note.id)!;
    const expiredAt = new Date(Date.now() - 31 * 86400000).toISOString();
    f.store.save("craft_note", note.id, { ...stale, qualified_at: expiredAt, qualification_checked_at: expiredAt });
    const beforeConfirm = f.store.find("craft_note", note.id)!;
    assert.throws(() => f.notes.confirm({ id: note.id, expected_version: beforeConfirm.version }), /qualification has expired/u);

    assert.equal(f.notes.qualifyCandidates().qualified, 1);
    const refreshed = f.store.find("craft_note", note.id)!;
    assert.ok(Date.parse(String(refreshed.qualified_at)) > Date.parse(expiredAt));
    assert.equal(f.notes.confirm({ id: note.id, expected_version: refreshed.version }).status, "confirmed");
  } finally {
    await f.close();
  }
});

test("rejected candidates wait for their review window before policy recheck", async () => {
  const opened = await openStore();
  let blocked = false;
  const notes = new CraftNotesRegistry(opened.store, value => {
    if (blocked && value === "candidate") throw new Error("policy denied");
  });
  try {
    notes.createDevice({ id: "local", note: "device" });
    const note = notes.observeDirectory({ path: "/work/rejected-window", pin: true, note: "candidate" }).note as { id: string };
    blocked = true;
    assert.equal(notes.qualifyCandidates().rejected, 1);
    const rejected = opened.store.find("craft_note", note.id)!;
    assert.equal(notes.qualifyCandidates().processed, 0);
    assert.equal(Number(opened.store.find("craft_note", note.id)!.version), Number(rejected.version));

    blocked = false;
    const expiredAt = new Date(Date.now() - 31 * 86400000).toISOString();
    opened.store.save("craft_note_qualification_cursor", note.id, {
      ...opened.store.find("craft_note_qualification_cursor", note.id), checked_at: expiredAt,
    });
    assert.equal(notes.qualifyCandidates().qualified, 1);
    assert.equal(opened.store.find("craft_note", note.id)!.qualification_status, "qualified");
  } finally {
    await opened.close();
  }
});

test("Notes qualification waits when device identity is no longer valid", async () => {
  const f = await fixture();
  try {
    const candidate = f.notes.observeDirectory({ path: "/work/device-changed", pin: true, device_id: "local" }).note as { id: string; version: number };
    f.notes.createDevice({ id: "local", note: "设备停用", status: "disabled" });
    const result = f.notes.qualifyCandidates();
    assert.deepEqual(result.items, [{ note_id: candidate.id, status: "waiting", reason: "device_identity_unavailable" }]);
    assert.equal(f.store.find("craft_note", candidate.id)!.status, "candidate");
    assert.equal(f.store.find("craft_note", candidate.id)!.qualification_status, "waiting");
    const waitingVersion = Number(f.store.find("craft_note", candidate.id)!.version);
    const firstCheckedAt = String(f.store.find("craft_note_qualification_cursor", candidate.id)!.checked_at);
    assert.equal(f.notes.qualifyCandidates().waiting, 1);
    assert.equal(Number(f.store.find("craft_note", candidate.id)!.version), waitingVersion);
    assert.ok(String(f.store.find("craft_note_qualification_cursor", candidate.id)!.checked_at) >= firstCheckedAt);
    f.store.save("craft_note", "missing-device", {
      id: "missing-device", subject_type: "directory", subject_key: "unknown:/work", text: "unknown scope", status: "candidate",
      qualification_status: "pending", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    assert.equal(f.notes.qualifyCandidates().items.find(item => item.note_id === "missing-device")!.reason, "device_identity_unavailable");
    f.store.save("device", "local", { ...f.store.find("device", "local"), status: "active" });
    assert.equal(f.notes.qualifyCandidates().items.find(item => item.note_id === candidate.id)!.status, "qualified");
    assert.throws(() => f.notes.qualifyCandidates({ limit: 0 }), /limit/u);
  } finally {
    await f.close();
  }
});

test("Notes qualification waits below threshold and rejects a candidate that fails current policy", async () => {
  const opened = await openStore();
  let blocked = false;
  const notes = new CraftNotesRegistry(opened.store, value => {
    if (blocked && value === "policy changed") throw new Error("policy denied");
  });
  try {
    notes.createDevice({ id: "local", note: "device" });
    const insufficient = notes.observeDirectory({ path: "/work/insufficient", task_id: "t1", session_id: "s1", outcome: "completed" });
    const rejected = notes.observeDirectory({ path: "/work/rejected", pin: true, note: "policy changed" });
    blocked = true;
    const result = notes.qualifyCandidates();
    assert.deepEqual(result.items.map(item => [item.status, item.reason]).sort(), [
      ["rejected", "candidate_validation_failed"],
      ["waiting", "insufficient_independent_usage"],
    ]);
    assert.equal(notes.resolve({ path: "/work/insufficient" }).items.some(item => item.id === (insufficient.note as { id: string }).id), false);
    assert.equal(notes.resolve({ path: "/work/rejected" }).items.some(item => item.id === (rejected.note as { id: string }).id), false);
    assert.equal("text" in result.items[1]!, false);
  } finally {
    await opened.close();
  }
});

test("pinned directory notes bypass usage evidence and keep their own text", async () => {
  const f = await fixture();
  try {
    const pinned = f.notes.observeDirectory({ path: "/work/pinned", device_id: "local", pin: true, note: "pinned note", project_id: "p1" });
    assert.equal(pinned.eligible, false);
    assert.equal(pinned.reason, "awaiting_async_qualification");
    assert.equal(pinned.evidence_count, 0);
    const note = pinned.note as { id: string; text: string; project_id: string; version: number; subject_type: string };
    assert.equal(note.text, "pinned note");
    assert.equal(note.project_id, "p1");
    assert.equal(note.subject_type, "directory");
    assert.equal(f.notes.qualifyCandidates().items[0]!.reason, "pinned_review_required");
    const qualified = f.notes.list({ status: "candidate" }).items.find(item => item.id === note.id)!;
    const again = f.notes.observeDirectory({ path: "/work/pinned", device_id: "local", pin: true });
    assert.equal((again.note as { version: number }).version, qualified.version + 1);
    const unnamed = f.notes.observeDirectory({ path: "/work/unnamed", device_id: "local", pin: true });
    assert.equal((unnamed.note as { text: string }).text, "unnamed");
    const explicit = f.notes.observeDirectory({ path: "/work/explicit", device_id: "local", pin: true, id: "custom-id" });
    assert.equal((explicit.note as { id: string }).id, "custom-id");
  } finally {
    await f.close();
  }
});

test("file references track metadata freshness and require artifact evidence", async () => {
  const f = await fixture();
  try {
    const path = "/work/app.ts";
    assert.throws(() => f.notes.observeFileReference({ path, device_id: "local", task_id: "t", session_id: "s", outcome: "completed" }), /artifact/u);
    assert.throws(() => f.notes.observeFileReference({ path, device_id: "local", pin: true, metadata: [] }), /metadata must be an object/u);
    assert.throws(() => f.notes.observeFileReference({ path, device_id: "local", pin: true, metadata: { size: -1 } }), /non-negative/u);
    assert.throws(() => f.notes.observeFileReference({ path, device_id: "local", pin: true, metadata: { size: 1.5 } }), /non-negative/u);
    assert.throws(() => f.notes.observeFileReference({ path, device_id: "local", pin: true, metadata: { modified_at: "not-a-date" } }), /valid timestamp/u);
    const pinned = f.notes.observeFileReference({ path, device_id: "local", pin: true });
    assert.equal((pinned.note as { freshness: string }).freshness, "path_only");
    const first = f.notes.observeFileReference({ path, device_id: "local", pin: true, metadata: { size: 10, modified_at: "2026-01-01T00:00:00.000Z" } });
    assert.equal((first.note as { freshness: string }).freshness, "current");
    const changed = f.notes.observeFileReference({ path, device_id: "local", pin: true, metadata: { size: 11, modified_at: "2026-01-02T00:00:00.000Z" } });
    assert.equal((changed.note as { freshness: string }).freshness, "needs_review");
    const note = changed.note as { id: string; version: number };
    assert.equal(f.notes.qualifyCandidates().qualified, 1);
    const stored = f.store.find("craft_note", note.id)!;
    f.notes.confirm({ id: note.id, expected_version: Number(stored.version) });
    const afterConfirm = f.notes.observeFileReference({ path, device_id: "local", pin: true, metadata: { size: 12, modified_at: "2026-01-03T00:00:00.000Z" } });
    assert.equal((afterConfirm.note as { status: string }).status, "needs_review");
    const withoutMetadata = f.notes.observeFileReference({ path, device_id: "local", pin: true });
    assert.equal((withoutMetadata.note as { freshness: string }).freshness, "path_only");
    const artifact = f.notes.observeFileReference({ path, device_id: "local", task_id: "t", session_id: "s", outcome: "completed", artifact_ref: "artifact-1" });
    assert.equal(artifact.eligible, false);
    const codebase = f.notes.observeFileReference({ path: "/work/other.ts", device_id: "local", task_id: "t", session_id: "s", outcome: "completed", confirmed_codebase_ref: true });
    assert.equal(codebase.eligible, false);
  } finally {
    await f.close();
  }
});

test("resolve returns confirmed notes per device and path, and honours project scope", async () => {
  const f = await fixture();
  try {
    f.notes.createDevice({ id: "laptop", note: "笔记本" });
    const localNote = f.notes.observeDirectory({ path: "/work/app", device_id: "local", pin: true, project_id: "p1" }).note as { id: string; version: number };
    f.notes.qualifyCandidates();
    f.notes.confirm({ id: localNote.id, expected_version: Number(f.store.find("craft_note", localNote.id)!.version) });
    const laptopNote = f.notes.observeDirectory({ path: "/work/app", device_id: "laptop", pin: true, project_id: "p1" }).note as { id: string; version: number };
    f.notes.qualifyCandidates();
    f.notes.confirm({ id: laptopNote.id, expected_version: Number(f.store.find("craft_note", laptopNote.id)!.version) });
    const places = (query: Record<string, unknown>) => f.notes.resolve(query).items.filter(item => item.subject_type === "directory");
    assert.equal(places({ path: "/work/app" }).length, 1);
    assert.equal(places({ path: "/work/app" })[0]!.device_id, "local");
    assert.equal(places({ path: "/work/app", device_id: "laptop" }).length, 1);
    assert.equal(places({ path: "/work/app", project_id: "p2" }).length, 0);
    assert.equal(places({ project_id: "p1" }).length, 0);
    assert.equal(f.notes.resolve({}).items.filter(item => item.subject_type === "device").length, 1);
    assert.equal(f.notes.resolve({ device_id: "laptop" }).items.filter(item => item.subject_type === "device").length, 1);
    f.notes.createDevice({ id: "laptop", note: "停用", status: "disabled" });
    assert.equal(places({ path: "/work/app", device_id: "laptop" }).length, 0);
  } finally {
    await f.close();
  }
});

test("list filters by status and limit and validates limits", async () => {
  const f = await fixture();
  try {
    f.notes.createDevice({ id: "laptop", note: "笔记本" });
    assert.equal(f.notes.list().items.length, 2);
    assert.equal(f.notes.list({ status: "confirmed" }).items.length, 2);
    assert.equal(f.notes.list({ status: "revoked" }).items.length, 0);
    assert.equal(f.notes.list({ limit: 1 }).items.length, 1);
    assert.throws(() => f.notes.list({ limit: 0 }), /limit/u);
    assert.throws(() => f.notes.list({ limit: 1001 }), /limit/u);
    assert.throws(() => f.notes.list({ limit: "abc" }), /limit/u);
    assert.throws(() => f.notes.candidateList({ limit: 0 }), /limit/u);
    assert.throws(() => f.notes.resolve({ limit: 1001 }), /limit/u);
  } finally {
    await f.close();
  }
});

test("stored records with sparse fields read back with stable defaults", async () => {
  const f = await fixture();
  try {
    f.store.save("craft_note", "sparse", {
      id: "sparse", subject_type: "file", subject_key: "local:/x", text: "text", status: "legacy_unreviewed",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    });
    const item = f.notes.list({ status: "legacy_unreviewed" }).items[0]!;
    assert.equal(item.version, 1);
    assert.deepEqual(item.evidence_refs, []);
    assert.equal(item.verified_at, null);
    assert.equal(item.device_id, undefined);
    const rich = f.store.save("craft_note", "rich", {
      id: "rich", subject_type: "device", subject_key: "local", text: "t", status: "confirmed",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", device_id: "local",
      project_id: "p", sensitivity: "s", freshness: "current", evidence_refs: ["e"],
    });
    assert.equal(rich.id, "rich");
    const read = f.notes.list({ status: "confirmed" }).items.find(note => note.id === "rich")!;
    assert.equal(read.project_id, "p");
    assert.equal(read.sensitivity, "s");
    assert.equal(read.freshness, "current");
    assert.deepEqual(read.evidence_refs, ["e"]);
  } finally {
    await f.close();
  }
});

test("sparse and legacy rows take every documented default branch", async () => {
  const f = await fixture();
  try {
    const legacyPath = join(f.root, "legacy.ts");
    const unnamedPath = join(f.root, "unnamed");
    f.store.save("craft_note", "legacy-file", {
      id: "legacy-file", subject_type: "file", subject_key: `local:${legacyPath}`, text: "legacy", status: "legacy_unreviewed",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    });
    const candidates = f.notes.candidateList().items;
    assert.equal(candidates.some(item => item.id === "legacy-file"), true);
    assert.equal(f.notes.resolve({ path: legacyPath }).items.some(item => item.id === "legacy-file"), true);
    assert.equal(f.notes.resolve({ path: legacyPath, device_id: "local" }).items.some(item => item.id === "legacy-file"), false);
    const unnamed = f.store.save("craft_note", "unnamed", {
      id: "unnamed", subject_type: "directory", subject_key: `local:${unnamedPath}`, text: "t", status: "candidate",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(unnamed.id, "unnamed");
    assert.equal(f.notes.resolve({ path: unnamedPath }).items.some(item => item.id === "unnamed"), false);
    assert.equal(f.notes.resolve({ path: unnamedPath, device_id: "local" }).items.some(item => item.id === "unnamed"), false);
    assert.equal(f.notes.resolve({}).items.some(item => item.id === "unnamed"), false);
    const aliasDevice = f.notes.createDevice({ device_id: "local-alias", note: "alias" });
    assert.equal(aliasDevice.subject_key, "local-alias");
    assert.equal(f.notes.observeFileReference({ path: "/work/default.ts", pin: true, device_id: "local" }).note !== undefined, true);
    assert.throws(() => f.notes.confirm({ id: "missing", expected_version: 1 }), /Unknown craft_note/u);
    const device = f.notes.createDevice({ id: "confirm-device", note: "confirm" });
    const confirmed = f.notes.confirm({ id: device.id, expected_version: device.version });
    assert.equal(confirmed.status, "confirmed");
    const revoked = f.notes.revoke({ id: device.id, expected_version: confirmed.version, revoked_by: "u", reason: "r" });
    assert.equal(revoked.version, confirmed.version + 1);
    assert.equal(revoked.version, Number(f.store.find("craft_note", device.id)!.version ?? 1));
    assert.equal(f.notes.resolve({ device_id: "ghost" }).items.length, 0);
    assert.equal(f.notes.list({ limit: null }).items.length > 0, true);
    const legacyStore = new Map<string, Record<string, unknown>>([["legacy-note", {
      id: "legacy-note", subject_type: "device", subject_key: "legacy", text: "legacy",
      status: "confirmed", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    }]]);
    const legacyNotes = new CraftNotesRegistry({
      find: (kind: string, id: string) => kind === "craft_note" ? legacyStore.get(id) ?? null : null,
      list: (kind: string) => kind === "craft_note" ? [...legacyStore.values()] : [],
      save: (kind: string, id: string, payload: Record<string, unknown>) => {
        legacyStore.set(id, payload);
        return payload;
      },
    } as never);
    assert.equal(legacyNotes.confirm({ id: "legacy-note", expected_version: 1 }).version, 2);
  } finally {
    await f.close();
  }
});

test("file metadata comparison and default ids stay stable", async () => {
  const f = await fixture();
  try {
    const path = "/work/stable.ts";
    f.notes.observeFileReference({ path, pin: true, metadata: { size: 1, modified_at: "2026-01-01T00:00:00.000Z" } });
    const same = f.notes.observeFileReference({ path, pin: true, metadata: { size: 1, modified_at: "2026-01-01T00:00:00.000Z" } });
    assert.equal((same.note as { freshness: string }).freshness, "current");
    const sizeOnly = f.notes.observeFileReference({ path, pin: true, metadata: { size: 2 } });
    assert.equal((sizeOnly.note as { freshness: string }).freshness, "path_only");
    const timeOnly = f.notes.observeFileReference({ path, pin: true, metadata: { modified_at: "2026-01-05T00:00:00.000Z" } });
    assert.equal((timeOnly.note as { freshness: string }).freshness, "path_only");
    const noArgs = f.notes.observeFileReference({ path: "/work/no-device.ts", pin: true });
    assert.match((noArgs.note as { subject_key: string }).subject_key, /^local:.*no-device\.ts$/u);
  } finally {
    await f.close();
  }
});

test("legacy records without version or description fall back safely", async () => {
  const opened = await openStore();
  try {
    const records = new Map<string, Record<string, unknown>>([
      ["legacy", {
        id: "legacy", subject_type: "directory", subject_key: "local:/legacy",
        text: "legacy", status: "candidate", created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }],
    ]);
    const notes = new CraftNotesRegistry({
      find: (kind: string, id: string) => kind === "craft_note" ? records.get(id) ?? null : null,
      list: (kind: string) => kind === "craft_note" ? [...records.values()] : [],
      save: (kind: string, id: string, payload: Record<string, unknown>) => {
        records.set(id, payload);
        return payload;
      },
    } as never);
    assert.equal(notes.list().items[0]!.version, 1);
    assert.equal(notes.candidateList().items[0]!.version, 1);
    assert.equal(notes.revoke({ id: "legacy", expected_version: 1, revoked_by: "u", reason: "r" }).version, 2);
    const implicit = new CraftNotesRegistry(opened.store);
    implicit.createDevice({ id: "local", note: "device" });
    implicit.observeDirectory({ path: "/work/legacy", pin: true, description: "description fallback" });
    assert.equal(implicit.list({ status: "candidate" }).items.length, 1);
    implicit.observeDirectory({ path: "/", pin: true });
    assert.equal(implicit.list({ status: "candidate" }).items.length, 2);
    opened.store.save("craft_note", "no-device", {
      id: "no-device", subject_type: "file", subject_key: "local:/no-device", text: "t", status: "candidate",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(implicit.candidateList({ device_id: "local" }).items.length, 2);
    assert.equal(implicit.candidateList({ device_id: "other" }).items.length, 0);
  } finally {
    await opened.close();
  }
});

test("implicit local notes resolve without an explicit device row", async () => {
  const opened = await openStore();
  try {
    opened.store.save("craft_note", "implicit", {
      id: "implicit", subject_type: "directory", subject_key: `local:${join(opened.root, "implicit")}`,
      text: "implicit", status: "confirmed", created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const notes = new CraftNotesRegistry(opened.store);
    assert.equal(notes.resolve({ path: join(opened.root, "implicit") }).items.length, 1);
    assert.equal(notes.resolve({ path: join(opened.root, "implicit"), device_id: "local" }).items.length, 0);
    assert.equal(notes.resolve({ device_id: "local" }).items.length, 0);
  } finally {
    await opened.close();
  }
});

test("note seed text uses the final path segment and falls back to the path", () => {
  assert.equal(noteSeedText("C:\\work\\billing"), "billing");
  assert.equal(noteSeedText("/work/billing/"), "billing");
  assert.equal(noteSeedText("/"), "/");
  assert.equal(noteSeedText("\\\\server\\share"), "share");
});

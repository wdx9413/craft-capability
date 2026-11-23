import assert from "node:assert/strict";
import test from "node:test";
import { stableDigest } from "craft-common-base/digest";
import { CraftNotesRegistry } from "../craft-note-lifecycle.ts";
import { openStore } from "./store.ts";

function replayLineage(runId: string, session = "history-session") {
  return [{ origin: "historical_replay", replay_run_id: runId, session_id: session, project_scope_id: "project:billing",
    source_ref: { kind: "host_task", id: "history-task", digest: `sha256:${"a".repeat(64)}` },
    evidence_refs: [{ kind: "evidence", id: "history-evidence", version: 1 }] }];
}
function liveLineage(task: string, session: string) {
  return [{ origin: "live_hook", session_id: session, task_id: task, project_scope_id: "project:billing",
    source_ref: { kind: "host_task", id: task, digest: `sha256:${"b".repeat(64)}` },
    evidence_refs: [{ kind: "evidence", id: "live-evidence", version: 1 }] }];
}

async function fixture() {
  const opened = await openStore();
  const notes = new CraftNotesRegistry(opened.store);
  notes.createDevice({ id: "local", note: "本地设备" });
  opened.store.create("evidence", "history-evidence", { confidence: "unverified" });
  opened.store.create("evidence", "live-evidence", { confidence: "confirmed" });
  return { ...opened, notes };
}

async function confirmedDirectory(f: Awaited<ReturnType<typeof fixture>>, path = "/work/replay-ready") {
  for (const [taskId, sessionId] of [["ready-task-1", "ready-session-1"], ["ready-task-2", "ready-session-1"], ["ready-task-3", "ready-session-2"]]) {
    f.notes.observeDirectory({ path, device_id: "local", project_id: "billing", task_id: taskId, session_id: sessionId,
      outcome: "completed", evidence_ref: { kind: "evidence", id: "live-evidence", version: 1 },
      source_lineage: liveLineage(taskId, sessionId) });
  }
  f.notes.qualifyCandidates();
  const candidate = f.notes.list({ status: "candidate" }).items.find(item => item.subject_key === `local:${path}`)!;
  const qualified = f.notes.list({ status: "candidate" }).items.find(item => item.id === candidate.id)!;
  return f.notes.confirm({ id: candidate.id, expected_version: qualified.version });
}

test("Notes usage event keeps the exact caller Evidence ref", async () => {
  const f = await fixture();
  try {
    const ref = { kind: "evidence", id: "live-evidence", version: 1 };
    f.notes.observeDirectory({ path: "/work/ref", device_id: "local", task_id: "ref-task", session_id: "ref-session",
      outcome: "completed", evidence_ref: ref, source_lineage: [{ origin: "live_hook", session_id: "ref-session", project_scope_id: "project:billing",
        source_ref: { kind: "host_task", id: "ref-task" }, evidence_refs: [ref] }] });
    const event = f.store.list("craft_note_usage", 10, row => row.subject_key === "local:/work/ref")[0]!;
    assert.deepEqual(event.evidence_ref, ref);
    assert.deepEqual(event.source_lineage, [{ origin: "live_hook", session_id: "ref-session", project_scope_id: "project:billing",
      source_ref: { kind: "host_task", id: "ref-task" }, evidence_refs: [ref] }]);
  } finally { await f.close(); }
});

test("Notes live lineage validation rejects malformed values before persisting usage", async () => {
  const f = await fixture();
  try {
    const base = liveLineage("bad-task", "bad-session")[0]!;
    const invalid: unknown[] = [
      null,
      { ...base, extra: true },
      { ...base, origin: "historical_replay", replay_run_id: "run" },
      { ...base, replay_run_id: "unexpected" },
      { ...base, session_id: "" },
      { ...base, project_scope_id: "billing" },
      { ...base, source_ref: null },
      { ...base, source_ref: { ...base.source_ref, extra: true } },
      { ...base, source_ref: { kind: "host_task", id: "x", version: 0 } },
      { ...base, source_ref: { kind: "host_task", id: "x", digest: "sha256:bad" } },
      { ...base, evidence_refs: [] },
      { ...base, evidence_refs: [null] },
      { ...base, evidence_refs: [{ kind: "evidence", id: "live-evidence", version: 1, extra: true }] },
      { ...base, evidence_refs: [{ kind: "other", id: "live-evidence", version: 1 }] },
      { ...base, evidence_refs: [{ kind: "evidence", id: "live-evidence", version: 0 }] },
      { ...base, evidence_refs: [{ kind: "evidence", id: "missing", version: 1 }] },
      { ...base, turn_id: "x".repeat(257) },
    ];
    for (let index = 0; index < invalid.length; index++) assert.throws(() => f.notes.observeDirectory({ path: `/work/invalid-${index}`,
      device_id: "local", task_id: "bad-task", session_id: "bad-session", outcome: "completed", source_lineage: [invalid[index]] }));
    assert.throws(() => f.notes.observeDirectory({ path: "/work/mismatch", device_id: "local", task_id: "bad-task", session_id: "bad-session",
      outcome: "completed", source_lineage: [{ ...base, session_id: "other-session" }] }), /match/u);
    assert.throws(() => f.notes.observeDirectory({ path: "/work/bad-evidence", device_id: "local", task_id: "bad-task", session_id: "bad-session",
      outcome: "completed", evidence_ref: "live-evidence" }), /evidence_ref must be an object/u);
    assert.throws(() => f.notes.observeDirectory({ path: "/work/bad-evidence-kind", device_id: "local", task_id: "bad-task", session_id: "bad-session",
      outcome: "completed", evidence_ref: { kind: "other", id: "live-evidence", version: 1 } }), /kind, id and positive version/u);
    assert.equal(f.store.count("craft_note_usage"), 0);
  } finally { await f.close(); }
});

test("Notes replay capture covers exact identity, device, status, scope, and live evidence gates", async () => {
  const f = await fixture();
  try {
    const note = await confirmedDirectory(f);
    const capture = (overrides: Record<string, unknown> = {}) => f.notes.captureHistoricalReplayCandidate({ note_id: note.id,
      expected_version: Number(f.store.get("craft_note", note.id).version), device_id: "local", subject_type: "directory", subject_key: note.subject_key,
      source_lineage: replayLineage("run-gates"), ...overrides });
    assert.deepEqual(capture({ expected_version: 0 }), { status: "skipped", reason: "exact_note_version_required" });
    assert.deepEqual(capture({ subject_type: "file" }), { status: "skipped", reason: "exact_object_identity_required" });
    assert.deepEqual(capture({ source_lineage: replayLineage("run-gates").map(item => ({ ...item, project_scope_id: "project:other" })) }),
      { status: "skipped", reason: "project_scope_mismatch" });
    const withNoProject = f.store.get("craft_note", note.id);
    delete (withNoProject as Record<string, unknown>).project_id;
    const noProjectSaved = f.store.save("craft_note", note.id, withNoProject);
    assert.deepEqual(f.notes.captureHistoricalReplayCandidate({ note_id: note.id, expected_version: noProjectSaved.version, device_id: "local",
      subject_type: "directory", subject_key: note.subject_key, source_lineage: replayLineage("run-no-project") }),
    { status: "skipped", reason: "project_scope_mismatch" });
    f.store.save("craft_note", note.id, { ...f.store.get("craft_note", note.id), project_id: "billing" });
    const needsReview = f.store.save("craft_note", note.id, { ...f.store.get("craft_note", note.id), status: "needs_review" });
    assert.equal((f.notes.captureHistoricalReplayCandidate({ note_id: note.id, expected_version: needsReview.version, device_id: "local",
      subject_type: "directory", subject_key: note.subject_key, source_lineage: replayLineage("run-needs-review") }) as Record<string, unknown>).status, "captured");

    const candidate = f.store.save("craft_note", note.id, { ...f.store.get("craft_note", note.id), status: "candidate" });
    assert.deepEqual(f.notes.captureHistoricalReplayCandidate({ note_id: note.id, expected_version: candidate.version, device_id: "local",
      subject_type: "directory", subject_key: note.subject_key, source_lineage: replayLineage("run-candidate") }),
    { status: "skipped", reason: "confirmed_object_required" });

    const device = f.store.get("device", "local");
    f.store.save("device", "local", { ...device, status: "disabled" });
    assert.deepEqual(f.notes.captureHistoricalReplayCandidate({ note_id: note.id, expected_version: candidate.version, device_id: "local",
      subject_type: "directory", subject_key: note.subject_key, source_lineage: replayLineage("run-disabled") }),
    { status: "skipped", reason: "active_device_confirmation_required" });
    f.store.save("device", "local", { ...device, status: "active" });

    const deviceNote = f.store.list("craft_note", 10, row => row.subject_type === "device" && row.subject_key === "local")[0]!;
    f.store.save("craft_note", String(deviceNote.id), { ...deviceNote, status: "revoked" });
    assert.deepEqual(f.notes.captureHistoricalReplayCandidate({ note_id: note.id, expected_version: candidate.version, device_id: "local",
      subject_type: "directory", subject_key: note.subject_key, source_lineage: replayLineage("run-no-device-note") }),
    { status: "skipped", reason: "active_device_confirmation_required" });
    const orphan = f.store.create("craft_note", "orphan-replay-note", { subject_type: "directory", subject_key: "orphan:/work/path",
      text: "legacy", status: "confirmed", version: 1, project_id: "billing" });
    assert.deepEqual(f.notes.captureHistoricalReplayCandidate({ note_id: orphan.id, expected_version: orphan.version, device_id: "",
      subject_type: "directory", subject_key: orphan.subject_key, source_lineage: replayLineage("run-orphan") }),
    { status: "skipped", reason: "active_device_confirmation_required" });
  } finally { await f.close(); }
});

test("Notes replay lineage validates optional source identity and rejects multiple runs", async () => {
  const f = await fixture();
  try {
    const base = replayLineage("run-options")[0]!;
    const optional = [{ ...base, source_ref: { kind: "host_task", id: "task-no-version" }, turn_id: undefined, task_id: undefined,
      evidence_refs: [{ kind: "evidence", id: "history-evidence", version: 1 }, { kind: "evidence", id: "live-evidence", version: 1 }] }];
    const result = f.notes.captureHistoricalReplayCandidate({ source_lineage: optional, note_id: "missing", expected_version: 1 });
    assert.deepEqual(result, { status: "skipped", reason: "exact_note_not_found" });
    const missingRun = { ...base };
    delete (missingRun as Record<string, unknown>).replay_run_id;
    assert.throws(() => f.notes.captureHistoricalReplayCandidate({ source_lineage: [missingRun], note_id: "missing", expected_version: 1 }), /requires replay_run_id/u);
    assert.throws(() => f.notes.captureHistoricalReplayCandidate({ source_lineage: [{ ...base, origin: "live_hook", replay_run_id: undefined }],
      note_id: "missing", expected_version: 1 }), /historical_replay lineage/u);
    assert.deepEqual(f.notes.captureHistoricalReplayCandidate({ source_lineage: [base], note_id: "missing" }),
      { status: "skipped", reason: "exact_note_version_required" });
    const withTurnAndVersion = [{ ...base, turn_id: "turn-options", source_ref: { kind: "host_task", id: "task-with-version", version: 1 } }];
    assert.deepEqual(f.notes.captureHistoricalReplayCandidate({ source_lineage: withTurnAndVersion, note_id: "missing", expected_version: 2 }),
      { status: "skipped", reason: "exact_note_not_found" });
    assert.throws(() => f.notes.captureHistoricalReplayCandidate({ source_lineage: [base, { ...base, replay_run_id: "another-run" }],
      note_id: "missing", expected_version: 1 }), /one replay run/u);
    assert.throws(() => f.notes.captureHistoricalReplayCandidate({ source_lineage: [{ ...base, origin: "live_hook", replay_run_id: "run-options" }],
      note_id: "missing", expected_version: 1 }), /only historical replay/u);
    assert.throws(() => f.notes.captureHistoricalReplayCandidate({ source_lineage: "malformed", note_id: "missing", expected_version: 1 }), /source_lineage/u);
  } finally { await f.close(); }
});

test("Notes historical projection cleanup fails closed on malformed projection metadata", async () => {
  const f = await fixture();
  try {
    f.store.create("evidence", "malformed-notes-projection", { source_type: "historical_replay_projection",
      claim: "Historical replay Evidence reference projection.", metadata: { replay_run_id: "run-bad" } });
    assert.throws(() => f.notes.historicalReplayCleanupPreview({ replay_run_id: "run-bad" }), /projection metadata is malformed/u);
    f.store.create("evidence", "malformed-notes-projection-claim", { source_type: "historical_replay_projection",
      claim: "unrecognized", metadata: {} });
    assert.throws(() => f.notes.historicalReplayCleanupPreview({ replay_run_id: "run-claim" }), /projection is malformed/u);
  } finally { await f.close(); }
});

test("Notes cleanup excludes projections belonging to other runs or already revoked", async () => {
  const f = await fixture();
  try {
    for (const [id, run, status] of [["unmatched-projection", "another-run", "active"], ["revoked-projection", "run-empty", "revoked"]]) {
      f.store.create("evidence", id, { source_type: "historical_replay_projection", claim: "Historical replay Evidence reference projection.", metadata: {
        replay_run_id: run, source_owner: "context", source_evidence_id: "source", source_evidence_version: 1,
        semantic_digest: `sha256:${"f".repeat(64)}`, projection_status: status } });
    }
    assert.deepEqual(f.notes.historicalReplayCleanupPreview({ replay_run_id: "run-empty" }).items, []);
  } finally { await f.close(); }
});

test("Notes replay skips unknown legacy objects without writing anything", async () => {
  const f = await fixture();
  try {
    const beforeNotes = f.store.count("craft_note");
    const beforeUsage = f.store.count("craft_note_usage");
    const result = f.notes.captureHistoricalReplayCandidate({ note_id: "missing", expected_version: 1, device_id: "local",
      subject_type: "directory", subject_key: "local:/work/missing", source_lineage: replayLineage("run-skip") });
    assert.deepEqual(result, { status: "skipped", reason: "exact_note_not_found" });
    assert.equal(f.store.count("craft_note"), beforeNotes);
    assert.equal(f.store.count("craft_note_usage"), beforeUsage);
  } finally { await f.close(); }
});

test("historical usage lineage never counts toward Notes qualification", async () => {
  const f = await fixture();
  try {
    f.notes.observeDirectory({ path: "/work/threshold", device_id: "local", task_id: "live-task", session_id: "live-session",
      outcome: "completed", project_id: "billing", source_lineage: liveLineage("live-task", "live-session") });
    for (let i = 1; i <= 3; i++) {
      f.store.create("craft_note_usage", `replay-event-${i}`, { subject_type: "directory", subject_key: "local:/work/threshold",
        task_id: `replay-task-${i}`, session_id: `replay-session-${i}`, event_type: "usage", observed_at: new Date().toISOString(),
        source_lineage: replayLineage("run-threshold", `replay-session-${i}`) });
    }
    const result = f.notes.qualifyCandidates();
    assert.equal(result.waiting, 1);
    assert.equal(result.items[0]!.reason, "insufficient_independent_usage");
    const preview = f.notes.historicalReplayCleanupPreview({ replay_run_id: "run-threshold" });
    assert.equal((preview.items as Array<Record<string, unknown>>).length, 3);
    assert.ok((preview.items as Array<Record<string, unknown>>).every(item => item.action === "revoke"));
    f.notes.historicalReplayCleanupApply({ replay_run_id: "run-threshold", expected_manifest_digest: preview.manifest_digest });
    assert.ok(f.store.list("craft_note_usage", 10, row => row.subject_key === "local:/work/threshold" && row.event_type === "revoked").length === 3);
    assert.equal(f.notes.qualifyCandidates().items[0]!.reason, "insufficient_independent_usage");
  } finally { await f.close(); }
});

test("Notes accepts replay lineage only on an exact confirmed live object and cleanup preserves live lineage", async () => {
  const f = await fixture();
  try {
    for (const [task, session] of [["task-1", "session-1"], ["task-2", "session-1"], ["task-3", "session-2"]]) {
      f.notes.observeDirectory({ path: "/work/shared", device_id: "local", task_id: task, session_id: session, outcome: "completed",
        project_id: "billing", evidence_ref: { kind: "evidence", id: "live-evidence", version: 1 }, source_lineage: liveLineage(task, session) });
    }
    const candidate = f.notes.list({ status: "candidate" }).items.find(item => item.subject_key === "local:/work/shared")!;
    const qualified = f.notes.qualifyCandidates();
    assert.equal(qualified.qualified, 1);
    const qualifiedCandidate = f.notes.list({ status: "candidate" }).items.find(item => item.id === candidate.id)!;
    const confirmed = f.notes.confirm({ id: candidate.id, expected_version: qualifiedCandidate.version });
    assert.deepEqual(f.notes.captureHistoricalReplayCandidate({ note_id: confirmed.id, expected_version: 0,
      device_id: "local", subject_type: "directory", subject_key: "local:/work/shared", source_lineage: replayLineage("run-clean") }),
    { status: "skipped", reason: "exact_note_version_required" });
    assert.deepEqual(f.notes.captureHistoricalReplayCandidate({ note_id: confirmed.id, expected_version: confirmed.version,
      device_id: "other", subject_type: "directory", subject_key: confirmed.subject_key, source_lineage: replayLineage("run-clean") }),
    { status: "skipped", reason: "exact_object_identity_required" });
    const replay = f.notes.captureHistoricalReplayCandidate({ note_id: confirmed.id, expected_version: confirmed.version,
      device_id: "local", subject_type: "directory", subject_key: "local:/work/shared", source_lineage: replayLineage("run-clean") });
    assert.deepEqual(replay, { status: "captured", note_id: confirmed.id, version: confirmed.version + 1 });
    const duplicateReplay = f.notes.captureHistoricalReplayCandidate({ note_id: confirmed.id, expected_version: confirmed.version + 1,
      device_id: "local", subject_type: "directory", subject_key: "local:/work/shared", source_lineage: replayLineage("run-clean") });
    assert.equal((duplicateReplay as Record<string, unknown>).status, "captured");
    const preview = f.notes.historicalReplayCleanupPreview({ replay_run_id: "run-clean" });
    assert.deepEqual(preview.items, [{ kind: "craft_note", id: confirmed.id, version: confirmed.version + 2,
      lineage_digest: (preview.items as Array<Record<string, unknown>>)[0]!.lineage_digest, action: "remove_replay_lineage" }]);
    const applied = f.notes.historicalReplayCleanupApply({ replay_run_id: "run-clean", expected_manifest_digest: preview.manifest_digest });
    assert.equal(applied.status, "cleaned");
    const cleaned = f.store.get("craft_note", confirmed.id);
    assert.equal(cleaned.status, "confirmed");
    assert.ok((cleaned.source_lineage as Array<Record<string, unknown>>).every(item => item.origin === "live_hook"));
    const retried = f.notes.historicalReplayCleanupApply({ replay_run_id: "run-clean", expected_manifest_digest: preview.manifest_digest });
    assert.equal(retried.idempotent, true);
  } finally { await f.close(); }
});

test("Notes replay gates reject missing live identity and cleanup fails closed on stale state", async () => {
  const f = await fixture();
  try {
    const note = await confirmedDirectory(f, "/work/cleanup-stale");
    const current = f.store.get("craft_note", note.id);
    const { source_lineage: _removed, ...legacy } = current;
    f.store.save("craft_note", note.id, legacy);
    const legacyNote = f.store.get("craft_note", note.id);
    assert.deepEqual(f.notes.captureHistoricalReplayCandidate({ note_id: note.id, expected_version: legacyNote.version,
      device_id: "local", subject_type: "directory", subject_key: note.subject_key, source_lineage: replayLineage("run-legacy") }),
    { status: "skipped", reason: "legacy_note_identity_unknown" });

    const liveOnlyMissing = f.store.save("craft_note", note.id, { ...legacyNote, source_lineage: replayLineage("run-only-replay") });
    assert.deepEqual(f.notes.captureHistoricalReplayCandidate({ note_id: note.id, expected_version: liveOnlyMissing.version,
      device_id: "local", subject_type: "directory", subject_key: note.subject_key, source_lineage: replayLineage("run-only-replay-2") }),
    { status: "skipped", reason: "explicit_live_lineage_required" });

    const usage = f.store.create("craft_note_usage", "unrelated-replay-usage", { subject_type: "directory", subject_key: "local:/work/unrelated",
      task_id: "x", session_id: "x", event_type: "usage", observed_at: new Date().toISOString(), source_lineage: replayLineage("other-run") });
    const previewUnrelated = f.notes.historicalReplayCleanupPreview({ replay_run_id: "no-matching-run" });
    assert.ok(!(previewUnrelated.items as Array<Record<string, unknown>>).some(item => item.id === usage.id));

    const preview = f.notes.historicalReplayCleanupPreview({ replay_run_id: "run-only-replay" });
    f.store.save("craft_note", note.id, { ...f.store.get("craft_note", note.id), text: "changed after preview" });
    assert.throws(() => f.notes.historicalReplayCleanupApply({ replay_run_id: "run-only-replay", expected_manifest_digest: preview.manifest_digest }), /manifest changed/u);
  } finally { await f.close(); }
});

test("Notes cleanup removes replay-only note content and retries a transaction receipt", async () => {
  const f = await fixture();
  try {
    const note = await confirmedDirectory(f, "/work/replay-only-cleanup");
    const current = f.store.get("craft_note", note.id);
    f.store.save("craft_note", note.id, { ...current, source_lineage: replayLineage("run-pure-cleanup") });
    const preview = f.notes.historicalReplayCleanupPreview({ replay_run_id: "run-pure-cleanup" });
    f.notes.historicalReplayCleanupApply({ replay_run_id: "run-pure-cleanup", expected_manifest_digest: preview.manifest_digest });
    const cleanedNote = f.store.get("craft_note", note.id);
    assert.equal(cleanedNote.text, "");
    assert.equal(cleanedNote.status, "revoked");

    const emptyPreview = f.notes.historicalReplayCleanupPreview({ replay_run_id: "run-race" });
    const receiptId = `notes_replay_cleanup_${stableDigest({ replay_run_id: "run-race", manifest_digest: emptyPreview.manifest_digest }).slice(-32)}`;
    f.store.create("notes_replay_cleanup_receipt", receiptId, { owner: "notes", replay_run_id: "run-race",
      manifest_digest: emptyPreview.manifest_digest, content_free: true, status: "cleaned" });
    const originalFind = f.store.find.bind(f.store);
    let hideFirstReceiptRead = true;
    f.store.find = ((kind: string, id: string) => {
      if (hideFirstReceiptRead && kind === "notes_replay_cleanup_receipt" && id === receiptId) { hideFirstReceiptRead = false; return null; }
      return originalFind(kind, id);
    }) as typeof f.store.find;
    const retried = f.notes.historicalReplayCleanupApply({ replay_run_id: "run-race", expected_manifest_digest: emptyPreview.manifest_digest });
    f.store.find = originalFind;
    assert.equal(retried.idempotent, true);
  } finally { await f.close(); }
});

test("Notes lineage merge rejects source conflicts and capture rejects insufficient live use", async () => {
  const f = await fixture();
  try {
    f.notes.observeDirectory({ path: "/work/merge", device_id: "local", task_id: "merge-task-1", session_id: "merge-session-1",
      outcome: "completed", source_lineage: liveLineage("merge-task-1", "merge-session-1") });
    f.notes.observeDirectory({ path: "/work/merge", device_id: "local", task_id: "merge-task-2", session_id: "merge-session-2",
      outcome: "completed", source_lineage: liveLineage("merge-task-2", "merge-session-2") });
    const conflict = liveLineage("conflict-task", "conflict-session");
    assert.throws(() => f.notes.observeDirectory({ path: "/work/merge-conflict", device_id: "local", task_id: "conflict-task",
      session_id: "conflict-session", outcome: "completed", source_lineage: [conflict[0]!, { ...conflict[0]!,
        source_ref: { kind: "host_task", id: "different-source" } }] }), /source_ref conflicts/u);

    const note = await confirmedDirectory(f, "/work/insufficient");
    const events = f.store.list("craft_note_usage", 10, row => row.subject_key === note.subject_key);
    f.store.remove("craft_note_usage", String(events[0]!.id));
    f.store.remove("craft_note_usage", String(events[1]!.id));
    const current = f.store.get("craft_note", note.id);
    assert.deepEqual(f.notes.captureHistoricalReplayCandidate({ note_id: note.id, expected_version: current.version,
      device_id: "local", subject_type: "directory", subject_key: note.subject_key, source_lineage: replayLineage("run-insufficient") }),
    { status: "skipped", reason: "insufficient_live_usage" });
  } finally { await f.close(); }
});

test("Notes cleanup detects object and projection changes after the exact preview", async () => {
  const f = await fixture();
  try {
    const replay = replayLineage("run-race-check");
    const usage = f.store.create("craft_note_usage", "stale-usage", { subject_type: "directory", subject_key: "local:/work/stale",
      task_id: "history-task", session_id: "history-session", event_type: "usage", observed_at: new Date().toISOString(), source_lineage: replay });
    const usagePreview = f.notes.historicalReplayCleanupPreview({ replay_run_id: "run-race-check" });
    const originalGet = f.store.get.bind(f.store);
    f.store.get = ((kind: string, id: string, version?: number) => {
      if (kind === "craft_note_usage" && id === usage.id) {
        const row = originalGet(kind, id);
        f.store.save(kind, id, { ...row, event_type: "changed" });
      }
      return originalGet(kind, id, version);
    }) as typeof f.store.get;
    assert.throws(() => f.notes.historicalReplayCleanupApply({ replay_run_id: "run-race-check",
      expected_manifest_digest: usagePreview.manifest_digest }), /object changed after cleanup preview/u);
    f.store.get = originalGet;

    const projection = f.store.create("evidence", "stale-notes-projection", { confidence: "unverified",
      source_type: "historical_replay_projection", claim: "Historical replay Evidence reference projection.", metadata: {
        replay_run_id: "run-projection-check", source_owner: "context", source_evidence_id: "source", source_evidence_version: 1,
        semantic_digest: `sha256:${"9".repeat(64)}`, projection_status: "active" } });
    const projectionPreview = f.notes.historicalReplayCleanupPreview({ replay_run_id: "run-projection-check" });
    f.store.get = ((kind: string, id: string, version?: number) => {
      if (kind === "evidence" && id === projection.id) {
        const row = originalGet(kind, id);
        f.store.save(kind, id, { ...row, metadata: { ...(row.metadata as Record<string, unknown>), projection_status: "revoked" } });
      }
      return originalGet(kind, id, version);
    }) as typeof f.store.get;
    assert.throws(() => f.notes.historicalReplayCleanupApply({ replay_run_id: "run-projection-check",
      expected_manifest_digest: projectionPreview.manifest_digest }), /Evidence projection changed after cleanup preview/u);
    f.store.get = originalGet;
  } finally { await f.close(); }
});

test("Notes replay cleanup revokes only its projection Evidence and preserves original Evidence", async () => {
  const f = await fixture();
  try {
    f.store.create("evidence", "original-evidence", { confidence: "confirmed", source_type: "host_completion", claim: "original" });
    const projection = f.store.create("evidence", "evidence_historical_replay_projection_notes", { confidence: "unverified",
      source_type: "historical_replay_projection", claim: "Historical replay Evidence reference projection.", metadata: {
        replay_run_id: "run-notes-evidence", source_owner: "context", source_evidence_id: "original-evidence", source_evidence_version: 1,
        semantic_digest: `sha256:${"e".repeat(64)}`, projection_status: "active" } });
    const replay = replayLineage("run-notes-evidence");
    replay[0]!.evidence_refs[0]!.id = String(projection.id);
    f.store.create("craft_note_usage", "projection-usage", { subject_type: "directory", subject_key: "local:/work/projection",
      task_id: "history-task", session_id: "history-session", event_type: "usage", observed_at: new Date().toISOString(), source_lineage: replay });
    const preview = f.notes.historicalReplayCleanupPreview({ replay_run_id: "run-notes-evidence" });
    const evidenceItem = (preview.items as Array<Record<string, unknown>>).find(item => item.kind === "evidence_projection");
    assert.deepEqual({ id: evidenceItem?.id, version: evidenceItem?.version, action: evidenceItem?.action },
      { id: projection.id, version: projection.version, action: "revoke" });
    assert.equal(JSON.stringify(preview).includes("original"), false);
    f.notes.historicalReplayCleanupApply({ replay_run_id: "run-notes-evidence", expected_manifest_digest: preview.manifest_digest });
    const cleanedProjection = f.store.get("evidence", String(projection.id));
    const original = f.store.get("evidence", "original-evidence");
    assert.equal(cleanedProjection.confidence, "rejected");
    assert.equal((cleanedProjection.metadata as Record<string, unknown>).projection_status, "revoked");
    assert.equal(original.confidence, "confirmed");
    assert.equal(original.claim, "original");
  } finally { await f.close(); }
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "craft-common-store-local/store";
import { craftPaths } from "craft-common-store-local/paths";
import { digestJson, stableDigest } from "craft-common-base/digest";
import { MemoryCapture } from "../memory-capture.ts";
import { MemoryGovernanceKernel } from "../memory-governance.ts";
import { MemoryLedgerKernel } from "../memory-ledger.ts";

const PROJECT_SCOPE = "project:craft";
const CONTENT = "This project uses focused verification.";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-memory-replay-"));
  const store = await new CraftStore(craftPaths(root)).open();
  store.create("knowledge_source", "builtin.evidence-wiki", { scope: { kind: "global", id: "global" }, status: "active", trust: "verified" });
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  store.create("scope_alias", "memory-replay-project", { scope: { kind: "project", id: "craft" }, alias_kind: "path", alias: projectRoot, status: "active" });
  const ledger = new MemoryLedgerKernel(store);
  const governance = new MemoryGovernanceKernel(store, ledger);
  const capture = new MemoryCapture(governance, () => undefined, args => {
    const id = String(args.evidence_id);
    const existing = store.find("evidence", id);
    if (existing) return { evidence: existing, idempotent: true };
    return store.create("evidence", id, { ...args });
  });
  function addEvidence(id: string, confidence = "unverified") {
    return store.create("evidence", id, { source_type: "program", confidence, claim: "Sanitized source reference", metadata: { content_stored: false } });
  }
  function addReplayProjection(runId: string, source: JsonObject) {
    const id = `evidence_historical_replay_projection_${stableDigest({ replay_run_id: runId, source_evidence_id: source.id }).slice(-32)}`;
    return store.create("evidence", id, { source_type: "historical_replay_projection", confidence: "unverified",
      claim: "Historical replay Evidence reference projection.", metadata: { replay_run_id: runId, source_owner: "experience",
        source_evidence_id: source.id, source_evidence_version: source.version,
        semantic_digest: stableDigest({ source_evidence_id: source.id, source_evidence_version: source.version }), projection_status: "active" } });
  }
  async function close() { store.close(); await rm(root, { recursive: true, force: true }); }
  return { root, store, capture, governance, ledger, addEvidence, addReplayProjection, close };
}

function lineage(replayRunId: string, sessionId: string, evidenceId: string): JsonObject {
  return { origin: "historical_replay", replay_run_id: replayRunId, session_id: sessionId, turn_id: `${sessionId}-turn`,
    project_scope_id: PROJECT_SCOPE, source_ref: { kind: "codex_session", id: sessionId },
    evidence_refs: [{ kind: "evidence", id: evidenceId, version: 1 }] };
}

function replayArgs(sourceLineage: JsonObject, candidateId = "memory-replay-candidate"): JsonObject {
  return { candidate_id: candidateId, content: CONTENT, kind: "preference", topic: "project:verification", project_scope_id: PROJECT_SCOPE,
    source_lineage: [sourceLineage], dataset_partition: "candidate_generation" };
}

test("historical Memory replay is proposal-only and cannot create live promotion work", async () => {
  const f = await fixture();
  try {
    const evidence = f.addReplayProjection("replay-a", f.addEvidence("memory-replay-evidence"));
    const result = f.capture.captureHistoricalReplayCandidate(replayArgs(lineage("replay-a", "session-a", String(evidence.id)))) as JsonObject;
    const candidate = result.candidate as JsonObject;
    assert.equal(result.status, "candidate");
    assert.equal(result.auto_committed, false);
    assert.equal(candidate.status, "candidate");
    assert.deepEqual(candidate.source_lineage, [lineage("replay-a", "session-a", String(evidence.id))]);
    assert.equal(f.store.list("memory_ledger", 20).length, 0);
    assert.equal(f.store.list("memory_observation_promotion", 20).length, 0);
    assert.equal(f.store.list("memory_observation_intent", 20).length, 0);
  } finally { await f.close(); }
});

test("live user and observed Memory Hook captures persist exact Evidence and task lineage", async () => {
  const f = await fixture();
  try {
    const sourceDigest = `sha256:${"b".repeat(64)}`;
    const observed = f.capture.captureObservedFact({ session_id: "live-observed-session", project_scope_id: "craft", turn_id: "turn-1", task_id: "task-1",
      task_source_digest: sourceDigest, content: "This project uses focused verification.", topic: "project:verification" }) as JsonObject;
    const observedCandidate = observed.candidate as JsonObject;
    const observedLineage = (observedCandidate.source_lineage as JsonObject[])[0]!;
    assert.equal(observedLineage.origin, "live_hook");
    assert.equal(observedLineage.project_scope_id, PROJECT_SCOPE);
    assert.equal(observedLineage.session_id, "live-observed-session");
    assert.equal(observedLineage.turn_id, "turn-1");
    assert.equal(observedLineage.task_id, "task-1");
    assert.deepEqual(observedLineage.source_ref, { kind: "codex_session_task", id: "task-1", digest: sourceDigest });
    assert.deepEqual(observedLineage.evidence_refs, [{ kind: "evidence", id: String((observed.evidence as JsonObject).id), version: (observed.evidence as JsonObject).version }]);

    const explicitDigest = `sha256:${"d".repeat(64)}`;
    const digestCapture = f.capture.captureObservedFact({ session_id: "live-explicit-digest-session", project_scope_id: "craft", turn_id: "turn-digest",
      task_id: "task-digest", source_digest: explicitDigest, content: "This project favors reliable focused tests.", topic: "project:test-style" }) as JsonObject;
    assert.equal((((digestCapture.candidate as JsonObject).source_lineage as JsonObject[])[0]!.source_ref as JsonObject).digest, explicitDigest);

    const user = f.capture.captureUserStatement({ session_id: "live-user-session", project_scope_id: PROJECT_SCOPE, turn_id: "turn-2", content: "Prefer focused verification.", topic: "project:preference" }) as JsonObject;
    const userLineage = ((user.candidate as JsonObject).source_lineage as JsonObject[])[0]!;
    assert.equal(userLineage.origin, "live_hook");
    assert.equal(userLineage.session_id, "live-user-session");
    assert.equal(userLineage.turn_id, "turn-2");
    assert.equal(userLineage.task_id, undefined);
    assert.equal((userLineage.evidence_refs as JsonObject[])[0]?.version, (user.evidence as JsonObject).version);
  } finally { await f.close(); }
});

test("independent live Memory observations carry lineage into the project Ledger", async () => {
  const f = await fixture();
  try {
    const promote = (sessionId: string) => {
      const captured = f.capture.captureObservedFact({ session_id: sessionId, project_scope_id: "craft", task_id: `${sessionId}-task`,
        turn_id: `${sessionId}-turn`, content: CONTENT, topic: "project:verification" }) as JsonObject;
      const candidate = captured.candidate as JsonObject;
      const evidence = captured.evidence as JsonObject;
      return (f.capture as unknown as { promoteRepeatedFact(input: JsonObject): JsonObject[] }).promoteRepeatedFact({
        sessionId, projectId: "craft", candidate, evidence,
      });
    };
    assert.deepEqual(promote("live-session-a"), []);
    const firstCandidate = f.store.list("memory_candidate", 1)[0]!;
    f.store.create("memory_observation", "unlineaged-legacy-observation", { content_digest: firstCandidate.content_digest, project_id: "craft",
      session_digest: digestJson("legacy-session"), kind: firstCandidate.kind, topic: firstCandidate.topic ?? "", scope: { kind: "project", id: "craft" },
      content_free: true, status: "active" });
    const result = promote("live-session-b");
    const projectMemory = f.store.list("memory_ledger", 20, record => (record.scope as JsonObject | undefined)?.kind === "project")[0]!;
    assert.ok(result.some(item => item.tier === "project"));
    assert.equal((result.find(item => item.tier === "project") as JsonObject).repetition_count, 2);
    const lineage = projectMemory.source_lineage as JsonObject[];
    assert.deepEqual(lineage.map(item => item.session_id).sort(), ["live-session-a", "live-session-b"]);
    assert.deepEqual(new Set(lineage.flatMap(item => (item.evidence_refs as JsonObject[]).map(ref => ref.id))).size, 2);
  } finally { await f.close(); }
});

test("repeated Memory promotion refuses a previously stored observation whose lineage disappeared", async () => {
  const f = await fixture();
  try {
    const captured = f.capture.captureObservedFact({ session_id: "lineage-loss-session", project_scope_id: "craft", turn_id: "lineage-loss-turn",
      task_id: "lineage-loss-task", content: CONTENT, topic: "project:verification" }) as JsonObject;
    const input = { sessionId: "lineage-loss-session", projectId: "craft", candidate: captured.candidate as JsonObject, evidence: captured.evidence as JsonObject };
    const promote = () => (f.capture as unknown as { promoteRepeatedFact(input: JsonObject): JsonObject[] }).promoteRepeatedFact(input);
    assert.deepEqual(promote(), []);
    const observation = f.store.list("memory_observation", 10)[0]!;
    const legacy = { ...observation };
    delete legacy.source_lineage;
    f.store.save("memory_observation", String(observation.id), legacy);
    const mismatchEvidence = f.addEvidence("lineage-loss-mismatch-topic-evidence", "bounded");
    f.store.create("memory_observation", "lineage-loss-mismatched-topic", { content_digest: String((input.candidate as JsonObject).content_digest),
      project_id: "craft", session_digest: digestJson("mismatched-topic-session"), kind: (input.candidate as JsonObject).kind,
      topic: "unrelated-topic", scope: { kind: "project", id: "craft" }, evidence_ids: [String(mismatchEvidence.id)],
      evidence_refs: [{ id: String(mismatchEvidence.id), version: mismatchEvidence.version }], content_free: true, status: "active" });
    assert.throws(promote, /lineage is unavailable/u);
  } finally { await f.close(); }
});

test("repeated Memory promotion uses an empty topic when a legacy candidate has no topic field", async () => {
  const f = await fixture();
  try {
    const captured = f.capture.captureObservedFact({ session_id: "legacy-topic-session", project_scope_id: "craft", turn_id: "legacy-topic-turn",
      content: CONTENT, topic: "project:verification" }) as JsonObject;
    const candidate = { ...(captured.candidate as JsonObject) };
    delete candidate.topic;
    const result = (f.capture as unknown as { promoteRepeatedFact(input: JsonObject): JsonObject[] }).promoteRepeatedFact({
      sessionId: "legacy-topic-session", projectId: "craft", candidate, evidence: captured.evidence as JsonObject,
    });
    assert.deepEqual(result, []);
    const observation = f.store.list("memory_observation", 1)[0]!;
    assert.equal(observation.topic, "");
  } finally { await f.close(); }
});

test("Memory Ledger merges exact live lineage and rejects replay attachment to legacy records", async () => {
  const f = await fixture();
  try {
    const evidence = f.addEvidence("memory-ledger-lineage-evidence", "bounded");
    const base = { memory_id: "lineaged-ledger", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: "craft",
      topic: "project:verification", content: CONTENT, sensitivity: "internal", confidence: "bounded", evidence_ids: [String(evidence.id)] };
    const firstLineage: JsonObject = { origin: "live_hook", session_id: "ledger-session-a", project_scope_id: PROJECT_SCOPE,
      source_ref: { kind: "codex_session_task", id: "ledger-task-a" }, evidence_refs: [{ kind: "evidence", id: String(evidence.id), version: evidence.version }] };
    const secondLineage: JsonObject = { ...firstLineage, session_id: "ledger-session-b", source_ref: { kind: "codex_session_task", id: "ledger-task-b" } };
    const first = f.ledger.remember({ ...base, source_lineage: [firstLineage] }) as JsonObject;
    const exactRetry = f.ledger.remember({ ...base, source_lineage: [firstLineage] }) as JsonObject;
    assert.equal(exactRetry.idempotent, true);
    assert.equal((exactRetry.memory as JsonObject).version, (first.memory as JsonObject).version);
    const retry = f.ledger.remember({ ...base, source_lineage: [secondLineage] }) as JsonObject;
    assert.equal(retry.idempotent, true);
    assert.deepEqual(((retry.memory as JsonObject).source_lineage as JsonObject[]).map(item => item.session_id).sort(), ["ledger-session-a", "ledger-session-b"]);

    const legacyArgs = { ...base, memory_id: "legacy-ledger" };
    f.ledger.remember(legacyArgs);
    assert.throws(() => f.ledger.remember({ ...legacyArgs, source_lineage: [lineage("replay-ledger", "replay-ledger-session", String(evidence.id))] }), /lineage is unavailable/u);

    const working = f.ledger.remember({ ...base, memory_id: "working-note-ledger", kind: "working", working_note: true,
      scope_kind: "project", scope_id: "craft", source_lineage: [firstLineage] }) as JsonObject;
    assert.equal((working.memory as JsonObject).working_note, true);
  } finally { await f.close(); }
});

test("historical Memory replay rejects held-out, development, incomplete and cross-scope provenance", async () => {
  const f = await fixture();
  try {
    const evidence = f.addReplayProjection("replay-a", f.addEvidence("memory-invalid-replay-evidence"));
    const valid = lineage("replay-a", "session-a", String(evidence.id));
    for (const args of [
      { ...replayArgs(valid, "held-out"), dataset_partition: "held_out" },
      { ...replayArgs(valid, "development"), dataset_partition: "development" },
      { ...replayArgs(valid, "missing-run"), source_lineage: [{ ...valid, replay_run_id: undefined }] },
      { ...replayArgs(valid, "wrong-scope"), source_lineage: [{ ...valid, project_scope_id: "project:other" }] },
      { ...replayArgs(valid, "missing-evidence"), source_lineage: [{ ...valid, evidence_refs: [] }] },
    ]) {
      assert.throws(() => f.capture.captureHistoricalReplayCandidate(args), /partition|lineage|scope|Evidence|evidence_refs/u);
    }
    assert.throws(() => f.capture.captureHistoricalReplayCandidate({ ...replayArgs(valid), source_lineage: [{ ...valid, evidence_refs: [{ kind: "evidence", id: String(evidence.id), version: 2 }] }] }), /missing or changed/u);
    const sourceEvidence = f.addEvidence("memory-unprojected-source-evidence");
    const unprojected = lineage("replay-a", "session-unprojected", String(sourceEvidence.id));
    assert.throws(() => f.capture.captureHistoricalReplayCandidate(replayArgs(unprojected)), /owner-local Evidence projection/u);
    const otherRunProjection = f.addReplayProjection("replay-other-run", sourceEvidence);
    assert.throws(() => f.capture.captureHistoricalReplayCandidate(replayArgs(lineage("replay-a", "session-wrong-projection-run", String(otherRunProjection.id)))), /belongs to another run/u);
    f.governance.propose({ candidate_id: "legacy-memory-candidate", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: "craft",
      topic: "project:verification", content: CONTENT, sensitivity: "internal", confidence: "unverified", evidence_ids: [String(sourceEvidence.id)], proposal_only: true });
    const legacyReplayProjection = f.addReplayProjection("replay-a", sourceEvidence);
    assert.throws(() => f.capture.captureHistoricalReplayCandidate(replayArgs(lineage("replay-a", "session-legacy", String(legacyReplayProjection.id)), "legacy-memory-candidate")), /lineage is unavailable/u);
    assert.equal(f.store.list("memory_candidate", 20, item => item.id !== "legacy-memory-candidate").length, 0);
    assert.equal(f.store.list("memory_ledger", 20).length, 0);
  } finally { await f.close(); }
});

test("historical Memory capture supplies stable defaults and cleanup receipts are idempotent", async () => {
  const f = await fixture();
  try {
    const evidence = f.addReplayProjection("replay-defaults", f.addEvidence("memory-defaults-evidence"));
    const source = lineage("replay-defaults", "session-defaults", String(evidence.id));
    const args = replayArgs(source);
    delete args.candidate_id; delete args.kind; delete args.topic; delete args.source_id; delete args.scope_envelope; delete args.sensitivity;
    const captured = f.capture.captureHistoricalReplayCandidate(args) as JsonObject;
    assert.equal((captured.candidate as JsonObject).id, (f.capture.captureHistoricalReplayCandidate(args).candidate as JsonObject).id);
    assert.equal(captured.status, "candidate");
    const preview = f.capture.historicalReplayCleanupPreview({ replay_run_id: "empty-run" }) as JsonObject;
    const first = f.capture.historicalReplayCleanupApply({ replay_run_id: "empty-run", expected_manifest_digest: preview.manifest_digest }) as JsonObject;
    assert.equal(first.status, "cleaned");
    assert.equal((first.cleaned as JsonObject[]).length, 0);
    const again = f.capture.historicalReplayCleanupApply({ replay_run_id: "empty-run", expected_manifest_digest: preview.manifest_digest }) as JsonObject;
    assert.equal(again.idempotent, true);
  } finally { await f.close(); }
});

test("historical Memory replay preserves explicit expiry and live captures without scope omit provenance", async () => {
  const f = await fixture();
  try {
    const evidence = f.addReplayProjection("replay-expiry", f.addEvidence("memory-explicit-expiry-evidence"));
    const expires = "2099-01-01T00:00:00.000Z";
    const replay = f.capture.captureHistoricalReplayCandidate({ ...replayArgs(lineage("replay-expiry", "session-expiry", String(evidence.id))),
      scope_envelope: null, valid_until: expires }) as JsonObject;
    assert.equal((replay.candidate as JsonObject).valid_until, expires);

    const compatibilityCapture = f.capture.captureUserStatement({ content: "Prefer concise design reviews.", topic: "project:review" }) as JsonObject;
    assert.deepEqual((compatibilityCapture.candidate as JsonObject).source_lineage, []);
  } finally { await f.close(); }
});

test("historical Memory response falls back safely when a proposal is unavailable and cleanup rejects bad object kinds", async () => {
  const f = await fixture();
  try {
    const evidence = f.addReplayProjection("replay-unavailable", f.addEvidence("memory-unavailable-proposal-evidence"));
    const args = replayArgs(lineage("replay-unavailable", "session-unavailable", String(evidence.id)));
    const originalPropose = f.governance.propose.bind(f.governance);
    f.governance.propose = (() => ({ candidate: null, status: null })) as typeof f.governance.propose;
    const unavailable = f.capture.captureHistoricalReplayCandidate(args) as JsonObject;
    assert.equal(unavailable.status, "candidate");
    assert.equal(unavailable.auto_committed, false);
    f.governance.propose = originalPropose;

    const originalPreview = f.capture.historicalReplayCleanupPreview.bind(f.capture);
    f.capture.historicalReplayCleanupPreview = (() => ({ owner: "memory", replay_run_id: "unknown-kind-run", manifest_digest: "test-manifest",
      items: [{ kind: "unknown", id: "x", version: 1, lineage_digest: "test", action: "revoke" }] })) as typeof f.capture.historicalReplayCleanupPreview;
    assert.throws(() => f.capture.historicalReplayCleanupApply({ replay_run_id: "unknown-kind-run", expected_manifest_digest: "test-manifest" }), /object kind is unsupported/u);
    f.capture.historicalReplayCleanupPreview = originalPreview;
  } finally { await f.close(); }
});

test("replaying the same Memory candidate is idempotent and distinct lineage is merged", async () => {
  const f = await fixture();
  try {
    const firstEvidence = f.addReplayProjection("replay-a", f.addEvidence("memory-replay-evidence-a"));
    const secondEvidence = f.addReplayProjection("replay-b", f.addEvidence("memory-replay-evidence-b"));
    const first = f.capture.captureHistoricalReplayCandidate(replayArgs(lineage("replay-a", "session-a", String(firstEvidence.id)))) as JsonObject;
    const sameRun = f.capture.captureHistoricalReplayCandidate(replayArgs(lineage("replay-a", "session-a", String(firstEvidence.id)))) as JsonObject;
    assert.equal(sameRun.idempotent, true);
    assert.equal((sameRun.candidate as JsonObject).version, (first.candidate as JsonObject).version);
    const merged = f.capture.captureHistoricalReplayCandidate(replayArgs(lineage("replay-b", "session-b", String(secondEvidence.id)))) as JsonObject;
    const candidate = merged.candidate as JsonObject;
    assert.equal(candidate.id, (first.candidate as JsonObject).id);
    assert.equal(merged.idempotent, true);
    assert.deepEqual((candidate.source_lineage as JsonObject[]).map(item => item.replay_run_id).sort(), ["replay-a", "replay-b"]);
    assert.deepEqual((candidate.evidence_ids as string[]).sort(), [String(firstEvidence.id), String(secondEvidence.id)].sort());
    assert.equal(candidate.status, "candidate");
    assert.equal(f.store.list("memory_ledger", 20).length, 0);
    assert.throws(() => f.capture.captureHistoricalReplayCandidate({ ...replayArgs(lineage("replay-a", "session-a", String(firstEvidence.id)), String(candidate.id)),
      content: "A conflicting Memory candidate." }), /idempotency conflict/u);

    const missingEvidenceCandidate = f.capture.captureHistoricalReplayCandidate(replayArgs(lineage("replay-missing-evidence", "session-missing-evidence",
      String(f.addReplayProjection("replay-missing-evidence", f.addEvidence("memory-replay-missing-evidence-source")).id)), "candidate-missing-evidence-array")) as JsonObject;
    const missingEvidenceRecord = { ...f.store.get("memory_candidate", String((missingEvidenceCandidate.candidate as JsonObject).id)) };
    delete missingEvidenceRecord.evidence_ids;
    f.store.save("memory_candidate", String(missingEvidenceRecord.id), missingEvidenceRecord);
    const repairProjection = f.addReplayProjection("replay-missing-evidence-repair", f.addEvidence("memory-replay-repair-source"));
    const repaired = f.capture.captureHistoricalReplayCandidate(replayArgs(lineage("replay-missing-evidence-repair", "session-missing-evidence-repair",
      String(repairProjection.id)), String(missingEvidenceRecord.id))) as JsonObject;
    assert.deepEqual((repaired.candidate as JsonObject).evidence_ids, [String(repairProjection.id)]);
  } finally { await f.close(); }
});

test("Memory replay cleanup revokes and redacts replay-only candidates after manifest verification", async () => {
  const f = await fixture();
  try {
    const evidence = f.addReplayProjection("replay-clean", f.addEvidence("memory-cleanup-evidence"));
    const captured = f.capture.captureHistoricalReplayCandidate(replayArgs(lineage("replay-clean", "session-clean", String(evidence.id)))) as JsonObject;
    const candidate = captured.candidate as JsonObject;
    const secondCaptured = f.capture.captureHistoricalReplayCandidate(replayArgs(lineage("replay-clean", "session-clean-second", String(evidence.id)), "memory-cleanup-second")) as JsonObject;
    const firstStored = { ...f.store.get("memory_candidate", String(candidate.id)) };
    delete firstStored.topic;
    firstStored.promotion_support_refs = [];
    f.store.save("memory_candidate", String(candidate.id), firstStored);
    const secondStored = f.store.get("memory_candidate", String((secondCaptured.candidate as JsonObject).id));
    f.store.save("memory_candidate", String(secondStored.id), { ...secondStored, promotion_support_refs: [{ kind: "memory_observation", id: "support-ref", version: 1 }] });
    const preview = f.capture.historicalReplayCleanupPreview({ replay_run_id: "replay-clean" }) as JsonObject;
    assert.equal(preview.owner, "memory");
    assert.equal((preview.items as JsonObject[]).length, 3);
    assert.ok((preview.items as JsonObject[]).some(item => item.kind === "memory_candidate" && item.action === "revoke"));
    assert.ok((preview.items as JsonObject[]).some(item => item.kind === "evidence_projection" && item.action === "revoke"));
    assert.equal(JSON.stringify(preview).includes(CONTENT), false);
    assert.throws(() => f.capture.historicalReplayCleanupApply({ replay_run_id: "replay-clean", expected_manifest_digest: "sha256:wrong" }), /manifest/u);
    assert.equal(f.store.get("memory_candidate", String(candidate.id)).status, "candidate");
    const applied = f.capture.historicalReplayCleanupApply({ replay_run_id: "replay-clean", expected_manifest_digest: preview.manifest_digest }) as JsonObject;
    assert.equal(applied.status, "cleaned");
    const retired = f.store.get("memory_candidate", String(candidate.id));
    assert.equal(retired.status, "rejected");
    assert.equal(retired.content, undefined);
    assert.deepEqual(retired.source_lineage, []);
    const projection = f.store.find("evidence", String(evidence.id))!;
    assert.equal((projection.metadata as JsonObject).projection_status, "revoked");
    assert.equal(f.store.list("memory_candidate", 20, row => row.status === "candidate").length, 0);
  } finally { await f.close(); }
});

test("Memory cleanup removes only replay lineage from a mixed-source candidate", async () => {
  const f = await fixture();
  try {
    const liveEvidence = f.addEvidence("memory-live-evidence");
    const replayEvidence = f.addReplayProjection("replay-mixed", f.addEvidence("memory-mixed-replay-evidence"));
    const live = { origin: "live_hook", session_id: "live-session", project_scope_id: PROJECT_SCOPE,
      source_ref: { kind: "codex_session", id: "live-session" }, evidence_refs: [{ kind: "evidence", id: String(liveEvidence.id), version: 1 }] };
    const replay = lineage("replay-mixed", "replay-session", String(replayEvidence.id));
    f.governance.propose({ candidate_id: "mixed-memory-candidate", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: "craft",
      topic: "project:verification", content: CONTENT, sensitivity: "internal", confidence: "unverified", evidence_ids: [String(liveEvidence.id)],
      proposal_only: true, proposed_by: "live-hook", source_lineage: [live] });
    f.capture.captureHistoricalReplayCandidate(replayArgs(replay, "mixed-memory-candidate"));
    const preview = f.capture.historicalReplayCleanupPreview({ replay_run_id: "replay-mixed" }) as JsonObject;
    const item = (preview.items as JsonObject[]).find(row => row.kind === "memory_candidate")!;
    assert.equal(item.action, "remove_replay_lineage");
    const result = f.capture.historicalReplayCleanupApply({ replay_run_id: "replay-mixed", expected_manifest_digest: preview.manifest_digest }) as JsonObject;
    assert.equal(result.status, "cleaned");
    const retained = f.store.get("memory_candidate", "mixed-memory-candidate");
    assert.equal(retained.status, "candidate");
    assert.equal(retained.content, CONTENT);
    assert.deepEqual(retained.source_lineage, [live]);
    assert.deepEqual(retained.evidence_ids, [String(liveEvidence.id)]);
  } finally { await f.close(); }
});

test("Memory replay candidates cannot be approved and cleanup revokes pre-existing replay Ledger records", async () => {
  const f = await fixture();
  try {
    const evidence = f.addReplayProjection("replay-committed", f.addEvidence("memory-manual-commit-evidence", "bounded"));
    const captured = f.capture.captureHistoricalReplayCandidate(replayArgs(lineage("replay-committed", "session-committed", String(evidence.id)))) as JsonObject;
    const candidate = captured.candidate as JsonObject;
    assert.throws(() => f.governance.review({ candidate_id: candidate.id, decision: "approve", reviewer: "test-reviewer", reason: "manual review" }), /cannot be approved/u);
    f.store.save("memory_candidate", String(candidate.id), { ...candidate, status: "approved" });
    assert.throws(() => f.governance.remember({ candidate_id: candidate.id }), /cannot enter the Ledger/u);
    f.store.save("memory_candidate", String(candidate.id), { ...f.store.get("memory_candidate", String(candidate.id)), status: "candidate" });
    const memoryResult = f.ledger.remember({ memory_id: "legacy-replay-ledger", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "project", scope_id: "craft",
      topic: "project:verification", content: CONTENT, sensitivity: "internal", confidence: "unverified", evidence_ids: [String(evidence.id)], source_lineage: candidate.source_lineage });
    const memory = memoryResult.memory as JsonObject;
    const preview = f.capture.historicalReplayCleanupPreview({ replay_run_id: "replay-committed" }) as JsonObject;
    assert.deepEqual((preview.items as JsonObject[]).map(item => item.kind).sort(), ["evidence_projection", "memory_candidate", "memory_ledger"]);
    const applied = f.capture.historicalReplayCleanupApply({ replay_run_id: "replay-committed", expected_manifest_digest: preview.manifest_digest }) as JsonObject;
    assert.equal(applied.status, "cleaned");
    assert.equal(f.store.get("memory_ledger", String(memory.id)).status, "revoked");
    const revokedMemory = f.store.get("memory_ledger", String(memory.id));
    assert.deepEqual(revokedMemory.source_lineage, []);
    assert.equal(f.store.contentStore.readCompatSync(revokedMemory.content_ref as never).body, "This historical replay Memory content was revoked.");
    assert.equal(f.store.get("memory_candidate", String(candidate.id)).status, "rejected");
  } finally { await f.close(); }
});

test("Memory cleanup fails closed when a replay object has malformed lineage", async () => {
  const f = await fixture();
  try {
    const evidence = f.addReplayProjection("replay-corrupt", f.addEvidence("memory-corrupt-lineage-evidence"));
    const captured = f.capture.captureHistoricalReplayCandidate(replayArgs(lineage("replay-corrupt", "session-corrupt", String(evidence.id)))) as JsonObject;
    const candidate = captured.candidate as JsonObject;
    f.store.save("memory_candidate", String(candidate.id), { ...candidate, source_lineage: [{ origin: "historical_replay", replay_run_id: "replay-corrupt" }] });
    assert.throws(() => f.capture.historicalReplayCleanupPreview({ replay_run_id: "replay-corrupt" }), /lineage|scope/u);
    assert.equal(f.store.get("memory_candidate", String(candidate.id)).status, "candidate");
  } finally { await f.close(); }
});

test("Memory cleanup fails closed when Evidence identity is incomplete or an object changes after preview", async () => {
  const f = await fixture();
  try {
    const evidence = f.addReplayProjection("replay-race", f.addEvidence("memory-cleanup-race-evidence"));
    const captured = f.capture.captureHistoricalReplayCandidate(replayArgs(lineage("replay-race", "session-race", String(evidence.id)))) as JsonObject;
    const candidate = captured.candidate as JsonObject;
    f.store.save("memory_candidate", String(candidate.id), { ...candidate, evidence_ids: [...candidate.evidence_ids as string[], "unrelated-evidence"] });
    const incompletePreview = f.capture.historicalReplayCleanupPreview({ replay_run_id: "replay-race" }) as JsonObject;
    assert.throws(() => f.capture.historicalReplayCleanupApply({ replay_run_id: "replay-race", expected_manifest_digest: incompletePreview.manifest_digest }), /Evidence lineage is incomplete/u);
    const current = f.store.get("memory_candidate", String(candidate.id));
    const missingEvidenceIds = { ...current };
    delete missingEvidenceIds.evidence_ids;
    f.store.save("memory_candidate", String(candidate.id), missingEvidenceIds);
    const missingEvidencePreview = f.capture.historicalReplayCleanupPreview({ replay_run_id: "replay-race" }) as JsonObject;
    assert.throws(() => f.capture.historicalReplayCleanupApply({ replay_run_id: "replay-race", expected_manifest_digest: missingEvidencePreview.manifest_digest }), /Evidence lineage is incomplete/u);
    f.store.save("memory_candidate", String(candidate.id), { ...f.store.get("memory_candidate", String(candidate.id)), evidence_ids: [String(evidence.id)] });
    const preview = f.capture.historicalReplayCleanupPreview({ replay_run_id: "replay-race" }) as JsonObject;
    const originalGet = f.store.get.bind(f.store);
    f.store.get = ((kind: string, id: string, ...rest: unknown[]) => {
      const record = originalGet(kind, id, ...(rest as [number?]));
      return kind === "memory_candidate" && id === String(candidate.id) ? { ...record, version: Number(record.version) + 1 } : record;
    }) as typeof f.store.get;
    assert.throws(() => f.capture.historicalReplayCleanupApply({ replay_run_id: "replay-race", expected_manifest_digest: preview.manifest_digest }), /changed after cleanup preview/u);
    f.store.get = originalGet;

    const projectionSource = f.addEvidence("memory-projection-race-source");
    const projection = f.addReplayProjection("replay-projection-race", projectionSource);
    f.capture.captureHistoricalReplayCandidate(replayArgs(lineage("replay-projection-race", "projection-race-session", String(projection.id))));
    const projectionPreview = f.capture.historicalReplayCleanupPreview({ replay_run_id: "replay-projection-race" }) as JsonObject;
    const originalProjectionGet = f.store.get.bind(f.store);
    f.store.get = ((kind: string, id: string, ...rest: unknown[]) => {
      const record = originalProjectionGet(kind, id, ...(rest as [number?]));
      return kind === "evidence" && id === String(projection.id) ? { ...record, version: Number(record.version) + 1 } : record;
    }) as typeof f.store.get;
    assert.throws(() => f.capture.historicalReplayCleanupApply({ replay_run_id: "replay-projection-race",
      expected_manifest_digest: projectionPreview.manifest_digest }), /changed after cleanup preview/u);
    f.store.get = originalProjectionGet;
  } finally { await f.close(); }
});

test("Memory cleanup redacts inline replay Ledger bodies and rejects bodyless legacy Ledger records", async () => {
  const f = await fixture();
  try {
    const evidence = f.addReplayProjection("replay-inline-ledger", f.addEvidence("memory-inline-ledger-evidence"));
    const now = new Date().toISOString();
    const replayLineage = lineage("replay-inline-ledger", "inline-session", String(evidence.id));
    f.store.create("memory_ledger", "inline-replay-ledger", { source_id: "builtin.evidence-wiki", source_version: 1, kind: "preference",
      scope: { kind: "project", id: "craft" }, scope_envelope: null, content: CONTENT, content_digest: "inline-content-digest", sensitivity: "internal",
      confidence: "unverified", evidence_ids: [String(evidence.id)], valid_until: null, observed_at: now, effective_from: now, working_note: false,
      promotion_support_refs: [{ kind: "memory_ledger", id: "fixture-support", version: 1 }], status: "active", source_lineage: [replayLineage] });
    const preview = f.capture.historicalReplayCleanupPreview({ replay_run_id: "replay-inline-ledger" }) as JsonObject;
    assert.ok((preview.items as JsonObject[]).some(item => item.kind === "memory_ledger"));
    const applied = f.capture.historicalReplayCleanupApply({ replay_run_id: "replay-inline-ledger", expected_manifest_digest: preview.manifest_digest }) as JsonObject;
    assert.ok((applied.cleaned as JsonObject[]).some(item => item.kind === "memory_ledger" && item.id === "inline-replay-ledger"));
    assert.ok((applied.cleaned as JsonObject[]).some(item => item.kind === "evidence_projection"));
    const revoked = f.store.get("memory_ledger", "inline-replay-ledger");
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.content, "This historical replay Memory content was revoked.");
    assert.deepEqual(revoked.source_lineage, []);

    const brokenEvidence = f.addReplayProjection("replay-bodyless", f.addEvidence("memory-bodyless-ledger-evidence"));
    f.store.create("memory_ledger", "bodyless-replay-ledger", { source_id: "builtin.evidence-wiki", source_version: 1, kind: "preference",
      scope: { kind: "project", id: "craft" }, content_digest: "missing-body", sensitivity: "internal", confidence: "unverified",
      evidence_ids: [String(brokenEvidence.id)], status: "active", source_lineage: [lineage("replay-bodyless", "bodyless-session", String(brokenEvidence.id))] });
    const brokenPreview = f.capture.historicalReplayCleanupPreview({ replay_run_id: "replay-bodyless" }) as JsonObject;
    assert.throws(() => f.capture.historicalReplayCleanupApply({ replay_run_id: "replay-bodyless", expected_manifest_digest: brokenPreview.manifest_digest }), /cannot be safely redacted/u);
  } finally { await f.close(); }
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "craft-common-store-local/store";
import { craftPaths } from "craft-common-store-local/paths";
import { stableDigest } from "craft-common-base/digest";
import { KnowledgeAutoReviewKernel } from "../knowledge-auto-review.ts";
import { KnowledgeClaimGovernance } from "../claim-governance.ts";

const PROJECT_SCOPE = "project:craft";
const CONTENT = "This project uses focused verification.";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-replay-"));
  const store = await new CraftStore(craftPaths(root)).open();
  store.create("knowledge_source", "builtin.evidence-wiki", { scope: { kind: "global", id: "global" }, status: "active", trust: "verified", content_digest: "source-v1" });
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  store.create("scope_alias", "knowledge-replay-project", { scope: { kind: "project", id: "project:craft" }, alias_kind: "path", alias: projectRoot,
    alias_digest: stableDigest(projectRoot), status: "active" });
  const governance = new KnowledgeClaimGovernance(store);
  const review = new KnowledgeAutoReviewKernel(store);
  function addEvidence(id: string, confidence = "bounded") {
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
  return { root, store, governance, review, addEvidence, addReplayProjection, close };
}

function lineage(runId: string, sessionId: string, evidenceId: string): JsonObject {
  return { origin: "historical_replay", replay_run_id: runId, session_id: sessionId, turn_id: `${sessionId}-turn`, project_scope_id: PROJECT_SCOPE,
    source_ref: { kind: "codex_session_task", id: sessionId, digest: `sha256:${"a".repeat(64)}` },
    evidence_refs: [{ kind: "evidence", id: evidenceId, version: 1 }] };
}

function replayArgs(sourceLineage: JsonObject, claimId = "knowledge-replay-candidate"): JsonObject {
  return { claim_id: claimId, scope: PROJECT_SCOPE, project_scope_id: PROJECT_SCOPE, kind: "fact", content: CONTENT,
    source_lineage: [sourceLineage], dataset_partition: "candidate_generation" };
}

test("historical Knowledge replay creates only a candidate and auto promotion remains blocked", async () => {
  const f = await fixture();
  try {
    const evidence = f.addReplayProjection("run-a", f.addEvidence("knowledge-replay-evidence"));
    const captured = f.governance.captureHistoricalReplayCandidate(replayArgs(lineage("run-a", "session-a", String(evidence.id)))) as JsonObject;
    const claim = captured.claim as JsonObject;
    assert.equal(captured.status, "candidate");
    assert.equal(captured.auto_committed, false);
    assert.equal(claim.status, "candidate");
    assert.deepEqual(claim.source_lineage, [lineage("run-a", "session-a", String(evidence.id))]);
    const assessment = f.review.assess({ scope_kind: "project", scope_id: "craft", auto_promote: true }) as JsonObject;
    const item = (assessment.assessments as JsonObject[]).find(row => row.claim_id === claim.id)!;
    assert.equal(item.verdict, "revalidation_required");
    assert.ok((item.reasons as string[]).includes("historical_replay_requires_separately_sourced_live_candidate"));
    assert.equal(f.store.get("knowledge_claim", String(claim.id)).status, "candidate");
    const hostReview = f.review.hostReview({ claim_id: String(claim.id), host_run_key: "replay-review", decision: "supported", source_digest: "source-v1" }) as JsonObject;
    assert.equal(hostReview.promoted, false);
    assert.ok((hostReview.blocking_reasons as string[]).includes("historical_replay_requires_separately_sourced_live_candidate"));
  } finally { await f.close(); }
});

test("historical Knowledge replay rejects held-out, incomplete, cross-project and unlineaged legacy candidates", async () => {
  const f = await fixture();
  try {
    const sourceEvidence = f.addEvidence("knowledge-invalid-replay-evidence");
    const evidence = f.addReplayProjection("run-a", sourceEvidence);
    const valid = lineage("run-a", "session-a", String(evidence.id));
    for (const args of [
      { ...replayArgs(valid, "held-out"), dataset_partition: "held_out" },
      { ...replayArgs(valid, "missing-run"), source_lineage: [{ ...valid, replay_run_id: undefined }] },
      { ...replayArgs(valid, "wrong-project"), source_lineage: [{ ...valid, project_scope_id: "project:other" }] },
      { ...replayArgs(valid, "wrong-scope"), scope: "project:other" },
      { ...replayArgs(valid, "missing-evidence"), source_lineage: [{ ...valid, evidence_refs: [] }] },
      { ...replayArgs(valid, "unknown-evidence"), source_lineage: [{ ...valid, evidence_refs: [{ kind: "evidence", id: "missing-evidence", version: 1 }] }] },
      { ...replayArgs(valid, "unprojected-evidence"), source_lineage: [{ ...valid, evidence_refs: [{ kind: "evidence", id: String(sourceEvidence.id), version: sourceEvidence.version }] }] },
      { ...replayArgs(valid, "wrong-projection-run"), source_lineage: [{ ...valid, evidence_refs: [{ kind: "evidence",
        id: String(f.addReplayProjection("run-other", sourceEvidence).id), version: 1 }] }] },
    ]) assert.throws(() => f.governance.captureHistoricalReplayCandidate(args), /partition|lineage|scope|evidence_refs|Evidence/u);
    assert.throws(() => f.governance.knowledgeClaimSave({ claim_id: "forged-lineage", scope: PROJECT_SCOPE, kind: "fact", content: CONTENT,
      evidence_ids: [String(sourceEvidence.id)], source_lineage: [valid] }), /owner-validated/u);
    f.governance.knowledgeClaimSave({ claim_id: "legacy-candidate", scope: PROJECT_SCOPE, kind: "fact", content: CONTENT, evidence_ids: [String(sourceEvidence.id)] });
    assert.throws(() => f.governance.captureHistoricalReplayCandidate(replayArgs(valid, "legacy-candidate")), /lineage is unavailable/u);
    assert.deepEqual(f.store.find("knowledge_claim", "legacy-candidate")?.source_lineage, []);
  } finally { await f.close(); }
});

test("live Knowledge Hook capture binds actual Evidence version and keeps the claim pending", async () => {
  const f = await fixture();
  try {
    const evidence = f.addEvidence("knowledge-live-hook-evidence");
    const live: JsonObject = { origin: "live_hook", session_id: "live-session", turn_id: "live-turn", task_id: "live-task", project_scope_id: PROJECT_SCOPE,
      source_ref: { kind: "codex_session_task", id: "live-task", digest: `sha256:${"c".repeat(64)}` },
      evidence_refs: [{ kind: "evidence", id: String(evidence.id), version: evidence.version }] };
    const captured = f.governance.captureLiveHookCandidate({ kind: "fact", content: CONTENT, scope: PROJECT_SCOPE, evidence_ids: [String(evidence.id)], source_lineage: [live] }) as JsonObject;
    const claim = captured.claim as JsonObject;
    assert.equal(captured.status, "candidate");
    assert.equal(captured.auto_committed, false);
    assert.equal((captured.candidate as JsonObject).id, claim.id);
    assert.deepEqual(claim.source_lineage, [live]);
    const exactRetry = f.governance.captureLiveHookCandidate({ kind: "fact", content: CONTENT, scope: PROJECT_SCOPE,
      evidence_ids: [String(evidence.id)], source_lineage: [live] }) as JsonObject;
    assert.equal(exactRetry.idempotent, true);
    assert.equal((exactRetry.claim as JsonObject).version, claim.version);
    assert.throws(() => f.governance.captureLiveHookCandidate({ kind: "fact", content: CONTENT, scope: PROJECT_SCOPE, evidence_ids: [String(evidence.id)],
      source_lineage: [{ ...live, evidence_refs: [{ kind: "evidence", id: String(evidence.id), version: Number(evidence.version) + 1 }] }] }), /missing or changed/u);
    assert.throws(() => f.governance.captureLiveHookCandidate({ kind: "fact", content: CONTENT, scope: PROJECT_SCOPE, evidence_ids: [String(evidence.id)], source_lineage: [] }), /matching live_hook/u);
    assert.throws(() => f.governance.captureLiveHookCandidate({ kind: "fact", content: CONTENT, scope: "user:local", evidence_ids: [String(evidence.id)], source_lineage: [live] }), /project scope/u);
    assert.throws(() => f.governance.captureLiveHookCandidate({ kind: "fact", content: CONTENT, scope: PROJECT_SCOPE, evidence_ids: ["different-evidence"], source_lineage: [live] }), /must match lineage/u);

    f.store.save("knowledge_claim", String(claim.id), { ...claim, status: "reviewed" });
    const replayEvidence = f.addReplayProjection("run-reviewed", evidence);
    assert.throws(() => f.governance.captureHistoricalReplayCandidate(replayArgs(lineage("run-reviewed", "replay-session", String(replayEvidence.id)), String(claim.id))), /cannot attach to an enabled/u);
  } finally { await f.close(); }
});

test("replay retries merge exact source lineage and accumulate independent Evidence", async () => {
  const f = await fixture();
  try {
    const a = f.addReplayProjection("run-a", f.addEvidence("knowledge-replay-evidence-a"));
    const b = f.addReplayProjection("run-b", f.addEvidence("knowledge-replay-evidence-b"));
    const first = f.governance.captureHistoricalReplayCandidate(replayArgs(lineage("run-a", "session-a", String(a.id)))) as JsonObject;
    const retry = f.governance.captureHistoricalReplayCandidate(replayArgs(lineage("run-a", "session-a", String(a.id)))) as JsonObject;
    assert.equal(retry.idempotent, true);
    assert.equal((retry.claim as JsonObject).version, (first.claim as JsonObject).version);
    const secondOccurrence = f.governance.captureHistoricalReplayCandidate(replayArgs(lineage("run-a", "session-a-second", String(a.id)))) as JsonObject;
    assert.equal(secondOccurrence.idempotent, false);
    assert.equal(((secondOccurrence.claim as JsonObject).source_lineage as JsonObject[]).length, 2);
    const conflictEvidence = f.addReplayProjection("run-conflict", f.addEvidence("knowledge-replay-conflict-evidence"));
    assert.throws(() => f.governance.captureHistoricalReplayCandidate({ ...replayArgs(lineage("run-conflict", "session-conflict", String(conflictEvidence.id))),
      content: "A conflicting Knowledge claim.", claim_id: String((first.claim as JsonObject).id) }), /idempotency conflict/u);
    const merged = f.governance.captureHistoricalReplayCandidate(replayArgs(lineage("run-b", "session-b", String(b.id)))) as JsonObject;
    assert.equal(merged.idempotent, false);
    assert.deepEqual(((merged.claim as JsonObject).source_lineage as JsonObject[]).map(item => item.replay_run_id).sort(), ["run-a", "run-a", "run-b"]);
    assert.deepEqual(((merged.claim as JsonObject).evidence_ids as string[]).sort(), [String(a.id), String(b.id)].sort());
    const reduced = f.addReplayProjection("run-reduced", f.addEvidence("knowledge-reduced-lineage-evidence"));
    const saveClaim = (f.governance as unknown as { saveClaim(args: JsonObject, lineage: JsonObject[]): JsonObject }).saveClaim.bind(f.governance);
    assert.throws(() => saveClaim({ claim_id: String((first.claim as JsonObject).id), scope: PROJECT_SCOPE, kind: "fact", content: CONTENT,
      evidence_ids: [String(reduced.id)] }, [lineage("run-reduced", "session-reduced", String(reduced.id))]), /idempotency conflict/u);
  } finally { await f.close(); }
});

test("historical Knowledge capture derives a stable candidate ID and default kind", async () => {
  const f = await fixture();
  try {
    const evidence = f.addReplayProjection("run-default", f.addEvidence("knowledge-default-evidence"));
    const args = replayArgs(lineage("run-default", "session-default", String(evidence.id)));
    delete args.claim_id; delete args.kind;
    const first = f.governance.captureHistoricalReplayCandidate(args) as JsonObject;
    const second = f.governance.captureHistoricalReplayCandidate(args) as JsonObject;
    assert.equal((first.claim as JsonObject).id, (second.claim as JsonObject).id);
    assert.equal((first.claim as JsonObject).kind, "fact");
  } finally { await f.close(); }
});

test("historical Knowledge capture repairs a candidate with missing Evidence ids without claiming old evidence", async () => {
  const f = await fixture();
  try {
    const firstProjection = f.addReplayProjection("run-missing-evidence-a", f.addEvidence("knowledge-missing-evidence-source-a"));
    const args = replayArgs(lineage("run-missing-evidence-a", "session-missing-evidence-a", String(firstProjection.id)), "missing-evidence-claim");
    const first = f.governance.captureHistoricalReplayCandidate(args) as JsonObject;
    const claim = first.claim as JsonObject;
    const stored = { ...f.store.get("knowledge_claim", String(claim.id)) };
    delete stored.evidence_ids;
    f.store.save("knowledge_claim", String(claim.id), stored);
    const restored = f.governance.captureHistoricalReplayCandidate(args) as JsonObject;
    assert.deepEqual((restored.claim as JsonObject).evidence_ids, [String(firstProjection.id)]);
    const secondProjection = f.addReplayProjection("run-missing-evidence-b", f.addEvidence("knowledge-missing-evidence-source-b"));
    const recovered = f.governance.captureHistoricalReplayCandidate(replayArgs(lineage("run-missing-evidence-b", "session-missing-evidence-b",
      String(secondProjection.id)), String(claim.id))) as JsonObject;
    assert.deepEqual(((recovered.claim as JsonObject).evidence_ids as string[]).sort(), [String(firstProjection.id), String(secondProjection.id)].sort());
    assert.deepEqual(((recovered.claim as JsonObject).source_lineage as JsonObject[]).map(item => item.replay_run_id), ["run-missing-evidence-a", "run-missing-evidence-b"]);
  } finally { await f.close(); }
});

test("Knowledge cleanup tolerates a redacted content reference without a projection path", async () => {
  const f = await fixture();
  try {
    const evidence = f.addReplayProjection("run-no-path", f.addEvidence("knowledge-no-path-source"));
    const captured = f.governance.captureHistoricalReplayCandidate(replayArgs(lineage("run-no-path", "session-no-path", String(evidence.id)), "no-path-claim")) as JsonObject;
    const originalRewrite = f.store.contentStore.rewriteSync.bind(f.store.contentStore);
    f.store.contentStore.rewriteSync = (args => {
      const ref = originalRewrite(args);
      const { path: _path, ...withoutPath } = ref;
      return withoutPath;
    }) as typeof f.store.contentStore.rewriteSync;
    const preview = f.governance.historicalReplayCleanupPreview({ replay_run_id: "run-no-path" }) as JsonObject;
    const result = f.governance.historicalReplayCleanupApply({ replay_run_id: "run-no-path", expected_manifest_digest: preview.manifest_digest }) as JsonObject;
    assert.ok((result.cleaned as JsonObject[]).some(item => item.kind === "knowledge_claim" && item.id === (captured.claim as JsonObject).id));
  } finally { await f.close(); }
});

test("Knowledge cleanup redacts replay-only Claims and removes only replay lineage from mixed Claims", async () => {
  const f = await fixture();
  try {
    const evidence = f.addReplayProjection("run-clean", f.addEvidence("knowledge-cleanup-evidence"));
    const captured = f.governance.captureHistoricalReplayCandidate({ ...replayArgs(lineage("run-clean", "session-clean", String(evidence.id)), "cleanup-claim"),
      title: "Focused verification" }) as JsonObject;
    const claim = captured.claim as JsonObject;
    f.governance.captureHistoricalReplayCandidate(replayArgs(lineage("run-clean", "session-clean-second", String(evidence.id)), "cleanup-second-claim"));
    const preview = f.governance.historicalReplayCleanupPreview({ replay_run_id: "run-clean" }) as JsonObject;
    assert.equal(preview.owner, "knowledge");
    assert.ok((preview.items as JsonObject[]).some(item => item.kind === "knowledge_claim" && item.action === "revoke"));
    assert.ok((preview.items as JsonObject[]).some(item => item.kind === "evidence_projection" && item.action === "revoke"));
    assert.equal(JSON.stringify(preview).includes(CONTENT), false);
    assert.throws(() => f.governance.historicalReplayCleanupApply({ replay_run_id: "run-clean", expected_manifest_digest: "sha256:wrong" }), /manifest/u);
    const applied = f.governance.historicalReplayCleanupApply({ replay_run_id: "run-clean", expected_manifest_digest: preview.manifest_digest }) as JsonObject;
    assert.equal(applied.status, "cleaned");
    assert.ok((applied.cleaned as JsonObject[]).some(item => item.kind === "knowledge_claim" && item.id === claim.id));
    assert.ok((applied.cleaned as JsonObject[]).some(item => item.kind === "evidence_projection"));
    const stale = f.store.get("knowledge_claim", String(claim.id));
    assert.equal(stale.status, "stale");
    assert.deepEqual(stale.source_lineage, []);
    assert.equal(((f.store.find("evidence", String(evidence.id))?.metadata) as JsonObject).projection_status, "revoked");
    assert.equal(f.store.contentStore.readCompatSync(stale.content_ref as never, PROJECT_SCOPE).body, "This historical replay Knowledge content was revoked.");
    const emptyPreview = f.governance.historicalReplayCleanupPreview({ replay_run_id: "empty-knowledge-run" }) as JsonObject;
    const emptyApply = f.governance.historicalReplayCleanupApply({ replay_run_id: "empty-knowledge-run", expected_manifest_digest: emptyPreview.manifest_digest }) as JsonObject;
    assert.equal((emptyApply.cleaned as JsonObject[]).length, 0);
    const repeatedEmptyApply = f.governance.historicalReplayCleanupApply({ replay_run_id: "empty-knowledge-run", expected_manifest_digest: emptyPreview.manifest_digest }) as JsonObject;
    assert.equal(repeatedEmptyApply.idempotent, true);

    const liveEvidence = f.addEvidence("knowledge-live-evidence");
    const replayEvidence = f.addReplayProjection("run-mixed", f.addEvidence("knowledge-mixed-replay-evidence"));
    const liveLineage = { origin: "live_hook", session_id: "live-session", project_scope_id: PROJECT_SCOPE,
      source_ref: { kind: "codex_session", id: "live-session" }, evidence_refs: [{ kind: "evidence", id: String(liveEvidence.id), version: 1 }] };
    const liveClaim = f.governance.knowledgeClaimSave({ claim_id: "mixed-claim", scope: PROJECT_SCOPE, kind: "fact", content: CONTENT, evidence_ids: [String(liveEvidence.id)] }).claim as JsonObject;
    f.store.save("knowledge_claim", String(liveClaim.id), { ...liveClaim, source_lineage: [liveLineage] });
    f.governance.captureHistoricalReplayCandidate(replayArgs(lineage("run-mixed", "session-replay", String(replayEvidence.id)), "mixed-claim"));
    const mixedPreview = f.governance.historicalReplayCleanupPreview({ replay_run_id: "run-mixed" }) as JsonObject;
    assert.ok((mixedPreview.items as JsonObject[]).some(item => item.kind === "knowledge_claim" && item.action === "remove_replay_lineage"));
    f.governance.historicalReplayCleanupApply({ replay_run_id: "run-mixed", expected_manifest_digest: mixedPreview.manifest_digest });
    const retained = f.store.get("knowledge_claim", "mixed-claim");
    assert.equal(retained.status, "candidate");
    assert.deepEqual(retained.source_lineage, [liveLineage]);
    assert.deepEqual(retained.evidence_ids, [String(liveEvidence.id)]);
    assert.equal(retained.content, CONTENT);
    const idempotent = f.governance.historicalReplayCleanupApply({ replay_run_id: "run-mixed", expected_manifest_digest: mixedPreview.manifest_digest }) as JsonObject;
    assert.equal(idempotent.idempotent, true);
  } finally { await f.close(); }
});

test("Knowledge cleanup refuses to retire replay Claims whose content reference is unavailable", async () => {
  const f = await fixture();
  try {
    const evidence = f.addReplayProjection("run-no-content", f.addEvidence("knowledge-missing-content-evidence"));
    const captured = f.governance.captureHistoricalReplayCandidate(replayArgs(lineage("run-no-content", "session-no-content", String(evidence.id)), "no-content-claim")) as JsonObject;
    const claim = captured.claim as JsonObject;
    f.store.save("knowledge_claim", String(claim.id), { ...claim, content_ref: null });
    const preview = f.governance.historicalReplayCleanupPreview({ replay_run_id: "run-no-content" }) as JsonObject;
    assert.throws(() => f.governance.historicalReplayCleanupApply({ replay_run_id: "run-no-content", expected_manifest_digest: preview.manifest_digest }), /cannot be safely redacted/u);
    assert.equal(f.store.get("knowledge_claim", String(claim.id)).status, "candidate");
    const originalPreview = f.governance.historicalReplayCleanupPreview.bind(f.governance);
    f.governance.historicalReplayCleanupPreview = (() => ({ owner: "knowledge", replay_run_id: "invalid-kind", manifest_digest: "test-manifest",
      items: [{ kind: "unknown", id: "x", version: 1, lineage_digest: "test", action: "revoke" }] })) as typeof f.governance.historicalReplayCleanupPreview;
    assert.throws(() => f.governance.historicalReplayCleanupApply({ replay_run_id: "invalid-kind", expected_manifest_digest: "test-manifest" }), /object kind is unsupported/u);
    f.governance.historicalReplayCleanupPreview = originalPreview;
  } finally { await f.close(); }
});

test("Knowledge cleanup rejects incomplete Evidence lineage and detects object version races", async () => {
  const f = await fixture();
  try {
    const evidence = f.addReplayProjection("run-race", f.addEvidence("knowledge-cleanup-race-evidence"));
    const captured = f.governance.captureHistoricalReplayCandidate(replayArgs(lineage("run-race", "session-race", String(evidence.id)), "race-claim")) as JsonObject;
    const claim = captured.claim as JsonObject;
    f.store.save("knowledge_claim", String(claim.id), { ...claim, evidence_ids: [...claim.evidence_ids as string[], "unrelated-evidence"] });
    const incompletePreview = f.governance.historicalReplayCleanupPreview({ replay_run_id: "run-race" }) as JsonObject;
    assert.throws(() => f.governance.historicalReplayCleanupApply({ replay_run_id: "run-race", expected_manifest_digest: incompletePreview.manifest_digest }), /Evidence lineage is incomplete/u);
    const current = f.store.get("knowledge_claim", String(claim.id));
    const missingEvidenceIds = { ...current };
    delete missingEvidenceIds.evidence_ids;
    f.store.save("knowledge_claim", String(claim.id), missingEvidenceIds);
    const missingEvidencePreview = f.governance.historicalReplayCleanupPreview({ replay_run_id: "run-race" }) as JsonObject;
    assert.throws(() => f.governance.historicalReplayCleanupApply({ replay_run_id: "run-race", expected_manifest_digest: missingEvidencePreview.manifest_digest }), /Evidence lineage is incomplete/u);
    f.store.save("knowledge_claim", String(claim.id), { ...f.store.get("knowledge_claim", String(claim.id)), evidence_ids: [String(evidence.id)] });
    const preview = f.governance.historicalReplayCleanupPreview({ replay_run_id: "run-race" }) as JsonObject;
    const originalGet = f.store.get.bind(f.store);
    f.store.get = ((kind: string, id: string, ...rest: unknown[]) => {
      const record = originalGet(kind, id, ...(rest as [number?]));
      return kind === "knowledge_claim" && id === String(claim.id) ? { ...record, version: Number(record.version) + 1 } : record;
    }) as typeof f.store.get;
    assert.throws(() => f.governance.historicalReplayCleanupApply({ replay_run_id: "run-race", expected_manifest_digest: preview.manifest_digest }), /changed after cleanup preview/u);
    f.store.get = originalGet;

    const projectionSource = f.addEvidence("knowledge-projection-race-source");
    const projection = f.addReplayProjection("run-projection-race", projectionSource);
    f.governance.captureHistoricalReplayCandidate(replayArgs(lineage("run-projection-race", "projection-race-session", String(projection.id)), "projection-race-claim"));
    const projectionPreview = f.governance.historicalReplayCleanupPreview({ replay_run_id: "run-projection-race" }) as JsonObject;
    const originalProjectionGet = f.store.get.bind(f.store);
    f.store.get = ((kind: string, id: string, ...rest: unknown[]) => {
      const record = originalProjectionGet(kind, id, ...(rest as [number?]));
      return kind === "evidence" && id === String(projection.id) ? { ...record, version: Number(record.version) + 1 } : record;
    }) as typeof f.store.get;
    assert.throws(() => f.governance.historicalReplayCleanupApply({ replay_run_id: "run-projection-race",
      expected_manifest_digest: projectionPreview.manifest_digest }), /Evidence projection changed/u);
    f.store.get = originalProjectionGet;
  } finally { await f.close(); }
});

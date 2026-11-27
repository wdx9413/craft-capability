import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { stableDigest } from "craft-common-base/digest";
import { craftPaths } from "craft-common-store-local/paths";
import { CraftStore, type JsonObject } from "craft-common-store-local/store";
import { ExperienceLearningWorkItemOwner, experienceLearningWorkItemId, type ExperienceCandidateRef, type ExperienceEvaluationContractRef } from "../learning-work-item.ts";

const scope = "project:learning-work-item";
const digest = `sha256:${"a".repeat(64)}`;
const sources = [{ kind: "trace", id: "trace-1", version: 1, digest: `sha256:${"b".repeat(64)}` }];

async function fixture(ownerRecords = false) {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-learning-work-item-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  let store = await new CraftStore(craftPaths(root)).open({ ownerRecords, fileRecords: ownerRecords });
  store.create("scope_alias", "project-root", {
    status: "active", alias_kind: "path", alias: projectRoot, alias_digest: stableDigest(projectRoot),
    scope: { kind: "project", id: scope },
  });
  const candidate = store.create("experience_procedure", "procedure-work-item-1", {
    scope, provenance: "explicit_trace_distillation", lifecycle: "candidate", version: 1, candidate_version: 1,
    definition_digest: digest, source_refs: sources, completed_gates: [], routeable: false, publication_allowed: false,
  });
  const candidateRef: ExperienceCandidateRef = { kind: "experience_procedure", id: String(candidate.id), version: 1, digest };
  const owner = () => new ExperienceLearningWorkItemOwner(store);
  const evaluationContract = store.create("evaluation_contract", "task-effect-work-item-1", {
    effect: "task_effect", capability_id: `experience-procedure:${candidate.id}`, capability_version: 1,
    contract_digest: `sha256:${"c".repeat(64)}`, task_effect: { candidate_family: "experience_procedure" },
  });
  const contractRef: ExperienceEvaluationContractRef = {
    kind: "evaluation_contract", id: String(evaluationContract.id), version: 1, digest: String(evaluationContract.contract_digest),
  };
  const enqueueArgs = (evaluation_contract_ref: unknown = null) => ({
    candidate_ref: candidateRef, scope, source_refs: sources, evaluation_contract_ref, now: "2026-11-26T10:00:00.000Z",
  });
  return {
    root, candidateRef, contractRef, enqueueArgs,
    get store() { return store; },
    owner,
    async restart() {
      await store.close();
      store = await new CraftStore(craftPaths(root)).open({ ownerRecords, fileRecords: ownerRecords });
    },
    async close() { await store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("normal Work Item enqueue stores the body in the project in standalone owner mode", async () => {
  const f = await fixture(true);
  try {
    const item = f.owner().enqueue(f.enqueueArgs(f.contractRef)).work_item as JsonObject;
    const db = new DatabaseSync(join(f.root, "project", ".craft_data", "experience", "experience.db"), { readOnly: true });
    try {
      const row = db.prepare("SELECT payload_json FROM records WHERE kind=? AND id=?").get("experience_learning_work_item", String(item.id)) as { payload_json: string };
      assert.equal(JSON.parse(row.payload_json).scope, scope);
      assert.equal(f.store.get("experience_learning_work_item", String(item.id)).status, "queued");
    } finally { db.close(); }
  } finally { await f.close(); }
});

function bindGate(f: Awaited<ReturnType<typeof fixture>>, owner: ExperienceLearningWorkItemOwner, itemId: unknown, gate: JsonObject): JsonObject {
  const now = new Date().toISOString();
  let claim = owner.claimNext({ worker_id: "gate-test", now }) as { work_item: JsonObject; lease_token: string };
  while (claim.work_item && claim.work_item.id !== itemId) {
    owner.block({ work_item_id: claim.work_item.id, worker_id: "gate-test", lease_token: claim.lease_token, reason: "worker_unavailable", now });
    claim = owner.claimNext({ worker_id: "gate-test", now }) as { work_item: JsonObject; lease_token: string };
  }
  assert.equal(claim.work_item.id, itemId);
  const candidate = f.store.get("experience_procedure", String(gate.procedure_id));
  const dispatch = f.store.create("experience_evaluation_dispatch", `dispatch-${String(gate.id)}`, {
    learning_work_item_id: itemId, procedure_id: candidate.id, procedure_version: candidate.version, stage: gate.stage, status: "awaiting_adapter",
  });
  owner.attachEvaluationDispatch({ work_item_id: itemId, worker_id: "gate-test", lease_token: claim.lease_token, dispatch_id: dispatch.id, now });
  f.store.save("experience_evaluation_dispatch", String(dispatch.id), { ...dispatch, status: gate.passed ? "passed" : "failed", gate_id: gate.id });
  return { worker_id: "gate-test", lease_token: claim.lease_token };
}

test("Experience owner atomically persists one content-free Work Item per exact Candidate", async () => {
  const f = await fixture();
  try {
    const owner = f.owner();
    const first = owner.enqueue(f.enqueueArgs()) as { work_item: Record<string, unknown>; idempotent: boolean };
    const retry = owner.enqueue(f.enqueueArgs()) as { work_item: Record<string, unknown>; idempotent: boolean };
    const item = first.work_item;
    assert.equal(first.idempotent, false);
    assert.equal(retry.idempotent, true);
    assert.equal(item.id, experienceLearningWorkItemId(f.candidateRef));
    assert.deepEqual(item.candidate_ref, f.candidateRef);
    assert.deepEqual(item.source_refs, sources);
    assert.equal(item.evaluation_contract_ref, null);
    assert.equal(item.scope, scope);
    assert.equal(item.stage, "evaluation_contract");
    assert.equal(item.status, "blocked");
    assert.equal(item.blocked_reason, "evaluation_contract_unavailable");
    assert.equal(item.attempts, 0);
    assert.equal(item.raw_content_stored, false);
    assert.equal("body" in item, false);
    assert.deepEqual(owner.get({ work_item_id: item.id }).work_item, item);
    assert.equal(owner.findForCandidate(f.candidateRef)?.id, item.id);
    owner.setEvaluationContractSource(f.store);
    assert.throws(() => owner.get({ work_item_id: " " }), /work_item_id is invalid/u);
    assert.throws(() => owner.resume({ work_item_id: item.id, expected_version: item.version }),
      /before its Evaluation Contract is bound/u);
    assert.throws(() => owner.enqueue(f.enqueueArgs(f.contractRef)), /Evaluation Contract binding conflict/u);
    const malformed = { ...f.enqueueArgs(), source_refs: [{ ...sources[0]!, id: "other-trace" }] };
    assert.throws(() => owner.enqueue(malformed), /exact Candidate source references/u);
    assert.throws(() => owner.enqueue({ ...f.enqueueArgs(), candidate_ref: { ...f.candidateRef, digest: `sha256:${"d".repeat(64)}` } }),
      /unrouteable Trace Candidate/u);
    assert.throws(() => owner.enqueue({
      ...f.enqueueArgs(), candidate_ref: { ...f.candidateRef, id: "missing-work-item-candidate" },
    }), /Candidate reference is unavailable/u);
    assert.throws(() => owner.claimNext({ worker_id: " " }), /worker_id is invalid/u);
    assert.throws(() => owner.listPending({ now: "invalid" }), /ISO timestamp/u);
    f.store.save("experience_learning_work_item", String(item.id), { ...item, intent_digest: `sha256:${"f".repeat(64)}` });
    assert.throws(() => owner.enqueue(f.enqueueArgs()), /idempotency conflict/u);
  } finally { await f.close(); }
});

test("Pending Work Items are ordered by creation time then stable id", async () => {
  const f = await fixture();
  try {
    const owner = f.owner();
    const first = owner.enqueue(f.enqueueArgs(f.contractRef)) as { work_item: Record<string, unknown> };
    const secondCandidate = f.store.create("experience_procedure", "procedure-work-item-2", {
      scope, provenance: "explicit_trace_distillation", lifecycle: "candidate", version: 1, candidate_version: 1,
      definition_digest: `sha256:${"d".repeat(64)}`, source_refs: sources, completed_gates: [], routeable: false, publication_allowed: false,
    });
    const secondContract = f.store.create("evaluation_contract", "task-effect-work-item-2", {
      effect: "task_effect", capability_id: `experience-procedure:${secondCandidate.id}`, capability_version: 1,
      contract_digest: `sha256:${"e".repeat(64)}`, task_effect: { candidate_family: "experience_procedure" },
    });
    const second = owner.enqueue({
      candidate_ref: { kind: "experience_procedure", id: String(secondCandidate.id), version: 1, digest: secondCandidate.definition_digest },
      scope, source_refs: sources,
      evaluation_contract_ref: { kind: "evaluation_contract", id: String(secondContract.id), version: 1, digest: secondContract.contract_digest },
      now: "2026-11-26T10:00:00.000Z",
    }) as { work_item: Record<string, unknown> };
    const listed = owner.listPending({ now: "2026-11-26T10:00:01.000Z" });
    assert.equal(listed.count, 2);
    const expected = [first.work_item, second.work_item]
      .sort((left, right) => `${String(left.created_at)}\0${String(left.id)}`.localeCompare(`${String(right.created_at)}\0${String(right.id)}`));
    assert.deepEqual((listed.items as Record<string, unknown>[]).map(item => item.id),
      expected.map(item => item.id));
  } finally { await f.close(); }
});

test("Candidate lookup returns null and claim reports the earliest blocked item when no work is pending", async () => {
  const f = await fixture();
  try {
    const owner = f.owner();
    assert.equal(owner.findForCandidate(f.candidateRef), null);

    const earlier = owner.enqueue(f.enqueueArgs()) as {
      work_item: Record<string, unknown>;
    };
    f.store.save("experience_learning_work_item", String(earlier.work_item.id), {
      ...earlier.work_item, blocked_reason: null,
    });
    const laterCandidate = f.store.create("experience_procedure", "procedure-work-item-later-blocked", {
      scope, provenance: "explicit_trace_distillation", lifecycle: "candidate", version: 1, candidate_version: 1,
      definition_digest: `sha256:${"d".repeat(64)}`, source_refs: sources, completed_gates: [], routeable: false,
      publication_allowed: false,
    });
    const later = owner.enqueue({
      candidate_ref: { kind: "experience_procedure", id: String(laterCandidate.id), version: 1,
        digest: laterCandidate.definition_digest },
      scope, source_refs: sources, evaluation_contract_ref: null,
    }) as { work_item: Record<string, unknown> };

    const claim = owner.claimNext({ worker_id: "blocked-item-selector", now: "2026-11-26T10:03:00.000Z" }) as {
      status: string;
      work_item: Record<string, unknown>;
      blocked_reason: string;
    };
    assert.equal(claim.status, "blocked");
    assert.equal(claim.work_item.id, earlier.work_item.id);
    assert.equal(claim.blocked_reason, "learning_work_item_blocked");
    assert.notEqual(claim.work_item.id, later.work_item.id);
  } finally { await f.close(); }
});

test("Enqueue recovers a content-cleaned Work Item by its exact Candidate and lineage", async () => {
  const f = await fixture();
  try {
    const owner = f.owner();
    const cleaned = f.store.create("experience_learning_work_item", "cleaned-work-item-recovery", {
      candidate_ref: f.candidateRef, scope, source_refs: [], source_refs_cleanup_applied: true,
      evaluation_contract_ref: null,
    });
    const retried = owner.enqueue(f.enqueueArgs()) as { work_item: Record<string, unknown>; idempotent: boolean };

    assert.equal(retried.idempotent, true);
    assert.equal(retried.work_item.id, cleaned.id);
    assert.equal(f.store.list("experience_learning_work_item", 10).length, 1);

    const unchangedCandidate = f.store.create("experience_procedure", "procedure-work-item-source-ref-recovery", {
      scope, provenance: "explicit_trace_distillation", lifecycle: "candidate", version: 1, candidate_version: 1,
      definition_digest: `sha256:${"d".repeat(64)}`, source_refs: sources, completed_gates: [], routeable: false,
      publication_allowed: false,
    });
    const unchangedRef: ExperienceCandidateRef = {
      kind: "experience_procedure", id: String(unchangedCandidate.id), version: 1,
      digest: String(unchangedCandidate.definition_digest),
    };
    const unchanged = f.store.create("experience_learning_work_item", "unchanged-source-ref-recovery", {
      candidate_ref: unchangedRef, scope, source_refs: sources, evaluation_contract_ref: null,
    });
    const unchangedRetry = owner.enqueue({ candidate_ref: unchangedRef, scope, source_refs: sources,
      evaluation_contract_ref: null }) as { work_item: Record<string, unknown>; idempotent: boolean };

    assert.equal(unchangedRetry.idempotent, true);
    assert.equal(unchangedRetry.work_item.id, unchanged.id);
    assert.equal(f.store.list("experience_learning_work_item", 10).length, 2);
  } finally { await f.close(); }
});

test("Candidate lookup selects the exact replay lineage among legacy items", async () => {
  const f = await fixture();
  try {
    const evidence = f.store.create("evidence", "lookup-replay-lineage-evidence", {
      confidence: "unverified", source_type: "historical_session",
    });
    const sourceLineage = [{
      origin: "historical_replay", replay_run_id: "lookup-replay-run", session_id: "lookup-replay-session",
      project_scope_id: scope, source_ref: { kind: "host_session", id: "lookup-replay-session", version: 1 },
      evidence_refs: [{ kind: "evidence", id: String(evidence.id), version: 1 }],
    }];
    const candidate = f.store.get("experience_procedure", f.candidateRef.id);
    f.store.save("experience_procedure", f.candidateRef.id, { ...candidate, source_lineage: sourceLineage });
    const exact = f.store.create("experience_learning_work_item", "lookup-exact-replay-item", {
      candidate_ref: f.candidateRef, scope, source_refs: sources, source_lineage: sourceLineage,
    });
    f.store.create("experience_learning_work_item", "lookup-legacy-item-without-lineage", {
      candidate_ref: f.candidateRef, scope, source_refs: sources,
    });

    assert.equal(f.owner().findForCandidate(f.candidateRef)?.id, exact.id);
  } finally { await f.close(); }
});

test("Dispatch attachment accepts the legacy Candidate version field", async () => {
  const f = await fixture();
  try {
    const candidate = f.store.create("experience_procedure", "procedure-work-item-legacy-version", {
      scope, provenance: "explicit_trace_distillation", lifecycle: "candidate", version: 1,
      definition_digest: digest, source_refs: sources, completed_gates: [], routeable: false, publication_allowed: false,
    });
    const contract = f.store.create("evaluation_contract", "legacy-version-task-effect-contract", {
      effect: "task_effect", capability_id: `experience-procedure:${candidate.id}`, capability_version: 1,
      contract_digest: `sha256:${"c".repeat(64)}`, task_effect: { candidate_family: "experience_procedure" },
    });
    const candidateRef: ExperienceCandidateRef = {
      kind: "experience_procedure", id: String(candidate.id), version: 1, digest,
    };
    const owner = f.owner();
    const queued = owner.enqueue({ candidate_ref: candidateRef, scope, source_refs: sources,
      evaluation_contract_ref: { kind: "evaluation_contract", id: String(contract.id), version: 1,
        digest: String(contract.contract_digest) } }) as { work_item: Record<string, unknown> };
    const claimed = owner.claimNext({ worker_id: "legacy-version-worker" }) as { lease_token: string };
    const dispatch = f.store.create("experience_evaluation_dispatch", "legacy-version-dispatch", {
      learning_work_item_id: queued.work_item.id, procedure_id: candidate.id, procedure_version: 1, stage: "shadow",
    });

    assert.equal(owner.attachEvaluationDispatch({ work_item_id: queued.work_item.id, worker_id: "legacy-version-worker",
      lease_token: claimed.lease_token, dispatch_id: dispatch.id }).idempotent, false);
  } finally { await f.close(); }
});

test("Historical Work Item identity pins exact replay lineage while live items stay unmarked", async () => {
  const f = await fixture();
  try {
    const historicalEvidence = f.store.create("evidence", "replay-work-item-evidence", {
      confidence: "unverified", source_type: "historical_session",
    });
    const sourceLineage = [{
      origin: "historical_replay",
      replay_run_id: "replay-run-work-item-1",
      session_id: "session-work-item-1",
      project_scope_id: scope,
      source_ref: { kind: "host_session", id: "session-work-item-1", version: 1 },
      evidence_refs: [{ kind: "evidence", id: String(historicalEvidence.id), version: 1 }],
    }];
    const candidate = f.store.create("experience_procedure", "procedure-work-item-replay", {
      scope, provenance: "explicit_trace_distillation", lifecycle: "candidate", version: 1, candidate_version: 1,
      definition_digest: digest, source_refs: sources, source_lineage: sourceLineage, completed_gates: [],
      routeable: false, publication_allowed: false,
    });
    const candidateRef: ExperienceCandidateRef = {
      kind: "experience_procedure", id: String(candidate.id), version: 1, digest,
    };
    const owner = f.owner();
    const queued = owner.enqueue({
      candidate_ref: candidateRef, scope, source_refs: sources, source_lineage: sourceLineage,
      replay_run_id: "replay-run-work-item-1", evaluation_contract_ref: null,
    }) as { work_item: Record<string, unknown>; idempotent: boolean };

    assert.equal(queued.idempotent, false);
    assert.deepEqual(queued.work_item.source_lineage, sourceLineage);
    assert.equal(queued.work_item.replay_run_id, "replay-run-work-item-1");
    assert.equal(queued.work_item.id, experienceLearningWorkItemId(candidateRef, sourceLineage));
    assert.throws(() => owner.enqueue({
      candidate_ref: candidateRef, scope, source_refs: sources, source_lineage: sourceLineage,
      replay_run_id: "another-run", evaluation_contract_ref: null,
    }), /replay_run_id must match/u);
    assert.throws(() => owner.enqueue({
      candidate_ref: candidateRef, scope, source_refs: sources, source_lineage: [],
      replay_run_id: "replay-run-work-item-1", evaluation_contract_ref: null,
    }), /exact Candidate source lineage/u);
    assert.throws(() => owner.enqueue({
      candidate_ref: f.candidateRef, scope, source_refs: sources, source_lineage: sourceLineage,
      replay_run_id: "replay-run-work-item-1", evaluation_contract_ref: null,
    }), /exact Candidate source lineage/u);
    assert.deepEqual(owner.findForCandidate(candidateRef, sourceLineage), queued.work_item);

    const live = owner.enqueue(f.enqueueArgs()) as { work_item: Record<string, unknown> };
    assert.equal("source_lineage" in live.work_item, false);
    assert.equal("replay_run_id" in live.work_item, false);

    const liveEvidence = f.store.create("evidence", "live-work-item-evidence", {
      confidence: "bounded", source_type: "host_completion",
    });
    const liveLineage = [{
      origin: "live_hook", session_id: "live-session", project_scope_id: scope,
      source_ref: { kind: "host_task", id: "live-task" },
      evidence_refs: [{ kind: "evidence", id: String(liveEvidence.id), version: 1 }],
    }];
    const liveLineageCandidate = f.store.create("experience_procedure", "procedure-work-item-live-lineage", {
      scope, provenance: "explicit_trace_distillation", lifecycle: "candidate", version: 1, candidate_version: 1,
      definition_digest: `sha256:${"e".repeat(64)}`, source_refs: sources, source_lineage: liveLineage,
      completed_gates: [], routeable: false, publication_allowed: false,
    });
    const liveLineageRef: ExperienceCandidateRef = {
      kind: "experience_procedure", id: String(liveLineageCandidate.id), version: 1,
      digest: String(liveLineageCandidate.definition_digest),
    };
    const liveLineageItem = owner.enqueue({
      candidate_ref: liveLineageRef, scope, source_refs: sources, source_lineage: liveLineage,
      evaluation_contract_ref: null,
    }).work_item as Record<string, unknown>;
    assert.equal("source_lineage" in liveLineageItem, false);
    assert.equal(owner.findForCandidate(liveLineageRef, liveLineage)?.id, liveLineageItem.id);
  } finally { await f.close(); }
});

test("Candidate lookup rejects ambiguous Work Items after comparing their current lineage", async () => {
  const f = await fixture();
  try {
    const owner = f.owner();
    const makeLineage = (sessionId: string) => {
      const evidence = f.store.create("evidence", `find-lineage-${sessionId}`, { confidence: "bounded", source_type: "host_completion" });
      return [{
        origin: "live_hook", session_id: sessionId, project_scope_id: scope,
        source_ref: { kind: "host_task", id: `task-${sessionId}` },
        evidence_refs: [{ kind: "evidence", id: String(evidence.id), version: 1 }],
      }];
    };
    const firstLineage = makeLineage("find-session-a");
    const secondLineage = makeLineage("find-session-b");
    const candidate = f.store.get("experience_procedure", f.candidateRef.id);
    f.store.save("experience_procedure", f.candidateRef.id, { ...candidate, source_lineage: firstLineage });
    for (const [id, source_lineage] of [["find-item-a", firstLineage], ["find-item-b", secondLineage]] as const) {
      f.store.create("experience_learning_work_item", id, {
        candidate_ref: f.candidateRef, scope, source_refs: sources, source_lineage,
      });
    }

    assert.throws(() => owner.findForCandidate(f.candidateRef),
      /Candidate has multiple Learning Work Items; provide source_lineage/u);
  } finally { await f.close(); }
});

test("Work Item retry after partial replay cleanup keeps its original identity", async () => {
  const f = await fixture();
  try {
    const firstEvidence = f.store.create("evidence", "partial-replay-evidence-1", {
      confidence: "unverified", source_type: "historical_session",
    });
    const secondEvidence = f.store.create("evidence", "partial-replay-evidence-2", {
      confidence: "unverified", source_type: "historical_session",
    });
    const mixedSources = [
      { kind: "trace", id: "trace-replay-1", version: 1, digest: `sha256:${"b".repeat(64)}` },
      { kind: "trace", id: "trace-replay-2", version: 1, digest: `sha256:${"c".repeat(64)}` },
    ];
    const mixedLineage = [
      {
        origin: "historical_replay",
        replay_run_id: "replay-run-removed",
        session_id: "session-removed",
        project_scope_id: scope,
        source_ref: { kind: "trace", id: "trace-replay-1", version: 1 },
        evidence_refs: [{ kind: "evidence", id: String(firstEvidence.id), version: 1 }],
      },
      {
        origin: "historical_replay",
        replay_run_id: "replay-run-retained",
        session_id: "session-retained",
        project_scope_id: scope,
        source_ref: { kind: "trace", id: "trace-replay-2", version: 1 },
        evidence_refs: [{ kind: "evidence", id: String(secondEvidence.id), version: 1 }],
      },
    ];
    const candidate = f.store.create("experience_procedure", "procedure-work-item-partial-replay-cleanup", {
      scope, provenance: "explicit_trace_distillation", lifecycle: "candidate", version: 1, candidate_version: 1,
      definition_digest: digest, source_refs: mixedSources, source_lineage: mixedLineage, completed_gates: [],
      routeable: false, publication_allowed: false,
    });
    const candidateRef: ExperienceCandidateRef = {
      kind: "experience_procedure", id: String(candidate.id), version: 1, digest,
    };
    const owner = f.owner();
    const queued = owner.enqueue({
      candidate_ref: candidateRef, scope, source_refs: mixedSources, source_lineage: mixedLineage,
      evaluation_contract_ref: null,
    }) as { work_item: Record<string, unknown> };
    const originalId = String(queued.work_item.id);
    const retainedLineage = (queued.work_item.source_lineage as Record<string, unknown>[])
      .filter(entry => entry.replay_run_id === "replay-run-retained");
    const retainedSourceRefs = [mixedSources[1]!];

    f.store.updateIfVersion("experience_procedure", String(candidate.id), Number(candidate.version), {
      ...candidate, source_lineage: retainedLineage,
    });
    f.store.updateIfVersion("experience_learning_work_item", originalId, Number(queued.work_item.version), {
      ...queued.work_item, source_lineage: retainedLineage, source_refs: retainedSourceRefs,
      source_refs_cleanup_applied: true,
    });

    assert.equal(owner.findForCandidate(candidateRef)?.id, originalId);
    const retry = owner.enqueue({
      candidate_ref: candidateRef, scope, source_refs: mixedSources, source_lineage: retainedLineage,
      replay_run_id: "replay-run-retained", evaluation_contract_ref: null,
    }) as { work_item: Record<string, unknown>; idempotent: boolean };

    assert.equal(retry.idempotent, true);
    assert.equal(retry.work_item.id, originalId);
    assert.deepEqual(retry.work_item.source_lineage, retainedLineage);
    assert.deepEqual(retry.work_item.source_refs, retainedSourceRefs);
    assert.equal(f.store.list("experience_learning_work_item", 10, item =>
      stableDigest(item.candidate_ref) === stableDigest(candidateRef)).length, 1);
  } finally { await f.close(); }
});

test("Work Item cleanup recovery rejects ambiguous matches without creating another item", async () => {
  const f = await fixture();
  try {
    const firstEvidence = f.store.create("evidence", "ambiguous-cleanup-evidence-1", {
      confidence: "unverified", source_type: "historical_session",
    });
    const secondEvidence = f.store.create("evidence", "ambiguous-cleanup-evidence-2", {
      confidence: "unverified", source_type: "historical_session",
    });
    const sourceLineage = [{
      origin: "historical_replay",
      replay_run_id: "replay-run-retained",
      session_id: "session-retained",
      project_scope_id: scope,
      source_ref: { kind: "trace", id: "trace-ambiguous-retained", version: 1 },
      evidence_refs: [{ kind: "evidence", id: String(firstEvidence.id), version: 1 }],
    }];
    const otherLineage = [{
      ...sourceLineage[0]!,
      replay_run_id: "replay-run-other",
      session_id: "session-other",
      source_ref: { kind: "trace", id: "trace-ambiguous-other", version: 1 },
      evidence_refs: [{ kind: "evidence", id: String(secondEvidence.id), version: 1 }],
    }];
    const candidate = f.store.create("experience_procedure", "procedure-work-item-ambiguous-cleanup", {
      scope, provenance: "explicit_trace_distillation", lifecycle: "candidate", version: 1, candidate_version: 1,
      definition_digest: digest, source_refs: sources, source_lineage: sourceLineage, completed_gates: [],
      routeable: false, publication_allowed: false,
    });
    const candidateRef: ExperienceCandidateRef = {
      kind: "experience_procedure", id: String(candidate.id), version: 1, digest,
    };
    for (const [id, lineage] of [
      ["legacy-cleanup-match-1", sourceLineage],
      ["legacy-cleanup-match-2", sourceLineage],
      ["legacy-cleanup-nonmatch", otherLineage],
    ] as const) {
      f.store.create("experience_learning_work_item", id, {
        candidate_ref: candidateRef, scope, source_refs: sources, source_lineage: lineage,
        source_refs_cleanup_applied: true, evaluation_contract_ref: null, stage: "evaluation_contract",
        status: "blocked", blocked_reason: "evaluation_contract_unavailable", attempts: 0,
      });
    }

    assert.throws(() => f.owner().enqueue({
      candidate_ref: candidateRef, scope, source_refs: sources, source_lineage: sourceLineage, evaluation_contract_ref: null,
    }), /ambiguous after replay lineage cleanup/u);
    assert.equal(f.store.list("experience_learning_work_item", 10, item =>
      stableDigest(item.candidate_ref) === stableDigest(candidateRef)).length, 3);
  } finally { await f.close(); }
});

test("Work Item pins Candidate content or identity digests when definition digests are absent", async () => {
  const f = await fixture();
  try {
    const owner = f.owner();
    for (const [id, field, value] of [
      ["candidate-content-digest", "content_digest", `sha256:${"c".repeat(64)}`],
      ["candidate-identity-digest", "identity_digest", `sha256:${"d".repeat(64)}`],
    ]) {
      const candidate = f.store.create("experience_procedure", id, {
        scope, provenance: "explicit_trace_distillation", lifecycle: "candidate", version: 1,
        [field]: value, source_refs: sources, completed_gates: field === "content_digest" ? ["shadow"] : [],
        routeable: false, publication_allowed: false,
      });
      const contract = f.store.create("evaluation_contract", `${id}-contract`, {
        effect: "task_effect", capability_id: `experience-procedure:${id}`, capability_version: 1,
        contract_digest: `sha256:${"c".repeat(63)}${field === "content_digest" ? "1" : "2"}`,
        task_effect: { candidate_family: "experience_procedure" },
      });
      const result = owner.enqueue({ candidate_ref: { kind: "experience_procedure", id, version: 1, digest: value },
        scope, source_refs: sources,
        evaluation_contract_ref: { kind: "evaluation_contract", id: contract.id, version: 1, digest: contract.contract_digest },
        now: "2026-11-26T10:00:00.000Z" }) as { work_item: Record<string, unknown> };
      assert.equal((result.work_item.candidate_ref as Record<string, unknown>).digest, value);
      assert.equal(result.work_item.stage, "shadow");
      assert.equal(candidate.candidate_version, undefined);
      if (field === "content_digest") {
        const claim = owner.claimNext({ worker_id: `worker-${id}`, now: "2026-11-26T10:00:01.000Z" }) as {
          work_item: Record<string, unknown>; lease_token: string;
        };
        assert.equal(owner.assertDispatchClaim({ work_item_id: result.work_item.id, worker_id: `worker-${id}`,
          lease_token: claim.lease_token, now: "2026-11-26T10:00:01.500Z" }, "shadow", candidate).id, result.work_item.id);
        const blocked = owner.block({ work_item_id: result.work_item.id, worker_id: `worker-${id}`, lease_token: claim.lease_token,
          reason: "worker_unavailable", now: "2026-11-26T10:00:01.600Z" }) as { work_item: Record<string, unknown> };
        assert.equal((owner.resume({ work_item_id: result.work_item.id, expected_version: blocked.work_item.version,
          now: "2026-11-26T10:00:01.700Z" }).work_item as Record<string, unknown>).status, "queued");
      }
      const gate = f.store.create("experience_procedure_gate", `${id}-gate`, { procedure_id: id, stage: "shadow",
        passed: field === "content_digest", evidence_ids: [`evidence-${id}`] });
      const credentials = bindGate(f, owner, result.work_item.id, gate);
      if (field === "content_digest") {
        assert.equal((owner.advance({ ...credentials, work_item_id: result.work_item.id, gate_id: gate.id }).work_item as Record<string, unknown>).stage, "held_out");
      } else {
        assert.equal((owner.failFromGate({ ...credentials, work_item_id: result.work_item.id, gate_id: gate.id }).work_item as Record<string, unknown>).status, "failed");
      }
    }
    f.store.create("experience_procedure", "candidate-missing-digest", {
      scope, provenance: "explicit_trace_distillation", lifecycle: "candidate", version: 1,
      source_refs: sources, completed_gates: [], routeable: false, publication_allowed: false,
    });
    assert.throws(() => owner.enqueue({ candidate_ref: { kind: "experience_procedure", id: "candidate-missing-digest", version: 1,
      digest: f.candidateRef.digest }, scope, source_refs: sources }), /digest is unavailable/u);
    assert.throws(() => owner.enqueue({ candidate_ref: null, scope, source_refs: sources }), /candidate_ref must be an object/u);
  } finally { await f.close(); }
});

test("Work Item binds one exact task-effect Evaluation Contract and rejects boundary drift", async () => {
  const f = await fixture();
  try {
    const owner = f.owner();
    const created = owner.enqueue(f.enqueueArgs()) as { work_item: Record<string, unknown> };
    const item = created.work_item;
    const pinnedMismatch = f.store.create("evaluation_contract", "pinned-mismatch-contract", {
      effect: "task_effect", capability_id: `experience-procedure:${f.candidateRef.id}`, capability_version: 1,
      contract_digest: `sha256:${"f".repeat(64)}`, task_effect: { candidate_family: "experience_procedure",
        candidate_ref: { ...f.candidateRef, digest: `sha256:${"e".repeat(64)}` } },
    });
    assert.throws(() => owner.bindEvaluationContract({ work_item_id: item.id, expected_version: item.version,
      evaluation_contract_ref: { kind: "evaluation_contract", id: pinnedMismatch.id, version: 1, digest: pinnedMismatch.contract_digest } }),
    /Candidate digest does not match/u);
    const invalidDigestContract = f.store.create("evaluation_contract", "invalid-digest-contract", {
      effect: "task_effect", capability_id: `experience-procedure:${f.candidateRef.id}`, capability_version: 1,
      task_effect: { candidate_family: "experience_procedure" },
    });
    assert.throws(() => owner.bindEvaluationContract({ work_item_id: item.id, expected_version: item.version,
      evaluation_contract_ref: { kind: "evaluation_contract", id: invalidDigestContract.id, version: 1,
        digest: f.contractRef.digest } }), /Evaluation Contract digest is invalid/u);
    const bound = owner.bindEvaluationContract({ work_item_id: item.id, expected_version: item.version,
      evaluation_contract_ref: f.contractRef, now: "2026-11-26T10:01:00.000Z" }) as { work_item: Record<string, unknown>; idempotent: boolean };
    assert.equal(bound.idempotent, false);
    assert.equal(bound.work_item.stage, "shadow");
    assert.equal(bound.work_item.status, "queued");
    assert.deepEqual(bound.work_item.evaluation_contract_ref, f.contractRef);
    const retry = owner.bindEvaluationContract({ work_item_id: item.id, expected_version: item.version,
      evaluation_contract_ref: f.contractRef }) as { idempotent: boolean };
    assert.equal(retry.idempotent, true);
    assert.throws(() => owner.bindEvaluationContract({ work_item_id: item.id, expected_version: 1,
      evaluation_contract_ref: { ...f.contractRef, digest: `sha256:${"d".repeat(64)}` } }), /exact Experience Candidate/u);
    assert.throws(() => owner.bindEvaluationContract({ work_item_id: item.id, expected_version: 1,
      evaluation_contract_ref: { ...f.contractRef, kind: "procedure" } }), /invalid/u);
    const replacementContract = f.store.create("evaluation_contract", "replacement-contract", {
      effect: "task_effect", capability_id: `experience-procedure:${f.candidateRef.id}`, capability_version: 1,
      contract_digest: `sha256:${"a".repeat(64)}`, task_effect: { candidate_family: "experience_procedure" },
    });
    assert.throws(() => owner.bindEvaluationContract({ work_item_id: item.id, expected_version: 0,
      evaluation_contract_ref: { kind: "evaluation_contract", id: replacementContract.id, version: 1,
        digest: replacementContract.contract_digest } }), /expected_version/u);

    f.store.create("evaluation_contract", "wrong-family-contract", {
      effect: "task_effect", capability_id: `experience-procedure:${f.candidateRef.id}`, capability_version: 1,
      contract_digest: `sha256:${"e".repeat(64)}`, task_effect: { candidate_family: "other" },
    });
    assert.throws(() => owner.bindEvaluationContract({ work_item_id: item.id, expected_version: 1,
      evaluation_contract_ref: { kind: "evaluation_contract", id: "wrong-family-contract", version: 1, digest: `sha256:${"e".repeat(64)}` } }),
    /exact Experience Candidate/u);
    assert.throws(() => owner.bindEvaluationContract({ work_item_id: item.id, expected_version: bound.work_item.version,
      evaluation_contract_ref: { kind: "evaluation_contract", id: replacementContract.id, version: 1,
        digest: replacementContract.contract_digest } }), /may bind only once/u);
  } finally { await f.close(); }
});

test("Work Item claim, block, failure, explicit resume and lease expiry are durable across restart", async () => {
  const f = await fixture();
  try {
    const owner = f.owner();
    const queued = owner.enqueue(f.enqueueArgs(f.contractRef)) as { work_item: Record<string, unknown> };
    const { attempts: _attempts, ...legacyPending } = queued.work_item;
    f.store.save("experience_learning_work_item", String(queued.work_item.id), legacyPending);
    const claimed = owner.claimNext({ worker_id: "worker-a", now: "2026-11-26T10:02:00.000Z", lease_ms: 1_000 }) as {
      work_item: Record<string, unknown>; lease_token: string; status: string;
    };
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.work_item.status, "processing");
    assert.equal(claimed.work_item.attempts, 1);
    assert.throws(() => owner.block({ work_item_id: queued.work_item.id, worker_id: "worker-b", lease_token: claimed.lease_token,
      reason: "evaluation_adapter_unavailable", now: "2026-11-26T10:02:01.000Z" }), /lease/u);
    const blocked = owner.block({ work_item_id: queued.work_item.id, worker_id: "worker-a", lease_token: claimed.lease_token,
      reason: "evaluation_adapter_unavailable", now: "2026-11-26T10:02:00.500Z" }) as { work_item: Record<string, unknown> };
    assert.equal(blocked.work_item.status, "blocked");
    assert.equal(blocked.work_item.stage, "shadow");
    assert.equal(blocked.work_item.blocked_reason, "evaluation_adapter_unavailable");
    assert.throws(() => owner.resume({ work_item_id: queued.work_item.id, expected_version: 1 }), /expected_version/u);
    const resumed = owner.resume({ work_item_id: queued.work_item.id, expected_version: blocked.work_item.version,
      now: "2026-11-26T10:02:01.000Z" }) as { work_item: Record<string, unknown> };
    assert.equal(resumed.work_item.status, "queued");

    const beforeRestart = owner.claimNext({ worker_id: "worker-a", now: "2026-11-26T10:02:02.000Z", lease_ms: 1_000 }) as {
      work_item: Record<string, unknown>; lease_token: string;
    };
    await f.restart();
    const afterRestart = f.owner().claimNext({ worker_id: "worker-b", now: "2026-11-26T10:02:04.000Z", lease_ms: 5_000 }) as {
      work_item: Record<string, unknown>; lease_token: string; status: string;
    };
    assert.equal(afterRestart.status, "claimed");
    assert.equal(afterRestart.work_item.id, beforeRestart.work_item.id);
    assert.equal(afterRestart.work_item.stage, "shadow");
    assert.equal(afterRestart.work_item.attempts, 3);
    assert.notEqual(afterRestart.lease_token, beforeRestart.lease_token);
    assert.throws(() => f.owner().block({ work_item_id: afterRestart.work_item.id, worker_id: "worker-a",
      lease_token: beforeRestart.lease_token, reason: "worker_unavailable", now: "2026-11-26T10:02:05.000Z" }), /lease/u);
    const failed = f.owner().fail({ work_item_id: afterRestart.work_item.id, worker_id: "worker-b", lease_token: afterRestart.lease_token,
      reason: "worker_unavailable", retryable: true, now: "2026-11-26T10:02:05.000Z" }) as { work_item: Record<string, unknown> };
    assert.equal(failed.work_item.status, "failed");
    assert.equal(failed.work_item.failure_reason, "worker_unavailable");
    const retry = f.owner().resume({ work_item_id: failed.work_item.id, expected_version: failed.work_item.version,
      now: "2026-11-26T10:02:06.000Z" }) as { work_item: Record<string, unknown> };
    assert.equal(retry.work_item.status, "queued");
    assert.equal(f.owner().listPending({ now: "2026-11-26T10:02:07.000Z" }).count, 1);
    assert.throws(() => f.owner().claimNext({ worker_id: "worker-c", now: "2026-11-26T10:02:07.000Z", lease_ms: 500 }), /lease_ms/u);
  } finally { await f.close(); }
});

test("Work Item records dispatch references and advances only on ordered, evidenced gates", async () => {
  const f = await fixture();
  try {
    const owner = f.owner();
    const queued = owner.enqueue(f.enqueueArgs(f.contractRef)) as { work_item: Record<string, unknown> };
    const claimed = owner.claimNext({ worker_id: "worker-a", now: "2026-11-26T10:03:00.000Z" }) as {
      work_item: Record<string, unknown>; lease_token: string;
    };
    const candidate = f.store.get("experience_procedure", f.candidateRef.id);
    assert.equal(owner.assertDispatchClaim({ work_item_id: queued.work_item.id, worker_id: "worker-a",
      lease_token: claimed.lease_token, now: "2026-11-26T10:03:00.500Z" }, "shadow", candidate).id, queued.work_item.id);
    assert.throws(() => owner.assertDispatchClaim({ work_item_id: queued.work_item.id, worker_id: "worker-a",
      lease_token: claimed.lease_token, now: "2026-11-26T10:03:00.500Z" }, "held_out", candidate), /exact Candidate stage/u);
    const mismatchedDispatch = f.store.create("experience_evaluation_dispatch", "dispatch-mismatch", {
      learning_work_item_id: queued.work_item.id, procedure_id: f.candidateRef.id, procedure_version: 1, stage: "held_out",
    });
    assert.throws(() => owner.attachEvaluationDispatch({ work_item_id: queued.work_item.id, worker_id: "worker-a",
      lease_token: claimed.lease_token, dispatch_id: mismatchedDispatch.id, now: "2026-11-26T10:03:00.500Z" }),
    /does not match the claimed Learning Work Item/u);
    const dispatch = f.store.create("experience_evaluation_dispatch", "dispatch-shadow", {
      learning_work_item_id: queued.work_item.id, procedure_id: f.candidateRef.id, procedure_version: 1, stage: "shadow",
    });
    const attached = owner.attachEvaluationDispatch({ work_item_id: queued.work_item.id, worker_id: "worker-a",
      lease_token: claimed.lease_token, dispatch_id: dispatch.id, now: "2026-11-26T10:03:01.000Z" }) as {
      work_item: Record<string, unknown>; idempotent: boolean;
    };
    assert.equal(attached.idempotent, false);
    assert.equal((attached.work_item.active_dispatch_ref as Record<string, unknown>).id, dispatch.id);
    const attachRetry = owner.attachEvaluationDispatch({ work_item_id: queued.work_item.id, worker_id: "worker-a",
      lease_token: claimed.lease_token, dispatch_id: dispatch.id, now: "2026-11-26T10:03:02.000Z" }) as { idempotent: boolean };
    assert.equal(attachRetry.idempotent, true);
    const competingDispatch = f.store.create("experience_evaluation_dispatch", "dispatch-shadow-competing", {
      learning_work_item_id: queued.work_item.id, procedure_id: f.candidateRef.id, procedure_version: 1, stage: "shadow",
    });
    assert.throws(() => owner.attachEvaluationDispatch({ work_item_id: queued.work_item.id, worker_id: "worker-a",
      lease_token: claimed.lease_token, dispatch_id: competingDispatch.id, now: "2026-11-26T10:03:02.500Z" }),
    /different active Evaluation dispatch/u);
    assert.throws(() => owner.assertDispatchClaim({ work_item_id: queued.work_item.id, worker_id: "worker-a",
      lease_token: "stale" }, "shadow", f.store.get("experience_procedure", f.candidateRef.id)), /lease/u);
    assert.throws(() => owner.attachEvaluationDispatch({ work_item_id: queued.work_item.id, worker_id: "worker-a",
      lease_token: claimed.lease_token, dispatch_id: "missing-dispatch", now: "2026-11-26T10:03:03.000Z" }), /Unknown experience_evaluation_dispatch/u);

    f.store.save("experience_procedure", f.candidateRef.id, {
      ...f.store.get("experience_procedure", f.candidateRef.id), completed_gates: ["shadow"],
    });
    const gate = f.store.create("experience_procedure_gate", "gate-shadow", {
      procedure_id: f.candidateRef.id, stage: "shadow", passed: true, evidence_ids: ["evidence-shadow"],
    });
    f.store.save("experience_evaluation_dispatch", String(dispatch.id), { ...dispatch, status: "passed", gate_id: gate.id });
    const currentWorkItem = f.store.get("experience_learning_work_item", String(queued.work_item.id));
    const { completed_gate_refs: _completedGateRefs, ...withoutGateHistory } = currentWorkItem;
    f.store.save("experience_learning_work_item", String(currentWorkItem.id), withoutGateHistory);
    const advanced = owner.advance({ worker_id: "worker-a", lease_token: claimed.lease_token, work_item_id: queued.work_item.id, gate_id: gate.id,
      now: "2026-11-26T10:03:02.000Z" }) as { work_item: Record<string, unknown>; idempotent: boolean };
    assert.equal(advanced.idempotent, false);
    assert.equal(advanced.work_item.stage, "held_out");
    assert.equal(advanced.work_item.status, "queued");
    assert.equal(owner.advance({ work_item_id: queued.work_item.id, gate_id: gate.id }).idempotent, true);

    const heldOutGate = f.store.create("experience_procedure_gate", "gate-held-out", {
      procedure_id: f.candidateRef.id, stage: "held_out", passed: false, evidence_ids: ["evidence-held-out"],
    });
    assert.throws(() => owner.advance({ work_item_id: queued.work_item.id, gate_id: heldOutGate.id }), /passed stage Gate/u);
    const heldCredentials = bindGate(f, owner, queued.work_item.id, heldOutGate);
    const failed = owner.failFromGate({ ...heldCredentials, work_item_id: queued.work_item.id, gate_id: heldOutGate.id }) as {
      work_item: Record<string, unknown>; idempotent: boolean;
    };
    assert.equal(failed.idempotent, false);
    assert.equal(failed.work_item.status, "failed");
    assert.equal(failed.work_item.retryable, false);
    assert.equal(owner.failFromGate({ work_item_id: queued.work_item.id, gate_id: heldOutGate.id }).idempotent, true);
    assert.throws(() => owner.resume({ work_item_id: queued.work_item.id, expected_version: failed.work_item.version }), /retryable/u);
  } finally { await f.close(); }
});

test("Work Item rejects another dispatch and a result after its claim expires or is replaced", async () => {
  const f = await fixture();
  try {
    const owner = f.owner(), item = (owner.enqueue(f.enqueueArgs(f.contractRef)).work_item as JsonObject);
    const claim = owner.claimNext({ worker_id: "first", now: "2026-11-26T10:00:00Z", lease_ms: 1000 });
    const dispatch = f.store.create("experience_evaluation_dispatch", "lease-dispatch", { learning_work_item_id: item.id,
      procedure_id: f.candidateRef.id, procedure_version: 1, stage: "shadow", status: "awaiting_adapter" });
    owner.attachEvaluationDispatch({ work_item_id: item.id, worker_id: "first", lease_token: claim.lease_token, dispatch_id: dispatch.id, now: "2026-11-26T10:00:00Z" });
    const candidate = f.store.get("experience_procedure", f.candidateRef.id);
    f.store.save("experience_procedure", f.candidateRef.id, { ...candidate, completed_gates: ["shadow"] });
    const gate = f.store.create("experience_procedure_gate", "lease-gate", { procedure_id: f.candidateRef.id, stage: "shadow", passed: true, evidence_ids: ["evidence"] });
    f.store.save("experience_evaluation_dispatch", String(dispatch.id), { ...dispatch, status: "passed", gate_id: "other-gate" });
    assert.throws(() => owner.advance({ worker_id: "first", lease_token: claim.lease_token, work_item_id: item.id, gate_id: gate.id, now: "2026-11-26T10:00:00.500Z" }), /Gate does not match/u);
    const current = f.store.get("experience_evaluation_dispatch", String(dispatch.id));
    f.store.save("experience_evaluation_dispatch", String(dispatch.id), { ...current, gate_id: gate.id });
    const active = f.store.get("experience_learning_work_item", String(item.id));
    f.store.save("experience_learning_work_item", String(item.id), { ...active, lease_expires_at: "invalid" });
    assert.throws(() => owner.advance({ worker_id: "first", lease_token: claim.lease_token, work_item_id: item.id, gate_id: gate.id, now: "2026-11-26T10:00:00.500Z" }), /unexpired lease/u);
    assert.throws(() => owner.assertDispatchClaim({ work_item_id: item.id, worker_id: "first", lease_token: claim.lease_token, now: "2026-11-26T10:00:00.500Z" }, "shadow", f.store.get("experience_procedure", f.candidateRef.id)), /lease/u);
    f.store.updateIfVersion("experience_learning_work_item", String(item.id), Number(f.store.get("experience_learning_work_item", String(item.id)).version), active);
    assert.throws(() => owner.advance({ worker_id: "first", lease_token: claim.lease_token, work_item_id: item.id, gate_id: gate.id, now: "2026-11-26T10:00:01Z" }), /unexpired lease/u);
    owner.claimNext({ worker_id: "second", now: "2026-11-26T10:00:02Z" });
    assert.throws(() => owner.advance({ worker_id: "first", lease_token: claim.lease_token, work_item_id: item.id, gate_id: gate.id, now: "2026-11-26T10:00:02Z" }), /active dispatch/u);
  } finally { await f.close(); }
});

test("Work Item dispatch attachment rejects Candidate digest drift after the lease is claimed", async () => {
  const f = await fixture();
  try {
    const owner = f.owner();
    const queued = owner.enqueue(f.enqueueArgs(f.contractRef)) as { work_item: Record<string, unknown> };
    const claim = owner.claimNext({ worker_id: "worker-a", now: "2026-11-26T10:03:00.000Z" }) as {
      work_item: Record<string, unknown>; lease_token: string;
    };
    const dispatch = f.store.create("experience_evaluation_dispatch", "dispatch-drifted-candidate", {
      learning_work_item_id: queued.work_item.id, procedure_id: f.candidateRef.id, procedure_version: 1, stage: "shadow",
    });
    const candidate = f.store.get("experience_procedure", f.candidateRef.id);
    f.store.save("experience_procedure", f.candidateRef.id, {
      ...candidate, definition_digest: `sha256:${"f".repeat(64)}`,
    });

    assert.throws(() => owner.attachEvaluationDispatch({ work_item_id: queued.work_item.id, worker_id: "worker-a",
      lease_token: claim.lease_token, dispatch_id: dispatch.id, now: "2026-11-26T10:03:00.500Z" }),
    /Candidate has drifted from the pinned Learning Work Item/u);
  } finally { await f.close(); }
});

test("Work Item dispatch attachment rejects Candidate version drift with a stable digest", async () => {
  const f = await fixture();
  try {
    const owner = f.owner();
    const queued = owner.enqueue(f.enqueueArgs(f.contractRef)) as { work_item: Record<string, unknown> };
    const claim = owner.claimNext({ worker_id: "worker-version", now: "2026-11-26T10:03:00.000Z" }) as {
      work_item: Record<string, unknown>; lease_token: string;
    };
    const dispatch = f.store.create("experience_evaluation_dispatch", "dispatch-drifted-candidate-version", {
      learning_work_item_id: queued.work_item.id, procedure_id: f.candidateRef.id, procedure_version: 2, stage: "shadow",
    });
    const candidate = f.store.get("experience_procedure", f.candidateRef.id);
    f.store.save("experience_procedure", f.candidateRef.id, { ...candidate, candidate_version: 2 });

    assert.throws(() => owner.attachEvaluationDispatch({ work_item_id: queued.work_item.id, worker_id: "worker-version",
      lease_token: claim.lease_token, dispatch_id: dispatch.id, now: "2026-11-26T10:03:00.500Z" }),
    /Candidate has drifted from the pinned Learning Work Item/u);
  } finally { await f.close(); }
});

test("Work Item rejects out-of-order or early-routeable gates and stale Candidate resume", async () => {
  const f = await fixture();
  try {
    const owner = f.owner();
    const queued = owner.enqueue(f.enqueueArgs(f.contractRef)) as { work_item: Record<string, unknown> };
    const candidate = () => f.store.get("experience_procedure", f.candidateRef.id);
    const saveCandidate = (changes: Record<string, unknown>) => f.store.save("experience_procedure", f.candidateRef.id,
      { ...candidate(), ...changes });
    const gate = (id: string, stage: string, passed: boolean) => f.store.create("experience_procedure_gate", id, {
      procedure_id: f.candidateRef.id, stage, passed, evidence_ids: [`evidence-${id}`],
    });

    saveCandidate({ completed_gates: ["shadow"] });
    const shadowGate = gate("ordered-shadow", "shadow", true);
    const shadowCredentials = bindGate(f, owner, queued.work_item.id, shadowGate);
    owner.advance({ ...shadowCredentials, work_item_id: queued.work_item.id, gate_id: shadowGate.id });
    assert.throws(() => owner.failFromGate({ work_item_id: queued.work_item.id,
      gate_id: gate("wrong-stage-failure", "signoff", false).id }), /exact failed stage Gate/u);

    saveCandidate({ completed_gates: ["held_out"] });
    assert.throws(() => owner.advance({ work_item_id: queued.work_item.id,
      gate_id: gate("missing-shadow-gate", "held_out", true).id }), /Gate order is incomplete/u);

    saveCandidate({ completed_gates: ["shadow", "held_out"], lifecycle: "routeable", routeable: true });
    const heldOutGate = gate("held-out-early-route", "held_out", true);
    assert.throws(() => owner.advance({ work_item_id: queued.work_item.id, gate_id: heldOutGate.id }),
      /Candidate became routeable before the Canary Gate/u);
    saveCandidate({ lifecycle: "candidate", routeable: false });
    const heldCredentials = bindGate(f, owner, queued.work_item.id, heldOutGate);
    owner.advance({ ...heldCredentials, work_item_id: queued.work_item.id, gate_id: heldOutGate.id });

    saveCandidate({ completed_gates: ["shadow", "held_out", "signoff"] });
    const signoffGate = gate("ordered-signoff", "signoff", true);
    const signoffCredentials = bindGate(f, owner, queued.work_item.id, signoffGate);
    owner.advance({ ...signoffCredentials, work_item_id: queued.work_item.id, gate_id: signoffGate.id });
    saveCandidate({ completed_gates: ["shadow", "held_out", "signoff", "canary"] });
    assert.throws(() => owner.advance({ work_item_id: queued.work_item.id,
      gate_id: gate("canary-without-route", "canary", true).id }), /did not make the exact Candidate routeable/u);
    saveCandidate({ lifecycle: "routeable", routeable: true });
    assert.throws(() => owner.failFromGate({ work_item_id: queued.work_item.id,
      gate_id: gate("routeable-failed-canary", "canary", false).id }), /Failed Gate does not match the pinned Candidate/u);

    const claim = owner.claimNext({ worker_id: "worker-a", now: "2026-11-26T10:05:00.000Z" }) as {
      work_item: Record<string, unknown>; lease_token: string;
    };
    const blocked = owner.block({ work_item_id: claim.work_item.id, worker_id: "worker-a", lease_token: claim.lease_token,
      reason: "worker_unavailable", now: "2026-11-26T10:05:01.000Z" }) as { work_item: Record<string, unknown> };
    saveCandidate({ lifecycle: "candidate", routeable: false, definition_digest: `sha256:${"f".repeat(64)}` });
    assert.throws(() => owner.resume({ work_item_id: blocked.work_item.id, expected_version: blocked.work_item.version,
      now: "2026-11-26T10:05:02.000Z" }), /Candidate changed/u);
  } finally { await f.close(); }
});

test("Work Item completes only after all ordered gates leave the exact Candidate routeable", async () => {
  const f = await fixture();
  try {
    const owner = f.owner();
    const queued = owner.enqueue(f.enqueueArgs(f.contractRef)) as { work_item: Record<string, unknown> };
    for (const stage of ["shadow", "held_out", "signoff", "canary"] as const) {
      const current = f.store.get("experience_procedure", f.candidateRef.id);
      const completed = [...(current.completed_gates as string[]), stage];
      f.store.save("experience_procedure", f.candidateRef.id, {
        ...current, completed_gates: completed,
        ...(stage === "canary" ? { lifecycle: "routeable", routeable: true } : {}),
      });
      const gate = f.store.create("experience_procedure_gate", `gate-${stage}`, {
        procedure_id: f.candidateRef.id, stage, passed: true, evidence_ids: [`evidence-${stage}`],
      });
      const credentials = bindGate(f, owner, queued.work_item.id, gate);
      const result = owner.advance({ ...credentials, work_item_id: queued.work_item.id, gate_id: gate.id }) as { work_item: Record<string, unknown> };
      assert.equal(result.work_item.stage, stage === "canary" ? "completed" : ["shadow", "held_out", "signoff", "canary"][["shadow", "held_out", "signoff", "canary"].indexOf(stage) + 1]);
    }
    const item = f.store.get("experience_learning_work_item", String(queued.work_item.id));
    assert.equal(item.status, "completed");
    assert.equal(item.stage, "completed");
    assert.equal((item.completed_gate_refs as JsonObject[]).length, 4);
    assert.equal(f.owner().claimNext({ worker_id: "worker-a" }).status, "idle");
  } finally { await f.close(); }
});

test("Work Item input, stage, source, lease and restart boundaries fail closed", async () => {
  const f = await fixture();
  try {
    const owner = f.owner();
    assert.throws(() => owner.setEvaluationContractSource(null as never), /owner is unavailable/u);
    assert.throws(() => owner.enqueue({ ...f.enqueueArgs(), scope: "user:local" }), /canonical project scope/u);
    assert.throws(() => owner.enqueue({ ...f.enqueueArgs(), candidate_ref: { ...f.candidateRef, version: 0 } }), /candidate_ref is invalid/u);
    assert.throws(() => owner.enqueue({ ...f.enqueueArgs(), candidate_ref: { ...f.candidateRef, digest: "bad" } }), /candidate_ref is invalid/u);
    assert.throws(() => owner.listPending({ limit: 0 }), /limit/u);
    assert.throws(() => owner.claimNext({ worker_id: "worker-a", lease_ms: 500 }), /lease_ms/u);
  assert.equal(owner.claimNext({ worker_id: "worker-a" }).status, "idle");

    const queued = owner.enqueue(f.enqueueArgs(f.contractRef)) as { work_item: Record<string, unknown> };
    const claim = owner.claimNext({ worker_id: "worker-a", now: "2026-11-26T10:04:00.000Z" }) as {
      work_item: Record<string, unknown>; lease_token: string;
    };
    assert.throws(() => owner.block({ work_item_id: queued.work_item.id, worker_id: "worker-a", lease_token: claim.lease_token,
      reason: "raw user content", now: "2026-11-26T10:04:01.000Z" }), /reason/u);
    assert.throws(() => owner.fail({ work_item_id: queued.work_item.id, worker_id: "worker-a", lease_token: claim.lease_token,
      reason: "unsupported", now: "2026-11-26T10:04:01.000Z" }), /failure reason/u);
    assert.throws(() => owner.block({ work_item_id: queued.work_item.id, worker_id: "worker-a", lease_token: claim.lease_token,
      reason: "worker_unavailable", now: "2026-11-26T10:10:00.000Z" }), /lease/u);
    assert.throws(() => owner.advance({ work_item_id: queued.work_item.id, gate_id: "missing-gate" }), /Unknown experience_procedure_gate/u);

    const wrongGate = f.store.create("experience_procedure_gate", "wrong-gate", {
      procedure_id: f.candidateRef.id, stage: "held_out", passed: true, evidence_ids: ["evidence"],
    });
    assert.throws(() => owner.advance({ work_item_id: queued.work_item.id, gate_id: wrongGate.id }), /passed stage Gate/u);
    const candidate = f.store.get("experience_procedure", f.candidateRef.id);
    f.store.save("experience_procedure", f.candidateRef.id, { ...candidate, completed_gates: ["shadow"], definition_digest: `sha256:${"f".repeat(64)}` });
    const shadowGate = f.store.create("experience_procedure_gate", "stale-candidate-gate", {
      procedure_id: f.candidateRef.id, stage: "shadow", passed: true, evidence_ids: ["evidence"],
    });
    assert.throws(() => owner.advance({ work_item_id: queued.work_item.id, gate_id: shadowGate.id }), /Candidate has not committed/u);
  } finally { await f.close(); }
});

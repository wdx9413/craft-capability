import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "craft-common-store-local/store";
import { craftPaths } from "craft-common-store-local/paths";
import { digestJson, stableDigest } from "craft-common-base/digest";
import { MemoryCapture } from "../memory-capture.ts";
import { seedLegacySession } from "./legacy-session-fixture.ts";
import { MemoryGovernanceKernel } from "../memory-governance.ts";
import { MemoryLedgerKernel } from "../memory-ledger.ts";
import { globalPromotionContentDecision } from "../global-promotion-gate.ts";

const CONTENT = "I prefer clear written plans.";
const identifiableExample = ["Contact alex", "@example.com for this."].join("");

test("global Memory gate rejects non-shareable sensitivity and recognizable identifiers", () => {
  assert.deepEqual(globalPromotionContentDecision(CONTENT, "restricted"), { eligible: false, reason_code: "sensitivity_not_shareable" });
  for (const content of [
    identifiableExample, ["Read https://", "internal.example/path"].join(""), "Use host 10.2.3.4",
    "Build 123e4567-e89b-12d3-a456-426614174000", ["Config lives at /", "Users/alex/private"].join(""),
    "Use project ABC-123 for this task.",
  ]) assert.deepEqual(globalPromotionContentDecision(content, "internal"), { eligible: false, reason_code: "deidentification_required" });
  assert.deepEqual(globalPromotionContentDecision(CONTENT, "internal"), { eligible: true });
  assert.deepEqual(globalPromotionContentDecision(CONTENT, "public"), { eligible: true });
});

test("global Memory gate keeps project-scoped statements inside their project", () => {
  for (const content of ["本项目默认使用 Node.js", "当前仓库约定：先运行 focused tests", "This repository uses Node.js"]) {
    assert.deepEqual(globalPromotionContentDecision(content, "internal"), { eligible: false, reason_code: "project_scope_not_shareable" });
  }
  assert.deepEqual(globalPromotionContentDecision("I prefer Node.js across projects.", "internal"), { eligible: true });
});

test("public Memory writes reject session scope and accept project or global scope", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.capture.captureUserStatement({ session_id: "session-only", content: "Prefer concise replies." }), /project or global scope/u);
    assert.throws(() => f.capture.captureUserStatement({ scope_kind: "global", scope_id: "other", content: "Prefer concise replies." }), /scope_id must be global/u);
    assert.throws(() => f.capture.captureUserStatement({ scope_kind: "project", scope_id: "other", project_scope_id: "project-current", content: "Prefer concise replies." }), /does not match/u);
    assert.throws(() => f.capture.memory.propose({ source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "session",
      scope_id: "session-only", content: "Prefer concise replies." }), /project or global scope/u);
    assert.throws(() => f.capture.memory.ledger.remember({ source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "session",
      scope_id: "session-only", content: "Prefer concise replies." }), /project or global scope/u);
    assert.deepEqual(f.capture.memory.ledger.files.sync({ kind: "session", id: "session-only" }),
      { status: "unavailable", reason: "session_projection_disabled", count: 0 });
    const project = f.capture.captureUserStatement({ project_scope_id: "project-current", content: "Prefer concise replies.", topic: "project-test" });
    assert.deepEqual((project.candidate as JsonObject).scope, { kind: "project", id: "project-current" });
    const global = f.capture.captureUserStatement({ content: "Prefer clear replies.", topic: "global-test" });
    assert.deepEqual((global.candidate as JsonObject).scope, { kind: "global", id: "global" });
  } finally { await f.close(); }
});

async function fixture(options: { sharedEvidence?: boolean; invalidScope?: boolean; canonicalScope?: boolean; content?: string; sensitivity?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "craft-memory-global-gate-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const ledger = new MemoryLedgerKernel(store);
  const governance = new MemoryGovernanceKernel(store, ledger);
  store.create("knowledge_source", "builtin.evidence-wiki", { scope: { kind: "global", id: "global" }, status: "active", trust: "verified" });
  const content = options.content ?? CONTENT;
  const contentDigest = stableDigest(content);
  for (const projectId of ["project-0", "project-1", "project-2", "project-current"]) {
    const projectRoot = join(root, projectId);
    await mkdir(projectRoot);
    store.create("scope_alias", `alias-${projectId}`, { scope: { kind: "project", id: projectId }, alias_kind: "path", alias: projectRoot, status: "active" });
  }
  if (options.canonicalScope) store.create("scope_alias", "alias-canonical", { scope: { kind: "project", id: "project:project-0" }, alias_kind: "path", alias: join(root, "project-0"), status: "active" });
  for (let index = 0; index < 3; index += 1) {
    const evidenceId = options.sharedEvidence ? "e-shared" : `e-project-${index}`;
    if (!store.find("evidence", evidenceId)) store.create("evidence", evidenceId, { source_type: "host_observed_fact", confidence: "bounded" });
    store.create("memory_ledger", `memory-project-${index}`, { source_id: "builtin.evidence-wiki", kind: "preference", scope: { kind: "project", id: options.canonicalScope && index === 0 ? `project:project-${index}` : `project-${index}` }, content, content_digest: contentDigest, topic: "", sensitivity: "internal", confidence: "bounded", evidence_ids: [evidenceId], status: "active", source_lineage: [{ origin: "live_hook", session_id: `project-session-${index}`, project_scope_id: `project:project-${index}`, source_ref: { kind: "fixture", id: `source-${index}` }, evidence_refs: [{ kind: "evidence", id: evidenceId, version: 1 }] }] });
  }
  store.create("memory_ledger", "memory-project-current", { source_id: "builtin.evidence-wiki", kind: "preference", scope: { kind: "project", id: "project-current" }, content, content_digest: contentDigest, topic: "", sensitivity: "internal", confidence: "bounded", evidence_ids: [options.sharedEvidence ? "e-shared" : "e-current-project"], status: "active", source_lineage: [{ origin: "live_hook", session_id: "project-session-current", project_scope_id: "project:project-current", source_ref: { kind: "fixture", id: "source-current" }, evidence_refs: [{ kind: "evidence", id: options.sharedEvidence ? "e-shared" : "e-current-project", version: 1 }] }] });
  if (!options.sharedEvidence) store.create("evidence", "e-current-project", { source_type: "host_observed_fact", confidence: "bounded" });
  for (const [suffix, evidenceId] of [["a", "e-observation-a"], ["b", "e-observation-b"]]) {
    store.create("evidence", evidenceId, { source_type: "human", confidence: "bounded" });
    store.create("memory_observation", `observation-${suffix}`, {
      content_digest: contentDigest, project_id: "project-current", session_digest: `session-${suffix}`, kind: "preference", topic: "",
      scope: { kind: "project", id: "project-current" }, evidence_ids: [evidenceId], evidence_refs: [{ id: evidenceId, version: 1 }], content_free: true, status: "active",
      source_lineage: [{ origin: "test_fixture", session_id: `session-${suffix}`, project_scope_id: "project:project-current",
        source_ref: { kind: "test_observation", id: `observation-${suffix}` }, evidence_refs: [{ kind: "evidence", id: evidenceId, version: 1 }] }],
    });
  }
  const capture = new MemoryCapture(governance, () => undefined, (args) => store.create("evidence", String(args.evidence_id), {
    source_type: args.source_type, confidence: args.confidence, claim: args.claim, locator: args.locator, metadata: args.metadata,
  }));
  const evidence = store.create("evidence", "e-observation-current", { source_type: "human", confidence: "bounded" });
  return {
    content, capture, evidence, store,
    captureObserved() {
      return capture.captureObservedFact({ session_id: "session-current", project_scope_id: "project-current", content,
        sensitivity: options.sensitivity ?? "internal" });
    },
    captureLegacy() {
      return seedLegacySession(capture, { session_id: "session-current", project_scope_id: "project-current", content,
        sensitivity: options.sensitivity ?? "internal" });
    },
    archive() { return ledger.files.archiveSession("session-current"); },
    async close() { store.close(); await rm(root, { recursive: true, force: true }); },
    promote() {
      return (capture as unknown as { promoteRepeatedFact(input: JsonObject): JsonObject[] }).promoteRepeatedFact({
        sessionId: "session-current", projectId: "project-current", candidate: {
          id: "candidate-current", scope: { kind: "session", id: "session-current" }, content, content_digest: contentDigest,
          source_id: "builtin.evidence-wiki", kind: "preference", sensitivity: options.sensitivity ?? "internal", topic: "", evidence_ids: [String(evidence.id)],
        }, evidence,
      });
    },
    rejectSupport() { capture.memory.ledger.validatePromotionSupport = () => { throw new Error("support unavailable"); }; },
  };
}

test("global Memory promotion uses independent project evidence and awaits evaluation", async () => {
  const f = await fixture();
  try {
    const projectMemory = f.store.get("memory_ledger", "memory-project-0");
    const projectEvidenceId = String((projectMemory.evidence_ids as string[])[0]);
    f.store.save("memory_ledger", String(projectMemory.id), { ...projectMemory, source_lineage: [{ origin: "live_hook", session_id: "project-zero-session",
      project_scope_id: "project:project-0", source_ref: { kind: "fixture", id: "project-zero" },
      evidence_refs: [{ kind: "evidence", id: projectEvidenceId, version: 1 }] }] });
    f.store.create("memory_observation", "legacy-source-lineage-omitted", { content_digest: stableDigest(f.content), project_id: "project-current",
      session_digest: "legacy-no-lineage-session", kind: "preference", topic: "", scope: { kind: "project", id: "project-current" }, status: "active" });
    const result = f.promote();
    const global = result.find(item => item.tier === "global")!;
    assert.equal(global.auto_committed, false);
    assert.equal(global.evaluation_status, "pending");
    assert.ok(((global.candidate as JsonObject).source_lineage as JsonObject[]).some(item => item.session_id === "project-zero-session"));
  } finally { await f.close(); }
});

test("ordinary governed conflict resolution commits a supported project candidate", async () => {
  const f = await fixture();
  try {
    f.capture.memory.policySave({ mode: "propose" });
    const input = { project_scope_id: "project-current", content: "Prefer concise responses.", topic: "response-style" };
    const proposed = f.capture.captureUserStatement(input);
    f.capture.memory.policySave({ mode: "governed" });
    const resolved = f.capture.memory.resolveConflict({ candidate_id: (proposed.candidate as JsonObject).id,
      resolution: "supersede", actor: "operator", reason: "This is the current preference." });
    assert.equal(resolved.auto_committed, true);
    assert.equal(f.capture.captureUserStatement(input).already_retained, true);
  } finally { await f.close(); }
});

test("global promotion waits when evidence storage is unavailable", async t => {
  const f = await fixture();
  try {
    t.mock.method(f.store, "list", () => { throw new Error("offline"); });
    const run = f.capture as unknown as { tryPromoteGlobalFact(candidate: JsonObject): JsonObject[] };
    assert.deepEqual(run.tryPromoteGlobalFact({ content_digest: "digest" }), [{ tier: "global", status: "waiting", auto_committed: false,
      reason_code: "promotion_gate_unavailable", error_type: "Error" }]);
    t.mock.restoreAll();
    t.mock.method(f.store, "list", () => { throw "offline"; });
    assert.equal(run.tryPromoteGlobalFact({})[0]?.error_type, "unknown");
  } finally { await f.close(); }
});

test("global promotion waits for verifiable live project lineage", async () => {
  for (const variant of ["missing", "fixture", "wrong-project", "changed-evidence", "missing-evidence", "unrelated-evidence"]) {
    const f = await fixture();
    try {
      const memory = f.store.get("memory_ledger", "memory-project-0");
      const lineage = (memory.source_lineage as JsonObject[])[0]!;
      if (variant === "changed-evidence") {
        const evidence = f.store.get("evidence", String((memory.evidence_ids as string[])[0]));
        f.store.save("evidence", String(evidence.id), { ...evidence, confidence: "confirmed" });
      } else if (variant === "missing-evidence" || variant === "unrelated-evidence") {
        f.store.save("memory_ledger", String(memory.id), { ...memory, evidence_ids: variant === "missing-evidence" ? null : ["other-evidence"] });
      } else {
        const next = variant === "missing" ? [] : [{ ...lineage, ...(variant === "fixture" ? { origin: "test_fixture" } : { project_scope_id: "project:other" }) }];
        f.store.save("memory_ledger", String(memory.id), { ...memory, source_lineage: next });
      }
      const result = f.promote().find(item => item.tier === "global");
      assert.equal(result?.reason_code, "independent_project_lineage_unverified");
      assert.equal(result?.status, "waiting");
    } finally { await f.close(); }
  }
});

test("global promotion accepts a canonical project scope when lineage matches", async () => {
  const f = await fixture({ canonicalScope: true });
  try {
    assert.equal(f.promote().find(item => item.tier === "global")?.evaluation_status, "pending");
  } finally { await f.close(); }
});

test("global promotion rejects two projects supported by the same Host session", async () => {
  const f = await fixture();
  try {
    for (const index of [0, 1]) {
      const memory = f.store.get("memory_ledger", `memory-project-${index}`);
      f.store.save("memory_ledger", String(memory.id), { ...memory, source_lineage: [{ origin: "live_hook", session_id: "same-session",
        project_scope_id: `project:project-${index}`, source_ref: { kind: "fixture", id: `project-${index}` },
        evidence_refs: [{ kind: "evidence", id: String((memory.evidence_ids as string[])[0]), version: 1 }] }] });
    }
    assert.equal(f.promote().find(item => item.tier === "global")?.reason_code, "shared_session");
  } finally { await f.close(); }
});

test("Memory capture auto-promotion rejects identifiers, non-shareable sensitivity, shared Evidence, and accepts a clean case", async () => {
  const cases = [
    { options: { content: ["Contact alex at alex", "@example.com."].join("") }, reason: "deidentification_required" },
    { options: { content: "本项目默认使用 Node.js" }, reason: "project_scope_not_shareable" },
    { options: { sensitivity: "restricted" }, reason: "sensitivity_not_shareable" },
    { options: { sharedEvidence: true }, reason: "shared_evidence" },
  ];
  for (const item of cases) {
    const f = await fixture(item.options);
    try {
      const captured = f.captureObserved() as JsonObject;
      const global = (captured.promotions as JsonObject[]).find(row => row.tier === "global")!;
      assert.equal(global.status, "rejected");
      assert.equal(global.auto_committed, false);
      assert.equal(global.reason_code, item.reason);
      assert.equal(f.store.list("memory_candidate", 100, row => (row.scope as JsonObject | undefined)?.kind === "global").length, 0);
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    const captured = f.captureObserved() as JsonObject;
    const global = (captured.promotions as JsonObject[]).find(row => row.tier === "global")!;
    assert.equal(global.auto_committed, false);
    assert.equal(global.evaluation_status, "pending");
    assert.equal(f.store.list("memory_ledger", 100, row => (row.scope as JsonObject).kind === "global").length, 0);
    const candidate = global.candidate as JsonObject;
    assert.throws(() => f.capture.memory.review({ candidate_id: candidate.id, decision: "approve", reviewer: "operator", reason: "Attempt to approve." }), /independent evaluation/u);
    f.capture.memory.policySave({ mode: "governed" });
    const resolved = f.capture.memory.resolveConflict({ candidate_id: candidate.id, resolution: "supersede", actor: "operator", reason: "Resolve conflict." });
    assert.equal(resolved.auto_committed, false);
    const updated = resolved.candidate as JsonObject;
    Object.assign(candidate, updated);
    const candidateRef = { kind: "memory_candidate", id: candidate.id, version: candidate.version, digest: candidate.content_digest };
    const evaluationBinding = { contract_id: "contract", evaluation_id: "evaluation", candidate_ref: candidateRef };
    assert.throws(() => f.capture.memory.review({ candidate_id: candidate.id, decision: "approve", reviewer: "operator", reason: "No verifier.", evaluation_binding: evaluationBinding }), /verifier is unavailable/u);
    assert.throws(() => f.capture.memory.review({ candidate_id: candidate.id, decision: "approve", reviewer: "operator", reason: "Stale version.", evaluation_binding: { ...evaluationBinding, candidate_ref: { ...candidateRef, version: 999 } } }), /current candidate version/u);
    f.capture.memory.setEvaluationVerifier({ verifyTaskEffectEvaluation: () => ({ valid: true, eligible: false, routeable: false, candidate_ref: candidateRef }) });
    assert.throws(() => f.capture.memory.review({ candidate_id: candidate.id, decision: "approve", reviewer: "operator",
      reason: "Reviewed evaluation.", evaluation_binding: evaluationBinding }), /did not pass/u);
    f.capture.memory.setEvaluationVerifier({ verifyTaskEffectEvaluation: () => ({ valid: true, eligible: true, routeable: true, candidate_ref: candidateRef }) });
    f.capture.memory.review({ candidate_id: candidate.id, decision: "approve", reviewer: "operator",
      reason: "Reviewed evaluation.", evaluation_binding: evaluationBinding });
    const approved = f.store.get("memory_candidate", String(candidate.id));
    f.store.save("memory_candidate", String(candidate.id), { ...approved, evaluation_binding: null });
    assert.throws(() => f.capture.memory.remember({ candidate_id: candidate.id }), /independent evaluation before commit/u);
    f.store.save("memory_candidate", String(candidate.id), { ...f.store.get("memory_candidate", String(candidate.id)), evaluation_binding: approved.evaluation_binding, identity_digest: "tampered" });
    assert.throws(() => f.capture.memory.remember({ candidate_id: candidate.id }), /version is unavailable or changed/u);
    const tampered = f.store.get("memory_candidate", String(candidate.id));
    f.store.save("memory_candidate", String(candidate.id), { ...tampered, identity_digest: approved.identity_digest });
    f.capture.memory.remember({ candidate_id: candidate.id });
    assert.equal(f.store.list("memory_ledger", 100, row => (row.scope as JsonObject).kind === "global").length, 1);
  } finally { await f.close(); }
});

test("promotion worker ignores approved project candidates without a committed ledger", async () => {
  const f = await fixture();
  try {
    f.store.create("memory_candidate", "incomplete-candidate", { scope: { kind: "project", id: "project-current" },
      proposed_by: "host-observed-stable-fact", status: "approved" });
    const result = f.capture.processObservedPromotions({ project_scope_id: "project-current" });
    assert.equal((result.items as JsonObject[]).length, 0);
  } finally { await f.close(); }
});

test("an independent evaluation candidate can be rejected without binding", async () => {
  const f = await fixture();
  try {
    const result = f.captureObserved();
    const candidate = ((result.promotions as JsonObject[]).find(item => item.tier === "global")!.candidate as JsonObject);
    const rejected = f.capture.memory.review({ candidate_id: candidate.id, decision: "reject", reviewer: "operator", reason: "Not useful." });
    assert.equal((rejected.candidate as JsonObject).status, "rejected");
    assert.equal((rejected.candidate as JsonObject).evaluation_binding, undefined);
  } finally { await f.close(); }
});

test("worker revisits manually approved project captures for global promotion", async () => {
  const f = await fixture();
  try {
    f.capture.memory.policySave({ mode: "propose" });
    const captured = f.captureObserved() as JsonObject;
    const candidate = captured.candidate as JsonObject;
    f.capture.memory.review({ candidate_id: candidate.id, decision: "approve", reviewer: "operator", reason: "Reviewed the project observation." });
    f.capture.memory.remember({ candidate_id: candidate.id });
    const repeated = f.captureObserved();
    assert.equal(repeated.already_retained, true);
    f.capture.memory.policySave({ mode: "governed" });
    const result = f.capture.processObservedPromotions({ project_scope_id: "project-current" });
    assert.ok((result.items as JsonObject[]).some(item =>
      (item.promotions as JsonObject[] | undefined)?.some(promotion => promotion.tier === "global" && promotion.evaluation_status === "pending")));
    assert.equal(f.store.list("memory_ledger", 100, row => (row.scope as JsonObject).kind === "global").length, 0);
  } finally { await f.close(); }
});

test("project promotion worker rotates pages and retries earlier candidates", async () => {
  const f = await fixture();
  try {
    f.capture.memory.policySave({ mode: "propose" });
    for (const [session, content, topic] of [
      ["page-a", "I prefer focused test reports.", "report"],
      ["page-b", "I prefer concise status updates.", "status"],
    ]) {
      const captured = f.capture.captureObservedFact({ session_id: session, project_scope_id: "project-current", content, topic });
      const candidate = captured.candidate as JsonObject;
      f.capture.memory.review({ candidate_id: candidate.id, decision: "approve", reviewer: "operator", reason: "Reviewed the observation." });
      f.capture.memory.remember({ candidate_id: candidate.id });
    }
    const position = () => String(f.store.list("memory_project_promotion_cursor", 1)[0]?.last_candidate_id);
    f.capture.processObservedPromotions({ project_scope_id: "project-current", limit: 1 });
    const first = position();
    f.capture.processObservedPromotions({ project_scope_id: "project-current", limit: 1 });
    const second = position();
    assert.notEqual(first, second);
    f.capture.processObservedPromotions({ project_scope_id: "project-current", limit: 1 });
    assert.equal(position(), first);
  } finally { await f.close(); }
});

test("observed Memory capture queues promotion for idempotent asynchronous processing", async () => {
  const f = await fixture();
  try {
    const captured = f.captureLegacy() as JsonObject;
    assert.deepEqual(captured.promotions, []);
    assert.equal(captured.next_action, "memory_promotion_queued");
    const first = f.capture.processObservedPromotions() as JsonObject;
    const second = f.capture.processObservedPromotions({ project_scope_id: "project-current" }) as JsonObject;
    assert.equal(first.processed, 1);
    assert.equal(first.promoted, 0);
    assert.equal(second.processed, 0);
    assert.equal(second.promoted, 0);
    const captureEvidenceId = String((captured.evidence as JsonObject).id);
    const observation = f.store.list("memory_observation", 100, row => Array.isArray(row.evidence_ids) && row.evidence_ids.includes(captureEvidenceId))[0]!;
    assert.ok((observation.source_lineage as JsonObject[]).some(item => item.origin === "live_hook"));
    assert.equal(f.store.list("memory_ledger", 100, row => (row.scope as JsonObject).kind === "global").length, 0);
  } finally { await f.close(); }
});

test("Memory promotion reclaims an expired processing lease without duplicating the observation", async () => {
  const f = await fixture();
  try {
    f.captureLegacy();
    const job = f.store.list("memory_observation_promotion", 10)[0]!;
    f.store.save("memory_observation_promotion", String(job.id), { ...job, status: "processing", claim_id: "dead-worker",
      lease_expires_at: "2000-01-01T00:00:00.000Z", attempts: 1 });
    const result = f.capture.processObservedPromotions() as JsonObject;
    assert.equal(result.processed, 1);
    assert.equal(result.promoted, 0);
    const completed = f.store.find("memory_observation_promotion", String(job.id))!;
    assert.equal(completed.status, "observed");
    assert.equal(completed.attempts, 2);
    assert.equal(f.store.list("memory_observation", 10, row => row.project_id === "project-current").length, 3);
  } finally { await f.close(); }
});

test("session archive retains the minimum approved Memory candidate until the worker observes it", async () => {
  const f = await fixture();
  try {
    f.captureLegacy();
    const archived = f.archive() as JsonObject;
    assert.equal(archived.content_deleted, false);
    assert.equal(archived.promotion_content_retained, true);
    assert.equal(archived.pending_promotion_count, 1);
    assert.equal(f.store.listSessionMemoryPage("memory_observation_intent", "session-current", "", 500).records.filter(row => row.promotion_status === "pending").length, 1);
    assert.equal(f.store.listSessionMemoryPage("memory_candidate", "session-current", "", 500).records.filter(row => row.status === "approved").length, 1);
    const processed = f.capture.processObservedPromotions({ project_scope_id: "project-current" }) as JsonObject;
    assert.equal(processed.processed, 1);
    const cleaned = f.archive() as JsonObject;
    assert.equal(cleaned.content_deleted, true);
    assert.equal(cleaned.promotion_content_retained, false);
    assert.equal(f.store.list("memory_observation", 10, row => row.project_id === "project-current").length, 3);
  } finally { await f.close(); }
});

test("session archive refuses to attach live lineage to an existing legacy observation", async () => {
  const f = await fixture();
  try {
    const captured = f.captureLegacy() as JsonObject;
    const candidate = captured.candidate as JsonObject;
    const evidence = captured.evidence as JsonObject;
    const intent = f.store.list("memory_observation_intent", 1)[0]!;
    const identity = { content_digest: candidate.content_digest, project_id: intent.project_id, session_digest: digestJson("session-current"),
      kind: candidate.kind, topic: candidate.topic ?? "" };
    f.store.create("memory_observation", `memory_observation_${digestJson(identity).slice(-32)}`, {
      ...identity, scope: { kind: "project", id: intent.project_id }, evidence_ids: candidate.evidence_ids,
      evidence_refs: [{ id: evidence.id, version: evidence.version }], content_free: true, status: "active",
    });
    assert.throws(() => f.archive(), /existing observation lineage is unavailable/u);
  } finally { await f.close(); }
});

test("archived Memory work releases retained content after Evidence is revoked", async () => {
  const f = await fixture();
  try {
    const captured = f.captureLegacy() as JsonObject;
    f.archive();
    const evidence = captured.evidence as JsonObject;
    f.store.save("evidence", String(evidence.id), { ...evidence, confidence: "unverified" });
    const processed = f.capture.processObservedPromotions({ project_scope_id: "project-current" }) as JsonObject;
    const item = (processed.items as JsonObject[])[0]!;
    assert.equal(item.status, "rejected");
    assert.equal(item.reason, "evidence_changed_or_unavailable");
    const cleaned = f.archive() as JsonObject;
    assert.equal(cleaned.content_deleted, true);
    assert.equal(cleaned.promotion_content_retained, false);
  } finally { await f.close(); }
});

test("global Memory promotion returns safe reasons for identifiable or non-independent evidence", async () => {
  for (const options of [{ content: identifiableExample }, { sensitivity: "restricted" }, { sharedEvidence: true }, { invalidScope: true }]) {
    const f = await fixture(options);
    try {
      if (options.invalidScope) f.rejectSupport();
      const result = f.promote();
      const global = result.find(item => item.tier === "global")!;
      assert.equal(global.status, "rejected");
      assert.equal(global.auto_committed, false);
      assert.equal(JSON.stringify(global).includes(identifiableExample), false);
      assert.equal(f.store.list("memory_candidate", 100, row => (row.scope as JsonObject | undefined)?.kind === "global").length, 0);
      assert.equal(global.reason_code, options.content ? "deidentification_required" : options.sensitivity ? "sensitivity_not_shareable" : options.sharedEvidence ? "shared_evidence" : "independent_project_evidence_unverified");
    } finally { await f.close(); }
  }
});

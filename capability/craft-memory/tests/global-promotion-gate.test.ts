import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "craft-common-store-local/store";
import { craftPaths } from "craft-common-store-local/paths";
import { stableDigest } from "craft-common-base/digest";
import { MemoryCapture } from "../memory-capture.ts";
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

async function fixture(options: { sharedEvidence?: boolean; invalidScope?: boolean; content?: string; sensitivity?: string } = {}) {
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
  for (let index = 0; index < 3; index += 1) {
    const evidenceId = options.sharedEvidence ? "e-shared" : `e-project-${index}`;
    if (!store.find("evidence", evidenceId)) store.create("evidence", evidenceId, { source_type: "human", confidence: "bounded" });
    store.create("memory_ledger", `memory-project-${index}`, { source_id: "builtin.evidence-wiki", kind: "preference", scope: { kind: "project", id: `project-${index}` }, content, content_digest: contentDigest, topic: "", sensitivity: "internal", confidence: "bounded", evidence_ids: [evidenceId], status: "active" });
  }
  store.create("memory_ledger", "memory-project-current", { source_id: "builtin.evidence-wiki", kind: "preference", scope: { kind: "project", id: "project-current" }, content, content_digest: contentDigest, topic: "", sensitivity: "internal", confidence: "bounded", evidence_ids: [options.sharedEvidence ? "e-shared" : "e-current-project"], status: "active" });
  if (!options.sharedEvidence) store.create("evidence", "e-current-project", { source_type: "human", confidence: "bounded" });
  for (const [suffix, evidenceId] of [["a", "e-observation-a"], ["b", "e-observation-b"]]) {
    store.create("evidence", evidenceId, { source_type: "human", confidence: "bounded" });
    store.create("memory_observation", `observation-${suffix}`, {
      content_digest: contentDigest, project_id: "project-current", session_digest: `session-${suffix}`, kind: "preference", topic: "",
      scope: { kind: "project", id: "project-current" }, evidence_ids: [evidenceId], evidence_refs: [{ id: evidenceId, version: 1 }], content_free: true, status: "active",
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

test("global Memory promotion uses independent project evidence and commits", async () => {
  const f = await fixture();
  try {
    const result = f.promote();
    const global = result.find(item => item.tier === "global")!;
    assert.equal(global.auto_committed, true);
    assert.equal(f.store.list("memory_ledger", 100, row => (row.scope as JsonObject).kind === "global").length, 1);
  } finally { await f.close(); }
});

test("Memory capture auto-promotion rejects identifiers, non-shareable sensitivity, shared Evidence, and accepts a clean case", async () => {
  const cases = [
    { options: { content: ["Contact alex at alex", "@example.com."].join("") }, reason: "deidentification_required" },
    { options: { sensitivity: "restricted" }, reason: "sensitivity_not_shareable" },
    { options: { sharedEvidence: true }, reason: "shared_evidence" },
  ];
  for (const item of cases) {
    const f = await fixture(item.options);
    try {
      f.captureObserved();
      const processed = f.capture.processObservedPromotions({ project_scope_id: "project-current" }) as JsonObject;
      const global = ((processed.items as JsonObject[]).flatMap(row => row.promotions as JsonObject[] ?? [])).find(row => row.tier === "global")!;
      assert.equal(global.status, "rejected");
      assert.equal(global.auto_committed, false);
      assert.equal(global.reason_code, item.reason);
      assert.equal(f.store.list("memory_candidate", 100, row => (row.scope as JsonObject | undefined)?.kind === "global").length, 0);
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    f.captureObserved();
    const processed = f.capture.processObservedPromotions({ project_scope_id: "project-current" }) as JsonObject;
    const global = ((processed.items as JsonObject[]).flatMap(row => row.promotions as JsonObject[] ?? [])).find(row => row.tier === "global")!;
    assert.equal(global.auto_committed, true);
    assert.equal(f.store.list("memory_ledger", 100, row => (row.scope as JsonObject).kind === "global").length, 1);
  } finally { await f.close(); }
});

test("observed Memory capture queues promotion for idempotent asynchronous processing", async () => {
  const f = await fixture();
  try {
    const captured = f.captureObserved() as JsonObject;
    assert.deepEqual(captured.promotions, []);
    assert.equal(captured.next_action, "memory_promotion_queued");
    const first = f.capture.processObservedPromotions() as JsonObject;
    const second = f.capture.processObservedPromotions({ project_scope_id: "project-current" }) as JsonObject;
    assert.equal(first.processed, 1);
    assert.equal(first.promoted, 1);
    assert.equal(second.processed, 0);
    assert.equal(second.promoted, 0);
    assert.equal(f.store.list("memory_ledger", 100, row => (row.scope as JsonObject).kind === "global").length, 1);
  } finally { await f.close(); }
});

test("Memory promotion reclaims an expired processing lease without duplicating the observation", async () => {
  const f = await fixture();
  try {
    f.captureObserved();
    const job = f.store.list("memory_observation_promotion", 10)[0]!;
    f.store.save("memory_observation_promotion", String(job.id), { ...job, status: "processing", claim_id: "dead-worker",
      lease_expires_at: "2000-01-01T00:00:00.000Z", attempts: 1 });
    const result = f.capture.processObservedPromotions() as JsonObject;
    assert.equal(result.processed, 1);
    assert.equal(result.promoted, 1);
    const completed = f.store.find("memory_observation_promotion", String(job.id))!;
    assert.equal(completed.status, "promoted");
    assert.equal(completed.attempts, 2);
    assert.equal(f.store.list("memory_observation", 10, row => row.project_id === "project-current").length, 3);
  } finally { await f.close(); }
});

test("session archive retains the minimum approved Memory candidate until the worker observes it", async () => {
  const f = await fixture();
  try {
    f.captureObserved();
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

test("archived Memory work releases retained content after Evidence is revoked", async () => {
  const f = await fixture();
  try {
    const captured = f.captureObserved() as JsonObject;
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

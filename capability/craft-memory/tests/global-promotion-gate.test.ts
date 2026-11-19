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
    assert.equal(global.auto_committed, true);
    assert.equal(f.store.list("memory_ledger", 100, row => (row.scope as JsonObject).kind === "global").length, 1);
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

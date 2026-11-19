import assert from "node:assert/strict";
import test from "node:test";
import { buildDomainEvaluationSummary, DOMAIN_ADAPTERS, DOMAIN_CASES, OFFICE_EVALUATION_CASES, OFFICE_EVALUATION_CONTRACT, prepareDomainAdapterCandidate } from "../domain-adapter-contract.ts";
import { SelfEvolutionKernel } from "../self-evolution.ts";

class MemoryStore {
  private readonly rows = new Map<string, Record<string, unknown>>();
  find(kind: string, id: string) { return this.rows.get(`${kind}:${id}`); }
  create(kind: string, id: string, value: Record<string, unknown>) { const row = { id, ...value }; this.rows.set(`${kind}:${id}`, row); return row; }
  get(kind: string, id: string) { const row = this.find(kind, id); if (!row) throw new Error("not found"); return row; }
  list(kind: string, limit: number) { return [...this.rows.entries()].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value).slice(0, limit); }
}

test("all adapter candidates bind a stable exact identity to the existing Evaluation Contract shape", () => {
  for (const name of DOMAIN_ADAPTERS) {
    const candidate = prepareDomainAdapterCandidate({ name, version: "v2" });
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.identity_digest, candidate.contract_binding.identity_digest);
    assert.equal(candidate.contract_binding.capability_id, `craft-context.domain-adapter.${name}`);
    assert.equal(candidate.contract_binding.capability_version, 2);
    assert.deepEqual(candidate.eval_case_ids, DOMAIN_CASES[name].map((item) => `${name}.${item}`));
    assert.equal(candidate.value_threshold, 2);
  }
  assert.notEqual(prepareDomainAdapterCandidate({ name: "office", version: "v2" }).identity_digest,
    prepareDomainAdapterCandidate({ name: "office", version: "v3" }).identity_digest);
});

test("candidate hints and evidence are normalized without granting capture or activation authority", () => {
  const candidate = prepareDomainAdapterCandidate({ name: "office", version: "v1", extraction_patterns: ["  agenda ", "decision"],
    evidence_types: ["minutes"], eval_case_ids: DOMAIN_CASES.office.map((item) => `office.${item}`), value_threshold: 4 });
  assert.deepEqual(candidate.extraction_patterns, ["agenda", "decision"]);
  assert.deepEqual(candidate.evidence_types, ["minutes"]);
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.value_threshold, 4);
  assert.deepEqual(OFFICE_EVALUATION_CONTRACT.hard_gates, { scope_leak_count: 0, unsupported_claim_rate_max: 0 });
  assert.ok(OFFICE_EVALUATION_CONTRACT.cases.every((item) => item.observed === false));
  assert.deepEqual(OFFICE_EVALUATION_CONTRACT.cases.map((item) => item.case_id), DOMAIN_CASES.office.map((item) => `office.${item}`));
  assert.ok(OFFICE_EVALUATION_CASES.every((item) => item.split === "held_out" && item.assertion.length > 0));
  const summary = buildDomainEvaluationSummary();
  assert.equal(summary.quotable, false);
  const office = summary.domains.find((item) => item.domain === "office");
  assert.deepEqual(office?.evaluation_contract?.hard_gates, OFFICE_EVALUATION_CONTRACT.hard_gates);
  const general = summary.domains.find((item) => item.domain === "general");
  assert.ok(general?.cases.some((item) => item.case_id === "general.unknown_scenario" && !item.observed));
  assert.ok(summary.domains.every((item) => item.cases.every((caseItem) => caseItem.observed === false)));
});

test("invalid domain and version values fail closed", () => {
  assert.throws(() => prepareDomainAdapterCandidate({ name: "", version: "v1" }), /name must/u);
  assert.throws(() => prepareDomainAdapterCandidate({ name: "legal", version: "v1" }), /unsupported domain/u);
  for (const version of ["", "v0", "1", "v01", "v1.1", `v${Number.MAX_SAFE_INTEGER + 1}`])
    assert.throws(() => prepareDomainAdapterCandidate({ name: "office", version }), /version/u);
});

test("pattern and evidence lists reject malformed, oversized, empty and duplicate entries", () => {
  for (const [field, value] of [["extraction_patterns", null], ["evidence_types", 1], ["eval_case_ids", "office"]] as const)
    assert.throws(() => prepareDomainAdapterCandidate({ name: "office", version: "v1", [field]: value }), new RegExp(`${field} must`));
  for (const field of ["extraction_patterns", "evidence_types", "eval_case_ids"] as const) {
    assert.throws(() => prepareDomainAdapterCandidate({ name: "office", version: "v1", [field]: [] }), new RegExp(`${field} must`));
    assert.throws(() => prepareDomainAdapterCandidate({ name: "office", version: "v1", [field]: Array.from({ length: 51 }, (_, i) => `item-${i}`) }), new RegExp(`${field} must`));
    assert.throws(() => prepareDomainAdapterCandidate({ name: "office", version: "v1", [field]: ["ok", " "] }), new RegExp(`${field} must`));
    assert.throws(() => prepareDomainAdapterCandidate({ name: "office", version: "v1", [field]: ["same", " same "] }), new RegExp(`${field} must not contain duplicates`));
  }
  assert.throws(() => prepareDomainAdapterCandidate({ name: "office", version: "v1", eval_case_ids: ["office.meeting_decision_recall"] }), /every domain safety case/u);
});

test("value threshold has a finite bounded range", () => {
  for (const value of [0, -1, 10.1, Number.NaN, Number.POSITIVE_INFINITY, "not-a-number"])
    assert.throws(() => prepareDomainAdapterCandidate({ name: "office", version: "v1", value_threshold: value }), /between 1 and 10/u);
  assert.equal(prepareDomainAdapterCandidate({ name: "office", version: "v1", value_threshold: 1 }).value_threshold, 1);
  assert.equal(prepareDomainAdapterCandidate({ name: "office", version: "v1", value_threshold: 10 }).value_threshold, 10);
});

test("the existing Context adapter API returns the evaluation-bound candidate and office suite", () => {
  const kernel = new SelfEvolutionKernel(new MemoryStore() as never);
  const candidate = kernel.registerAdapter({ name: "office", version: "v3" });
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.name, "office");
  assert.equal(candidate.identity_digest, (candidate.contract_binding as Record<string, unknown>).identity_digest);
  assert.equal((candidate.contract_binding as Record<string, unknown>).capability_version, 3);
  assert.throws(() => kernel.registerAdapter({ name: "unknown" }), /unsupported domain/u);
  const summary = kernel.evalSummary();
  const domains = summary.domains as Record<string, unknown>[];
  const office = domains.find((item) => item.domain === "office");
  const officeContract = office?.evaluation_contract as Record<string, unknown>;
  assert.deepEqual((officeContract.hard_gates as Record<string, unknown>).scope_leak_count, 0);
  assert.equal((domains.find((item) => item.domain === "general")?.cases as Record<string, unknown>[])
    .find((item) => item.case_id === "general.unknown_scenario")?.observed, false);
});

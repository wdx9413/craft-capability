import assert from "node:assert/strict";
import test from "node:test";
import { bridgeVerifiedOutcome, isDurableCandidate } from "../learning-cycle-bridge.ts";
import { DEFAULT_PERMISSION_MODEL } from "../permission-boundary.ts";

const report = { expected: 5, recorded: 5, passed: 5, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "complete" };
const permitted = { permissionTarget: "/local/craft-data/experience/candidates.json", permissionModel: {
  ...DEFAULT_PERMISSION_MODEL, rules: [{ id: "write-local-experience", member: "experience", effect: "allow" as const,
    path_prefix: "/local/craft-data/experience", writes: true }],
} };
function bridge(input: Parameters<typeof bridgeVerifiedOutcome>[0]) {
  return bridgeVerifiedOutcome({ ...permitted, ...input });
}

test("a passing report can qualify a bounded candidate decision", () => {
  const outcome = bridge({
    runReport: report,
    evidenceRef: "run-ok",
    statement: "先安装依赖再运行测试",
    domain: "coding",
    explicit: true,
  });
  assert.equal(outcome.verdict.report_passed, true);
  assert.equal(outcome.permitted, true);
  assert.equal(outcome.bridgeable, true, "the previous bridgeable field remains available as an alias");
  assert.equal(outcome.candidateEligible, true);
  assert.equal(outcome.reason, "verified candidate is eligible for the owning persistence path");
});

test("failed run does not bridge", () => {
  const outcome = bridge({
    runReport: { ...report, passed: 4, failed: 1 },
    evidenceRef: "run-bad",
    statement: "retry on timeout with backoff",
    domain: "coding",
  });
  assert.equal(outcome.verdict.report_passed, false);
  assert.equal(outcome.candidateEligible, false);
  assert.equal(outcome.reason, "report did not pass");
});

test("missing persistence target is reported separately from an explicit permission denial", () => {
  const outcome = bridgeVerifiedOutcome({ runReport: report, evidenceRef: "run-no-target", statement: "先安装依赖再运行测试" });
  assert.equal(outcome.permitted, false);
  assert.equal(outcome.reason, "no permission target supplied");
  assert.equal(outcome.bridgeable, false);
  assert.equal(outcome.candidateEligible, false);
});

test("an explicitly supplied target outside the allowed root reports permission denial", () => {
  const outcome = bridge({ runReport: report, evidenceRef: "run-denied", statement: "先安装依赖再运行测试",
    permissionTarget: "/outside/candidates.json" });
  assert.equal(outcome.permitted, false);
  assert.equal(outcome.reason, "permission denied");
});

test("incomplete run does not bridge", () => {
  const outcome = bridge({
    runReport: { ...report, status: "incomplete" },
    evidenceRef: "run-inc",
    statement: "retry on timeout with backoff",
  });
  assert.equal(outcome.candidateEligible, false);
});

test("zero passed run does not bridge", () => {
  const outcome = bridge({
    runReport: { ...report, passed: 0 },
    evidenceRef: "run-zero",
    statement: "retry on timeout with backoff",
  });
  assert.equal(outcome.candidateEligible, false);
});

test("operating steps with verification become candidate_procedure", () => {
  const outcome = bridge({
    runReport: report,
    evidenceRef: "run-steps",
    statement: "先安装依赖再运行测试",
    domain: "coding",
  });
  assert.equal(outcome.decision.action, "candidate_procedure");
  assert.ok(isDurableCandidate(outcome.decision));
});

test("rule statement becomes store_as_fact", () => {
  const outcome = bridge({
    runReport: report,
    evidenceRef: "run-rule",
    statement: "本项目约定：使用 pnpm",
    domain: "coding",
  });
  assert.equal(outcome.decision.action, "store_as_fact");
  assert.equal(isDurableCandidate(outcome.decision), false);
});

test("ordinary task text is ignored even when the report passes", () => {
  const outcome = bridge({
    runReport: report,
    evidenceRef: "run-ordinary",
    statement: "hello world",
  });
  assert.equal(outcome.decision.action, "ignore");
  assert.equal(outcome.candidateEligible, false);
  assert.equal(outcome.reason, "value gate did not produce a durable candidate");
});

test("secret statement is rejected even when verified", () => {
  const outcome = bridge({
    runReport: report,
    evidenceRef: "run-secret",
    statement: "api_key = {{SECRET_ab12cd34}}",
  });
  assert.equal(outcome.decision.action, "ignore");
  assert.equal(outcome.decision.reason, "credential or placeholder rejected");
});

test("scope is carried into the gate decision", () => {
  const scope = { kind: "project", id: "repo-1" };
  const outcome = bridge({
    runReport: report,
    evidenceRef: "run-scoped",
    statement: "use pnpm",
    domain: "coding",
    scope,
  });
  assert.equal(outcome.decision.scope.domain, "coding");
  assert.deepEqual(outcome.decision.scope, { kind: "project", id: "repo-1", domain: "coding" });
});

test("isDurableCandidate returns true only for procedure/mod candidates", () => {
  assert.equal(isDurableCandidate({ action: "candidate_procedure", reason: "x", digest: "d", scope: {}, note_refs: [], source_refs: [], gate_version: "v" }), true);
  assert.equal(isDurableCandidate({ action: "candidate_mod", reason: "x", digest: "d", scope: {}, note_refs: [], source_refs: [], gate_version: "v" }), true);
  assert.equal(isDurableCandidate({ action: "store_as_fact", reason: "x", digest: "d", scope: {}, note_refs: [], source_refs: [], gate_version: "v" }), false);
  assert.equal(isDurableCandidate({ action: "ignore", reason: "x", digest: "d", scope: {}, note_refs: [], source_refs: [], gate_version: "v" }), false);
});

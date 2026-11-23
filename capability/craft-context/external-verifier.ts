/** Thin contract binding an external verifier (Codex test runner / terminal command) to the
 * craft_context learning cycle. craft-context itself stays read-only; the external verifier
 * produces the `verified: true/false` terminal outcome that `craft_learning_cycle_finalize`
 * requires. */

export interface ExternalVerdict {
  readonly verified: boolean;
  readonly evidence_ref: string;
  readonly verifier: string;
  readonly at: string;
}

export interface CraftEvalRunReport {
  readonly passed: number;
  readonly failed: number;
  readonly inconclusive: number;
  readonly invalid: number;
  readonly missing: number;
  readonly status: string;
}

/** Map a craft-eval run report to an external verifier verdict. Only a fully-passing run
 * produces verified=true; any failed/inconclusive/invalid/missing case yields verified=false. */
export function verdictFromRunReport(report: CraftEvalRunReport, evidenceRef: string): ExternalVerdict {
  const allPassed = report.passed > 0
    && report.failed === 0
    && report.inconclusive === 0
    && report.invalid === 0
    && report.missing === 0
    && report.status === "complete";
  return {
    verified: allPassed,
    evidence_ref: evidenceRef,
    verifier: "craft-eval",
    at: new Date().toISOString(),
  };
}

/** Reject unverified outcomes so they never reach the learning cycle. */
export function requireVerified(verdict: ExternalVerdict): ExternalVerdict {
  if (!verdict.verified) {
    throw new Error("external verifier returned unverified outcome: " + verdict.evidence_ref);
  }
  return verdict;
}

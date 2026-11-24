/** Thin contract binding an external verifier (Codex test runner / terminal command) to the
 * craft_context learning cycle. craft-context itself stays read-only; the external verifier
 * produces the `verified: true/false` terminal outcome that `craft_learning_cycle_finalize`
 * requires. */

export interface ExternalVerdict {
  /** @deprecated Use report_passed; retained for existing capability consumers. */
  readonly verified: boolean;
  readonly evidence_ref: string;
  readonly verifier: string;
  readonly at: string;
}

export interface CountBoundedExternalVerdict extends ExternalVerdict {
  /** Report counts satisfy the pass criteria; this does not authenticate who produced the report. */
  readonly report_passed: boolean;
}

export interface CraftEvalRunReport {
  /** Required by the current verifier contract; optional in the type to accept legacy callers and reject them with a useful runtime error. */
  readonly expected?: number;
  /** Required by the current verifier contract; optional in the type to accept legacy callers and reject them with a useful runtime error. */
  readonly recorded?: number;
  readonly passed: number;
  readonly failed: number;
  readonly inconclusive: number;
  readonly invalid: number;
  readonly missing: number;
  readonly not_applicable?: number;
  readonly status: string;
}

/** Assess a supplied report's counts. The caller must obtain/authenticate the report separately. */
function isValidRunReport(report: unknown): report is CraftEvalRunReport & { expected: number; recorded: number } {
  if (report === null || typeof report !== "object" || Array.isArray(report)) return false;
  const value = report as Record<string, unknown>;
  const counts = ["expected", "recorded", "passed", "failed", "inconclusive", "invalid", "missing"];
  return counts.every((field) => Number.isSafeInteger(value[field]) && Number(value[field]) >= 0)
    && (value.not_applicable === undefined || (Number.isSafeInteger(value.not_applicable) && Number(value.not_applicable) >= 0))
    && typeof value.status === "string";
}

export function verdictFromRunReport(report: CraftEvalRunReport, evidenceRef: string): CountBoundedExternalVerdict {
  if (!isValidRunReport(report)) throw new Error("external evaluation report is malformed");
  const allPassed = report.expected > 0
    && report.recorded === report.expected && report.passed === report.expected
    && report.failed === 0
    && report.inconclusive === 0
    && report.invalid === 0
    && report.missing === 0
    && (report.not_applicable ?? 0) === 0
    && report.status === "complete";
  return {
    verified: allPassed,
    report_passed: allPassed,
    evidence_ref: evidenceRef,
    verifier: "craft-eval",
    at: new Date().toISOString(),
  };
}

/** Reject reports that fail the count/status criteria. This is not an authenticity check. */
export function requirePassingReport(verdict: CountBoundedExternalVerdict): CountBoundedExternalVerdict {
  if (!verdict.report_passed) {
    throw new Error("external evaluation report did not pass: " + verdict.evidence_ref);
  }
  return verdict;
}

/** @deprecated Use requirePassingReport for count-bounded evaluation reports. */
export function requireVerified(verdict: ExternalVerdict): ExternalVerdict {
  if (!verdict.verified) throw new Error("external verifier returned unverified outcome: " + verdict.evidence_ref);
  return verdict;
}

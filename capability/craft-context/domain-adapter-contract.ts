import { createHash } from "node:crypto";

export const DOMAIN_ADAPTERS = ["coding", "office", "travel", "creation", "research"] as const;
export type DomainAdapter = (typeof DOMAIN_ADAPTERS)[number];

export const DOMAIN_CASES: Readonly<Record<DomainAdapter, readonly string[]>> = {
  coding: ["write", "recall", "apply", "forget", "scope_leak"],
  office: ["meeting_decision_recall", "principal_scope_isolation", "unknown_to_general", "sensitive_scope_leak"],
  travel: ["write", "recall", "apply", "forget", "scope_leak"],
  creation: ["write", "recall", "apply", "forget", "scope_leak"],
  research: ["write", "recall", "apply", "forget", "scope_leak"],
};

export const OFFICE_EVALUATION_CASES = [
  { case_id: "office.meeting_decision_recall", task: "recall an approved meeting decision", assertion: "returned decision is grounded in its source", split: "held_out", observed: false },
  { case_id: "office.principal_scope_isolation", task: "recall a decision for one named principal", assertion: "results stay within the requested principal scope", split: "held_out", observed: false },
  { case_id: "office.unknown_to_general", task: "capture an unfamiliar office scenario", assertion: "capture continues through general without a domain-specific promotion", split: "held_out", observed: false },
  { case_id: "office.sensitive_scope_leak", task: "request an office record from another project scope", assertion: "no cross-scope record is returned", split: "held_out", observed: false },
] as const;

export const OFFICE_EVALUATION_CONTRACT = {
  capability_id: "craft-context.domain-adapter.office",
  input_contract: "Frozen office task cases: meeting decision recall, principal-scoped recall, unknown scenario fallback, and sensitive cross-scope negative case.",
  output_contract: "Content-free paired outcome per case; report task_success_rate, grounded_recall, unsupported_claim_rate, scope_leak_count, latency_ms, cost_usd.",
  hard_gates: { scope_leak_count: 0, unsupported_claim_rate_max: 0 },
  cases: OFFICE_EVALUATION_CASES,
} as const;

export interface DomainAdapterCandidateInput {
  name: unknown;
  version: unknown;
  extraction_patterns?: unknown;
  value_threshold?: unknown;
  evidence_types?: unknown;
  eval_case_ids?: unknown;
}

export interface DomainAdapterCandidate {
  name: DomainAdapter;
  version: string;
  status: "candidate";
  extraction_patterns: string[];
  value_threshold: number;
  evidence_types: string[];
  eval_case_ids: string[];
  identity_digest: string;
  contract_binding: { capability_id: string; capability_version: number; identity_digest: string };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function boundedStrings(value: unknown, field: string, fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length === 0 || value.length > 50
    || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${field} must contain 1..50 non-empty strings`);
  const normalized = value.map((item) => (item as string).trim());
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} must not contain duplicates`);
  return normalized;
}

export function prepareDomainAdapterCandidate(input: DomainAdapterCandidateInput): DomainAdapterCandidate {
  const name = requiredString(input.name, "name");
  if (!(DOMAIN_ADAPTERS as readonly string[]).includes(name)) throw new Error("unsupported domain adapter");
  const domain = name as DomainAdapter;
  const version = requiredString(input.version, "version");
  const parsedVersion = /^v([1-9]\d*)$/u.exec(version);
  if (!parsedVersion || !Number.isSafeInteger(Number(parsedVersion[1]))) throw new Error("version must use vN format");
  const extraction_patterns = boundedStrings(input.extraction_patterns, "extraction_patterns", ["general"]);
  const evidence_types = boundedStrings(input.evidence_types, "evidence_types", ["observed_outcome"]);
  const expectedCases = DOMAIN_CASES[domain].map((caseId) => `${domain}.${caseId}`);
  const eval_case_ids = boundedStrings(input.eval_case_ids, "eval_case_ids", expectedCases);
  if (expectedCases.some((caseId) => !eval_case_ids.includes(caseId))) throw new Error("eval_case_ids must include every domain safety case");
  const value_threshold = input.value_threshold === undefined ? 2 : Number(input.value_threshold);
  if (!Number.isFinite(value_threshold) || value_threshold < 1 || value_threshold > 10) throw new Error("value_threshold must be between 1 and 10");
  const capability_id = `craft-context.domain-adapter.${domain}`;
  const identity = { capability_id, capability_version: Number(parsedVersion[1]), name: domain, version,
    extraction_patterns, value_threshold, evidence_types, eval_case_ids };
  const identity_digest = digest(identity);
  return { ...identity, status: "candidate", identity_digest,
    contract_binding: { capability_id, capability_version: Number(parsedVersion[1]), identity_digest } };
}

export function buildDomainEvaluationSummary(): { schema: string; domains: { domain: string; cases: { case_id: string; observed: false }[]; evaluation_contract?: typeof OFFICE_EVALUATION_CONTRACT }[]; quotable: false } {
  const domains = [...DOMAIN_ADAPTERS, "general"].map((name) => {
    const cases = name === "general"
      ? ["unknown_scenario", "product_document", "technical_design", "web_system_operation"]
      : DOMAIN_CASES[name as DomainAdapter];
    return { domain: name, cases: cases.map((caseId) => ({ case_id: `${name}.${caseId}`, observed: false as const })),
      ...(name === "office" ? { evaluation_contract: OFFICE_EVALUATION_CONTRACT } : {}) };
  });
  return { schema: "craft.general-evolution-eval.v1", domains, quotable: false };
}

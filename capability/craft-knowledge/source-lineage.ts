import type { JsonObject } from "craft-common-store-local/store";
import { stableDigest } from "craft-common-base/digest";

const ORIGINS = new Set(["live_hook", "historical_replay", "test_fixture"]);
const PROJECT_SCOPE = /^project:[A-Za-z0-9_-]{1,96}$/u;
const IDENTIFIER = /^[^\s\r\n\0]{1,256}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const REPLAY_PROJECTION_CLAIM = "Historical replay Evidence reference projection.";

function record(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, keys: readonly string[], name: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${name} contains unsupported fields`);
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value.trim())) throw new Error(`${name} must be a bounded identifier`);
  return value.trim();
}

function positiveVersion(value: unknown, name: string, optional: boolean): number | undefined {
  if (value === undefined && optional) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

function sourceRef(value: unknown): JsonObject {
  const ref = record(value, "source_ref");
  exactKeys(ref, ["kind", "id", "version", "digest"], "source_ref");
  if (ref.digest !== undefined && (typeof ref.digest !== "string" || !SHA256.test(ref.digest))) throw new Error("source_ref.digest must be a sha256 digest");
  return { kind: identifier(ref.kind, "source_ref.kind"), id: identifier(ref.id, "source_ref.id"),
    ...(positiveVersion(ref.version, "source_ref.version", true) === undefined ? {} : { version: Number(ref.version) }),
    ...(ref.digest === undefined ? {} : { digest: ref.digest }) };
}

function evidenceRefs(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new Error("evidence_refs must contain one to 64 references");
  const refs = value.map((raw, index) => {
    const ref = record(raw, `evidence_refs[${index}]`);
    exactKeys(ref, ["kind", "id", "version"], `evidence_refs[${index}]`);
    if (ref.kind !== "evidence") throw new Error(`evidence_refs[${index}].kind must be evidence`);
    return { kind: "evidence", id: identifier(ref.id, `evidence_refs[${index}].id`), version: positiveVersion(ref.version, `evidence_refs[${index}].version`, false)! };
  });
  const unique = new Map(refs.map(ref => [`${ref.kind}:${ref.id}:${ref.version}`, ref]));
  if (unique.size !== refs.length) throw new Error("evidence_refs must be unique");
  return [...unique.values()].sort((left, right) => `${left.id}:${left.version}`.localeCompare(`${right.id}:${right.version}`));
}

export function normalizeKnowledgeSourceLineage(value: unknown): JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error("source_lineage must be an array of at most 100 entries");
  const normalized = value.map((raw, index) => {
    const item = record(raw, `source_lineage[${index}]`);
    exactKeys(item, ["origin", "replay_run_id", "session_id", "turn_id", "task_id", "project_scope_id", "source_ref", "evidence_refs"], `source_lineage[${index}]`);
    if (typeof item.origin !== "string" || !ORIGINS.has(item.origin)) throw new Error(`source_lineage[${index}].origin is unsupported`);
    const origin = item.origin;
    const replayRunId = item.replay_run_id === undefined ? undefined : identifier(item.replay_run_id, "replay_run_id");
    if (origin === "historical_replay" && replayRunId === undefined) throw new Error("historical replay lineage requires replay_run_id");
    if (origin !== "historical_replay" && replayRunId !== undefined) throw new Error("only historical replay lineage may have replay_run_id");
    const projectScopeId = identifier(item.project_scope_id, "project_scope_id");
    if (!PROJECT_SCOPE.test(projectScopeId)) throw new Error("project_scope_id must be canonical project scope");
    return { origin, ...(replayRunId === undefined ? {} : { replay_run_id: replayRunId }), session_id: identifier(item.session_id, "session_id"),
      ...(item.turn_id === undefined ? {} : { turn_id: identifier(item.turn_id, "turn_id") }),
      ...(item.task_id === undefined ? {} : { task_id: identifier(item.task_id, "task_id") }), project_scope_id: projectScopeId,
      source_ref: sourceRef(item.source_ref), evidence_refs: evidenceRefs(item.evidence_refs) } as JsonObject;
  });
  return normalized.sort((left, right) => knowledgeSourceLineageKey(left).localeCompare(knowledgeSourceLineageKey(right)));
}

function knowledgeSourceLineageKey(lineage: JsonObject): string {
  return stableDigest({ origin: lineage.origin, replay_run_id: lineage.replay_run_id ?? null, session_id: lineage.session_id,
    turn_id: lineage.turn_id ?? null, task_id: lineage.task_id ?? null, project_scope_id: lineage.project_scope_id, source_ref: lineage.source_ref });
}

function knowledgeSourceOccurrenceKey(lineage: JsonObject): string {
  return stableDigest({ origin: lineage.origin, replay_run_id: lineage.replay_run_id ?? null, session_id: lineage.session_id,
    turn_id: lineage.turn_id ?? null, task_id: lineage.task_id ?? null, project_scope_id: lineage.project_scope_id });
}

export function mergeKnowledgeSourceLineage(existingValue: unknown, incomingValue: unknown): { source_lineage: JsonObject[]; changed: boolean } {
  const existing = normalizeKnowledgeSourceLineage(existingValue);
  const incoming = normalizeKnowledgeSourceLineage(incomingValue);
  if (!incoming.length) return { source_lineage: existing, changed: false };
  const byOccurrence = new Map(existing.map(item => [knowledgeSourceOccurrenceKey(item), item]));
  const byKey = new Map(existing.map(item => [knowledgeSourceLineageKey(item), item]));
  let changed = false;
  for (const item of incoming) {
    const occurrence = knowledgeSourceOccurrenceKey(item), priorOccurrence = byOccurrence.get(occurrence);
    if (priorOccurrence && knowledgeSourceLineageKey(priorOccurrence) !== knowledgeSourceLineageKey(item)) throw new Error("source lineage source reference conflicts for the same occurrence");
    const key = knowledgeSourceLineageKey(item), prior = byKey.get(key);
    if (!prior) { byKey.set(key, item); byOccurrence.set(occurrence, item); changed = true; continue; }
    const mergedEvidence = evidenceRefs([...(prior.evidence_refs as JsonObject[]), ...(item.evidence_refs as JsonObject[])]
      .filter((ref, index, all) => all.findIndex(candidate => candidate.id === ref.id && candidate.version === ref.version) === index));
    if (stableDigest(mergedEvidence) !== stableDigest(prior.evidence_refs)) {
      const merged = { ...prior, evidence_refs: mergedEvidence };
      byKey.set(key, merged); byOccurrence.set(occurrence, merged); changed = true;
    }
  }
  return { source_lineage: [...byKey.values()].sort((left, right) => knowledgeSourceLineageKey(left).localeCompare(knowledgeSourceLineageKey(right))), changed };
}

export function knowledgeSourceLineageEvidenceIds(value: unknown): string[] {
  return [...new Set(normalizeKnowledgeSourceLineage(value).flatMap(item => (item.evidence_refs as JsonObject[]).map(ref => String(ref.id))))].sort();
}

export function knowledgeSourceLineageDigest(value: unknown): string { return stableDigest(normalizeKnowledgeSourceLineage(value)); }

export function replayKnowledgeLineageForRun(value: unknown, replayRunId: string): JsonObject[] {
  return normalizeKnowledgeSourceLineage(value).filter(item => item.origin === "historical_replay" && item.replay_run_id === replayRunId);
}

export function historicalReplayProjectionId(replayRunId: string, sourceEvidenceId: string): string {
  return `evidence_historical_replay_projection_${stableDigest({ replay_run_id: replayRunId, source_evidence_id: sourceEvidenceId }).slice(-32)}`;
}

export function validateHistoricalReplayProjection(evidence: JsonObject): JsonObject {
  if (evidence.source_type !== "historical_replay_projection" || evidence.claim !== REPLAY_PROJECTION_CLAIM) {
    throw new Error("Historical replay requires a well-formed owner-local Evidence projection");
  }
  const metadata = record(evidence.metadata, "historical replay projection metadata");
  exactKeys(metadata, ["replay_run_id", "source_owner", "source_evidence_id", "source_evidence_version", "semantic_digest", "projection_status"], "historical replay projection metadata");
  const replayRunId = identifier(metadata.replay_run_id, "replay_run_id");
  const sourceId = identifier(metadata.source_evidence_id, "source_evidence_id");
  if (!new Set(["active", "revoked"]).has(String(metadata.projection_status))
    || typeof metadata.source_owner !== "string" || !IDENTIFIER.test(metadata.source_owner)
    || positiveVersion(metadata.source_evidence_version, "source_evidence_version", false) === undefined
    || typeof metadata.semantic_digest !== "string" || !SHA256.test(metadata.semantic_digest)
    || evidence.id !== historicalReplayProjectionId(replayRunId, sourceId)) {
    throw new Error("Historical replay Evidence projection identity is invalid");
  }
  return metadata;
}

export function historicalReplayProjectionDigest(evidence: JsonObject): string {
  return stableDigest({ source_type: evidence.source_type, claim: evidence.claim, metadata: evidence.metadata });
}

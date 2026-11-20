import { createHash } from "node:crypto";
import type { CraftStore, JsonObject } from 'craft-common-store-local/store';
import { evaluateEvolutionValue, type EvolutionValueAction } from "craft-common-ontology";
import { matchesEvolutionProjectScope, requireEvolutionProjectScope } from "./evolution-project-scope.ts";

type TravelKind = "transport" | "budget" | "location" | "time_window" | "booking";

interface PreferenceExtraction {
  kind: "preference";
  travel_kind: Exclude<TravelKind, "time_window" | "booking">;
  content: string;
  topic: string;
}

interface PlanExtraction {
  kind: TravelKind;
  content: string;
  start?: string;
  end?: string;
}

export interface TravelExtraction {
  preferences: PreferenceExtraction[];
  plans: PlanExtraction[];
  booking_ids: string[];
  kinds(): TravelKind[];
  decision: EvolutionValueAction;
}

const TRAVEL_PATTERNS: ReadonlyArray<{ kind: TravelKind; pattern: RegExp; preference: boolean }> = [
  { kind: "transport", pattern: /我偏好([^\s;；，,。]{2,40}(?:座位|高铁|航班|交通|靠窗|过道))/iu, preference: true },
  { kind: "budget", pattern: /预算(?:不超过|上限|为)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:元|块|rmb|cny|美元|usd)?/iu, preference: true },
  { kind: "time_window", pattern: /(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(?:至|到|-|~)\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/iu, preference: false },
  { kind: "location", pattern: /(?:目的地|去|前往|入住|位于)\s*([\p{L}\p{N}_-]{2,40})(?=\s*[；;，,。]|$)|在\s*([\p{L}\p{N}_-]{2,40})(?=\s*[；;，,。])/iu, preference: true },
  { kind: "booking", pattern: /(?:航班|车次|酒店订单|预订号)\s*([A-Z0-9]{3,12})/iu, preference: false },
];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function scopeOf(value: unknown): { scope_kind: "project"; scope_id: string } {
  const scope = requireEvolutionProjectScope(value);
  return { scope_kind: scope.kind, scope_id: scope.id };
}

function timestamp(value: string, endOfDay: boolean, year: number): string {
  const month = Number(value.slice(0, value.indexOf("-")));
  const day = Number(value.slice(value.indexOf("-") + 1));
  const suffix = endOfDay ? "T23:59:59.000Z" : "T00:00:00.000Z";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}${suffix}`;
}

function contentOf(memory: JsonObject): string {
  return typeof memory.content === "string" ? memory.content : text(memory.body);
}

function isTravelMemory(memory: JsonObject): boolean {
  const topic = text(memory.topic);
  return topic.startsWith("travel:") || topic.startsWith("preference:travel:")
    || /^(?:Travel (?:budget ceiling:|time window:|location constraint:|booking )|I prefer .+ for travel$)/u.test(contentOf(memory));
}

export class TravelAdapter {
  readonly memory: {
    knowledgeMemoryInstallBuiltins(): unknown;
    memoryLedgerRemember(args: JsonObject): JsonObject;
    memoryLedgerGet(args: JsonObject): JsonObject;
    memoryLedgerList(args: JsonObject): JsonObject;
    memoryLedgerTransition(args: JsonObject): JsonObject;
  };
  readonly store: CraftStore;
  constructor(input: { memory: TravelAdapter["memory"]; store: CraftStore }) {
    this.memory = input.memory; this.store = input.store;
  }

  private prepare(): void {
    this.call("knowledgeMemoryInstallBuiltins", {});
  }

  static extract(statement: unknown, domain = "travel"): TravelExtraction {
    const value = text(statement);
    const decision = evaluateEvolutionValue({ statement: value, source_kind: "user-statement", explicit: true, domain });
    const preferences: PreferenceExtraction[] = [];
    const plans: PlanExtraction[] = [];
    const bookingIds: string[] = [];
    const kinds = new Set<TravelKind>();
    if (decision.action === "ignore") return { preferences, plans, booking_ids: bookingIds, kinds: () => [], decision: decision.action };
    for (const { kind, pattern, preference } of TRAVEL_PATTERNS) {
      for (const match of value.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))) {
        kinds.add(kind);
        if (kind === "budget") {
          const content = `Travel budget ceiling: ${match[1]}`;
          if (preference) preferences.push({ kind: "preference", travel_kind: "budget", content, topic: "preference:travel:budget" });
          if (!plans.some((plan) => plan.content === content)) plans.push({ kind, content });
        } else if (kind === "time_window") {
          const yearMatch = value.match(/(20\d{2})\s*年/);
          const year = yearMatch ? Number(yearMatch[1]) : 2026;
          const start = timestamp(`${match[1]}-${match[2]}`, false, year);
          const end = timestamp(`${match[3]}-${match[4]}`, true, year);
          const content = `Travel time window: ${start} to ${end}`;
          if (!plans.some((plan) => plan.content === content)) plans.push({ kind, content, start, end });
        } else if (kind === "transport" && preference) {
          const content = `I prefer ${match[1]} for travel`;
          preferences.push({ kind: "preference", travel_kind: "transport", content, topic: "preference:travel:transport" });
        } else if (kind === "location") {
          const content = `Travel location constraint: ${match[1] ?? match[2]}`;
          if (preference) preferences.push({ kind: "preference", travel_kind: "location", content, topic: "preference:travel:location" });
          if (!plans.some((plan) => plan.content === content)) plans.push({ kind, content });
        } else if (kind === "booking") {
          bookingIds.push(match[1]!);
          const content = `Travel booking ${match[1]}`;
          if (!plans.some((plan) => plan.content === content)) plans.push({ kind, content });
        }
      }
    }
    return { preferences, plans, booking_ids: bookingIds, kinds: () => [...kinds], decision: decision.action };
  }

  capture(args: JsonObject): JsonObject {
    if (text(args.domain) && text(args.domain) !== "travel") return { status: "denied", reason: "domain isolation" };
    this.prepare();
    const statement = text(args.statement);
    const scope = scopeOf(args.scope);
    const project = requireEvolutionProjectScope(args.scope);
    const evidenceIds = Array.isArray(args.evidence_ids) ? [...new Set(args.evidence_ids.map(String))].slice(0, 50) : [];
    for (const id of evidenceIds) {
      const evidence = this.store.find("evidence", id);
      const metadata = evidence?.metadata as JsonObject | undefined;
      if (!evidence || !matchesEvolutionProjectScope(evidence.scope ?? metadata?.project_scope_id, project))
        throw new Error("travel evidence is not in scope");
    }
    const extracted = TravelAdapter.extract(statement, text(args.domain) || "travel");
    const maxItems = Math.max(1, Math.min(20, Number.isFinite(Number(args.max_items)) ? Number(args.max_items) : 20));
    const nowMs = Number.isFinite(Date.parse(text(args.now))) ? Date.parse(text(args.now)) : Date.now();
    const maxPreferences = Math.min(extracted.preferences.length, Math.max(0, maxItems - 2));
    const preferences: JsonObject[] = [];
    const plans: JsonObject[] = [];
    for (const item of extracted.preferences.slice(0, maxPreferences)) {
      const result = this.call("memoryLedgerRemember", { source_id: "builtin.evidence-wiki", kind: "preference", project_root: text(args.project_root) || undefined,
        scope_kind: scope.scope_kind, scope_id: scope.scope_id, content: item.content, topic: item.topic,
        evidence_ids: evidenceIds, concept_kind: "preference" }) as JsonObject;
      preferences.push({ ...(result.memory as JsonObject), kind: "preference", content: item.content });
      void item.travel_kind;
    }
    for (const item of extracted.plans.slice(0, Math.max(0, maxItems - preferences.length))) {
      const validUntil = item.end ?? (item.kind === "booking" ? new Date(nowMs + 30 * 24 * 60 * 60 * 1000).toISOString() : undefined);
      const result = this.call("memoryLedgerRemember", { source_id: "builtin.evidence-wiki", kind: "episodic", project_root: text(args.project_root) || undefined,
        scope_kind: scope.scope_kind, scope_id: scope.scope_id, content: item.content,
        topic: `travel:${item.kind}`, evidence_ids: evidenceIds, concept_kind: "fact",
        ...(validUntil ? { valid_until: validUntil } : {}) }) as JsonObject;
      plans.push({ ...(result.memory as JsonObject), kind: item.kind, content: item.content, ...(item.start ? { effective_from: item.start } : {}) });
    }
    return { domain: "travel", preferences, plans, booking_ids: extracted.booking_ids, omitted_count:
      Math.max(0, extracted.preferences.length + extracted.plans.length - preferences.length - plans.length) };
  }

  recall(args: JsonObject): JsonObject {
    this.prepare();
    const scope = scopeOf(args.scope);
    const includeStale = args.include_stale === true;
    const nowMs = Number.isFinite(Date.parse(text(args.now))) ? Date.parse(text(args.now)) : Date.now();
    const activeTopic = text(args.topic);
    const listed = this.call("memoryLedgerList", { scope_kind: scope.scope_kind, scope_id: scope.scope_id,
      limit: 100, include_history: true }) as JsonObject;
    const items: JsonObject[] = [];
    const excluded: JsonObject[] = [];
    for (const memory of (listed.memories as JsonObject[] | undefined) ?? []) {
      if (!isTravelMemory(memory)) continue;
      const content = contentOf(memory);
      const query = text(args.query);
      if (query && !content.toLowerCase().includes(query.toLowerCase())) continue;
      if (activeTopic && text(memory.topic) !== activeTopic && !content.toLowerCase().includes(activeTopic.toLowerCase())) continue;
      const stale = typeof memory.valid_until === "string" && Date.parse(memory.valid_until) <= nowMs;
      const supersededById = typeof args.superseded_by === "string" ? args.superseded_by
        : args.superseded_by === true ? String(memory.replacement_id ?? "") : "";
      if (memory.status === "superseded" || memory.status === "revoked" || memory.status === "expired"
        || supersededById && String(memory.id) === supersededById) {
        continue;
      }
      if (stale && !includeStale) {
        excluded.push({ memory_id: memory.id, reason: "stale" });
        continue;
      }
      items.push({ ...memory, content, ...(stale ? { status: "stale", advisory: "stale travel plan: do not treat as current fact" } : {}) });
    }
    return { scope, include_stale: includeStale, items, excluded };
  }

  supersede(args: JsonObject): JsonObject {
    this.prepare();
    const scope = scopeOf(args.scope);
    const previousId = text(args.previous_id);
    const replacementId = text(args.replacement_id);
    const previous = this.scopedTravelMemory({ memory_id: previousId, scope: args.scope });
    this.scopedTravelMemory({ memory_id: replacementId, scope: args.scope });
    const result = this.call("memoryLedgerTransition", { memory_id: previousId, status: "superseded",
      expected_version: previous.version,
      replacement_id: text(args.replacement_id), reason: text(args.reason) || "superseded by newer travel plan",
      scope_kind: scope.scope_kind, scope_id: scope.scope_id }) as JsonObject;
    this.call("memoryLedgerRemember", { source_id: "builtin.evidence-wiki", kind: "working", working_note: true,
      scope_kind: scope.scope_kind, scope_id: scope.scope_id, topic: "travel:audit",
      content: `travel supersede ${previousId} -> ${replacementId}` });
    return result;
  }

  audit(args: JsonObject): JsonObject {
    this.prepare();
    const scope = scopeOf(args.scope);
    const listed = this.call("memoryLedgerList", { scope_kind: scope.scope_kind, scope_id: scope.scope_id,
      limit: 100, include_history: true }) as JsonObject;
    return { scope, items: ((listed.memories as JsonObject[] | undefined) ?? []).filter((memory) =>
      isTravelMemory(memory) && ["superseded", "revoked", "expired"].includes(String(memory.status))) };
  }

  forget(args: JsonObject): JsonObject {
    this.prepare();
    const scope = scopeOf(args.scope);
    const memory = this.scopedTravelMemory(args);
    if (memory.status === "revoked") return { memory, idempotent: true };
    return this.call("memoryLedgerTransition", { memory_id: text(args.memory_id), status: "revoked", expected_version: memory.version,
      reason: text(args.reason) || "explicit travel forget request", scope_kind: scope.scope_kind, scope_id: scope.scope_id }) as JsonObject;
  }

  apply(args: JsonObject): JsonObject {
    if (text(args.domain) && text(args.domain) !== "travel") return { status: "denied", reason: "domain isolation" };
    const memory = this.scopedTravelMemory(args);
    if (memory.status !== "active" || Date.parse(text(memory.valid_until)) <= Date.now()
      || (args.expected_version !== undefined && memory.version !== args.expected_version))
      throw new Error("travel memory is unavailable");
    return { status: "applied", domain: "travel", memory };
  }

  private scopedTravelMemory(args: JsonObject): JsonObject {
    const scope = requireEvolutionProjectScope(args.scope);
    const memoryId = text(args.memory_id);
    const record = this.store.find("memory_ledger", memoryId, undefined, false);
    if (!record || !matchesEvolutionProjectScope(record.scope, scope)) throw new Error("travel memory is not in scope");
    const { memory } = this.memory.memoryLedgerGet({ memory_id: memoryId, scope_kind: scope.kind, scope_id: scope.id });
    const result = memory as JsonObject;
    if (!isTravelMemory(result) || result.topic === "travel:audit") throw new Error("travel memory is not in scope");
    return result;
  }

  private call(name: string, args: JsonObject): unknown {
    const method = (this.memory as unknown as Record<string, unknown>)[name];
    if (typeof method !== "function") throw new Error(`travel adapter requires ${name}`);
    return method.call(this.memory, args);
  }
}

export function travelExtractionDigest(extraction: TravelExtraction): string {
  return createHash("sha256").update(JSON.stringify({ preferences: extraction.preferences, plans: extraction.plans,
    booking_ids: extraction.booking_ids })).digest("hex");
}

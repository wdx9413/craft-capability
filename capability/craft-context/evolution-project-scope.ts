import type { JsonObject } from "craft-common-store-local/store";

export type EvolutionProjectScope = { kind: "project"; id: string };

export function evolutionProjectScope(value: unknown): EvolutionProjectScope | null {
  if (typeof value === "string") {
    return value.startsWith("project:") && value.slice(8).trim() ? { kind: "project", id: value } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { kind, id, scope_kind, scope_id } = value as JsonObject;
  if ((kind !== undefined && scope_kind !== undefined && kind !== scope_kind)
    || (id !== undefined && scope_id !== undefined && id !== scope_id)) return null;
  const projectId = id ?? scope_id;
  return (kind ?? scope_kind) === "project" && typeof projectId === "string" && projectId.trim()
    ? { kind: "project", id: projectId } : null;
}

export function matchesEvolutionProjectScope(recordScope: unknown, authorizedScope: EvolutionProjectScope): boolean {
  return evolutionProjectScope(recordScope)?.id === authorizedScope.id;
}

export function requireEvolutionProjectScope(value: unknown): EvolutionProjectScope {
  const scope = evolutionProjectScope(value);
  if (!scope) throw new Error("Evolution requires authorized project scope");
  return scope;
}

import type { JsonObject } from "craft-common-store-local/store";

/** Runtime-pinned global Knowledge source IDs and immutable descriptor digests. */
export function trustedOrganizationSourceDigests(env: string | undefined): Map<string, string> {
  if (!env?.trim()) return new Map();
  try {
    const values = JSON.parse(env) as unknown;
    if (!Array.isArray(values)) return new Map();
    const entries = values.filter((value): value is { id: string; identity_digest: string } => Boolean(value)
      && typeof value === "object" && !Array.isArray(value)
      && typeof (value as JsonObject).id === "string" && /^[A-Za-z0-9._:-]{1,160}$/u.test(String((value as JsonObject).id))
      && typeof (value as JsonObject).identity_digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(String((value as JsonObject).identity_digest)))
      .map(value => [value.id, value.identity_digest] as const);
    if (entries.length !== values.length || new Set(entries.map(([id]) => id)).size !== entries.length) return new Map();
    return new Map(entries);
  } catch { return new Map(); }
}

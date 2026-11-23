/** Craft Context plugin permission & data boundary model for the Codex host. */

import type { JsonObject } from 'craft-common-store-local/store';

export const PERMISSION_SCHEMA_VERSION = "craft-context.permission.v1";

export type PermissionEffect = "allow" | "deny";

export interface PermissionRule {
  /** Stable, human-readable rule id. */
  readonly id: string;
  /** Member this rule applies to: knowledge | memory | experience | codebase | notes | all. */
  readonly member: string;
  /** Effect applied when the rule matches. */
  readonly effect: PermissionEffect;
  /** Path prefix matched against the operation target path; empty matches any local path. */
  readonly path_prefix?: string;
  /** Whether the rule covers write operations (file/edit/write/apply/patch). */
  readonly writes?: boolean;
  /** Whether the rule covers read operations (read/search/index/resolve). */
  readonly reads?: boolean;
  /** Whether the rule covers execution (run command / invoke procedure / verify). */
  readonly executes?: boolean;
  /** Optional justification recorded in audit output. */
  readonly reason?: string;
}

export interface PermissionModel {
  readonly schema_version: string;
  readonly host: "codex";
  readonly rules: PermissionRule[];
  /** When true, no data may leave the local machine; remote sync is disabled. */
  readonly local_only: boolean;
  /** Credentials and secrets must never be persisted by this plugin. */
  readonly no_credentials: boolean;
  /** Default effect when no rule matches. */
  readonly default_effect: PermissionEffect;
}

const SECRET_MARKER = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu;
const REMOTE_PATH = /^https?:\/\//iu;

/** The default permission surface shipped with the craft-context Codex plugin.
 *
 * Reads are bounded to the user's workspace and Craft's own local data root.
 * Writes are bounded to the same workspace plus `.craft_data/` under the user
 * home; no remote write surface is granted. Credentials are never persisted.
 * Codebase is read-only; execution is not granted by default.
 */
export const DEFAULT_PERMISSION_MODEL: PermissionModel = {
  schema_version: PERMISSION_SCHEMA_VERSION,
  host: "codex",
  local_only: true,
  no_credentials: true,
  default_effect: "deny",
  rules: [
    { id: "read-workspace", member: "all", effect: "allow", path_prefix: "", reads: true, reason: "Read within the current workspace" },
    { id: "write-workspace", member: "all", effect: "allow", path_prefix: "", writes: true, reason: "Write within the current workspace" },
    { id: "write-craft-data", member: "all", effect: "allow", path_prefix: ".craft_data", reads: true, writes: true, reason: "Craft local data root" },
    { id: "read-codebase-index", member: "codebase", effect: "allow", path_prefix: "", reads: true, reason: "Read-only repository index" },
    { id: "deny-codebase-write", member: "codebase", effect: "deny", path_prefix: "", writes: true, executes: true, reason: "Codebase member is read-only" },
    { id: "deny-remote-surface", member: "all", effect: "deny", path_prefix: "http", writes: true, executes: true, reason: "No remote writes or execution from this plugin" },
  ],
};

function isRemotePath(path: string): boolean {
  return REMOTE_PATH.test(path);
}

function globMatchPrefix(target: string, prefix: string): boolean {
  if (prefix === "" || prefix === "/") return true;
  const normalizedTarget = target.replace(/\\/gu, "/");
  const normalizedPrefix = prefix.replace(/\\/gu, "/");
  return normalizedTarget === normalizedPrefix || normalizedTarget.startsWith(normalizedPrefix);
}

function operationMatches(rule: PermissionRule, operation: "read" | "write" | "execute"): boolean {
  return operation === "read" ? rule.reads === true : operation === "write" ? rule.writes === true : rule.executes === true;
}

export interface PermissionDecision {
  readonly allowed: boolean;
  readonly rule_id: string | null;
  readonly reason: string;
}

export function decidePermission(model: PermissionModel, member: string, path: string, operation: "read" | "write" | "execute"): PermissionDecision {
  // Remote surfaces are never writable or executable from this plugin.
  if (isRemotePath(path) && (operation === "write" || operation === "execute")) {
    return { allowed: false, rule_id: "deny-remote-surface", reason: "remote surface not permitted" };
  }

  const applicable: PermissionRule[] = [];
  for (const rule of model.rules) {
    if (rule.member !== "all" && rule.member !== member) continue;
    if (!globMatchPrefix(path, rule.path_prefix ?? "")) continue;
    if (!operationMatches(rule, operation)) continue;
    applicable.push(rule);
  }

  if (applicable.length === 0) return { allowed: model.default_effect === "allow", rule_id: null, reason: "no matching rule" };

  // Deny rules win over allow rules (most restrictive).
  const deny = applicable.find((rule) => rule.effect === "deny");
  if (deny) return { allowed: false, rule_id: deny.id, reason: deny.reason ?? "denied by rule" };

  const allow = applicable[0];
  return { allowed: true, rule_id: allow.id, reason: allow.reason ?? "allowed by rule" };
}

/** Reject any statement or payload that embeds credentials or placeholder tokens. */
export function rejectsCredentials(payload: unknown): { rejected: boolean; reason: string | null } {
  const text = JSON.stringify(payload);
  if (SECRET_MARKER.test(text)) return { rejected: true, reason: "credential or placeholder token detected" };
  return { rejected: false, reason: null };
}

export function serializePermissionModel(model: PermissionModel): string {
  return JSON.stringify({ schema_version: model.schema_version, host: model.host, local_only: model.local_only, no_credentials: model.no_credentials, default_effect: model.default_effect, rule_count: model.rules.length }, null, 2);
}

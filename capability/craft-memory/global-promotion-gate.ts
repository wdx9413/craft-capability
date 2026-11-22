/** Conservative content gate for moving a Memory across project boundaries.
 *
 * This does not attempt semantic anonymization. Content with recognizable
 * identifiers must be rewritten by its owner before a global proposal exists.
 */
export type GlobalPromotionContentDecision = { eligible: true } | { eligible: false; reason_code: "deidentification_required" | "project_scope_not_shareable" | "sensitivity_not_shareable" };

const IDENTIFIER = /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\bhttps?:\/\/\S+|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b|(?:^|\s)(?:\/Users\/|\/home\/|[A-Z]:\\)|\b(?:project|repo(?:sitory)?|customer|client|tenant|workspace|ticket|issue|pull request|pr)(?:\s+(?:id|name))?\s*[:#=]?\s*[A-Z0-9][A-Z0-9._/-]*(?:[-_/][A-Z0-9]{2,}|\d{3,})\b)/iu;
const PROJECT_SCOPE_REFERENCE = /(?:本项目|这个项目|当前项目|此项目|本仓库|这个仓库|当前仓库|本代码库|这个代码库|当前代码库|本工作区|当前工作区|本\s*repo|本\s*workspace|\b(?:this|current|local)\s+(?:project|repo(?:sitory)?|codebase|workspace)\b)/iu;

export function globalPromotionContentDecision(content: string, sensitivity: unknown): GlobalPromotionContentDecision {
  if (sensitivity !== "public" && sensitivity !== "internal") return { eligible: false, reason_code: "sensitivity_not_shareable" };
  if (PROJECT_SCOPE_REFERENCE.test(content)) return { eligible: false, reason_code: "project_scope_not_shareable" };
  if (IDENTIFIER.test(content)) return { eligible: false, reason_code: "deidentification_required" };
  return { eligible: true };
}

/**
 * Tool families owned by the Context capability.
 *
 * Context is a composition capability: it owns self-evolution state and
 * orchestration, while Knowledge, Memory, Experience and Notes keep their own
 * stores and gates. `owns` therefore names only the self-evolution families
 * this package implements.
 */
export const CONTEXT_FAMILIES =
  "craft_(?:evolution_(?:value_decide|domain_adapters|domain_capture|failure_capture|program_memory_(?:capture|list|submit|promote|feedback)|artifact_lineage_(?:record|recall)|prospective_(?:create|fire)|research_(?:link|capture|recall|impact|forget)|replication_propose|runbook_(?:capture|revoke)|eval_summary))";

export const CONTEXT_OWNS = new RegExp(`^${CONTEXT_FAMILIES}`);

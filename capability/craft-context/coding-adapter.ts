import type { JsonObject } from 'craft-common-store-local/store';
import type { SelfEvolutionKernel } from "./self-evolution.ts";

/** Thin coding adapter: classification and scope only; the kernel owns storage. */
export class CodingAdapter {
  readonly kernel: SelfEvolutionKernel;
  constructor(kernel: SelfEvolutionKernel) { this.kernel = kernel; }

  capture(args: JsonObject): JsonObject {
    return this.kernel.captureDomainStatement({ ...args, domain: "coding" });
  }

  recall(args: JsonObject = {}): JsonObject {
    const scope = args.scope as JsonObject | undefined;
    const items = (this.kernel.listProgramMemory({}).items as JsonObject[])
      .filter((item) => item.domain === "coding")
      .filter((item) => !scope || (String((item.scope as JsonObject)?.kind ?? "") === String(scope.kind)
        && String((item.scope as JsonObject)?.id ?? "") === String(scope.id)));
    return { items, scope: scope ?? null };
  }
}

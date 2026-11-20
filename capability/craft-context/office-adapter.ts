import type { JsonObject } from 'craft-common-store-local/store';
import type { SelfEvolutionKernel } from "./self-evolution.ts";

/** Thin office adapter; project scope comes from the Runtime binding. */
export class OfficeAdapter {
  readonly kernel: SelfEvolutionKernel;
  constructor(kernel: SelfEvolutionKernel) { this.kernel = kernel; }

  capture(args: JsonObject): JsonObject {
    return this.kernel.captureDomainStatement({ ...args, domain: "office" });
  }
}

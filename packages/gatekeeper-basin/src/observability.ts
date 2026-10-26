import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Basin gatekeeper. */
export type BasinObservabilityFields = {
  vendorId: string;
  /** How a per-user scope was resolved: "exact" | "patterns" | "default". */
  matched?: string;
};

/** Ambient observability fields for one Basin gatekeeper operation. */
export const obsContext = createObservabilityContext<BasinObservabilityFields>();

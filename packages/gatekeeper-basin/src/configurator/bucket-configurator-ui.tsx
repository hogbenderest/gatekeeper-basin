import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { BasinBucketConfiguratorRpc } from "./basin-configurator-types";

// The whole-warehouse resource has no user-selectable inputs: once an account is
// connected, the resource URL is fully determined. The configurator confirms which
// warehouse the binding grants and signals readiness.

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    return <Section>
      <Field
        label="Whole warehouse access"
        description="This binding grants read-only, governed SQL access to every table in the connected Basin warehouse.">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<BasinBucketConfiguratorRpc, Record<string, string | null>>;

import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  BasinNamespaceConfiguratorRpc,
  BasinNamespaceConfiguratorValues,
} from "./basin-configurator-types";

// One namespace of the connected warehouse. The value key matches the resource
// urlPattern's :namespace group, so a concrete resource URL pre-fills the form.

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.namespace === "string" && values.namespace.length > 0;
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.namespace!);
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field
        label="Namespace"
        description="The binding grants every table in this namespace of the connected Basin warehouse.">
        <Autocomplete
          name="namespace"
          value={values.namespace}
          placeholder="Search namespaces..."
          loadOptions={query => ui.listNamespaces(query)}
          onChange={namespace => setValues({ namespace })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<BasinNamespaceConfiguratorRpc, BasinNamespaceConfiguratorValues>;

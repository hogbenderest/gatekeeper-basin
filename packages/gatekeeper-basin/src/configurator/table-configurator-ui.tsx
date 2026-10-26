import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  BasinTableConfiguratorRpc,
  BasinTableConfiguratorValues,
} from "./basin-configurator-types";

// One table: pick the namespace first, then the table inside it. The value keys match
// the resource urlPattern's :namespace and :table groups, so a concrete resource URL
// pre-fills both. Changing the namespace clears the table selection too: the runtime's
// clearFields only drops an autocomplete's typed query, so a dependent value must also
// be nulled through setValues or a stale table silently survives into the resource URL.

export default {
  initial: {},

  isReady({ values }) {
    return (
      typeof values.namespace === "string" && values.namespace.length > 0 &&
      typeof values.table === "string" && values.table.length > 0
    );
  },

  resourceUrl({ values, ui }) {
    return ui.resourceUrl(values.namespace!, values.table!);
  },

  render({ values, setValues, clearFields, ui }) {
    return <Section>
      <Field
        label="Namespace"
        description="The namespace that holds the table.">
        <Autocomplete
          name="namespace"
          value={values.namespace}
          placeholder="Search namespaces..."
          loadOptions={query => ui.listNamespaces(query)}
          onChange={namespace => {
            clearFields("table");
            setValues({ namespace, table: null });
          }}
        />
      </Field>
      <Field
        label="Table"
        description="The single table this binding grants.">
        <Autocomplete
          name="table"
          value={values.table}
          placeholder="Search tables..."
          loadOptions={query => ui.listTables(values.namespace ?? "", query)}
          onChange={table => setValues({ table })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<BasinTableConfiguratorRpc, BasinTableConfiguratorValues>;

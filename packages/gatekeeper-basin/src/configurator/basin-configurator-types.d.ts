// Iframe-facing capabilities for the three Basin resource configurators. These
// interfaces are shared by the sandboxed configurator UI modules and the
// implementations in basin.ts; they surface no secrets and no cross-account data.

export interface BasinBucketConfiguratorRpc {
  /** The canonical basin:// URL of the connected warehouse. */
  resourceUrl(): Promise<string>;
}

export interface BasinNamespaceConfiguratorRpc {
  /** The canonical basin:// URL of one namespace. */
  resourceUrl(namespace: string): Promise<string>;
  /** Namespaces of the connected warehouse matching a search query. */
  listNamespaces(query: string): Promise<{ value: string; title: string }[]>;
}

export interface BasinTableConfiguratorRpc {
  /** The canonical basin:// URL of one table. */
  resourceUrl(namespace: string, table: string): Promise<string>;
  /** Namespaces of the connected warehouse matching a search query. */
  listNamespaces(query: string): Promise<{ value: string; title: string }[]>;
  /** Tables of one namespace matching a search query. */
  listTables(namespace: string, query: string): Promise<{ value: string; title: string }[]>;
}

/** Values of the namespace configurator form. */
export type BasinNamespaceConfiguratorValues = {
  namespace?: string | null;
};

/** Values of the table configurator form. */
export type BasinTableConfiguratorValues = {
  namespace?: string | null;
  table?: string | null;
};

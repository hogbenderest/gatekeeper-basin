// basin:// resource URLs: the gatekeeper's authority for what a URL grants.
// Pure (no Worker imports), extracted from basin.ts so the parser-differential
// corpus (security audit run 1, finding 2) can pin it from Node tests.

import { identifier } from "./catalog.js";
import type { BasinScope } from "./scope.js";

/**
 * Parse a basin:// resource URL into its scope, refusing anything ambiguous.
 *
 * Exactly one trailing slash is tolerated (the Workshop's URLPattern resolution
 * toggles it, and humans type it); every other empty path segment is refused.
 * Audit run 1, finding 2: `basin://<a>/<b>//` is labelled "Basin namespace" by
 * the Workshop's resolution (the :namespace group matches a bare "/") while a
 * segment-dropping parse enforced bucket scope - refusal is the only shape in
 * which the consent label can never disagree with the enforcement.
 */
export function parseBasinResourceUrl(url: string): {
  accountId: string;
  bucket: string;
  scope: BasinScope;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid Basin URL "${url}"`);
  }
  if (parsed.protocol !== "basin:") {
    throw new Error(`Basin resources use basin:// URLs, not ${parsed.protocol}//`);
  }
  const accountId = parsed.hostname;
  if (!/^[\w-]{6,64}$/.test(accountId)) {
    throw new Error("The basin:// URL's host must be the Cloudflare account ID.");
  }
  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  const segments = pathname.split("/").slice(1);
  if (segments.some((s) => s === "")) {
    throw new Error(
      "A basin:// URL may not contain empty path segments: " +
        "basin://<account>/<bucket>[/<namespace>[/<table>]].",
    );
  }
  if (segments.length === 0 || segments.length > 3) {
    throw new Error("A basin:// URL is basin://<account>/<bucket>[/<namespace>[/<table>]].");
  }
  const bucket = segments[0];
  if (segments.length === 1) {
    return { accountId, bucket, scope: { kind: "bucket" } };
  }
  const namespace = identifier(segments[1]);
  if (segments.length === 2) {
    return { accountId, bucket, scope: { kind: "namespace", namespace } };
  }
  const table = identifier(segments[2]);
  return { accountId, bucket, scope: { kind: "table", namespace, table } };
}

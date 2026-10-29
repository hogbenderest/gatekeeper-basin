# Upstream proposal: pass the provisioning user's identity to auto-provisioned gatekeeper accounts

**Filed 2026-10-29** as
[cloudflare/cloudflare-os discussion #900](https://github.com/cloudflare/cloudflare-os/discussions/900)
(category: Ideas, per their CONTRIBUTING's discussions-first policy). The text below
is the filed version; everything cited was verified against upstream commit `bd10b0e`
(2026-10-25).

---

**Title:** Auto-provisioned gatekeeper accounts are identity-blind; a per-user scoped
data gatekeeper needs the provisioning owner's identity (and eventually groups)

**What I'm building**

A gatekeeper for querying a Cloudflare Basin warehouse (Iceberg on R2, via Basin SQL)
with governed, scope-checked SQL: guardrails, a free `EXPLAIN` plan verifier that
enforces the binding's grant per query, a daily scan budget, and observations on every
read. It supports two modes: per-user connect (each user pastes their own warehouse
credential) and deployment auto-provision (a shared credential in a Worker secret,
ambient singleton per user).

Auto-provision mode is the interesting one for governed data: consent moves from
connect-time to admin-time, so enforcement has to happen at the gatekeeper as the
query-time choke point. Today the scope of that enforcement can only be
deployment-wide (`BASIN_SCOPE`), which means every user of a deployment gets the same
slice of the warehouse. For anything like per-table governance - finance tables for
finance, a public namespace for everyone - a deployment-wide scope is either
over-granting or useless.

**The gap**

The enforcement machinery is already per-binding: each user's ambient singleton is a
separate facet with its own props, and the plan verifier will enforce whatever scope
that facet carries. What is missing is the per-user *decision*: auto-provisioned
accounts are identity-blind by contract, so a gatekeeper cannot answer "which user is
this singleton for?":

- `GatekeeperVendor.createAccount()` takes no arguments by design ("it takes no user
  identity"), and the Workshop calls it without any (`#createAutoProvisionedAccount`,
  `packages/workshop-backend/src/user.ts`).
- The ambient facet's props are entirely the gatekeeper's own mint
  (`ownerDo.getSingletonGatekeeperClass(accountId)` in `overseer.ts`); the Workshop
  passes nothing of its own. (Context's `sharingDomain` is a deployment-static
  service-binding prop, not a per-user value.)
- The only identity-carrying surface in the contract is
  `GatekeeperVendor.getSupportedResources(options.userId)`, documented as "a temporary
  hack to enable a hidden internal gatekeeper".
- There is no group-claims source at all: Cloudflare Access verifies the email at the
  edge, and nothing downstream consumes group membership.

**A minimal, upstream-shaped mechanism**

One optional flag on `AccountDescription` and one optional method on `GatekeeperUser`:

```ts
// AccountDescription:
receivesProvisionedOwner?: true;

// GatekeeperUser (present only when the description declares the flag):
noteProvisionedOwner(owner: { email: string }): Promise<void>;
```

At auto-provisioning, right after `describe()`, the Workshop calls
`noteProvisionedOwner({ email: <the user's verified email> })` when the description
declares the flag. Callers gate on the declared flag, matching the platform's
optional-method convention. The account can then resolve each user's grant (from an
operator-configured map keyed by email today, by group membership once a group source
exists) and mint the ambient singleton with that user's scope. The full design, a
working gatekeeper that consumes it, and a patch demonstrating the Workshop-side change
are in the `gatekeeper-basin` repository.

**Why this shape**

- It adds no authority: the account capability remains the authority; the identity is
  information for scoping, delivered by the trusted Workshop, not asserted by the
  caller. (The gatekeeper should still treat it as scoping input and persist it
  write-once, since whoever could rewrite the owner could rewrite the scope.)
- It costs upstream one conditional call at provisioning time, and nothing for
  gatekeepers that do not declare the flag.
- It is the same trust shape as the existing user-selection tickets: the Workshop is
  the source of identity, and the gatekeeper never trusts the browser.

**Follow-up the mechanism enables**

Group/role plumbing. Once accounts can ask "what groups is my user in?", a data
gatekeeper can map `group -> scope` instead of `email -> scope`, which is the shape
enterprise directory systems already maintain. The natural sources are the Access JWT
claims the deployment's identity provider already carries, or a SCIM-fed directory in
the Workshop's admin config. Neither needs to land with this proposal; the
`email -> scope` map is sufficient and useful on its own.

**Alternatives considered**

- `createAccount(owner)` would change a public, security-reasoned contract method
  ("takes no arguments, so it carries no user identity") rather than adding an
  opt-in surface; the flag-gated note keeps that reasoning intact.
- Hanging identity off `getSupportedResources(options.userId)` would couple a
  security decision to a UI listing call that upstream explicitly calls a hack.
- Group *enforcement* in the Workshop (an admin-configured map in the kernel) would
  duplicate what gatekeepers are better placed to do: the gatekeeper is the choke
  point that already holds the credential, the scope grammar, and the audit trail.

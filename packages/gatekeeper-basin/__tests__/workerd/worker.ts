// Test worker for the workerd suite. Re-exports the production fetch handler and
// registers the Durable Object classes under their production names: under the
// capnweb-validate *vite* plugin the `@validateRpc()`-decorated classes do not
// register in `ctx.exports` (the production build registers them), so each gets an
// undecorated subclass that does, inheriting the production behaviour exactly.
//
// `TestHooks` has to be a Durable Object: a `DurableObjectClass` from
// `ctx.exports.X({props})` is only reachable through `ctx.facets`, which is how the
// overseer instantiates a gatekeeper. A stub to a facet, or to a session it mints,
// cannot be handed to the test, so TestHooks runs each scenario itself - a chain of
// method calls on a session - and returns the result as plain data.

import { DurableObject, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { BasinGatekeeperProps } from "../../src/basin.js";

export { default } from "../../src/worker.js";

import {
  BasinGatekeeper as BasinGatekeeperImpl,
  UserAccount as UserAccountImpl,
  BasinOwnerRecord as BasinOwnerRecordImpl,
  BasinAutoAccount as BasinAutoAccountImpl,
  BasinVerifier as BasinVerifierImpl,
} from "../../src/basin.js";

export class BasinGatekeeper extends BasinGatekeeperImpl {}
export class UserAccount extends UserAccountImpl {}
export class BasinOwnerRecord extends BasinOwnerRecordImpl {}
export class BasinAutoAccount extends BasinAutoAccountImpl {}
export class BasinVerifier extends BasinVerifierImpl {}

export type { BasinGatekeeperProps };

/** An approval queue that records what it is asked, and refuses observations it is told to. */
export class RecordingQueue extends RpcTarget {
  readonly submitted: Array<{ actionId: number; description: ActionDescription }> = [];
  readonly observations: ObservationDescription[] = [];
  refuseObservations = false;

  async submitAction(actionId: number, description: ActionDescription): Promise<void> {
    this.submitted.push({ actionId, description });
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    if (this.refuseObservations) throw new Error("The approval queue refused this observation.");
    this.observations.push(description);
  }
}

/** A forwarded call's result as plain data: an expected rejection crossing RPC also reports as unhandled. */
export type Outcome<T> = { ok: T } | { error: string };

async function outcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** One call in a scenario: a method and its arguments. */
export type Step = [method: string, ...args: unknown[]];

type Callable = Record<string, (...args: unknown[]) => Promise<unknown>> & Partial<Disposable>;

type GatekeeperFacet = {
  describe(): Promise<unknown>;
  startSession(queue: RecordingQueue): Promise<Callable>;
};

type TestExports = {
  BasinGatekeeper(options: { props: BasinGatekeeperProps }): DurableObjectClass;
};

export class TestHooks extends DurableObject<Cloudflare.Env> {
  #queues = new Map<string, RecordingQueue>();

  get #exports(): TestExports {
    return this.ctx.exports as unknown as TestExports;
  }

  /**
   * The gatekeeper facet named `facetName`, made with `props` on first use. A facet is cached per
   * name, storage and all, so each scenario takes a fresh name.
   */
  #gatekeeper(facetName: string, props: BasinGatekeeperProps): GatekeeperFacet {
    return this.ctx.facets.get(facetName, () => ({
      class: this.#exports.BasinGatekeeper({ props }),
    })) as unknown as GatekeeperFacet;
  }

  #queue(facetName: string): RecordingQueue {
    let queue = this.#queues.get(facetName);
    if (!queue) this.#queues.set(facetName, (queue = new RecordingQueue()));
    return queue;
  }

  /**
   * Opens a session and makes each call in `steps` on what the call before returned, starting with
   * the session. The last call's result comes back; with `pages`, it is a cursor, walked for at
   * most that many pages.
   */
  async run(
    facetName: string,
    props: BasinGatekeeperProps,
    steps: Step[],
    options: { pages?: number } = {},
  ): Promise<Outcome<unknown>> {
    return await outcome(async () => {
      const session = await this.#gatekeeper(facetName, props).startSession(this.#queue(facetName));
      try {
        let target: Callable = session;
        for (const [index, [method, ...args]] of steps.entries()) {
          const result = await target[method](...args);
          if (index === steps.length - 1) {
            if (options.pages === undefined) return result;
            const cursor = result as { next(): Promise<unknown[] | null> };
            const pages: unknown[][] = [];
            for (let page; pages.length < options.pages && (page = await cursor.next()) !== null;)
              pages.push(page);
            return pages;
          }
          target = result as Callable;
        }
        return undefined;
      } finally {
        session[Symbol.dispose]?.();
      }
    });
  }

  /**
   * N concurrent method calls, one session each, against one facet: the interleaving
   * model of audit run 1, finding 1 - concurrent agent calls against one binding's
   * budget. Each call's result comes back as its own outcome.
   */
  async runParallel(
    facetName: string,
    props: BasinGatekeeperProps,
    calls: Step[],
  ): Promise<Outcome<unknown>[]> {
    const gatekeeper = this.#gatekeeper(facetName, props);
    const queue = this.#queue(facetName);
    return await Promise.all(
      calls.map(([method, ...args]) =>
        outcome(async () => {
          const session = await gatekeeper.startSession(queue);
          try {
            return await session[method](...args);
          } finally {
            session[Symbol.dispose]?.();
          }
        }),
      ),
    );
  }

  /** What the facet's approval queue has recorded. */
  queueLog(
    facetName: string,
  ): { submitted: RecordingQueue["submitted"]; observations: RecordingQueue["observations"] } {
    const queue = this.#queue(facetName);
    return { submitted: queue.submitted, observations: queue.observations };
  }

  refuseObservations(facetName: string, refuse: boolean): void {
    this.#queue(facetName).refuseObservations = refuse;
  }

  /** Restarts the gatekeeper, as an eviction would: its storage stays, its memory does not. */
  restart(facetName: string): void {
    this.ctx.facets.abort(facetName, new Error("test restart"));
  }
}

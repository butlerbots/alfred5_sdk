import { matchesPrefilter, type Prefilter } from "./prefilter";

/**
 * One thing the server wants watched.
 *
 * `subscriptionId` is a handle the server issued, not a name you can invent: it is how an event is
 * attributed to a reflex and therefore to a user, which is why reporting an event never involves
 * naming a user at all.
 */
export type LinkSubscription = {
    subscriptionId: string;
    sourceId: string;
    /** Absent means every event from the source. */
    event?: string;
    /** A cheap condition to apply before reporting. Advisory — see `prefilter.ts`. */
    prefilter?: Prefilter;
    /**
     * The owner's accounts on platforms they have linked, keyed by a namespace this client
     * understands: `{ discord: "1897..." }`. Absent when the owner has linked nothing, in which case
     * a subscription that needs an identity to make sense should be treated as un-matchable rather
     * than matched against a guess.
     */
    identities?: Record<string, string>;
    /** For logging and for telling a user what is being watched. */
    name?: string;
};

export type SubscriptionSnapshot = {
    epoch: number;
    chunk?: number;
    of?: number;
    subscriptions: LinkSubscription[];
};

export type SubscriptionDelta = {
    epoch: number;
    added?: LinkSubscription[];
    removed?: string[];
    updated?: LinkSubscription[];
};

/**
 * WHAT THIS LINK HAS BEEN TOLD TO WATCH
 * =====================================
 *
 * Holds the subscription set, keeps it consistent, and answers "which subscriptions does this event
 * match".
 *
 * Nothing here is persisted, on purpose. A client that restarts reconnects, re-declares its sources
 * and is sent a fresh snapshot, so there is no durable state that can drift out of agreement with
 * the server and therefore no reconciliation to implement. Deltas and epochs are only an
 * optimisation on top of that: the epoch lets a client notice it missed a delta, and the answer to
 * missing one is always the same — ask for the snapshot again.
 *
 * Chunked snapshots are buffered until every chunk has arrived, so a half-applied set never briefly
 * looks like a complete one. That matters: applying half a snapshot would silently stop reporting
 * events for real subscriptions.
 */
export class SubscriptionStore {
    private subscriptions = new Map<string, LinkSubscription>();
    private currentEpoch = 0;
    private pending?: { epoch: number; chunks: Map<number, LinkSubscription[]>; of: number };

    /** Called when the store notices a gap and needs a fresh snapshot. */
    onResyncNeeded?: (have: number) => void;

    /** Called after the set changes, with the new set. */
    onChange?: (subscriptions: LinkSubscription[]) => void;

    get epoch(): number {
        return this.currentEpoch;
    }

    all(): LinkSubscription[] {
        return [...this.subscriptions.values()];
    }

    get(subscriptionId: string): LinkSubscription | undefined {
        return this.subscriptions.get(subscriptionId);
    }

    /** Subscriptions for one source, for a caller that wants to report matches itself. */
    forSource(sourceId: string): LinkSubscription[] {
        return this.all().filter(subscription => subscription.sourceId === sourceId);
    }

    /** Everything is forgotten on disconnect: the next connection is told again. */
    reset(): void {
        this.subscriptions.clear();
        this.currentEpoch = 0;
        this.pending = undefined;
    }

    applySnapshot(payload: SubscriptionSnapshot): void {
        const total = payload.of ?? 1;

        if (total === 1) {
            this.replace(payload.epoch, payload.subscriptions);
            return;
        }

        // A snapshot at a new epoch supersedes one still being assembled, rather than merging with
        // it: the older chunks describe a set that no longer exists.
        if (!this.pending || this.pending.epoch !== payload.epoch) {
            this.pending = { epoch: payload.epoch, chunks: new Map(), of: total };
        }

        this.pending.chunks.set(payload.chunk ?? 1, payload.subscriptions);
        if (this.pending.chunks.size < this.pending.of) return;

        const assembled = [...this.pending.chunks.entries()]
            .sort(([a], [b]) => a - b)
            .flatMap(([, chunk]) => chunk);

        this.pending = undefined;
        this.replace(payload.epoch, assembled);
    }

    /**
     * Applies a delta, or asks for a snapshot if one was missed.
     *
     * The gap check is the entire consistency mechanism, and the two failure directions are not the
     * same. An epoch *ahead* of the next one means a delta went missing, and applying this one anyway
     * would leave a set that is wrong in a way nothing later can detect — so ask for the truth. An
     * epoch at or *behind* the current one is a replay, which is already applied; asking for a
     * snapshot would turn a harmless duplicate into a round trip, and a re-sending server into a
     * loop.
     */
    applyDelta(payload: SubscriptionDelta): void {
        if (payload.epoch <= this.currentEpoch) return;

        if (payload.epoch > this.currentEpoch + 1) {
            this.onResyncNeeded?.(this.currentEpoch);
            return;
        }

        for (const subscriptionId of payload.removed ?? []) this.subscriptions.delete(subscriptionId);
        for (const subscription of [...(payload.added ?? []), ...(payload.updated ?? [])]) {
            this.subscriptions.set(subscription.subscriptionId, subscription);
        }

        this.currentEpoch = payload.epoch;
        this.onChange?.(this.all());
    }

    /**
     * The subscriptions an event should be reported against.
     *
     * Order is the pushed order, so a platform that logs the ids gets a stable list. An empty result
     * means the event is nobody's business and should not be sent at all — which is the point: the
     * server never sees the 10,000 messages a day that match nothing.
     */
    match(input: { sourceId: string; event: string; payload?: Record<string, unknown> }): string[] {
        const candidate = { ...(input.payload ?? {}), type: input.event };

        return this.all()
            .filter(subscription => subscription.sourceId === input.sourceId)
            .filter(subscription => !subscription.event || subscription.event === input.event)
            .filter(subscription => matchesPrefilter(candidate, subscription.prefilter))
            .map(subscription => subscription.subscriptionId);
    }

    private replace(epoch: number, subscriptions: LinkSubscription[]): void {
        this.subscriptions = new Map(subscriptions.map(subscription => [subscription.subscriptionId, subscription]));
        this.currentEpoch = epoch;
        this.onChange?.(this.all());
    }
}

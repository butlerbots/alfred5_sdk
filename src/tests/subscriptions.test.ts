import { describe, expect, it } from "bun:test";

import { SubscriptionStore, type LinkSubscription } from "../link/subscriptions";
import { matchesPrefilter } from "../link/prefilter";

function subscription(id: string, overrides: Partial<LinkSubscription> = {}): LinkSubscription {
    return { subscriptionId: id, sourceId: "link:bot/discord", ...overrides };
}

function store() {
    const resyncs: number[] = [];
    const changes: LinkSubscription[][] = [];
    const subject = new SubscriptionStore();

    subject.onResyncNeeded = have => resyncs.push(have);
    subject.onChange = subscriptions => changes.push(subscriptions);

    return { subject, resyncs, changes };
}

describe("prefilter", () => {
    it("matches a scalar, an array as 'in', and a missing path as undefined", () => {
        expect(matchesPrefilter({ channel: { id: "123" } }, { "channel.id": "123" })).toBe(true);
        expect(matchesPrefilter({ channel: { id: "999" } }, { "channel.id": ["123", "456"] })).toBe(false);
        expect(matchesPrefilter({}, { "channel.id": "123" })).toBe(false);
    });

    it("supports not and exists, and ANDs every condition", () => {
        expect(matchesPrefilter({ author: { bot: true } }, { "author.bot": { not: true } })).toBe(false);
        expect(matchesPrefilter({ author: {} }, { "author.id": { exists: false } })).toBe(true);
        expect(matchesPrefilter({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
    });

    it("matches everything when there is no prefilter", () => {
        // A subscription without one wants every event of its type; absent must not read as "none".
        expect(matchesPrefilter({ anything: true })).toBe(true);
        expect(matchesPrefilter({ anything: true }, null)).toBe(true);
    });

    it("does not compare objects, because that is where a gate becomes a query language", () => {
        expect(matchesPrefilter({ author: { id: "1" } }, { author: "[object Object]" as never })).toBe(false);
    });
});

describe("applying snapshots", () => {
    it("replaces the set and reports the new epoch", () => {
        const { subject, changes } = store();

        subject.applySnapshot({ epoch: 1, subscriptions: [subscription("rx-1")] });

        expect(subject.epoch).toBe(1);
        expect(subject.all()).toHaveLength(1);
        expect(changes).toHaveLength(1);
    });

    it("a later snapshot replaces rather than merges", () => {
        const { subject } = store();

        subject.applySnapshot({ epoch: 1, subscriptions: [subscription("rx-1")] });
        subject.applySnapshot({ epoch: 2, subscriptions: [subscription("rx-2")] });

        expect(subject.all().map(entry => entry.subscriptionId)).toEqual(["rx-2"]);
    });

    it("buffers a chunked snapshot until every chunk has arrived", () => {
        // Applying half a snapshot would silently stop reporting events for real subscriptions, and
        // nothing later would reveal it.
        const { subject, changes } = store();

        subject.applySnapshot({ epoch: 4, chunk: 1, of: 2, subscriptions: [subscription("rx-1")] });

        expect(subject.all()).toHaveLength(0);
        expect(changes).toHaveLength(0);

        subject.applySnapshot({ epoch: 4, chunk: 2, of: 2, subscriptions: [subscription("rx-2")] });

        expect(subject.all().map(entry => entry.subscriptionId)).toEqual(["rx-1", "rx-2"]);
        expect(subject.epoch).toBe(4);
    });

    it("assembles chunks in order however they arrive", () => {
        const { subject } = store();

        subject.applySnapshot({ epoch: 1, chunk: 2, of: 2, subscriptions: [subscription("rx-2")] });
        subject.applySnapshot({ epoch: 1, chunk: 1, of: 2, subscriptions: [subscription("rx-1")] });

        expect(subject.all().map(entry => entry.subscriptionId)).toEqual(["rx-1", "rx-2"]);
    });

    it("abandons a half-assembled snapshot when a newer one starts", () => {
        // The older chunks describe a set that no longer exists, so merging them would invent one.
        const { subject } = store();

        subject.applySnapshot({ epoch: 1, chunk: 1, of: 2, subscriptions: [subscription("rx-old")] });
        subject.applySnapshot({ epoch: 2, chunk: 1, of: 2, subscriptions: [subscription("rx-new-a")] });
        subject.applySnapshot({ epoch: 2, chunk: 2, of: 2, subscriptions: [subscription("rx-new-b")] });

        expect(subject.all().map(entry => entry.subscriptionId)).toEqual(["rx-new-a", "rx-new-b"]);
    });
});

describe("applying deltas", () => {
    it("adds, updates and removes at the next epoch", () => {
        const { subject } = store();
        subject.applySnapshot({ epoch: 1, subscriptions: [subscription("rx-1"), subscription("rx-2")] });

        subject.applyDelta({
            epoch: 2,
            added: [subscription("rx-3")],
            updated: [subscription("rx-1", { prefilter: { "author.bot": false } })],
            removed: ["rx-2"],
        });

        expect(subject.all().map(entry => entry.subscriptionId)).toEqual(["rx-1", "rx-3"]);
        expect(subject.get("rx-1")?.prefilter).toEqual({ "author.bot": false });
        expect(subject.epoch).toBe(2);
    });

    it("asks for a snapshot instead of applying a delta that skipped one", () => {
        // The gap check is the whole consistency mechanism: applying it anyway would leave a set that
        // is wrong in a way nothing later can detect.
        const { subject, resyncs } = store();
        subject.applySnapshot({ epoch: 1, subscriptions: [] });

        subject.applyDelta({ epoch: 3, added: [subscription("rx-1")] });

        expect(subject.all()).toHaveLength(0);
        expect(subject.epoch).toBe(1);
        expect(resyncs).toEqual([1]);
    });

    it("ignores a replayed delta instead of asking for a snapshot", () => {
        // A duplicate is already applied. Treating it as a gap would turn a harmless re-send into a
        // round trip, and a server that re-sends into a loop.
        const { subject, resyncs } = store();
        subject.applySnapshot({ epoch: 1, subscriptions: [] });
        subject.applyDelta({ epoch: 2, added: [subscription("rx-1")] });

        subject.applyDelta({ epoch: 2, added: [subscription("rx-1")] });
        subject.applyDelta({ epoch: 1, removed: ["rx-1"] });

        expect(subject.all()).toHaveLength(1);
        expect(subject.epoch).toBe(2);
        expect(resyncs).toEqual([]);
    });
});

describe("matching events", () => {
    it("returns every subscription that matched, which is how fan-out reaches the wire", () => {
        // Five reflexes watching one channel is one frame with five ids.
        const { subject } = store();
        subject.applySnapshot({
            epoch: 1,
            subscriptions: [subscription("rx-1"), subscription("rx-2"), subscription("rx-3", { sourceId: "link:bot/other" })],
        });

        expect(subject.match({ sourceId: "link:bot/discord", event: "message.create" })).toEqual(["rx-1", "rx-2"]);
    });

    it("returns nothing when nothing subscribed, so the event never leaves the process", () => {
        const { subject } = store();
        subject.applySnapshot({ epoch: 1, subscriptions: [subscription("rx-1", { event: "voice.join" })] });

        expect(subject.match({ sourceId: "link:bot/discord", event: "message.create" })).toEqual([]);
    });

    it("matches the event name, treating an absent one as 'every event'", () => {
        const { subject } = store();
        subject.applySnapshot({
            epoch: 1,
            subscriptions: [subscription("rx-any"), subscription("rx-typed", { event: "message.create" })],
        });

        expect(subject.match({ sourceId: "link:bot/discord", event: "message.create" })).toEqual(["rx-any", "rx-typed"]);
        expect(subject.match({ sourceId: "link:bot/discord", event: "voice.join" })).toEqual(["rx-any"]);
    });

    it("applies the prefilter against the payload with the event name folded in", () => {
        // `type` is how the server sees an event, so a prefilter written on `type` has to work here.
        const { subject } = store();
        subject.applySnapshot({
            epoch: 1,
            subscriptions: [
                subscription("rx-channel", { prefilter: { "channel.id": "123" } }),
                subscription("rx-type", { prefilter: { type: "message.create" } }),
            ],
        });

        const matched = subject.match({
            sourceId: "link:bot/discord",
            event: "message.create",
            payload: { channel: { id: "123" } },
        });

        expect(matched).toEqual(["rx-channel", "rx-type"]);
    });

    it("exposes identities so a client can answer 'is this about my user'", () => {
        // The one place a linked account appears, and it arrives as an opaque string.
        const { subject } = store();
        subject.applySnapshot({ epoch: 1, subscriptions: [subscription("rx-1", { identities: { discord: "1897" } })] });

        expect(subject.forSource("link:bot/discord")[0].identities).toEqual({ discord: "1897" });
    });
});

describe("reconnects", () => {
    it("forgets everything, because the server re-sends it on connect", () => {
        // Nothing is persisted, so there is no client state that can diverge and nothing to reconcile.
        const { subject } = store();
        subject.applySnapshot({ epoch: 7, subscriptions: [subscription("rx-1")] });

        subject.reset();

        expect(subject.all()).toEqual([]);
        expect(subject.epoch).toBe(0);
    });

    it("accepts the first snapshot after a reset at whatever epoch it carries", () => {
        const { subject, resyncs } = store();
        subject.applySnapshot({ epoch: 7, subscriptions: [subscription("rx-1")] });
        subject.reset();

        subject.applySnapshot({ epoch: 1, subscriptions: [subscription("rx-2")] });

        expect(subject.epoch).toBe(1);
        expect(resyncs).toEqual([]);
    });
});

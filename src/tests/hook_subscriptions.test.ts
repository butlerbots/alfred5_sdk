import { describe, expect, it } from "bun:test";

import { Hook } from "../link/hook";
import type { LinkSubscription } from "../link/subscriptions";
import { createLinkHarness, flush } from "./support/fake_link";

/**
 * The inverted hook path over a link: the server pushes what to watch, the client matches locally and
 * reports ids. Driven through a fake socket so the frames themselves are the assertions.
 */

function doorbell() {
    return new Hook({
        id: "doorbell",
        name: "Doorbell",
        description: "Somebody at the door",
        events: [
            { name: "rang", description: "The bell rang" },
            { name: "knocked", description: "Somebody knocked" },
        ],
    });
}

function subscription(id: string, overrides: Partial<LinkSubscription> = {}): LinkSubscription {
    return { subscriptionId: id, sourceId: "link:coffee/doorbell", ...overrides };
}

async function connected(subscriptions: LinkSubscription[] = []) {
    const harness = createLinkHarness();
    const hook = doorbell();
    harness.link.addHook(hook);

    const socket = await harness.connect();
    socket.push("hook.subscriptions", { epoch: 1, subscriptions });
    await flush();

    return { ...harness, hook, socket };
}

describe("receiving subscriptions", () => {
    it("hands them to the hook that owns the source", async () => {
        const h = await connected([subscription("rx-1", { name: "Front door watcher" })]);

        expect(h.hook.subscriptions.map(entry => entry.subscriptionId)).toEqual(["rx-1"]);
        expect(h.link.subscriptions).toHaveLength(1);
    });

    it("announces the set, so a platform can set up whatever it needs to watch", async () => {
        const seen: LinkSubscription[][] = [];
        const harness = createLinkHarness();
        harness.link.addHook(doorbell());
        harness.link.on("subscriptions", subscriptions => seen.push(subscriptions));

        const socket = await harness.connect();
        socket.push("hook.subscriptions", { epoch: 1, subscriptions: [subscription("rx-1")] });
        await flush();

        expect(seen).toHaveLength(1);
        expect(seen[0][0].subscriptionId).toBe("rx-1");
    });

    it("applies deltas without being told the whole set again", async () => {
        const h = await connected([subscription("rx-1")]);

        h.socket.push("hook.subscriptions.delta", { epoch: 2, added: [subscription("rx-2")], removed: ["rx-1"] });
        await flush();

        expect(h.hook.subscriptions.map(entry => entry.subscriptionId)).toEqual(["rx-2"]);
    });

    it("asks for a snapshot when it notices it missed a delta", async () => {
        const h = await connected([subscription("rx-1")]);

        h.socket.push("hook.subscriptions.delta", { epoch: 5, added: [subscription("rx-9")] });
        await flush();

        expect(h.socket.ofType("hook.subscriptions.resync")[0].payload).toEqual({ have: 1 });
        // The bad delta is not applied: the set stays what the last good epoch said.
        expect(h.hook.subscriptions.map(entry => entry.subscriptionId)).toEqual(["rx-1"]);
    });

    it("forgets them on disconnect, because the next connection is told again", async () => {
        const h = await connected([subscription("rx-1")]);

        h.socket.drop();
        await flush();

        expect(h.link.subscriptions).toEqual([]);
    });
});

describe("reporting events", () => {
    it("sends the ids that matched, and the epoch it matched against", async () => {
        const h = await connected([subscription("rx-1"), subscription("rx-2")]);

        const reported = await h.hook.report("rang", { camera: "front" });

        expect(reported).toEqual(["rx-1", "rx-2"]);
        expect(h.socket.ofType("hook.event")[0].payload).toEqual({
            sourceId: "link:coffee/doorbell",
            subscriptionIds: ["rx-1", "rx-2"],
            event: "rang",
            payload: { camera: "front" },
            epoch: 1,
        });
    });

    it("sends nothing at all when nothing subscribed", async () => {
        // The volume story: a busy source produces thousands of events nobody asked about, and none of
        // them reach the wire.
        const h = await connected([subscription("rx-1", { event: "knocked" })]);

        const reported = await h.hook.report("rang");

        expect(reported).toEqual([]);
        expect(h.socket.ofType("hook.event")).toHaveLength(0);
    });

    it("applies the prefilter locally, which is where the platform knowledge lives", async () => {
        const h = await connected([subscription("rx-1", { prefilter: { camera: "front" } })]);

        expect(await h.hook.report("rang", { camera: "back" })).toEqual([]);
        expect(await h.hook.report("rang", { camera: "front" })).toEqual(["rx-1"]);
    });

    it("never names a user, on any frame", async () => {
        // Ownership is resolved from the id server-side, so there is nothing here to forge.
        const h = await connected([subscription("rx-1", { identities: { discord: "1897" } })]);

        await h.hook.report("rang");

        const payload = h.socket.ofType("hook.event")[0].payload as Record<string, unknown>;
        expect(payload).not.toHaveProperty("ownerId");
        expect(payload).not.toHaveProperty("userId");
    });

    it("refuses an undeclared event where the typo was made", async () => {
        const h = await connected([subscription("rx-1")]);

        await expect(h.hook.report("ringed")).rejects.toThrow(/does not declare an event named "ringed"/);
    });

    it("still supports emit, so deployed clients keep working", async () => {
        const h = await connected([]);

        await h.hook.emit("rang", { camera: "front" });

        expect(h.socket.ofType("hook.emit")).toHaveLength(1);
    });
});

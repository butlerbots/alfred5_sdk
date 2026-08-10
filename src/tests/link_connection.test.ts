import { describe, expect, it } from "bun:test";

import { z } from "zod";

import { Link } from "../link/link";
import { Hook } from "../link/hook";
import { Tool } from "../link/tool";
import { createLinkHarness, FakeSocket, flush } from "./support/fake_link";

/** Every test here drives a link through a socket that goes nowhere. */
const setup = createLinkHarness;

// =============================================
// HANDSHAKE
// =============================================

describe("Link handshake", () => {
    it("declares itself and registers everything it holds", async () => {
        const { link, connect } = setup();
        link.addTool(new Tool({ id: "brew", description: "Brew coffee", run: () => "done" }));
        link.addHook(new Hook({ id: "doorbell", name: "Doorbell", description: "Rang", events: [{ name: "rang" }] }));

        const socket = await connect();

        expect(socket.ofType("hello")[0].payload).toMatchObject({ linkId: "coffee", protocolVersion: 1 });
        expect(socket.ofType("tool.register")[0].payload.tools).toHaveLength(1);
        expect(socket.ofType("hook.register")[0].payload.localId).toBe("doorbell");
        expect(link.state).toBe("open");
        expect(link.connectionId).toBe("conn-1");
        expect(link.scope).toBe("user");
    });

    it("takes public ids from the server rather than assembling them itself", async () => {
        const { link, connect } = setup();
        const tool = new Tool({ id: "brew", description: "Brew coffee", run: () => "done" });
        const hook = new Hook({ id: "doorbell", name: "Doorbell", description: "Rang", events: [{ name: "rang" }] });
        link.addTool(tool).addHook(hook);

        await connect();

        expect(tool.linkedId).toBe("link:coffee/brew");
        expect(hook.sourceId).toBe("link:coffee/doorbell");
    });

    it("fails the connection when the server refuses the claim", async () => {
        // A rejected claim will not fix itself by retrying, so this surfaces instead of
        // looping in the background.
        const { link, sockets } = setup({ reconnect: true });
        link.addTool(new Tool({ id: "brew", description: "Brew coffee", run: () => "done" }));

        const connecting = link.connect();
        const socket = sockets[0];
        socket.open();
        await flush();

        socket.push("welcome", { connectionId: "conn-1", linkId: "coffee", scope: "user", protocolVersion: 1 }, socket.ofType("hello")[0].id);
        await flush();
        socket.push("error", { code: "claim_conflict", error: "That linkId is already claimed globally." }, socket.ofType("tool.register")[0].id);

        await expect(connecting).rejects.toThrow(/already claimed globally/);
    });

    it("registers a tool added after it is already connected", async () => {
        const { link, connect, answerRegistrations } = setup();
        const socket = await connect();

        const tool = new Tool({ id: "late", description: "Added later", run: () => "done" });
        link.addTool(tool);
        await answerRegistrations(socket);

        expect(socket.ofType("tool.register")).toHaveLength(1);
        expect(tool.linkedId).toBe("link:coffee/late");
    });
});

// =============================================
// TOOL CALLS
// =============================================

describe("Link tool calls", () => {
    it("runs a call, streams status, and answers the frame that asked", async () => {
        const { link, connect } = setup();
        link.addTool(new Tool({
            id: "brew",
            description: "Brew coffee",
            schema: z.object({ cups: z.number() }),
            run: async ({ args, status, meta }) => {
                status.update("Grinding");
                return `brewed ${args.cups} for ${meta.userId}`;
            },
        }));

        const socket = await connect();
        socket.push("tool.call", {
            callId: "call-1",
            localId: "brew",
            args: { cups: 2 },
            meta: { userId: "us-aaa", chatId: "convo-1", runId: "run-1" },
            timeoutMs: 30_000,
        });
        await flush();

        // Both the status and the result are correlated to the call frame, which is how
        // the server matches them up.
        const status = socket.ofType("tool.status")[0];
        expect(status.payload).toEqual({ label: "Grinding", state: "running" });

        const result = socket.ofType("tool.result")[0];
        expect(result.replyTo).toBe(status.replyTo);
        expect(result.payload).toEqual({ ok: true, output: "brewed 2 for us-aaa" });
    });

    it("reports a tool that threw as a failed call", async () => {
        const { link, connect } = setup();
        link.addTool(new Tool({ id: "brew", description: "Brew coffee", run: () => { throw new Error("out of beans"); } }));

        const socket = await connect();
        socket.push("tool.call", { callId: "call-1", localId: "brew", args: {}, meta: { userId: "us-aaa", runId: "run-1" }, timeoutMs: 1000 });
        await flush();

        expect(socket.ofType("tool.result")[0].payload).toEqual({ ok: false, error: "out of beans" });
    });

    it("answers a call for a tool it does not have", async () => {
        // Silence would leave the server waiting for the whole timeout.
        const { link, connect } = setup();
        const socket = await connect();

        socket.push("tool.call", { callId: "call-1", localId: "ghost", args: {}, meta: { userId: "us-aaa", runId: "run-1" }, timeoutMs: 1000 });
        await flush();

        expect(socket.ofType("tool.result")[0].payload).toMatchObject({ ok: false, error: expect.stringContaining("no tool") });
    });

    it("finishes a call the tool reported nothing about", async () => {
        // Only a final status is kept in the conversation, so a tool that never reports
        // one would run and leave no trace of having run.
        const { link, connect } = setup();
        link.addTool(new Tool({ id: "brew", description: "Brew coffee", run: () => "done" }));

        const socket = await connect();
        socket.push("tool.call", { callId: "call-1", localId: "brew", args: {}, meta: { userId: "us-aaa", runId: "run-1" }, timeoutMs: 1000 });
        await flush();

        expect(socket.ofType("tool.status").map(frame => frame.payload.state)).toEqual(["completed"]);
    });

    it("keeps the tool's own closing label rather than inventing one", async () => {
        const { link, connect } = setup();
        link.addTool(new Tool({
            id: "brew",
            description: "Brew coffee",
            run: ({ status }) => {
                status.update("Grinding");
                status.complete("Poured two cups");
                return "done";
            },
        }));

        const socket = await connect();
        socket.push("tool.call", { callId: "call-1", localId: "brew", args: {}, meta: { userId: "us-aaa", runId: "run-1" }, timeoutMs: 1000 });
        await flush();

        expect(socket.ofType("tool.status").map(frame => frame.payload)).toEqual([
            { label: "Grinding", state: "running" },
            { label: "Poured two cups", state: "completed" },
        ]);
    });

    it("ignores anything reported after the tool has closed the call", async () => {
        const { link, connect } = setup();
        link.addTool(new Tool({
            id: "brew",
            description: "Brew coffee",
            run: ({ status }) => {
                status.complete("Poured");
                status.update("Still going somehow");
                return "done";
            },
        }));

        const socket = await connect();
        socket.push("tool.call", { callId: "call-1", localId: "brew", args: {}, meta: { userId: "us-aaa", runId: "run-1" }, timeoutMs: 1000 });
        await flush();

        expect(socket.ofType("tool.status").map(frame => frame.payload)).toEqual([{ label: "Poured", state: "completed" }]);
    });

    it("marks a thrown call as failed, so the failure is kept too", async () => {
        const { link, connect } = setup();
        link.addTool(new Tool({ id: "brew", description: "Brew coffee", run: () => { throw new Error("out of beans"); } }));

        const socket = await connect();
        socket.push("tool.call", { callId: "call-1", localId: "brew", args: {}, meta: { userId: "us-aaa", runId: "run-1" }, timeoutMs: 1000 });
        await flush();

        expect(socket.ofType("tool.status")[0].payload).toEqual({ label: "out of beans", state: "failed" });
    });

    it("lets the outcome overrule a tool that claimed success and then threw", async () => {
        const { link, connect } = setup();
        link.addTool(new Tool({
            id: "brew",
            description: "Brew coffee",
            run: ({ status }) => {
                status.complete("Poured");
                throw new Error("spilled it");
            },
        }));

        const socket = await connect();
        socket.push("tool.call", { callId: "call-1", localId: "brew", args: {}, meta: { userId: "us-aaa", runId: "run-1" }, timeoutMs: 1000 });
        await flush();

        expect(socket.ofType("tool.status").map(frame => frame.payload)).toEqual([
            { label: "Poured", state: "completed" },
            { label: "spilled it", state: "failed" },
        ]);
    });

    it("aborts a running call when the server cancels it", async () => {
        const { link, connect } = setup();
        let aborted = false;

        link.addTool(new Tool({
            id: "brew",
            description: "Brew coffee",
            run: ({ signal }) => new Promise(resolve => {
                signal.addEventListener("abort", () => { aborted = true; resolve("aborted"); });
            }),
        }));

        const socket = await connect();
        socket.push("tool.call", { callId: "call-1", localId: "brew", args: {}, meta: { userId: "us-aaa", runId: "run-1" }, timeoutMs: 1000 });
        await flush();

        socket.push("tool.cancel", { callId: "call-1", reason: "user cancelled" });
        await flush();

        expect(aborted).toBe(true);
    });
});

// =============================================
// CONNECTION LIFE
// =============================================

describe("Link connection life", () => {
    it("re-declares everything after a reconnect", async () => {
        // The server keeps nothing between connections, so a reconnect that did not
        // re-register would leave the tools quietly missing.
        const { link, sockets, connect, answerRegistrations } = setup({ reconnect: true });
        link.addTool(new Tool({ id: "brew", description: "Brew coffee", run: () => "done" }));

        const first = await connect();
        first.drop();

        await new Promise(resolve => setTimeout(resolve, 20));
        const second = sockets[1];
        expect(second).toBeDefined();

        second.open();
        await flush();
        second.push("welcome", { connectionId: "conn-2", linkId: "coffee", scope: "user", protocolVersion: 1 }, second.ofType("hello")[0].id);
        await answerRegistrations(second);

        expect(second.ofType("tool.register")[0].payload.tools[0].localId).toBe("brew");
        expect(link.connectionId).toBe("conn-2");
    });

    it("reports a disconnect and whether it will come back", async () => {
        const { link, connect } = setup({ reconnect: false });
        const socket = await connect();

        const seen: unknown[] = [];
        link.on("disconnect", (event) => seen.push(event));
        socket.drop(1006, "abnormal");

        expect(seen).toEqual([{ code: 1006, reason: "abnormal", willReconnect: false }]);
        expect(link.state).toBe("closed");
    });

    it("fails everything in flight when the socket drops", async () => {
        // Waiting forever on a reply that can never arrive is the worst outcome here.
        const { link, connect } = setup();
        const socket = await connect();

        const inFlight = link.exchange("conversation.start", {}, { isDone: (frame) => frame.type === "conversation.open" });
        await flush();
        socket.drop();

        await expect(inFlight).rejects.toThrow(/disconnected/);
    });

    it("stops reconnecting once closed deliberately", async () => {
        const { link, sockets, connect } = setup({ reconnect: true });
        const socket = await connect();

        link.close();
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(sockets).toHaveLength(1);
        expect(socket.closed).toMatchObject({ code: 1000 });
        expect(link.state).toBe("closed");
    });

    it("waits for the connection before emitting a hook", async () => {
        // A hook that fires during startup should not have to be sequenced by hand.
        const { link, sockets, connect } = setup();
        const hook = new Hook({ id: "doorbell", name: "Doorbell", description: "Rang", events: [{ name: "rang" }] });
        link.addHook(hook);

        const emitting = hook.emit("rang", { camera: "front" });
        const socket = await connect();
        await emitting;

        expect(socket.ofType("hook.emit")[0].payload).toEqual({
            sourceId: "link:coffee/doorbell",
            event: "rang",
            payload: { camera: "front" },
        });
        expect(sockets).toHaveLength(1);
    });

    it("surfaces an unsolicited server error to listeners", async () => {
        const { link, connect } = setup();
        const socket = await connect();

        const errors: Error[] = [];
        link.on("error", (error) => errors.push(error));
        socket.push("error", { code: "frame_too_large", error: "That frame was too large." });

        expect(errors[0].message).toBe("That frame was too large.");
    });

    it("passes a goodbye on, with the delay the server asked for", async () => {
        const { link, connect } = setup({ reconnect: true });
        const socket = await connect();

        const goodbyes: unknown[] = [];
        link.on("goodbye", (event) => goodbyes.push(event));
        socket.push("goodbye", { reason: "deploy", reconnectAfterMs: 5_000 });

        expect(goodbyes).toEqual([{ reason: "deploy", reconnectAfterMs: 5_000 }]);
    });

    it("keeps a heartbeat's pong out of the log listeners", async () => {
        const link = new Link({
            apiKey: "ap-abc_123",
            linkId: "coffee",
            heartbeatMs: 5,
            reconnect: false,
            socketFactory: (url, protocols, handlers) => new FakeSocket(url, protocols, handlers),
        });

        const logs: string[] = [];
        link.on("log", (log) => logs.push(log));

        // Reaching into the socket the link built for itself, since the heartbeat only
        // runs on a live connection.
        const socket = (link as unknown as { socket: FakeSocket }).socket;
        const connecting = link.connect();
        const live = (link as unknown as { socket: FakeSocket }).socket ?? socket;
        live.open();
        await flush();
        live.push("welcome", { connectionId: "conn-1", linkId: "coffee", scope: "user", protocolVersion: 1 }, live.ofType("hello")[0].id);
        await connecting;

        await new Promise(resolve => setTimeout(resolve, 12));
        const ping = live.ofType("ping")[0];
        expect(ping).toBeDefined();

        live.push("log", { log: "pong" }, ping.id);
        live.push("log", { log: "something worth seeing" });

        expect(logs).toEqual(["something worth seeing"]);
        link.close();
    });
});

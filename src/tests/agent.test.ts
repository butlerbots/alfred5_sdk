import { describe, expect, it } from "bun:test";

import { Agent } from "../link/agent";
import { LinkError } from "../link/protocol";
import { Tool } from "../link/tool";
import { createLinkHarness, flush } from "./support/fake_link";

// =============================================
// HELPERS
// =============================================

const tool = (id: string, output = `${id} done`) => new Tool({ id, description: `Runs ${id}`, run: async () => output });

function barista(tools = [tool("grind"), tool("brew")]) {
    return new Agent({
        id: "barista",
        name: "Barista",
        description: "Runs the coffee machine.",
        prompt: "Grind before you brew.",
        model: "DeepSeek-V4-Flash",
        tools,
    });
}

// =============================================
// DECLARATION
// =============================================

describe("Agent", () => {
    it("declares itself with its tools inside, and none of their platforms", () => {
        const placed = new Tool({ id: "kick", description: "Kick", platforms: ["platform.agent.discord"], run: async () => "ok" });
        const agent = barista([placed]);

        const descriptor = agent.descriptor();

        expect(descriptor).toMatchObject({ localId: "barista", name: "Barista", model: "DeepSeek-V4-Flash" });
        expect(descriptor.tools).toHaveLength(1);
        expect(descriptor.tools[0]).toMatchObject({ localId: "kick", description: "Kick" });
        expect("platforms" in descriptor.tools[0]).toBe(false);
    });

    it("refuses to hold two tools with one id", () => {
        expect(() => barista([tool("brew"), tool("brew")])).toThrow(/two tools with the id "brew"/);
    });

    it("mints a thread of its own, and a fresh one on request", () => {
        const agent = barista();
        const first = agent.thread;

        expect(first).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/i);
        expect(agent.newThread()).not.toBe(first);
        expect(agent.thread).not.toBe(first);
    });

    it("cannot chat until it is on a link", async () => {
        await expect(barista().chat("hi")).rejects.toThrow(/has not been added to a link/);
    });
});

// =============================================
// ON A LINK
// =============================================

describe("Link with agents", () => {
    it("registers agents after tools, and takes their ids from the server", async () => {
        const harness = createLinkHarness();
        const agent = barista();
        harness.link.addTool(tool("hello"));
        harness.link.addAgent(agent);

        const socket = await harness.connect();

        const order = socket.sent.map(frame => frame.type);
        expect(order.indexOf("tool.register")).toBeLessThan(order.indexOf("agent.register"));

        const registered = socket.ofType("agent.register")[0];
        expect(registered.payload.agents.map(a => a.localId)).toEqual(["barista"]);
        // Only the link's own tools travel in tool.register; the agent's stay with the agent.
        expect(socket.ofType("tool.register")[0].payload.tools.map(t => t.localId)).toEqual(["hello"]);
        expect(agent.linkedId).toBe("link:coffee/barista");
    });

    it("keeps one namespace for tools and agents", () => {
        const harness = createLinkHarness();
        harness.link.addTool(tool("brew"));

        // An agent's tool may not share an id with a tool on the link...
        expect(() => harness.link.addAgent(barista())).toThrow(/shares an id with another tool/);
        // ...and neither may the agent itself.
        const namedLikeATool = new Agent({ id: "brew", name: "Brew", description: "d", prompt: "p" });
        expect(() => harness.link.addAgent(namedLikeATool)).toThrow(/already has that id/);
    });

    it("answers a call to one of an agent's tools", async () => {
        const harness = createLinkHarness();
        harness.link.addAgent(barista([tool("grind", "Ground 18g.")]));
        const socket = await harness.connect();

        socket.push("tool.call", { callId: "call-1", localId: "grind", args: {}, meta: { userId: "us-1", runId: "r1" }, timeoutMs: 1000 });
        await flush();
        await flush();

        expect(socket.ofType("tool.result")[0].payload).toEqual({ ok: true, output: "Ground 18g." });
    });

    it("runs a chat as one exchange: status to the caller, the result ends it", async () => {
        const harness = createLinkHarness();
        const agent = barista();
        harness.link.addAgent(agent);
        const socket = await harness.connect();

        const statuses: string[] = [];
        const reply = agent.chat("make me a coffee", { onStatus: (status) => statuses.push(`${status.state}:${status.label}`) });
        await flush();

        const sent = socket.ofType("agent.chat")[0];
        expect(sent.payload).toEqual({ localId: "barista", message: "make me a coffee", thread: agent.thread });

        socket.push("agent.status", { localId: "barista", label: "Barista: Waiting for response...", state: "running" }, sent.id);
        socket.push("agent.result", { localId: "barista", thread: agent.thread, ok: true, output: "One coffee." }, sent.id);

        expect(await reply).toEqual({ text: "One coffee.", thread: agent.thread });
        expect(statuses).toEqual(["running:Barista: Waiting for response..."]);
    });

    it("continues the thread it was given rather than its own", async () => {
        const harness = createLinkHarness();
        const agent = barista();
        harness.link.addAgent(agent);
        const socket = await harness.connect();

        const reply = agent.chat("again", { thread: "kitchen" });
        await flush();

        const sent = socket.ofType("agent.chat")[0];
        expect(sent.payload.thread).toBe("kitchen");
        socket.push("agent.result", { localId: "barista", thread: "kitchen", ok: true, output: "ok" }, sent.id);

        expect((await reply).thread).toBe("kitchen");
    });

    it("rejects with the server's code when the agent could not run", async () => {
        const harness = createLinkHarness();
        const agent = barista();
        harness.link.addAgent(agent);
        const socket = await harness.connect();

        const reply = agent.chat("hi");
        await flush();

        const sent = socket.ofType("agent.chat")[0];
        socket.push("agent.result", { localId: "barista", ok: false, code: "agent_failed", error: "no model available" }, sent.id);

        await expect(reply).rejects.toMatchObject({ name: "LinkError", code: "agent_failed", message: "no model available" });
        await expect(reply).rejects.toBeInstanceOf(LinkError);
    });

    it("fails a chat in flight when the connection drops", async () => {
        const harness = createLinkHarness();
        const agent = barista();
        harness.link.addAgent(agent);
        const socket = await harness.connect();

        const reply = agent.chat("hi");
        await flush();
        socket.drop();

        await expect(reply).rejects.toMatchObject({ code: "disconnected" });
    });
});

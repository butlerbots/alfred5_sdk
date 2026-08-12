import { describe, expect, it } from "bun:test";

import { z } from "zod";

import { Hook } from "../link/hook";
import { Link } from "../link/link";
import { LinkError } from "../link/protocol";
import { toJSONSchema, validateArgs } from "../link/schema";
import { buildHandshake } from "../link/socket";
import { Tool } from "../link/tool";
import type { ToolStatusReporter } from "../link/tool";

// =============================================
// SCHEMAS
// =============================================

describe("Schemas", () => {
    it("derives JSON Schema from a zod schema", () => {
        const schema = toJSONSchema(z.object({ cups: z.number().describe("How many") }), "brew");

        expect(schema.type).toBe("object");
        expect(schema.properties).toMatchObject({ cups: { type: "number", description: "How many" } });
    });

    it("takes a plain JSON Schema as given", () => {
        const raw = { type: "object", properties: { cups: { type: "number" } } };
        expect(toJSONSchema(raw, "brew")).toBe(raw);
    });

    it("uses a schema's own converter when it has one", () => {
        const converted = { type: "object" };
        expect(toJSONSchema({ toJSONSchema: () => converted }, "brew")).toBe(converted);
    });

    it("explains itself when a schema cannot be converted", () => {
        expect(() => toJSONSchema({ nonsense: true } as never, "brew"))
            .toThrow(/neither a JSON Schema nor a Standard Schema/);
    });

    it("validates arguments against a schema that can validate", async () => {
        const schema = z.object({ cups: z.number() });

        expect(await validateArgs(schema, { cups: 2 })).toEqual({ ok: true, value: { cups: 2 } });

        const bad = await validateArgs(schema, { cups: "two" });
        expect(bad.ok).toBe(false);
        if (!bad.ok) expect(bad.error).toContain("cups");
    });

    it("passes arguments through when the schema cannot validate", async () => {
        // A raw JSON Schema carries no validator, so the tool sees what arrived.
        const args = { cups: "two" };
        expect(await validateArgs({ type: "object" }, args)).toEqual({ ok: true, value: args });
    });
});

// =============================================
// HANDSHAKE
// =============================================

describe("Handshake", () => {
    it("carries the service and credential as subprotocols", () => {
        // A browser cannot set headers on a websocket, and a subprotocol keeps the key
        // out of the URL, which is what ends up in access logs.
        const { url, protocols } = buildHandshake("https://core.butler.now", "link", "ap-abc_123");

        expect(url).toBe("wss://core.butler.now/?service=link");
        expect(protocols).toEqual(["butler.service.link", "butler.key.ap-abc_123"]);
    });

    it("upgrades http to ws for local development", () => {
        expect(buildHandshake("http://localhost:3000", "link", "ap-abc_123").url).toBe("ws://localhost:3000/?service=link");
    });

    it("falls back to the query string for a key a subprotocol cannot carry", () => {
        // Subprotocols are HTTP tokens; a key with a space or comma would break the
        // handshake outright.
        const { url, protocols } = buildHandshake("https://core.butler.now", "link", "has space");

        expect(protocols).toEqual(["butler.service.link"]);
        expect(url).toContain("api_key=has+space");
    });
});

// =============================================
// TOOLS
// =============================================

describe("Tools", () => {
    const brew = () => new Tool({
        id: "brew",
        description: "Brew a coffee",
        schema: z.object({ cups: z.number() }),
        display: { name: "Brew", shortDescription: "Brews", longDescription: "Brews coffee" },
        defaultEnabled: true,
        run: async ({ args }) => `brewed ${args.cups}`,
    });

    it("declares itself for the wire", () => {
        expect(brew().descriptor()).toMatchObject({
            localId: "brew",
            description: "Brew a coffee",
            defaultEnabled: true,
            display: { name: "Brew" },
            inputSchema: { type: "object" },
        });
    });

    it("declares an empty object when it takes no arguments", () => {
        const tool = new Tool({ id: "ping", description: "Ping", run: () => "pong" });
        expect(tool.descriptor().inputSchema).toEqual({ type: "object", properties: {} });
    });

    it("runs and returns its output", async () => {
        const result = await brew().invoke({ cups: 2 }, meta(), noopStatus(), new AbortController().signal);
        expect(result).toEqual({ ok: true, output: "brewed 2" });
    });

    it("refuses arguments that do not match its schema", async () => {
        // The server does not check these — the client authored the schema, so this is
        // the only place the check can happen.
        const result = await brew().invoke({ cups: "two" }, meta(), noopStatus(), new AbortController().signal);

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("cups");
    });

    it("turns a throw into a failed call rather than rejecting", async () => {
        // Something is waiting on the other end of this call; it must always get an answer.
        const tool = new Tool({
            id: "brew",
            description: "Brew a coffee",
            run: () => { throw new Error("out of beans"); },
        });

        expect(await tool.invoke({}, meta(), noopStatus(), new AbortController().signal))
            .toEqual({ ok: false, error: "out of beans" });
    });

    it("types its arguments from the schema", async () => {
        // A compile-time assertion: `cups` is a number here, not unknown.
        const tool = new Tool({
            id: "brew",
            description: "Brew a coffee",
            schema: z.object({ cups: z.number() }),
            run: ({ args }) => args.cups.toFixed(0),
        });

        expect(await tool.invoke({ cups: 3 }, meta(), noopStatus(), new AbortController().signal))
            .toEqual({ ok: true, output: "3" });
    });
});

// =============================================
// HOOKS
// =============================================

describe("Hooks", () => {
    const doorbell = () => new Hook({
        id: "doorbell",
        name: "Doorbell",
        description: "Someone is at the door",
        events: [{ name: "rang", description: "The bell rang" }],
        schema: z.object({ camera: z.string() }),
    });

    it("declares itself for the wire", () => {
        expect(doorbell().declaration()).toMatchObject({
            localId: "doorbell",
            name: "Doorbell",
            events: [{ name: "rang" }],
            argsSchema: { type: "object" },
        });
    });

    /** A `HookEmitter` that does nothing, for tests that only care about one of its methods. */
    const noEmitter = {
        emitHook: async () => undefined,
        reportHookEvent: async () => [],
        hookSubscriptions: () => [],
    };

    it("emits through the link it is attached to", async () => {
        // Its own id goes over, not `sourceId`: an emit during startup happens before
        // registration has assigned one, so the link resolves it at send time.
        const emitted: unknown[] = [];
        const hook = doorbell();
        hook.attach({ ...noEmitter, emitHook: async (...args) => { emitted.push(args); } });

        await hook.emit("rang", { camera: "front" });

        expect(emitted).toEqual([["doorbell", "rang", { camera: "front" }, undefined]]);
    });

    it("refuses an event it never declared, where the typo was made", async () => {
        const hook = doorbell();
        hook.attach(noEmitter);

        await expect(hook.emit("ringed")).rejects.toThrow(/does not declare an event named "ringed"/);
    });

    it("says so when it is not on a link yet", async () => {
        await expect(doorbell().emit("rang")).rejects.toThrow(/not on a link yet/);
    });
});

// =============================================
// WHAT A LINK ACCEPTS
// =============================================

describe("Adding things to a link", () => {
    /**
     * A compile-time guard: tools and hooks with different schemas have no common
     * `Tool<S>` type, so a link has to accept them by what it uses, not by schema.
     * This once failed for every caller who passed a real schema.
     */
    it("takes tools and hooks whatever their schema", () => {
        const link = new Link({ apiKey: "ap-abc_123", linkId: "coffee", heartbeatMs: 0, reconnect: false });

        link.addTool(new Tool({
            id: "brew",
            description: "Brew a coffee",
            schema: z.object({ cups: z.number(), strength: z.enum(["mild", "strong"]).default("mild") }),
            run: ({ args }) => `${args.cups} ${args.strength}`,
        }));
        link.addTool(new Tool({ id: "ping", description: "Ping", run: () => "pong" }));
        link.addTool(new Tool({ id: "raw", description: "Raw schema", jsonSchema: { type: "object" }, run: () => "ok" }));

        link.addHook(new Hook({ id: "doorbell", name: "Doorbell", description: "Rang", events: [{ name: "rang" }] }));
        link.addHook(new Hook({
            id: "tank",
            name: "Tank",
            description: "Level changed",
            events: [{ name: "low" }],
            schema: z.object({ level: z.number() }),
        }));

        expect(link.getTool("brew")?.id).toBe("brew");
        expect(link.getHook("tank")?.id).toBe("tank");
    });
});

// =============================================
// ERRORS
// =============================================

describe("LinkError", () => {
    it("keeps the server's code so callers can branch on it", () => {
        const error = new LinkError("claim_conflict", "That linkId is taken.", true);

        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe("claim_conflict");
        expect(error.fatal).toBe(true);
    });
});

// =============================================
// HELPERS
// =============================================

function meta() {
    return { userId: "us-aaa", chatId: "convo-1", runId: "run-1" };
}

function noopStatus(): ToolStatusReporter {
    return { update: () => undefined, complete: () => undefined, fail: () => undefined };
}

describe("where a tool belongs", () => {
    it("says nothing by default, so the server picks the user's chat", () => {
        const tool = new Tool({ id: "brew", description: "Brew", run: () => "ok" });

        expect(tool.descriptor().platforms).toBeUndefined();
    });

    it("passes declared platforms through untouched", () => {
        // Not validated here: the server owns the list of platforms that exist, and a client shipped
        // six months ago should not be the thing deciding what is valid today.
        const tool = new Tool({
            id: "kick",
            description: "Kick",
            platforms: ["platform.agent.discord"],
            run: () => "ok",
        });

        expect(tool.descriptor().platforms).toEqual(["platform.agent.discord"]);
    });
});

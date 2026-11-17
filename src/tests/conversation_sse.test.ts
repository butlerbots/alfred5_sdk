import { describe, expect, it } from "bun:test";

import { Conversation } from "../modules/conversation";
import { ButlerBotAPIError } from "../util/api_error";
import { ButlerBotTurnError } from "../util/turn_error";
import { getUsagePolicyData } from "../modules/usage";

/**
 * The HTTP transport against a real server.
 *
 * The dialogue pipeline moved out from under this path, so these run end to end
 * over a socket rather than against a stubbed EventSource: what matters is that a
 * caller sees exactly what it saw before.
 */

type Payload = {
    success: boolean;
    data: { response?: { type: string }; convoId?: string; quitStream?: boolean; message?: string };
};

type Recorded = {
    method: string;
    url: URL;
    headers: Headers;
    /** The JSON body, parsed, when the request sent one. */
    body: Record<string, unknown> | undefined;
};

function sseServer(events: unknown[]) {
    const requests: Recorded[] = [];

    const server = Bun.serve({
        port: 0,
        async fetch(request) {
            const text = await request.text();
            requests.push({ method: request.method, url: new URL(request.url), headers: request.headers, body: text ? JSON.parse(text) : undefined });

            const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
            return new Response(body, {
                headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
            });
        },
    });

    return { server, requests, url: `http://localhost:${server.port}` };
}

/** A server that answers every request with a plain HTTP refusal. */
function refusingServer(status: number, body: unknown) {
    const server = Bun.serve({
        port: 0,
        fetch() {
            return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        },
    });
    return { server, url: `http://localhost:${server.port}` };
}

const message = (text: string, completed = false) => ({
    success: true,
    data: {
        response: { type: "message", payload: { message: text, messageId: "m1", completed }, metadata: { participantId: "alfred" } },
        convoId: "convo-1",
    },
});

const completion = () => ({
    success: true,
    data: { response: { type: "response_status", payload: { completed: true } }, convoId: "convo-1", quitStream: true },
});

describe("Conversations over SSE", () => {
    it("streams a turn and closes when the server says the stream is done", async () => {
        const { server, url } = sseServer([message("Good"), message("Good day", true), completion()]);

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat" });
            const received: Payload[] = [];

            await new Promise<void>((resolve) => {
                convo.send("hello", (chunk) => {
                    received.push(chunk as Payload);
                    if ((chunk as Payload).data.quitStream) resolve();
                });
            });

            expect(received.map(entry => entry.data.response?.type)).toEqual(["message", "message", "response_status"]);
            expect(convo.getConvoId()).toBe("convo-1");
        } finally {
            server.stop(true);
        }
    });

    it("POSTs the message and options as a JSON body, with the key in the Authorization header", async () => {
        const { server, requests, url } = sseServer([completion()]);

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat" });
            convo.setModel("GPT-5").setPlatform("tests")
                .setAddress({ platform: "discord", channelId: "channel-7", threadId: "thread-3", messageId: "msg-11" });

            await new Promise<void>((resolve) => {
                convo.send("hello there", (chunk) => { if ((chunk as Payload).data.quitStream) resolve(); });
            });

            const [request] = requests;
            expect(request.method).toBe("POST");
            expect(request.headers.get("content-type")).toBe("application/json");
            expect(request.headers.get("authorization")).toBe("Bearer ap-abc_123");
            // Nothing in the URL: not the key, not what the user typed.
            expect([...request.url.searchParams.keys()]).toEqual([]);
            expect(request.body).toEqual({
                message: "hello there",
                model: "GPT-5",
                platform: "tests",
                address: { platform: "discord", channelId: "channel-7", threadId: "thread-3", messageId: "msg-11" },
            });
        } finally {
            server.stop(true);
        }
    });

    it("leaves the address out when the conversation has none", async () => {
        // A conversation that never says where it is must not claim an address: the server
        // reads the absence as "wherever the user is", not as a place named "undefined".
        const { server, requests, url } = sseServer([completion()]);

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat" });
            convo.setPlatform("tests");

            await new Promise<void>((resolve) => {
                convo.send("hello", (chunk) => { if ((chunk as Payload).data.quitStream) resolve(); });
            });

            expect(requests[0].body).not.toHaveProperty("address");
            expect(convo.getAddress()).toBeUndefined();
        } finally {
            server.stop(true);
        }
    });

    it("sends the wake line with the turn it was given for", async () => {
        const { server, requests, url } = sseServer([completion()]);

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat" });

            await new Promise<void>((resolve) => {
                convo.send("hello", (chunk) => { if ((chunk as Payload).data.quitStream) resolve(); },
                    { wake: "You are joining because a rule of the user's matched: deploy failed" });
            });

            expect(requests[0].body!.wake)
                .toBe("You are joining because a rule of the user's matched: deploy failed");
        } finally {
            server.stop(true);
        }
    });

    it("leaves the wake line out when it is omitted or blank", async () => {
        // Blank is not a reason: the server would read an empty line as one to add to the prompt.
        const { server, requests, url } = sseServer([completion(), completion()]);

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat" });

            await new Promise<void>((resolve) => {
                convo.send("hello", (chunk) => { if ((chunk as Payload).data.quitStream) resolve(); });
            });
            await new Promise<void>((resolve) => {
                convo.send("hello", (chunk) => { if ((chunk as Payload).data.quitStream) resolve(); }, { wake: "   " });
            });

            expect(requests).toHaveLength(2);
            expect(requests[0].body).not.toHaveProperty("wake");
            expect(requests[1].body).not.toHaveProperty("wake");
        } finally {
            server.stop(true);
        }
    });

    it("sends a turn's tools as an array of ids: trimmed, folded, and none when empty", async () => {
        const { server, requests, url } = sseServer([completion(), completion(), completion()]);

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat" });

            await new Promise<void>((resolve) => {
                convo.send("hello", (chunk) => { if ((chunk as Payload).data.quitStream) resolve(); }, { tools: [" react ", "react", "", "describe_tool"] });
            });
            await new Promise<void>((resolve) => {
                convo.send("hello", (chunk) => { if ((chunk as Payload).data.quitStream) resolve(); }, { tools: [] });
            });
            await new Promise<void>((resolve) => {
                convo.send("hello", (chunk) => { if ((chunk as Payload).data.quitStream) resolve(); }, { tools: ["  "] });
            });

            expect(requests[0].body!.tools).toEqual(["react", "describe_tool"]);
            expect(requests[1].body).not.toHaveProperty("tools");
            expect(requests[2].body).not.toHaveProperty("tools");

            // A comma would read as two ids in the query form, so it is refused in both.
            expect(() => convo.send("hello", () => undefined, { tools: ["re,act"] })).toThrow("may not contain a comma");
        } finally {
            server.stop(true);
        }
    });

    it("sends a turn's context as an array, and none when it is empty", async () => {
        const { server, requests, url } = sseServer([completion(), completion(), completion()]);
        const context = [
            { kind: "reply", title: "Replying to", text: "Sam: what time does the store close?" },
            { kind: "mentions", title: "Mentions", text: "Sam (@sam) = <@123>" },
        ];

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat" });
            const turn = (options?: Parameters<typeof convo.send>[2]) => new Promise<void>((resolve) => {
                convo.send("hello", (chunk) => { if ((chunk as Payload).data.quitStream) resolve(); }, options);
            });

            await turn({ context });
            await turn({ context: [] });
            await turn();

            expect(requests[0].body!.context).toEqual(context);
            expect(requests[1].body).not.toHaveProperty("context");
            expect(requests[2].body).not.toHaveProperty("context");
        } finally {
            server.stop(true);
        }
    });

    it("sends each extra entry as a body field of its own", async () => {
        const { server, requests, url } = sseServer([completion()]);

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat" });

            await new Promise<void>((resolve) => {
                convo.send("hello", (chunk) => { if ((chunk as Payload).data.quitStream) resolve(); },
                    { model: "GPT-5", extra: { summon: "cold", mood: "cheerful" } });
            });

            expect(requests[0].body).toEqual({ summon: "cold", mood: "cheerful", message: "hello", model: "GPT-5" });
        } finally {
            server.stop(true);
        }
    });

    it("refuses an extra entry that would replace a field it sends, before sending anything", async () => {
        const { server, requests, url } = sseServer([completion()]);

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat" });

            for (const key of ["message", "api_key", "chatId", "wake", "tools", "context"]) {
                expect(() => convo.send("hello", () => undefined, { extra: { [key]: "x" } }))
                    .toThrow(`may not set "${key}"`);
            }
            await expect(convo.ask("hello", { extra: { model: "cheap" } })).rejects.toThrow(`may not set "model"`);

            await new Promise(resolve => setTimeout(resolve, 20));
            expect(requests).toHaveLength(0);
        } finally {
            server.stop(true);
        }
    });

    it("replaces the address whole rather than merging into it", async () => {
        // A conversation that moved out of a thread must stop naming the thread it was in,
        // which is what "whole" buys: the parts of the old address do not survive the new one.
        // The same holds for the message it was last held at, which a client re-sends per turn.
        const { server, requests, url } = sseServer([completion()]);

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat" });
            convo.setAddress({ platform: "discord", channelId: "channel-7", threadId: "thread-3", messageId: "msg-11" });
            convo.setAddress({ platform: "discord", channelId: "channel-7" });

            await new Promise<void>((resolve) => {
                convo.send("hello", (chunk) => { if ((chunk as Payload).data.quitStream) resolve(); });
            });

            expect(requests[0].body!.address).toEqual({ platform: "discord", channelId: "channel-7" });
            expect(convo.getAddress()).toEqual({ platform: "discord", channelId: "channel-7" });
        } finally {
            server.stop(true);
        }
    });

    it("continues an existing conversation", async () => {
        const { server, requests, url } = sseServer([completion()]);

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat", convoId: "convo-existing" });

            await new Promise<void>((resolve) => {
                convo.send("hello", (chunk) => { if ((chunk as Payload).data.quitStream) resolve(); });
            });

            expect(requests[0].body!.chatId).toBe("convo-existing");
        } finally {
            server.stop(true);
        }
    });

    it("hands back a handle that can close the stream", async () => {
        const { server, url } = sseServer([message("Good")]);

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat" });
            const stream = convo.send("hello", () => undefined);

            expect(typeof stream.close).toBe("function");
            // The EventSource is still reachable for anyone who was using it.
            expect(stream.source).toBeDefined();
            stream.close();
        } finally {
            server.stop(true);
        }
    });

    it("resolves ask() with the finished reply", async () => {
        const { server, url } = sseServer([message("Good"), message("Good day", true), completion()]);

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat" });
            const answer = await convo.ask("hello");

            expect(answer.text).toBe("Good day");
            expect(answer.convoId).toBe("convo-1");
        } finally {
            server.stop(true);
        }
    });
});

describe("Turns over SSE for an older server", () => {
    it("sends the turn as a GET query when asked to, still with the key in the header", async () => {
        const { server, requests, url } = sseServer([completion()]);

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat", turnMethod: "GET" });
            convo.setAddress({ platform: "discord", channelId: "channel-7" }).setPlatform("discord");

            await convo.ask("hello", { tools: ["react"], extra: { summon: "cold" } });

            const [request] = requests;
            expect(request.method).toBe("GET");
            expect(request.body).toBeUndefined();
            expect(request.url.searchParams.get("message")).toBe("hello");
            expect(request.url.searchParams.get("tools")).toBe("react");
            expect(request.url.searchParams.get("summon")).toBe("cold");
            expect(JSON.parse(request.url.searchParams.get("address")!)).toEqual({ platform: "discord", channelId: "channel-7" });
            expect(request.url.searchParams.has("api_key")).toBe(false);
            expect(request.headers.get("authorization")).toBe("Bearer ap-abc_123");
        } finally {
            server.stop(true);
        }
    });
});

describe("A turn whose stream fails", () => {
    it("ends on a failure payload carrying the status and what the server said, and ask() rejects with it", async () => {
        const { server, url } = refusingServer(401, { errormessage: "UnAuthorized" });

        try {
            const convo = new Conversation({ apiKey: "ap-wrong", serverUrl: url, convoPath: "/chat" });
            const received: Payload[] = [];

            const error = await convo.ask("hello", { onEvent: (chunk) => received.push(chunk as Payload) }).catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(ButlerBotTurnError);
            const turnError = error as ButlerBotTurnError;
            expect(turnError.code).toBe("SDK_UNAUTHORIZED");
            expect(turnError.status).toBe(401);
            expect(turnError.userMessage).toBe("UnAuthorized");
            expect(received).toHaveLength(1);
            expect(received[0]).toMatchObject({ success: false, data: { code: "SDK_UNAUTHORIZED", status: 401, quitStream: true } });
        } finally {
            server.stop(true);
        }
    });

    it("names a refused parameter and what was wrong with it", async () => {
        const { server, url } = refusingServer(400, {
            success: false,
            error: "Bad Request",
            message: "Request body validation failed.",
            validationErrors: ["address: The address is for discord but the platform is web."],
        });

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat" });
            const error = await convo.ask("hello").catch((caught: unknown) => caught) as ButlerBotTurnError;

            expect(error.code).toBe("SDK_BAD_REQUEST");
            expect(error.error).toContain("The address is for discord but the platform is web.");
            expect(error.userMessage).toBe("Request body validation failed.");
        } finally {
            server.stop(true);
        }
    });

    it("keeps the server's own code when the refusal carries one", async () => {
        const { server, url } = refusingServer(410, { errorcode: "SERVER_ENDPOINT_DEPRECATED", exacterror: "Endpoint Deprecated", errormessage: "Deprecated." });

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat" });
            const error = await convo.ask("hello").catch((caught: unknown) => caught) as ButlerBotTurnError;

            expect(error.code).toBe("SERVER_ENDPOINT_DEPRECATED");
            expect(error.status).toBe(410);
        } finally {
            server.stop(true);
        }
    });

    it("rejects on a stream the server closes for good without finishing", async () => {
        const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: `http://localhost:${server.port}`, convoPath: "/chat" });
            const error = await convo.ask("hello").catch((caught: unknown) => caught) as ButlerBotTurnError;

            expect(error.code).toBe("SDK_STREAM_CLOSED");
        } finally {
            server.stop(true);
        }
    });

    it("gives up a stream that says nothing within the first-event timeout, and says so", async () => {
        // A server that accepts the stream and never writes to it.
        const server = Bun.serve({
            port: 0,
            fetch: () => new Response(new ReadableStream({ start() { /* never writes */ } }), { headers: { "content-type": "text/event-stream" } }),
        });

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: `http://localhost:${server.port}`, convoPath: "/chat", timeout: { firstEventMs: 150 } });
            const started = Date.now();
            const error = await convo.ask("hello").catch((caught: unknown) => caught) as ButlerBotTurnError;

            expect(error).toBeInstanceOf(ButlerBotTurnError);
            expect(error.code).toBe("SDK_TIMEOUT");
            expect(Date.now() - started).toBeLessThan(2_000);
        } finally {
            server.stop(true);
        }
    });

    it("lets one turn set its own timeout, and an idle one that resets on every event", async () => {
        // One event, then silence: the first-event wait is met and the idle one is not.
        const server = Bun.serve({
            port: 0,
            fetch: () => new Response(new ReadableStream({
                start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message("Good"))}\n\n`)); },
            }), { headers: { "content-type": "text/event-stream" } }),
        });

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: `http://localhost:${server.port}`, convoPath: "/chat" });
            const received: Payload[] = [];
            const error = await convo.ask("hello", { timeout: { firstEventMs: 2_000, idleMs: 150 }, onEvent: (chunk) => received.push(chunk as Payload) })
                .catch((caught: unknown) => caught) as ButlerBotTurnError;

            expect(error.code).toBe("SDK_TIMEOUT");
            expect(received.map(entry => entry.success)).toEqual([true, false]);
        } finally {
            server.stop(true);
        }
    });

    it("never fires the timeout after the turn finished", async () => {
        const { server, url } = sseServer([message("Good day", true), completion()]);

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat", timeout: { firstEventMs: 100, idleMs: 100 } });
            const received: Payload[] = [];
            await convo.ask("hello", { onEvent: (chunk) => received.push(chunk as Payload) });
            await new Promise(resolve => setTimeout(resolve, 250));

            expect(received.every(entry => entry.success)).toBe(true);
        } finally {
            server.stop(true);
        }
    });
});

describe("A turn whose connection drops", () => {
    it("reconnects by sending the same request again with the last event id, and carries on", async () => {
        const requests: Recorded[] = [];
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                const text = await request.text();
                requests.push({ method: request.method, url: new URL(request.url), headers: request.headers, body: text ? JSON.parse(text) : undefined });
                // The first connection ends with no final word, as a hand-off does; the second
                // finishes the turn.
                const events = requests.length === 1
                    ? `retry: 10\nid: convo-1:1\ndata: ${JSON.stringify(message("Good"))}\n\n`
                    : `id: convo-1:2\ndata: ${JSON.stringify(message("Good day", true))}\n\ndata: ${JSON.stringify(completion())}\n\n`;
                return new Response(events, { headers: { "content-type": "text/event-stream" } });
            },
        });

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: `http://localhost:${server.port}`, convoPath: "/chat" });
            const answer = await convo.ask("hello");

            expect(answer.text).toBe("Good day");
            expect(requests).toHaveLength(2);
            expect(requests[1].method).toBe("POST");
            expect(requests[1].headers.get("last-event-id")).toBe("convo-1:1");
            expect(requests[1].headers.get("authorization")).toBe("Bearer ap-abc_123");
            expect(requests[1].body).toEqual(requests[0].body);
        } finally {
            server.stop(true);
        }
    });
});

describe("Reads beside the turn", () => {
    it("throw a ButlerBotAPIError with the status and the server's words", async () => {
        const { server, url } = refusingServer(404, { success: false, error: "Not found", errormessage: "No conversation of yours has that id." });

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoId: "convo-gone", historyPath: "/history", progressPath: "/progress" });

            const state = await convo.fetchState().catch((caught: unknown) => caught) as ButlerBotAPIError;
            expect(state).toBeInstanceOf(ButlerBotAPIError);
            expect(state.status).toBe(404);
            expect(state.errormessage).toBe("No conversation of yours has that id.");

            const progress = await convo.fetchProgress().catch((caught: unknown) => caught) as ButlerBotAPIError;
            expect(progress).toBeInstanceOf(ButlerBotAPIError);
            expect(progress.isNotFound).toBe(true);
        } finally {
            server.stop(true);
        }
    });

    it("send the key as a header, never in the URL", async () => {
        const seen: Array<{ url: URL; authorization: string | null }> = [];
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                seen.push({ url: new URL(request.url), authorization: request.headers.get("authorization") });
                return Response.json({ success: true, policy: { tiers: [] }, events: [] });
            },
        });

        try {
            const url = `http://localhost:${server.port}`;
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoId: "convo-1", historyPath: "/history", progressPath: "/progress" });
            await convo.fetchState();
            await convo.fetchProgress({ includeCompleted: true });
            await getUsagePolicyData({ apiKey: "ap-abc_123", serverURL: url, path: "/policy" });

            expect(seen).toHaveLength(3);
            for (const request of seen) {
                expect(request.url.searchParams.has("api_key")).toBe(false);
                expect(request.authorization).toBe("Bearer ap-abc_123");
            }
            expect(seen[1].url.searchParams.get("includeCompleted")).toBe("true");
        } finally {
            server.stop(true);
        }
    });

    it("read the usage policy's body once, so a refusal says what the server said", async () => {
        const { server, url } = refusingServer(403, { error: "Forbidden", errormessage: "API key is missing required scope(s): usage.read" });

        try {
            const error = await getUsagePolicyData({ apiKey: "ap-abc_123", serverURL: url, path: "/policy" }).catch((caught: unknown) => caught) as ButlerBotAPIError;

            expect(error).toBeInstanceOf(ButlerBotAPIError);
            expect(error.status).toBe(403);
            expect(error.errormessage).toContain("usage.read");
        } finally {
            server.stop(true);
        }
    });
});

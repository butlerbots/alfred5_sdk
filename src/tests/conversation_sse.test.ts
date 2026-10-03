import { describe, expect, it } from "bun:test";

import { Conversation } from "../modules/conversation";

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

function sseServer(events: unknown[]) {
    const requests: URL[] = [];

    const server = Bun.serve({
        port: 0,
        fetch(request) {
            requests.push(new URL(request.url));

            const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
            return new Response(body, {
                headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
            });
        },
    });

    return { server, requests, url: `http://localhost:${server.port}` };
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

    it("sends the message and options as query parameters", async () => {
        const { server, requests, url } = sseServer([completion()]);

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat" });
            convo.setModel("GPT-5").setPlatform("tests")
                .setAddress({ platform: "discord", channelId: "channel-7", threadId: "thread-3", messageId: "msg-11" });

            await new Promise<void>((resolve) => {
                convo.send("hello there", (chunk) => { if ((chunk as Payload).data.quitStream) resolve(); });
            });

            const query = requests[0].searchParams;
            expect(query.get("message")).toBe("hello there");
            expect(query.get("model")).toBe("GPT-5");
            expect(query.get("platform")).toBe("tests");
            expect(JSON.parse(query.get("address")!)).toEqual({
                platform: "discord",
                channelId: "channel-7",
                threadId: "thread-3",
                messageId: "msg-11",
            });
            expect(query.get("api_key")).toBe("ap-abc_123");
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

            expect(requests[0].searchParams.has("address")).toBe(false);
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

            expect(requests[0].searchParams.get("wake"))
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
            expect(requests[0].searchParams.has("wake")).toBe(false);
            expect(requests[1].searchParams.has("wake")).toBe(false);
        } finally {
            server.stop(true);
        }
    });

    it("sends a turn's tools as one comma-separated parameter: trimmed, folded, and none when empty", async () => {
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

            expect(requests[0].searchParams.get("tools")).toBe("react,describe_tool");
            expect(requests[1].searchParams.has("tools")).toBe(false);
            expect(requests[2].searchParams.has("tools")).toBe(false);

            // A comma would read as two ids on the wire, so it never reaches it.
            expect(() => convo.send("hello", () => undefined, { tools: ["re,act"] })).toThrow("may not contain a comma");
        } finally {
            server.stop(true);
        }
    });

    it("sends a turn's context as one JSON parameter, and none when it is empty", async () => {
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

            expect(JSON.parse(requests[0].searchParams.get("context")!)).toEqual(context);
            expect(requests[1].searchParams.has("context")).toBe(false);
            expect(requests[2].searchParams.has("context")).toBe(false);
        } finally {
            server.stop(true);
        }
    });

    it("sends each extra entry as a query parameter of its own", async () => {
        const { server, requests, url } = sseServer([completion()]);

        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat" });

            await new Promise<void>((resolve) => {
                convo.send("hello", (chunk) => { if ((chunk as Payload).data.quitStream) resolve(); },
                    { model: "GPT-5", extra: { summon: "cold", mood: "cheerful" } });
            });

            expect(requests[0].searchParams.get("summon")).toBe("cold");
            expect(requests[0].searchParams.get("mood")).toBe("cheerful");
            expect(requests[0].searchParams.get("message")).toBe("hello");
            expect(requests[0].searchParams.get("model")).toBe("GPT-5");
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

            expect(JSON.parse(requests[0].searchParams.get("address")!))
                .toEqual({ platform: "discord", channelId: "channel-7" });
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

            expect(requests[0].searchParams.get("chatId")).toBe("convo-existing");
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

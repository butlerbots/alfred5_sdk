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
            convo.setModel("GPT-5").setPlatform("tests");

            await new Promise<void>((resolve) => {
                convo.send("hello there", (chunk) => { if ((chunk as Payload).data.quitStream) resolve(); });
            });

            const query = requests[0].searchParams;
            expect(query.get("message")).toBe("hello there");
            expect(query.get("model")).toBe("GPT-5");
            expect(query.get("platform")).toBe("tests");
            expect(query.get("api_key")).toBe("ap-abc_123");
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

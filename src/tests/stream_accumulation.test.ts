import { describe, expect, it } from "bun:test";

import { Conversation } from "../modules/conversation";

/**
 * Streamed text arrives a piece at a time, and callers should not have to know.
 *
 * These run over a real SSE socket rather than against the accumulator directly: what
 * matters is that a caller sees whole messages exactly as it did when the server was
 * re-sending the entire answer on every token.
 */

type Payload = {
    success: boolean;
    data: {
        response?: { type: string; payload?: { message?: string; messageId?: string; reasoning?: string; delta?: string; completed?: boolean } };
        convoId?: string;
        quitStream?: boolean;
    };
};

function sseServer(events: unknown[]) {
    const server = Bun.serve({
        port: 0,
        fetch() {
            const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
            return new Response(body, {
                headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
            });
        },
    });

    return { server, url: `http://localhost:${server.port}` };
}

const METADATA = { participantId: "alfred", model: "GPT-5", responseId: "r1" };

/** The frame that opens a message: whole value, and the only one carrying the metadata. */
const opening = (text: string, messageId = "m1") => ({
    success: true,
    data: {
        response: {
            type: "message",
            payload: { message: text, messageId, completed: false },
            metadata: METADATA,
        },
        convoId: "convo-1",
    },
});

/** A chunk as the server now streams one: only what it added, and nothing else. */
const delta = (text: string, messageId = "m1") => ({
    success: true,
    data: {
        response: {
            type: "message",
            payload: { delta: text, messageId, completed: false },
        },
        convoId: "convo-1",
    },
});

/** A whole value: the last event of a message, or anything replayed after a reconnect. */
const whole = (text: string, completed = true, messageId = "m1") => ({
    success: true,
    data: {
        response: {
            type: "message",
            payload: { message: text, messageId, completed },
            metadata: METADATA,
        },
        convoId: "convo-1",
    },
});

const reasoningDelta = (text: string) => ({
    success: true,
    data: {
        response: {
            type: "reasoning",
            payload: { delta: text, reasoningId: "t1", completed: false },
        },
        convoId: "convo-1",
    },
});

const completion = () => ({
    success: true,
    data: { response: { type: "response_status", payload: { completed: true } }, convoId: "convo-1", quitStream: true },
});

/** Runs a turn against a server that streams `events`, collecting what the caller sees. */
async function collect(events: unknown[], options?: { accumulateStream?: boolean }) {
    const { server, url } = sseServer(events);

    try {
        const convo = new Conversation({
            apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat",
            ...(options ?? {}),
        });
        const received: Payload[] = [];

        await new Promise<void>((resolve) => {
            convo.send("hello", (chunk) => {
                received.push(chunk as Payload);
                if ((chunk as Payload).data.quitStream) resolve();
            });
        });

        return received;
    } finally {
        server.stop(true);
    }
}

const messages = (received: Payload[]) => received
    .filter(entry => entry.data.response?.type === "message")
    .map(entry => entry.data.response!.payload!);

describe("Streamed messages", () => {
    it("hands the caller whole messages, however they arrived", async () => {
        // The server sends each token once; `message` is still the whole answer so far,
        // which is what every consumer of this SDK already renders.
        const received = await collect([
            opening("Bond"), delta(", James"), delta(" Bond"), whole("Bond, James Bond"), completion(),
        ]);

        expect(messages(received).map(payload => payload.message)).toEqual([
            "Bond",
            "Bond, James",
            "Bond, James Bond",
            "Bond, James Bond",
        ]);
    });

    it("also says what each event added, for anyone appending", async () => {
        // Rendering the whole message per token is the client-side half of the same
        // problem, so the piece is offered as well as the whole.
        const received = await collect([opening("Bond"), delta(", James"), whole("Bond, James"), completion()]);

        expect(messages(received).map(payload => payload.delta)).toEqual([undefined, ", James", undefined]);
    });

    it("fills in the message a delta belongs to, keeping the delta itself", async () => {
        const received = await collect([opening("Bond"), delta(", James"), completion()]);
        expect(messages(received)[1]).toMatchObject({ message: "Bond, James", delta: ", James", messageId: "m1" });
    });

    it("puts back the metadata the server left off the deltas", async () => {
        // The server sends it once per message rather than on all thousand frames. A
        // caller should never know that happened.
        const received = await collect([opening("Bond"), delta(", James"), whole("Bond, James"), completion()]);
        const events = received.filter(entry => entry.data.response?.type === "message");

        expect(events.map(entry => (entry.data.response as { metadata?: unknown }).metadata))
            .toEqual([METADATA, METADATA, METADATA]);
    });

    it("does not carry metadata over from a message that has finished", async () => {
        // Ids are reused across the steps of a turn. A new message opens with its own.
        const next = { ...METADATA, responseId: "r2" };
        const reopened = { ...opening("second"), data: { ...opening("second").data, response: { ...opening("second").data.response, metadata: next } } };

        const received = await collect([opening("first"), whole("first"), reopened, completion()]);
        const events = received.filter(entry => entry.data.response?.type === "message");

        expect((events[2].data.response as { metadata?: unknown }).metadata).toEqual(next);
    });

    it("replaces rather than appends when a whole value arrives", async () => {
        // A reconnecting client is caught up with the answer so far. Appending that to
        // what it already had would duplicate half the message.
        const received = await collect([opening("half a"), whole("half a cup", false), delta(" of tea"), completion()]);

        expect(messages(received).map(payload => payload.message)).toEqual(["half a", "half a cup", "half a cup of tea"]);
    });

    it("keeps messages and reasoning apart", async () => {
        const received = await collect([opening("Bond"), reasoningDelta("thinking"), delta(", James"), completion()]);

        expect(messages(received).map(payload => payload.message)).toEqual(["Bond", "Bond, James"]);
        expect(received[1].data.response?.payload?.reasoning).toBe("thinking");
    });

    it("starts a fresh message after one has finished", async () => {
        // Ids are reused across the steps of a turn, so a finished message must not leave
        // its text behind for the next one to be appended to.
        const received = await collect([opening("first"), whole("first"), opening("second"), completion()]);

        expect(messages(received).map(payload => payload.message)).toEqual(["first", "first", "second"]);
    });

    it("hands over the wire payloads untouched when asked to", async () => {
        // For a caller that appends anyway and wants nothing between it and the socket.
        const received = await collect([opening("Bond"), delta(", James"), completion()], { accumulateStream: false });

        expect(messages(received)).toEqual([
            { message: "Bond", messageId: "m1", completed: false },
            { delta: ", James", messageId: "m1", completed: false },
        ]);

        // Including the bare deltas, metadata and all — or rather, metadata and none.
        const bare = received.filter(entry => entry.data.response?.type === "message");
        expect((bare[1].data.response as { metadata?: unknown }).metadata).toBeUndefined();
    });

    it("resolves ask() with the finished reply either way", async () => {
        const events = [opening("Good"), delta(" day"), whole("Good day"), completion()];

        const { server, url } = sseServer(events);
        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: url, convoPath: "/chat" });
            expect((await convo.ask("hello")).text).toBe("Good day");
        } finally {
            server.stop(true);
        }

        const raw = sseServer(events);
        try {
            const convo = new Conversation({ apiKey: "ap-abc_123", serverUrl: raw.url, convoPath: "/chat", accumulateStream: false });
            expect((await convo.ask("hello")).text).toBe("Good day");
        } finally {
            raw.server.stop(true);
        }
    });
});

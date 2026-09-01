import { describe, expect, it } from "bun:test";

import { Conversation } from "../modules/conversation";
import { ConversationEvent } from "../types/response/v5";
import { createLinkHarness, FakeSocket, flush } from "./support/fake_link";

// =============================================
// HELPERS
// =============================================

type Payload = {
    success: boolean;
    data: {
        response?: { type: string; payload?: Record<string, unknown>; metadata?: { participantId?: string; model?: string } };
        convoId?: string;
        quitStream?: boolean;
        code?: string;
        error?: string;
        message?: string;
    };
};

const messageEvent = (message: string, completed = false): ConversationEvent => ({
    type: "message",
    payload: { message, messageId: "m1", completed },
    metadata: { responseId: "r1", model: "GPT-5", modelId: "openai/gpt-5", timestamp: 1, firstTimestamp: 1, participantId: "alfred" },
} as ConversationEvent);

const completionEvent = (): ConversationEvent => ({
    type: "response_status",
    payload: { completed: true },
    metadata: { responseId: "r1", model: "GPT-5", modelId: "openai/gpt-5", timestamp: 2, firstTimestamp: 1, participantId: "alfred" },
} as ConversationEvent);

/** A conversation carried over a link, with the socket exposed for driving it. */
async function linkedConversation(options: { convoId?: string } = {}) {
    const harness = createLinkHarness();
    const socket = await harness.connect();

    const convo = new Conversation({
        apiKey: "ap-abc_123",
        transport: harness.link,
        ...(options.convoId ? { convoId: options.convoId } : {}),
    });

    return { ...harness, socket, convo };
}

/** Answers `conversation.start` the way the server would. */
async function openSession(socket: FakeSocket, sessionId = "sess-1", chatId?: string) {
    await flush();
    const start = socket.ofType("conversation.start").at(-1);
    if (!start) throw new Error("no conversation.start was sent");

    socket.push("conversation.open", { sessionId, ...(chatId ? { chatId } : {}) }, start.id);
    await flush();

    const chat = socket.ofType("conversation.chat").at(-1);
    if (!chat) throw new Error("no conversation.chat was sent");
    return chat;
}

// =============================================
// A TURN OVER A LINK
// =============================================

describe("Conversations over a link", () => {
    it("opens a session, streams the turn, and ends the stream", async () => {
        const { socket, convo } = await linkedConversation();

        const received: Payload[] = [];
        convo.send("hello there", (chunk) => received.push(chunk as Payload));

        const chat = await openSession(socket, "sess-1");
        expect(chat.payload).toMatchObject({ sessionId: "sess-1", message: "hello there" });

        socket.push("conversation.event", { chatId: "convo-1", event: messageEvent("Good") }, chat.id);
        socket.push("conversation.event", { chatId: "convo-1", event: messageEvent("Good day", true) }, chat.id);
        socket.push("conversation.event", { chatId: "convo-1", event: completionEvent() }, chat.id);
        socket.push("conversation.done", { chatId: "convo-1", ok: true }, chat.id);
        await flush();

        // The same envelope the HTTP transport produces, in the same order: which
        // conversation this is, then the reply, then the end of the stream.
        expect(received.map(entry => entry.data.response?.type))
            .toEqual(["convo_status", "message", "message", "response_status"]);
        expect(received[0].data.response?.payload).toEqual({ state: "started" });
        expect(received.at(-1)!.data.quitStream).toBe(true);
        expect(received.every(entry => entry.data.convoId === "convo-1")).toBe(true);
    });

    it("learns the conversation id and reports it once", async () => {
        // A new conversation has no id until its first turn begins, so this is how a
        // caller gets one to resume later.
        const { socket, convo } = await linkedConversation();

        const seen: string[] = [];
        convo.onConvoId((convoId) => seen.push(convoId));
        convo.send("hello", () => undefined);

        const chat = await openSession(socket);
        socket.push("conversation.event", { chatId: "convo-1", event: messageEvent("Hi", true) }, chat.id);
        socket.push("conversation.done", { chatId: "convo-1", ok: true }, chat.id);
        await flush();

        expect(seen).toEqual(["convo-1"]);
        expect(convo.getConvoId()).toBe("convo-1");
    });

    it("continues the same conversation on the next turn", async () => {
        const { socket, convo } = await linkedConversation();

        convo.send("first", () => undefined);
        const first = await openSession(socket);
        socket.push("conversation.done", { chatId: "convo-1", ok: true }, first.id);
        await flush();

        convo.send("second", () => undefined);
        await flush();

        // One session for both turns, and the second turn names the conversation.
        expect(socket.ofType("conversation.start")).toHaveLength(1);
        expect(socket.ofType("conversation.chat").at(-1)!.payload).toMatchObject({ sessionId: "sess-1", message: "second" });
    });

    it("continues an existing conversation it was constructed with", async () => {
        const { socket, convo } = await linkedConversation({ convoId: "convo-existing" });

        convo.send("hello again", () => undefined);
        await flush();

        expect(socket.ofType("conversation.start")[0].payload).toMatchObject({ chatId: "convo-existing" });
    });

    it("passes the conversation's configuration to the session", async () => {
        const { socket, convo } = await linkedConversation();
        convo.setModel("GPT-5").setPersonality("You are a barista").setInstructions("Be brief");

        convo.send("hello", () => undefined);
        await flush();

        expect(socket.ofType("conversation.start")[0].payload).toMatchObject({
            model: "GPT-5",
            personality: "You are a barista",
            instructions: "Be brief",
        });
    });

    it("presents a notice the way the HTTP transport does", async () => {
        // Alfred's own remarks are not part of conversation state, but a consumer that
        // switched transport should not need a special case for them.
        const { socket, convo } = await linkedConversation();

        const received: Payload[] = [];
        convo.send("hello", (chunk) => received.push(chunk as Payload));
        const chat = await openSession(socket);

        socket.push("conversation.notice", { chatId: "convo-1", message: "Switched to a model in your plan" }, chat.id);
        socket.push("conversation.done", { chatId: "convo-1", ok: true }, chat.id);
        await flush();

        const notice = received.find(entry => entry.data.response?.metadata?.participantId === "system");
        expect(notice).toBeDefined();
        expect(notice!.data.response).toMatchObject({
            type: "message",
            payload: { message: "Switched to a model in your plan", completed: true },
            metadata: { model: "System", participantId: "system" },
        });
    });

    it("reports a failed turn in the shape callers already handle", async () => {
        const { socket, convo } = await linkedConversation();

        const received: Payload[] = [];
        convo.send("hello", (chunk) => received.push(chunk as Payload));
        const chat = await openSession(socket);

        socket.push("conversation.done", {
            chatId: "convo-1",
            ok: false,
            code: "turn_failed",
            error: "DG_OVER_DAY_USAGE",
            message: "I'm terribly sorry, but it appears you've reached your daily usage limit.",
        }, chat.id);
        await flush();

        const failure = received.find(entry => !entry.success)!;
        // `code` is the dialogue code, as it is over SSE — not the link's own
        // classification of it.
        expect(failure.data).toMatchObject({
            code: "DG_OVER_DAY_USAGE",
            message: "I'm terribly sorry, but it appears you've reached your daily usage limit.",
            quitStream: true,
        });
    });

    it("ends the stream even when the turn produced no completion event", async () => {
        const { socket, convo } = await linkedConversation();

        const received: Payload[] = [];
        convo.send("hello", (chunk) => received.push(chunk as Payload));
        const chat = await openSession(socket);

        socket.push("conversation.done", { chatId: "convo-1", ok: true }, chat.id);
        await flush();

        expect(received.at(-1)!.data).toMatchObject({ quitStream: true, response: { type: "response_status" } });
    });

    it("reopens a session the server has forgotten and delivers the message anyway", async () => {
        // Sessions die with the connection they were opened on. The message had not
        // been delivered yet, so retrying is invisible rather than a lost turn.
        const { socket, convo } = await linkedConversation();

        const received: Payload[] = [];
        convo.send("hello", (chunk) => received.push(chunk as Payload));

        const first = await openSession(socket, "sess-1");
        socket.push("conversation.done", { ok: false, code: "unknown_session", error: "No such session." }, first.id);
        await flush();

        const second = await openSession(socket, "sess-2");
        expect(second.payload).toMatchObject({ sessionId: "sess-2", message: "hello" });

        socket.push("conversation.event", { chatId: "convo-1", event: messageEvent("Hi", true) }, second.id);
        socket.push("conversation.done", { chatId: "convo-1", ok: true }, second.id);
        await flush();

        // No failure ever reached the caller.
        expect(received.some(entry => !entry.success)).toBe(false);
        expect(received.some(entry => entry.data.response?.type === "message")).toBe(true);
    });

    it("stops delivering once the caller closes the stream", async () => {
        const { socket, convo } = await linkedConversation();

        const received: Payload[] = [];
        const stream = convo.send("hello", (chunk) => received.push(chunk as Payload));
        const chat = await openSession(socket);

        stream.close();
        socket.push("conversation.event", { chatId: "convo-1", event: messageEvent("Hi", true) }, chat.id);
        socket.push("conversation.done", { chatId: "convo-1", ok: true }, chat.id);
        await flush();

        expect(received).toEqual([]);
    });

    it("reports a dropped connection to the caller", async () => {
        const { socket, convo } = await linkedConversation();

        const received: Payload[] = [];
        convo.send("hello", (chunk) => received.push(chunk as Payload));
        await openSession(socket);

        socket.drop();
        await flush();

        expect(received.at(-1)).toMatchObject({ success: false, data: { code: "disconnected", quitStream: true } });
    });
});

// =============================================
// ASK
// =============================================

describe("Conversation.ask", () => {
    it("resolves with the finished reply", async () => {
        const { socket, convo } = await linkedConversation();

        const asking = convo.ask("hello there");
        const chat = await openSession(socket);

        socket.push("conversation.event", { chatId: "convo-1", event: messageEvent("Good") }, chat.id);
        socket.push("conversation.event", { chatId: "convo-1", event: messageEvent("Good day", true) }, chat.id);
        socket.push("conversation.event", { chatId: "convo-1", event: completionEvent() }, chat.id);
        socket.push("conversation.done", { chatId: "convo-1", ok: true }, chat.id);

        const answer = await asking;
        expect(answer.text).toBe("Good day");
        expect(answer.convoId).toBe("convo-1");
    });

    it("leaves Alfred's notices out of the reply text", async () => {
        const { socket, convo } = await linkedConversation();

        const asking = convo.ask("hello");
        const chat = await openSession(socket);

        socket.push("conversation.notice", { chatId: "convo-1", message: "Switched model" }, chat.id);
        socket.push("conversation.event", { chatId: "convo-1", event: messageEvent("Good day", true) }, chat.id);
        socket.push("conversation.event", { chatId: "convo-1", event: completionEvent() }, chat.id);
        socket.push("conversation.done", { chatId: "convo-1", ok: true }, chat.id);

        const answer = await asking;
        expect(answer.text).toBe("Good day");
        // Still delivered, just not part of what Alfred said.
        expect(answer.events.some(event => (event as Payload).data.response?.metadata?.participantId === "system")).toBe(true);
    });

    it("rejects when the turn fails", async () => {
        const { socket, convo } = await linkedConversation();

        const asking = convo.ask("hello");
        const chat = await openSession(socket);

        socket.push("conversation.done", {
            ok: false, code: "turn_failed", error: "DG_OVER_DAY_USAGE", message: "You've reached your daily usage limit.",
        }, chat.id);

        await expect(asking).rejects.toThrow("You've reached your daily usage limit.");
    });
});

// =============================================
// WATCHING A TURN SOMEONE ELSE STARTED
// =============================================

describe("Watching a running turn over a link", () => {
    it("follows the turn over the link instead of opening an SSE stream", async () => {
        // Reopening a conversation mid-answer is watching a turn, not starting one. It used
        // to always drop to SSE, so a client that had chosen the websocket transport ended up
        // with a second, differently-behaved connection for exactly the moments that matter.
        const { socket, convo } = await linkedConversation({ convoId: "convo-1" });

        const received: Payload[] = [];
        convo.fetchProgressStream((chunk) => received.push(chunk as Payload));
        await flush();

        const attach = socket.ofType("conversation.attach").at(-1);
        expect(attach?.payload).toMatchObject({ chatId: "convo-1" });
        // Nothing was started: watching is not speaking.
        expect(socket.ofType("conversation.start")).toHaveLength(0);
        expect(socket.ofType("conversation.chat")).toHaveLength(0);

        socket.push("conversation.event", { chatId: "convo-1", eventId: "2", event: messageEvent("Half a") }, attach!.id);
        socket.push("conversation.event", { chatId: "convo-1", eventId: "3", event: messageEvent("Half a cup", true) }, attach!.id);
        socket.push("conversation.event", { chatId: "convo-1", eventId: "4", event: completionEvent() }, attach!.id);
        socket.push("conversation.done", { chatId: "convo-1", ok: true }, attach!.id);
        await flush();

        // The same envelope a turn of its own produces, so a caller renders progress
        // through the code path it already has.
        expect(received.map(entry => entry.data.response?.type)).toEqual(["message", "message", "response_status"]);
        expect(received.every(entry => entry.data.convoId === "convo-1")).toBe(true);
        expect(received.at(-1)!.data.quitStream).toBe(true);
    });

    it("asks only for what it does not already have", async () => {
        const { socket, convo } = await linkedConversation({ convoId: "convo-1" });

        convo.fetchProgressStream(() => undefined, { afterEventId: "7" });
        await flush();

        expect(socket.ofType("conversation.attach").at(-1)!.payload).toMatchObject({ chatId: "convo-1", afterEventId: "7" });
    });

    it("ends quietly when nothing is running", async () => {
        // An idle conversation is the ordinary answer here, not a failure to report to a user.
        const { socket, convo } = await linkedConversation({ convoId: "convo-1" });

        const received: Payload[] = [];
        convo.fetchProgressStream((chunk) => received.push(chunk as Payload));
        await flush();

        const attach = socket.ofType("conversation.attach").at(-1)!;
        socket.push("conversation.done", { chatId: "convo-1", ok: false, code: "no_active_turn", error: "Nothing is running." }, attach.id);
        await flush();

        expect(received).toEqual([]);
    });

    it("reports a refusal the way every other failure is reported", async () => {
        const { socket, convo } = await linkedConversation({ convoId: "convo-1" });

        const received: Payload[] = [];
        convo.fetchProgressStream((chunk) => received.push(chunk as Payload));
        await flush();

        const attach = socket.ofType("conversation.attach").at(-1)!;
        socket.push("conversation.done", {
            chatId: "convo-1", ok: false, code: "forbidden_scope", error: "That conversation is not yours.",
        }, attach.id);
        await flush();

        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ success: false, data: { code: "forbidden_scope" } });
    });

    it("tells the server when it stops watching", async () => {
        // The turn keeps running server-side; this connection just stops hearing it.
        const { socket, convo } = await linkedConversation({ convoId: "convo-1" });

        const received: Payload[] = [];
        const stream = convo.fetchProgressStream((chunk) => received.push(chunk as Payload));
        await flush();

        const attach = socket.ofType("conversation.attach").at(-1)!;
        stream.close();
        await flush();

        expect(socket.ofType("conversation.detach").at(-1)!.payload).toMatchObject({ chatId: "convo-1" });

        socket.push("conversation.event", { chatId: "convo-1", eventId: "9", event: messageEvent("kept going") }, attach.id);
        await flush();
        expect(received).toEqual([]);
    });
});

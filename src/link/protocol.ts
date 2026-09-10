import { ConversationEvent } from "../types/response/v5";

/**
 * LINK WIRE PROTOCOL (client side)
 * ===============================
 *
 * The mirror of the server's protocol definition. Every frame is an envelope:
 * `{ v, id, type, replyTo?, payload }`, where `replyTo` carries the id of the
 * frame being answered — that is what makes request/response work over a stream.
 *
 * Keep this in step with the server. Fields are only ever added, never
 * repurposed, so an older SDK stays correct against a newer server.
 */
export const LINK_PROTOCOL_VERSION = 1;

// =============================================
// CLIENT → SERVER
// =============================================

export type LinkToolDescriptor = {
    localId: string;
    description: string;
    inputSchema: Record<string, unknown>;
    display?: {
        name: string;
        shortDescription: string;
        longDescription: string;
    };
    defaultEnabled?: boolean;
    platforms?: string[];
    timeoutMs?: number;
};

/**
 * An agent as declared to the server: a prompt, a model and the tools it works with.
 *
 * The tools travel inside the agent because that is what places them: reachable through the
 * agent only, never from a chat directly.
 */
export type LinkAgentDescriptor = {
    localId: string;
    name: string;
    description: string;
    prompt: string;
    model?: string;
    tools: Omit<LinkToolDescriptor, "platforms">[];
    display?: LinkToolDescriptor["display"];
    defaultEnabled?: boolean;
};

export type LinkHookEventDeclaration = {
    name: string;
    description?: string;
    /** Field name to human description, shown to whoever configures the hook. */
    payloadShape?: Record<string, string>;
};

export type LinkHookDeclaration = {
    localId: string;
    name: string;
    description: string;
    argsSchema: Record<string, unknown>;
    events: LinkHookEventDeclaration[];
};

export type { LinkSubscription } from "./subscriptions";
import type { LinkSubscription } from "./subscriptions";

export type LinkClientPayloads = {
    "hello": { linkId: string; client?: string; protocolVersion?: number };
    "ping": { message?: string };
    "tool.register": { tools: LinkToolDescriptor[] };
    "tool.result": { ok: true; output: unknown; cost?: number } | { ok: false; error: string };
    "tool.status": { label: string; state?: "running" | "completed" | "failed" };
    "hook.register": LinkHookDeclaration;
    "hook.emit": { sourceId: string; event: string; payload?: Record<string, unknown>; ownerId?: string };
    /**
     * An event reported against the subscriptions it matched.
     *
     * The inverted path, and the one to prefer: the server pushed a list of things to watch, this
     * client matched, and the ids say which subscriptions matched. Several ids in one frame is
     * fan-out — five reflexes watching one channel is one frame. No user is ever named.
     */
    "hook.event": {
        sourceId: string;
        subscriptionIds: string[];
        event: string;
        payload?: Record<string, unknown>;
        epoch?: number;
    };
    /** Asks for a fresh snapshot after noticing an epoch gap. */
    "hook.subscriptions.resync": { have?: number };
    "conversation.start": {
        chatId?: string;
        model?: string;
        personality?: string;
        instructions?: string;
        platform?: string;
    };
    "conversation.chat": {
        sessionId: string;
        message: string;
        model?: string;
        instructions?: string;
        personality?: string;
    };
    "conversation.end": { sessionId: string };
    /**
     * Watches a turn that is already running, without starting one.
     *
     * A turn belongs to the conversation, not to the socket that asked for it, so a
     * client that reloads or opens the conversation elsewhere can pick the answer back
     * up as it is written. `afterEventId` resumes from what the client already has.
     */
    "conversation.attach": { chatId: string; afterEventId?: string };
    /** Stops watching. The turn itself keeps running. */
    "conversation.detach": { chatId: string };
    /**
     * Stops a running turn.
     *
     * `soft` lets the model call in flight finish and takes no further step; `hard` aborts the
     * stream where it stands. A hard stop against a provider that cannot be cancelled is
     * applied as a soft one — the answer says which was applied.
     */
    "conversation.stop": { chatId: string; mode: "soft" | "hard" };
    /**
     * Says something to a turn that is still running. It reaches the model at its next step
     * boundary; the turn is not interrupted.
     */
    "conversation.steer": { chatId: string; message: string };
    "agent.register": { agents: LinkAgentDescriptor[] };
    /**
     * Talks to one of this link's agents directly. `thread` names the exchange the message
     * continues; the same thread carries the same memory.
     */
    "agent.chat": { localId: string; message: string; thread?: string };
};

export type LinkClientFrameType = keyof LinkClientPayloads;

/**
 * A union of one member per frame type, rather than one type whose `type` and
 * `payload` are both unions — otherwise checking `frame.type` narrows nothing and
 * `payload` stays a union of every payload.
 */
export type LinkClientFrame = {
    [T in LinkClientFrameType]: {
        v: number;
        id: string;
        type: T;
        replyTo?: string;
        payload: LinkClientPayloads[T];
    };
}[LinkClientFrameType];

/** One specific client frame, e.g. `LinkClientFrameOf<"tool.result">`. */
export type LinkClientFrameOf<T extends LinkClientFrameType> = Extract<LinkClientFrame, { type: T }>;

// =============================================
// SERVER → CLIENT
// =============================================

export type LinkScopeKind = "user" | "global";

export type LinkServerPayloads = {
    "welcome": { connectionId: string; linkId: string; scope: LinkScopeKind; protocolVersion: number };
    "ack": { ids?: string[]; message?: string };
    "error": { code: string; error: string; fatal?: boolean };
    "log": { log: string };
    "tool.call": {
        callId: string;
        localId: string;
        args: unknown;
        meta: { userId: string; chatId?: string; runId: string; identities?: Record<string, string> };
        timeoutMs: number;
    };
    "tool.cancel": { callId: string; reason: string };
    "conversation.open": { sessionId: string; chatId?: string };
    "conversation.event": { chatId?: string; eventId?: string; event: ConversationEvent };
    "conversation.notice": { chatId?: string; message: string };
    "conversation.done": { chatId?: string; ok: boolean; code?: string; error?: string; message?: string };
    /** A turn was stopped. `mode` is what was applied, `requestedMode` what was asked for. */
    "conversation.stopped": { chatId: string; mode: "soft" | "hard"; requestedMode: "soft" | "hard"; by: "user" | "system" };
    /** A steered message was accepted and will reach the model at its next step boundary. */
    "conversation.steered": { chatId: string };
    "goodbye": { reason: string; reconnectAfterMs: number };
    /** Progress on an `agent.chat`, in the words the agent's status feed would show a conversation. */
    "agent.status": { localId: string; label: string; state: "running" | "completed" | "failed" };
    /** The agent's reply, exactly once per `agent.chat`. */
    "agent.result":
        | { localId: string; thread: string; ok: true; output: string }
        | { localId: string; thread?: string; ok: false; code: string; error: string };
    /**
     * The full set this connection should watch, for the sources it has registered.
     *
     * `chunk` / `of` are 1-based and present only when the set was split; every chunk of one snapshot
     * carries the same `epoch`.
     */
    "hook.subscriptions": { epoch: number; chunk?: number; of?: number; subscriptions: LinkSubscription[] };
    /** An incremental change. An epoch more than one ahead means a delta was missed. */
    "hook.subscriptions.delta": { epoch: number; added?: LinkSubscription[]; removed?: string[]; updated?: LinkSubscription[] };
};

export type LinkServerFrameType = keyof LinkServerPayloads;

/** A union of one member per frame type, so `frame.type` narrows `frame.payload`. */
export type LinkServerFrame = {
    [T in LinkServerFrameType]: {
        v?: number;
        id: string;
        type: T;
        replyTo?: string;
        payload: LinkServerPayloads[T];
    };
}[LinkServerFrameType];

/** One specific server frame, e.g. `LinkServerFrameOf<"conversation.done">`. */
export type LinkServerFrameOf<T extends LinkServerFrameType> = Extract<LinkServerFrame, { type: T }>;

/** An error reported by the server, carrying the code it used. */
export class LinkError extends Error {
    constructor(readonly code: string, message: string, readonly fatal = false) {
        super(message);
        this.name = "LinkError";
    }
}

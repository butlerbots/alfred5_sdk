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
    timeoutMs?: number;
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

export type LinkClientPayloads = {
    "hello": { linkId: string; client?: string; protocolVersion?: number };
    "ping": { message?: string };
    "tool.register": { tools: LinkToolDescriptor[] };
    "tool.result": { ok: true; output: unknown; cost?: number } | { ok: false; error: string };
    "tool.status": { label: string; state?: "running" | "completed" | "failed" };
    "hook.register": LinkHookDeclaration;
    "hook.emit": { sourceId: string; event: string; payload?: Record<string, unknown>; ownerId?: string };
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
};

export type LinkClientFrameType = keyof LinkClientPayloads;

export type LinkClientFrame<T extends LinkClientFrameType = LinkClientFrameType> = {
    v: number;
    id: string;
    type: T;
    replyTo?: string;
    payload: LinkClientPayloads[T];
};

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
        meta: { userId: string; chatId?: string; runId: string };
        timeoutMs: number;
    };
    "tool.cancel": { callId: string; reason: string };
    "conversation.open": { sessionId: string; chatId?: string };
    "conversation.event": { chatId?: string; event: ConversationEvent };
    "conversation.notice": { chatId?: string; message: string };
    "conversation.done": { chatId?: string; ok: boolean; code?: string; error?: string; message?: string };
    "goodbye": { reason: string; reconnectAfterMs: number };
};

export type LinkServerFrameType = keyof LinkServerPayloads;

export type LinkServerFrame<T extends LinkServerFrameType = LinkServerFrameType> = {
    v?: number;
    id: string;
    type: T;
    replyTo?: string;
    payload: LinkServerPayloads[T];
};

/** Narrows a received frame to one type, for use in handlers. */
export function isFrameOfType<T extends LinkServerFrameType>(
    frame: LinkServerFrame,
    type: T,
): frame is LinkServerFrame<T> {
    return frame.type === type;
}

/** An error reported by the server, carrying the code it used. */
export class LinkError extends Error {
    constructor(readonly code: string, message: string, readonly fatal = false) {
        super(message);
        this.name = "LinkError";
    }
}

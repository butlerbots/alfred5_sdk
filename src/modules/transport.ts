/**
 * CONVERSATION TRANSPORTS
 * =======================
 *
 * A conversation is the same conversation however it is carried. The transport
 * only decides how a turn is sent and how its stream comes back — everything a
 * caller sees, including the payload shape, is identical either way.
 */

import type { ConversationAddress } from "../types/conversation/address";
import type { MessageContextItem } from "../types/conversation/context";

/** A turn in progress. */
export type ConversationStream = {
    /**
     * Stops listening. The turn itself continues server-side and its reply is still
     * persisted, on both transports — this is not a cancel. To actually stop the turn,
     * use `Conversation.stop()`.
     */
    close(): void;
    /** The underlying EventSource, when the turn is being carried over SSE. */
    readonly source?: unknown;
};

/**
 * How hard to stop a turn.
 *
 * - `soft`: let the model call in flight finish, then stop. Keeps the text, costs what that
 *   step cost, and works everywhere. The right default for a stop button.
 * - `hard`: abort the stream mid-sentence and every tool with it. Only stops the bill on
 *   providers that support cancellation; against one that does not the server applies a soft
 *   stop instead, rather than throwing away output that is billed either way. Check the
 *   `mode` you get back to see which happened.
 */
export type TurnStopMode = "soft" | "hard";

/** A stop, as the server applied it. */
export type TurnStopped = {
    /** What was applied. */
    mode: TurnStopMode;
    /** What was asked for. Differs from `mode` when a hard stop was downgraded. */
    requestedMode: TurnStopMode;
    by: "user" | "system";
};

/**
 * What became of a message steered into a running turn.
 *
 * `too_late` is the one that matters: the turn was already stopping or finished, the message
 * was NOT delivered, and it should be sent as an ordinary turn instead. Never drop it.
 */
export type SteerResult = { ok: true } | { ok: false; reason: "no_turn" | "too_late" };

export type TransportTurnRequest = {
    chatId?: string;
    message: string;
    model?: string;
    instructions?: string;
    platform?: string;
    /** Where on the platform the conversation is: on Discord, the channel and thread. */
    address?: ConversationAddress;
    personality?: string;
    /** Why Alfred is speaking on this one turn: a line for its system prompt, at most 500 characters. */
    wake?: string;
    /** Tools switched on for this one turn, by id. Sent only when non-empty; see `DialogueRequestParams.tools`. */
    tools?: string[];
    /** What the platform attaches beside this turn's message. Sent only when non-empty. */
    context?: MessageContextItem[];
    /** Further turn parameters, forwarded to the server verbatim. See `DialogueRequestParams.extra`. */
    extra?: Record<string, string>;
};

/**
 * The turn parameters the server reads by name, which a transport sends itself. An `extra`
 * entry may not use one: it would replace what the transport sent, or, for `api_key`, the
 * credential. Both transports refuse the same list, since over a Link the service spreads
 * `extra` into the very query the SSE transport builds.
 */
export const RESERVED_TURN_FIELDS: readonly string[] = [
    "api_key",
    "message",
    "chatId",
    "model",
    "instructions",
    "platform",
    "address",
    "personality",
    "wake",
    "tools",
    "context",
];

/**
 * A turn's `extra`, checked, or nothing when there is none to send. Throws on a key that
 * collides with a field the transport sends, and on a value that is not a string, before
 * anything reaches the wire.
 */
export function turnExtra(extra: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!extra) return undefined;

    const entries = Object.entries(extra);
    if (entries.length === 0) return undefined;

    for (const [key, value] of entries) {
        if (!key) throw new Error("A turn's `extra` may not have an empty key.");
        if (RESERVED_TURN_FIELDS.includes(key)) {
            throw new Error(`A turn's \`extra\` may not set "${key}": the transport already sends it. Reserved: ${RESERVED_TURN_FIELDS.join(", ")}.`);
        }
        if (typeof value !== "string") {
            throw new Error(`A turn's \`extra\` values must be strings; "${key}" is ${typeof value}.`);
        }
    }

    return Object.fromEntries(entries);
}

/** A turn's context as it travels, JSON-encoded, or nothing when there is none. */
export function turnContext(context: MessageContextItem[] | undefined): string | undefined {
    return context && context.length > 0 ? JSON.stringify(context) : undefined;
}

/**
 * A turn's tools as they travel: the ids trimmed, emptied ones dropped, repeats folded, joined
 * with commas; nothing when none is left. A comma in an id would read as two ids, so one is
 * refused before anything is sent.
 */
export function turnTools(tools: string[] | undefined): string | undefined {
    if (!tools || tools.length === 0) return undefined;
    const ids: string[] = [];
    for (const raw of tools) {
        if (typeof raw !== "string") throw new Error(`A turn's \`tools\` are tool ids; one is ${typeof raw}.`);
        const id = raw.trim();
        if (!id) continue;
        if (id.includes(",")) throw new Error(`A turn's \`tools\` entry may not contain a comma: "${id}".`);
        if (!ids.includes(id)) ids.push(id);
    }
    return ids.length > 0 ? ids.join(",") : undefined;
}

export type TransportHandlers = {
    /** One payload of the stream, already in the shape callers expect. */
    payload(payload: unknown): void;
    /** The conversation this turn belongs to, as soon as it is known. */
    convoId(convoId: string): void;
};

/** A request to watch a turn that is already running in a conversation. */
export type TransportAttachRequest = {
    chatId: string;
    /** Resume point: only what came after this event is replayed. */
    afterEventId?: string;
};

/** A request to interrupt a turn that is already running. */
export type TransportStopRequest = {
    chatId: string;
    mode: TurnStopMode;
};

export type TransportSteerRequest = {
    chatId: string;
    message: string;
};

export interface ConversationTransport {
    send(request: TransportTurnRequest, handlers: TransportHandlers): ConversationStream;

    /**
     * Stops the turn running in a conversation.
     *
     * Resolves `undefined` when there was nothing to stop — the turn finished on its own, or
     * never started. That is not an error: it is the answer to pressing stop a moment too late.
     */
    stop?(request: TransportStopRequest): Promise<TurnStopped | undefined>;

    /**
     * Says something to a turn that is still running, to be read at its next step boundary.
     *
     * The turn is not interrupted: work in flight finishes and the model reads the message as
     * the user talking mid-task.
     */
    steer?(request: TransportSteerRequest): Promise<SteerResult>;

    /**
     * Watches a turn that is already running, without starting one.
     *
     * Optional: a transport that cannot follow someone else's turn simply does not
     * implement it, and the conversation falls back to the HTTP progress stream.
     */
    attach?(request: TransportAttachRequest, handlers: TransportHandlers): ConversationStream;
}

// =============================================
// PAYLOAD SHAPES
// =============================================

/**
 * The system message form the HTTP transport uses for a notice.
 *
 * Alfred's own remarks — a forced model switch, a tier limit — are not part of
 * conversation state and won't be in history. Both transports present them the same
 * way so a consumer needs no special case.
 */
export function noticePayload(message: string, convoId?: string) {
    const messageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    return {
        success: true as const,
        data: {
            response: {
                type: "message",
                payload: { message, messageId, completed: true },
                metadata: {
                    responseId: messageId,
                    model: "System",
                    modelId: "system",
                    timestamp: Date.now(),
                    firstTimestamp: Date.now(),
                    participantId: "system",
                },
            },
            ...(convoId ? { convoId } : {}),
        },
    };
}

/** The first payload of a turn: which conversation it landed in. */
export function convoStartedPayload(convoId: string) {
    return {
        success: true as const,
        data: {
            response: { type: "convo_status", payload: { state: "started" } },
            convoId,
        },
    };
}

/** The terminal payload of a turn that produced no completion event of its own. */
export function completedPayload(convoId?: string) {
    return {
        success: true as const,
        data: {
            response: { type: "response_status", payload: { completed: true } },
            ...(convoId ? { convoId } : {}),
            quitStream: true,
        },
    };
}

export function failurePayload(code: string, error: string, message: string, convoId?: string) {
    return {
        success: false as const,
        data: {
            code,
            error,
            message,
            ...(convoId ? { convoId } : {}),
            quitStream: true,
        },
    };
}

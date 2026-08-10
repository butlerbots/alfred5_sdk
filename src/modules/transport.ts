/**
 * CONVERSATION TRANSPORTS
 * =======================
 *
 * A conversation is the same conversation however it is carried. The transport
 * only decides how a turn is sent and how its stream comes back — everything a
 * caller sees, including the payload shape, is identical either way.
 */

/** A turn in progress. `close()` stops delivery locally. */
export type ConversationStream = {
    /**
     * Stops listening. The turn itself continues server-side and its reply is still
     * persisted, on both transports — there is no cancel.
     */
    close(): void;
    /** The underlying EventSource, when the turn is being carried over SSE. */
    readonly source?: unknown;
};

export type TransportTurnRequest = {
    chatId?: string;
    message: string;
    model?: string;
    instructions?: string;
    platform?: string;
    personality?: string;
};

export type TransportHandlers = {
    /** One payload of the stream, already in the shape callers expect. */
    payload(payload: unknown): void;
    /** The conversation this turn belongs to, as soon as it is known. */
    convoId(convoId: string): void;
};

export interface ConversationTransport {
    send(request: TransportTurnRequest, handlers: TransportHandlers): ConversationStream;
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

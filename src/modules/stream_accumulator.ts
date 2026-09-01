/**
 * STREAM ACCUMULATION
 * ===================
 *
 * The server streams text a piece at a time.
 *
 * It used to send the whole message again on every token, which is O(N²) bytes for an
 * N-token reply — slow everywhere, and fatal on a Link websocket, where the answer queues
 * ahead of the connection's own heartbeat until this SDK closes it mid-sentence. A
 * streamed value now arrives as one of two shapes, and never both:
 *
 *     { messageId, message: "Good day to you", completed }   // the whole value: replace
 *     { messageId, delta: " to you", completed: false }      // what was added: append
 *
 * Deltas are also sent bare: no metadata block, since it is the same on every frame of a
 * message and several times the size of the few characters a delta carries. The frame that
 * opens a message brings it, and the one that finishes it brings it again.
 *
 * Callers should not have to care about any of that. This puts the message back together,
 * so `payload.message` is the whole message so far exactly as it always was, restores the
 * metadata onto every event, and keeps `payload.delta` for anyone who would rather append
 * than re-render.
 *
 * Whole values arrive for the last event of a message and for anything replaying after a
 * reconnect, and they replace rather than extend. That is what makes a reconnect cheap and
 * a dropped delta harmless, and it is handled here so no caller has to know about it.
 */

/** What a streamed value looks like on the wire: one of the two shapes, plus its id. */
type StreamedPayload = {
    messageId?: string;
    reasoningId?: string;
    message?: string;
    reasoning?: string;
    delta?: string;
    completed?: boolean;
};

type StreamedEvent = { type?: string; payload?: StreamedPayload; metadata?: unknown };

type StreamedResponse = { success?: boolean; data?: { response?: StreamedEvent } };

/** Which field of a payload holds the streamed text, and what identifies it. */
const STREAMED_FIELDS = {
    message: { id: "messageId", text: "message" },
    reasoning: { id: "reasoningId", text: "reasoning" },
} as const;

/**
 * Rebuilds whole values from a stream of pieces.
 *
 * Stateful, and one per stream: it holds what every message the stream is still writing
 * has said so far, so a turn and a progress stream never see each other's.
 */
export function createStreamAccumulator(): (payload: unknown) => unknown {
    /** Text so far and the metadata it was opened with, per streamed id. */
    const values = new Map<string, { text: string; metadata?: unknown }>();

    return (payload: unknown): unknown => {
        const response = payload as StreamedResponse;
        const event = response?.data?.response;
        const fields = event?.type ? STREAMED_FIELDS[event.type as keyof typeof STREAMED_FIELDS] : undefined;
        if (!event?.payload || !fields) return payload;

        const id = event.payload[fields.id];
        if (typeof id !== "string") return payload;

        // Which field is there is the whole discriminant — never `completed`, which says
        // nothing about the shape: a whole value arrives incomplete whenever this client is
        // being caught up in the middle of a message.
        const { delta } = event.payload;
        const whole = event.payload[fields.text];

        if (typeof delta !== "string" && typeof whole !== "string") return payload;

        const held = values.get(id);
        const text = typeof delta === "string" ? (held?.text ?? "") + delta : whole as string;

        // Deltas are sent without metadata, because it is identical on every frame of a
        // message and many times the size of the text. The frame that opened the message
        // carried it, so it is remembered here and handed back on every event — a caller
        // sees it throughout, exactly as when the server repeated it a thousand times.
        const metadata = event.metadata ?? held?.metadata;

        // A finished value is the last anyone will hear of that id. Holding it would only
        // leak, and ids are reused across the steps of a turn.
        if (event.payload.completed) values.delete(id);
        else values.set(id, { text, metadata });

        return {
            ...response,
            data: {
                ...response.data,
                response: {
                    ...event,
                    ...(metadata !== undefined ? { metadata } : {}),
                    payload: {
                        ...event.payload,
                        [fields.text]: text,
                        // Kept as it came: present means this event appended, absent means it
                        // replaced. Callers rendering incrementally read exactly this.
                        ...(typeof delta === "string" ? { delta } : {}),
                    },
                },
            },
        };
    };
}

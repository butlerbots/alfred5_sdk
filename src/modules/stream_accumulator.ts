/**
 * STREAM ACCUMULATION
 * ===================
 *
 * The server streams text a piece at a time.
 *
 * It used to send the whole answer again on every token, which is O(N²) bytes for an
 * N-token reply — slow everywhere, and fatal on a Link websocket, where the answer queues
 * ahead of the connection's own heartbeat until the client gives up on it. Now each event
 * carries only what it added, marked `chunk: "delta"`.
 *
 * Callers should not have to care. This puts the message back together, so
 * `payload.message` is the whole message so far exactly as it always was, and adds
 * `payload.delta` for anyone who would rather append than re-render.
 *
 * Values still arrive whole in two cases — the last event of a message, and anything
 * replayed after a reconnect — and those replace what came before rather than extending
 * it. That is what makes a reconnect cheap and a dropped delta harmless, and it is handled
 * here so no caller has to know about it.
 */

type StreamedPayload = {
    messageId?: string;
    reasoningId?: string;
    message?: string;
    reasoning?: string;
    delta?: string;
    chunk?: "delta";
    completed?: boolean;
};

type StreamedEvent = { type?: string; payload?: StreamedPayload };

type StreamedResponse = { success?: boolean; data?: { response?: StreamedEvent } };

/** Which field of a payload holds the streamed text, and what identifies it. */
const STREAMED_FIELDS = {
    message: { id: "messageId", text: "message" },
    reasoning: { id: "reasoningId", text: "reasoning" },
} as const;

/**
 * Rebuilds whole values from a stream of deltas.
 *
 * Stateful, and one per stream: it holds the text of every message the stream is still
 * writing, so a turn and a progress stream never see each other's.
 */
export function createStreamAccumulator(): (payload: unknown) => unknown {
    const values = new Map<string, string>();

    return (payload: unknown): unknown => {
        const response = payload as StreamedResponse;
        const event = response?.data?.response;
        const fields = event?.type ? STREAMED_FIELDS[event.type as keyof typeof STREAMED_FIELDS] : undefined;
        if (!event?.payload || !fields) return payload;

        const id = event.payload[fields.id];
        const text = event.payload[fields.text];
        if (typeof id !== "string" || typeof text !== "string") return payload;

        const { chunk, ...rest } = event.payload;
        const isDelta = chunk === "delta";
        const whole = isDelta ? (values.get(id) ?? "") + text : text;

        // A finished value is the last anyone will hear of that id. Holding it would only
        // leak, and ids are reused across the steps of a turn.
        if (event.payload.completed) values.delete(id);
        else values.set(id, whole);

        return {
            ...response,
            data: {
                ...response.data,
                response: {
                    ...event,
                    payload: {
                        ...rest,
                        [fields.text]: whole,
                        // Only when this event actually added something: absent means "replace",
                        // which is what a replayed snapshot is.
                        ...(isDelta ? { delta: text } : {}),
                    },
                },
            },
        };
    };
}

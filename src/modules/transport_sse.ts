import { EventSource } from "eventsource";

import { formatURL } from "../util/url_formatter";
import { ConversationStream, ConversationTransport, TransportHandlers, TransportTurnRequest } from "./transport";

type StreamOptions = {
    debug?: boolean;
    onPayload(payload: { success: boolean; data?: { convoId?: string; quitStream?: boolean } }): void;
};

/**
 * Streams a server-sent-events endpoint, closing when the server says the stream is
 * done. Shared by turns and by the progress stream, which is SSE-only.
 */
export function streamSSE(url: string, options: StreamOptions): EventSource {
    const sse = new EventSource(url);

    sse.addEventListener("message", (event) => {
        const payload = JSON.parse(event.data) as { success: boolean; data?: { convoId?: string; quitStream?: boolean } };
        options.onPayload(payload);
        if (payload.data?.quitStream) sse.close();
    });

    sse.addEventListener("error", (event) => {
        if (options.debug) console.warn(`[Stream Error: ${url}]`, event);
    });

    return sse;
}

/** Carries a turn over the HTTP chat endpoint. The default. */
export class SSEConversationTransport implements ConversationTransport {
    constructor(private readonly config: { endpoint(): string; apiKey: string; debug?: boolean }) { }

    send(request: TransportTurnRequest, handlers: TransportHandlers): ConversationStream {
        const url = formatURL(this.config.endpoint(), asQuery(request), { apiKey: this.config.apiKey, debug: this.config.debug });

        const sse = streamSSE(url, {
            debug: this.config.debug,
            onPayload: (payload) => {
                const convoId = payload.success ? payload.data?.convoId : undefined;
                if (convoId) handlers.convoId(convoId);
                handlers.payload(payload);
            },
        });

        return { close: () => sse.close(), source: sse };
    }
}

function asQuery(request: TransportTurnRequest): Record<string, string> {
    const query: Record<string, string> = { message: request.message };

    if (request.chatId) query.chatId = request.chatId;
    if (request.model) query.model = request.model;
    if (request.instructions) query.instructions = request.instructions;
    if (request.platform) query.platform = request.platform;
    if (request.personality) query.personality = request.personality;

    return query;
}

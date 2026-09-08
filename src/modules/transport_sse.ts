import { EventSource } from "eventsource";

import { formatURL } from "../util/url_formatter";
import {
    ConversationStream,
    ConversationTransport,
    SteerResult,
    TransportHandlers,
    TransportSteerRequest,
    TransportStopRequest,
    TransportTurnRequest,
    TurnStopped,
} from "./transport";

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
    constructor(private readonly config: {
        endpoint(): string;
        stopEndpoint?(): string;
        steerEndpoint?(): string;
        apiKey: string;
        debug?: boolean;
    }) { }

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

    /**
     * The turn is a GET that streams until it is done, so an interruption cannot travel on the
     * same request and gets one of its own.
     *
     * Closing the stream is deliberately not a stop: a reload, a backgrounded tab or a
     * reconnect all drop the connection and all expect to pick the answer back up.
     */
    async stop(request: TransportStopRequest): Promise<TurnStopped | undefined> {
        const endpoint = this.config.stopEndpoint?.();
        if (!endpoint) return undefined;

        const response = await this.post(endpoint, { chatId: request.chatId, mode: request.mode });
        // 404 is "nothing was running", which is the ordinary answer to stopping a moment late.
        if (!response || response.status === 404) return undefined;

        const body = await response.json().catch(() => undefined) as { stop?: TurnStopped } | undefined;
        return body?.stop;
    }

    async steer(request: TransportSteerRequest): Promise<SteerResult> {
        const endpoint = this.config.steerEndpoint?.();
        if (!endpoint) return { ok: false, reason: "no_turn" };

        const response = await this.post(endpoint, { chatId: request.chatId, message: request.message });
        if (!response) return { ok: false, reason: "no_turn" };
        if (response.ok) return { ok: true };

        // 409: the turn is no longer accepting messages. The caller still has something the
        // user typed and must send it as an ordinary turn.
        return { ok: false, reason: response.status === 409 ? "too_late" : "no_turn" };
    }

    private async post(endpoint: string, body: Record<string, unknown>) {
        const url = formatURL(endpoint, undefined, { apiKey: this.config.apiKey, debug: this.config.debug });

        try {
            return await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
        } catch (error) {
            // A stop that cannot reach the server is not worth throwing over: the turn is
            // ending on its own soon enough, and the caller has no better move to make.
            if (this.config.debug) console.warn(`[Interrupt failed: ${endpoint}]`, error);
            return undefined;
        }
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

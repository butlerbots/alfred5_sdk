import { EventSource } from "eventsource";

import { authHeaders, formatURL } from "../util/url_formatter";
import {
    ConversationStream,
    ConversationTransport,
    SteerResult,
    TransportHandlers,
    TransportSteerRequest,
    TransportStopRequest,
    TransportTurnRequest,
    TurnStopped,
    failurePayload,
    turnContext,
    turnTools,
    turnExtra,
} from "./transport";

type StreamPayload = { success: boolean; data?: { convoId?: string; quitStream?: boolean } };

type StreamOptions = {
    debug?: boolean;
    /** Sent as the `Authorization` header on every connection, the reconnects included. */
    apiKey: string;
    /** GET when nothing says otherwise. */
    method?: "GET" | "POST";
    /** A JSON body, sent again with each reconnect so the server can tell which turn it was. */
    body?: unknown;
    onPayload(payload: StreamPayload): void;
};

/**
 * How many connection attempts in a row may fail, with no stream opened between them, before the
 * stream is given up for good. The library reconnects every three seconds and never stops on its
 * own, which is right for a stream handed to another instance and wrong for a server that is not
 * there: this is the line between the two, about half a minute.
 */
export const STREAM_RECONNECT_ATTEMPTS = 10;

/**
 * Streams a server-sent-events endpoint, closing when the server says the stream is done. Shared
 * by turns and by the progress stream.
 *
 * A stream that ends any other way is ended with a failure payload (`success: false`, with
 * `quitStream`), so a caller is always told: a refusal (a bad key, a refused parameter) carries
 * the HTTP status and what the server said; a stream closed for good, or a server that cannot be
 * reached `STREAM_RECONNECT_ATTEMPTS` times in a row, says so. A dropped connection is not a
 * failure: the library reconnects with the last event id, and the server carries on from there.
 */
export function streamSSE(url: string, options: StreamOptions): EventSource {
    /** What the server answered the last connection with, when that was not the stream. */
    let refused: { status: number; body: string } | undefined;
    let failedAttempts = 0;
    let settled = false;

    const sse = new EventSource(url, {
        fetch: async (input, init) => {
            const response = await fetch(input, {
                ...init,
                method: options.method ?? "GET",
                headers: {
                    ...init?.headers,
                    ...authHeaders(options.apiKey),
                    ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
                },
                ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
            });
            // Read here because the library reports a refusal by its status alone, and the body
            // is where the server said what it refused.
            refused = response.status === 200 ? undefined : { status: response.status, body: await response.clone().text().catch(() => "") };
            return response;
        },
    });

    const settle = (payload: StreamPayload) => {
        if (settled) return;
        settled = true;
        sse.close();
        options.onPayload(payload);
    };

    sse.addEventListener("open", () => { failedAttempts = 0; });

    sse.addEventListener("message", (event) => {
        if (settled) return;
        let payload: StreamPayload;
        try {
            payload = JSON.parse(event.data) as StreamPayload;
        } catch {
            if (options.debug) console.warn(`[Stream: unreadable event on ${url}]`, event.data);
            return;
        }
        if (payload.data?.quitStream) settle(payload);
        else options.onPayload(payload);
    });

    sse.addEventListener("error", (event) => {
        if (options.debug) console.warn(`[Stream Error: ${url}]`, event);
        if (settled) return;

        if (sse.readyState === sse.CLOSED) {
            settle(streamFailure(event, refused));
            return;
        }

        // Reconnecting. A run of attempts that never reach the server is a server that is not there.
        failedAttempts++;
        if (failedAttempts >= STREAM_RECONNECT_ATTEMPTS) {
            settle(failurePayload(
                "SDK_UNREACHABLE",
                `The stream could not reach the server after ${failedAttempts} attempts: ${event.message ?? "no response"}`,
                "I'm afraid I can't reach my server right now. Please try again in a moment.",
            ));
        }
    });

    return sse;
}

/** What a stream the library closed for good is reported as. */
function streamFailure(event: { message?: string; code?: number }, refused: { status: number; body: string } | undefined) {
    const status = refused?.status ?? event.code;
    if (!refused || status === undefined || status === 200 || status === 204) {
        return failurePayload(
            "SDK_STREAM_CLOSED",
            `The server ended the stream without finishing the turn: ${event.message ?? "closed"}`,
            "I'm afraid the connection to my server closed before I finished.",
            undefined,
            status,
        );
    }

    const body = parseBody(refused.body);
    const said = body?.errormessage ?? body?.message ?? body?.error ?? (refused.body && !body ? refused.body.slice(0, 500) : undefined);
    const detail = [body?.error ?? body?.exacterror ?? `HTTP ${status}`, ...(body?.validationErrors ?? [])].join(": ");

    return failurePayload(
        body?.errorcode ?? codeForStatus(status),
        detail,
        said ?? `The server refused the turn (HTTP ${status}).`,
        undefined,
        status,
    );
}

function codeForStatus(status: number): string {
    if (status === 400 || status === 413) return "SDK_BAD_REQUEST";
    if (status === 401) return "SDK_UNAUTHORIZED";
    if (status === 403) return "SDK_FORBIDDEN";
    if (status === 429) return "SDK_RATE_LIMITED";
    return "SDK_HTTP_ERROR";
}

type RefusalBody = { errorcode?: string; error?: string; exacterror?: string; errormessage?: string; message?: string; validationErrors?: string[] };

function parseBody(text: string): RefusalBody | undefined {
    if (!text) return undefined;
    try {
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== "object") return undefined;
        const body = parsed as Record<string, unknown>;
        const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
        return {
            errorcode: str(body.errorcode),
            error: str(body.error),
            exacterror: str(body.exacterror),
            errormessage: str(body.errormessage),
            message: str(body.message),
            validationErrors: Array.isArray(body.validationErrors) ? body.validationErrors.filter((entry): entry is string => typeof entry === "string") : undefined,
        };
    } catch {
        return undefined;
    }
}

/**
 * Carries a turn over the HTTP chat endpoint. The default.
 *
 * A turn is a POST with its parameters as a JSON body and the key in the `Authorization` header,
 * so neither lands in a log or against a header limit. `method: "GET"` sends the parameters as a
 * query instead, for a self-hosted server older than POST turns; the key is a header either way.
 */
export class SSEConversationTransport implements ConversationTransport {
    constructor(private readonly config: {
        endpoint(): string;
        stopEndpoint?(): string;
        steerEndpoint?(): string;
        apiKey: string;
        debug?: boolean;
        method?: "POST" | "GET";
    }) { }

    send(request: TransportTurnRequest, handlers: TransportHandlers): ConversationStream {
        const method = this.config.method ?? "POST";
        const url = method === "GET"
            ? formatURL(this.config.endpoint(), asQuery(request), { debug: this.config.debug })
            : formatURL(this.config.endpoint(), {}, { debug: this.config.debug });

        const sse = streamSSE(url, {
            debug: this.config.debug,
            apiKey: this.config.apiKey,
            method,
            ...(method === "POST" ? { body: asBody(request) } : {}),
            onPayload: (payload) => {
                const convoId = payload.success ? payload.data?.convoId : undefined;
                if (convoId) handlers.convoId(convoId);
                handlers.payload(payload);
            },
        });

        return { close: () => sse.close(), source: sse };
    }

    /**
     * The turn is a request that streams until it is done, so an interruption cannot travel on
     * the same request and gets one of its own.
     *
     * Closing the stream is deliberately not a stop: a reload, a backgrounded tab or a
     * reconnect all drop the connection and all expect to pick the answer back up.
     */
    async stop(request: TransportStopRequest): Promise<TurnStopped | undefined> {
        const endpoint = this.config.stopEndpoint?.();
        if (!endpoint) return undefined;

        const response = await this.post(endpoint, { chatId: request.chatId, mode: request.mode });
        if (!response) return undefined;

        // 404 is "nothing was running", which is the ordinary answer to stopping a moment late.
        // Anything else is the server refusing or failing, and a stop button that quietly does
        // nothing is the hardest kind of bug to report — so it is said out loud.
        if (!response.ok) {
            if (response.status !== 404) console.warn(`[Stop failed: ${response.status}]`, await response.text().catch(() => ""));
            return undefined;
        }

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
        if (response.status === 409) return { ok: false, reason: "too_late" };

        // Anything other than "no turn" means the message did not land for a reason the caller
        // cannot see: it still falls back to sending, but not in silence.
        if (response.status !== 404) console.warn(`[Steer failed: ${response.status}]`, await response.text().catch(() => ""));
        return { ok: false, reason: "no_turn" };
    }

    private async post(endpoint: string, body: Record<string, unknown>) {
        const url = formatURL(endpoint, {}, { debug: this.config.debug });

        try {
            return await fetch(url, {
                method: "POST",
                headers: { ...authHeaders(this.config.apiKey), "content-type": "application/json" },
                body: JSON.stringify(body),
            });
        } catch (error) {
            // A stop that cannot reach the server is not worth throwing over: the turn is
            // ending on its own soon enough, and the caller has no better move to make. It is
            // still worth saying, and not only in debug — an interruption that vanishes without
            // a trace is indistinguishable from one the UI forgot to wire up.
            console.warn(`[Interrupt failed: ${endpoint}]`, error);
            return undefined;
        }
    }
}

/**
 * A POSTed turn's body: the same fields as the query, in JSON's own shapes. The address is an
 * object, the context an array and the tools an array of ids, checked by the same rules.
 */
function asBody(request: TransportTurnRequest): Record<string, unknown> {
    const body: Record<string, unknown> = { message: request.message };

    if (request.chatId) body.chatId = request.chatId;
    if (request.model) body.model = request.model;
    if (request.instructions) body.instructions = request.instructions;
    if (request.platform) body.platform = request.platform;
    if (request.address) body.address = request.address;
    if (request.personality) body.personality = request.personality;
    const wake = request.wake?.trim();
    if (wake) body.wake = wake;
    const tools = turnTools(request.tools);
    if (tools) body.tools = tools.split(",");
    if (request.context && request.context.length > 0) body.context = request.context;

    // Checked before anything else is added, so an entry can never replace a field above.
    const extra = turnExtra(request.extra);
    return extra ? { ...extra, ...body } : body;
}

/** A GET turn's query: the fields as strings, the address and context JSON-encoded. */
function asQuery(request: TransportTurnRequest): Record<string, string> {
    const query: Record<string, string> = { message: request.message };

    if (request.chatId) query.chatId = request.chatId;
    if (request.model) query.model = request.model;
    if (request.instructions) query.instructions = request.instructions;
    if (request.platform) query.platform = request.platform;
    // An address is a small object, and a query parameter is a string: it travels JSON-encoded
    // rather than as a field per part, so the server reads one whole address or none at all.
    if (request.address) query.address = JSON.stringify(request.address);
    if (request.personality) query.personality = request.personality;
    const wake = request.wake?.trim();
    if (wake) query.wake = wake;
    const tools = turnTools(request.tools);
    if (tools) query.tools = tools;
    const context = turnContext(request.context);
    if (context) query.context = context;

    // Checked before anything else is added, so an entry can never replace a field above.
    const extra = turnExtra(request.extra);
    return extra ? { ...extra, ...query } : query;
}

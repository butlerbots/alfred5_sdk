import { ButlerBotAPIError } from "../util/api_error";

/** What every JSON route on the server answers with, success or not. */
type APIEnvelope = {
    success?: boolean;
    error?: string;
    errormessage?: string;
};

export type APIRequestOptions = {
    url: string;
    /** GET when nothing says otherwise. */
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    /** Sent as JSON. A route that takes no body is called without one. */
    body?: unknown;
    /** What the caller was trying to do, for the message a failure carries. */
    action: string;
};

/**
 * One call to a JSON route, with the failure turned into a `ButlerBotAPIError`.
 *
 * The body is read as text once and parsed here rather than through `response.json()`, because
 * a failing route's body has to be readable both as the parsed `error`/`errormessage` and as
 * whatever else it carries — the job on a rejected cancel, the delivery on a rejected answer —
 * and a response body can only be consumed once.
 */
export async function requestAPI<T>(options: APIRequestOptions): Promise<T> {
    const init: RequestInit = { method: options.method || "GET" };

    if (options.body !== undefined) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(options.body);
    }

    const response = await fetch(options.url, init);
    const text = await response.text();
    const data = parseJSON(text);
    const envelope = (data && typeof data === "object" ? data : {}) as APIEnvelope;

    if (!response.ok || envelope.success !== true) {
        throw new ButlerBotAPIError({
            action: options.action,
            status: response.status,
            statusText: response.statusText,
            error: envelope.error,
            errormessage: envelope.errormessage,
            body: data ?? text,
        });
    }

    return data as T;
}

function parseJSON(text: string): unknown {
    if (!text) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

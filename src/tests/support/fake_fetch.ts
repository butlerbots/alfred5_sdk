/**
 * A `fetch` that answers from a script and writes down what it was asked.
 *
 * The HTTP modules are thin on purpose — a URL, a method, a body, and what the server said —
 * so what is worth asserting is exactly the call that went out and the value that came back.
 */

export type RecordedCall = {
    url: string;
    method: string;
    headers: Record<string, string>;
    /** The request body, parsed, or undefined when the call sent none. */
    body: unknown;
};

export type ScriptedReply = {
    status?: number;
    statusText?: string;
    /** Sent as JSON. */
    body?: unknown;
    /** Sent verbatim, for answers that are not JSON at all. */
    text?: string;
};

export type FakeFetch = {
    calls: RecordedCall[];
    /** The one call that went out. Fails loudly when there was not exactly one. */
    only(): RecordedCall;
    restore(): void;
};

/** Installs a `fetch` that answers every call with `reply`, until `restore()`. */
export function fakeFetch(reply: ScriptedReply = {}): FakeFetch {
    const original = globalThis.fetch;
    const calls: RecordedCall[] = [];

    globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const rawBody = init?.body;
        calls.push({
            url: String(input),
            method: init?.method || "GET",
            headers: (init?.headers as Record<string, string>) || {},
            body: typeof rawBody === "string" ? JSON.parse(rawBody) : undefined,
        });

        const payload = reply.text !== undefined ? reply.text : JSON.stringify(reply.body ?? { success: true });
        return new Response(payload, {
            status: reply.status ?? 200,
            statusText: reply.statusText ?? "",
            headers: { "Content-Type": "application/json" },
        });
    }) as typeof fetch;

    return {
        calls,
        only() {
            if (calls.length !== 1) throw new Error(`Expected exactly one call, saw ${calls.length}`);
            return calls[0];
        },
        restore() {
            globalThis.fetch = original;
        },
    };
}

/** The query of a recorded call, as a plain object. */
export function queryOf(call: RecordedCall): Record<string, string> {
    return Object.fromEntries(new URL(call.url).searchParams.entries());
}

/** The path of a recorded call, without its query. */
export function pathOf(call: RecordedCall): string {
    const url = new URL(call.url);
    return `${url.origin}${url.pathname}`;
}

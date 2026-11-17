/**
 * What an API call throws when the server did not answer with a success.
 *
 * One error class for every JSON route rather than a result type per method: the status is
 * what a caller branches on, and it is carried here alongside whatever the server said, so
 * "the job was already finished" (409) and "no job of yours has that id" (404) are told apart
 * without parsing a message. `body` is the parsed response when there was one, so a 409 on a
 * cancel still hands back the job, and a 409 on an answer still hands back the delivery.
 */
export class ButlerBotAPIError extends Error {
    /** The HTTP status the server answered with, or 0 when the call never got a response. */
    readonly status: number;
    readonly statusText: string;
    /** The server's short `error`, e.g. "Already finished". */
    readonly error?: string;
    /** The server's `errormessage`: the same thing in a sentence. */
    readonly errormessage?: string;
    /** The parsed response body, or the raw text when it was not JSON. */
    readonly body: unknown;

    constructor(options: {
        action: string;
        status: number;
        statusText?: string;
        error?: string;
        errormessage?: string;
        body?: unknown;
    }) {
        const detail = options.errormessage
            || options.error
            // A body that was not JSON at all still says more than "Unknown error" does.
            || (typeof options.body === "string" && options.body ? options.body.slice(0, 500) : "Unknown error");
        super(`Failed to ${options.action}: ${options.status} ${options.statusText || ""} - ${detail}`.replace(/\s+-/, " -"));

        this.name = "ButlerBotAPIError";
        this.status = options.status;
        this.statusText = options.statusText || "";
        this.error = options.error;
        this.errormessage = options.errormessage;
        this.body = options.body;

        // `target: es2020` down-levels the subclass, which breaks `instanceof` without this.
        Object.setPrototypeOf(this, ButlerBotAPIError.prototype);
    }

    /** The resource is not there, or is not this key's. The two are answered alike on purpose. */
    get isNotFound(): boolean {
        return this.status === 404;
    }

    /** Somebody got there first: the job had finished, or the delivery was already answered. */
    get isConflict(): boolean {
        return this.status === 409;
    }

    /** The request itself was refused: a value the server would not take. */
    get isBadRequest(): boolean {
        return this.status === 400;
    }

    /** The key may not do this: a scope it lacks, or a grant it does not hold. */
    get isForbidden(): boolean {
        return this.status === 403;
    }

    /** Too many requests: wait `retryAfter` seconds. */
    get isRateLimited(): boolean {
        return this.status === 429;
    }

    /** The service's machine-readable reason, when it gave one (the datasets API's `invalid`, `not_found`, `forbidden`…). */
    get code(): string | undefined {
        const code = this.bodyField("code");
        return typeof code === "string" ? code : undefined;
    }

    /** Every issue a refusal listed, each with a `path` and a `message`, when it listed them. */
    get issues(): Array<{ path: string; message: string; [extra: string]: unknown }> {
        const issues = this.bodyField("issues");
        return Array.isArray(issues) ? issues as Array<{ path: string; message: string }> : [];
    }

    /** How many seconds to wait before trying again, when the service said. */
    get retryAfter(): number | undefined {
        const value = this.bodyField("retryAfter");
        return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    }

    private bodyField(name: string): unknown {
        return this.body && typeof this.body === "object" && !Array.isArray(this.body) ? (this.body as Record<string, unknown>)[name] : undefined;
    }
}

import type { ErrorCode } from "../types/error";

/**
 * What `ask()` rejects with when the turn failed: the failure payload's code, its detail, the
 * line written for a person, and the HTTP status when the stream failed on one.
 *
 * Branch on `code` (see `TURN_ERROR_CODES`). The turn may still be running on the server after
 * an `SDK_TIMEOUT` or an `SDK_UNREACHABLE`: only the stream gave up.
 */
export class ButlerBotTurnError extends Error {
    readonly code: ErrorCode;
    /** What went wrong, for a developer: the server's short error, or the stream's. */
    readonly error: string;
    /** The same thing written for a person, safe to show. */
    readonly userMessage: string;
    /** The HTTP status, when the stream failed on one before the server said anything. */
    readonly status?: number;
    /** The conversation the turn was in, when it was known. */
    readonly convoId?: string;
    /** The failure payload as it arrived. */
    readonly payload: unknown;

    constructor(options: { code: ErrorCode; error?: string; message?: string; status?: number; convoId?: string; payload: unknown }) {
        super(options.message || options.error || options.code);

        this.name = "ButlerBotTurnError";
        this.code = options.code;
        this.error = options.error || "";
        this.userMessage = options.message || "";
        this.status = options.status;
        this.convoId = options.convoId;
        this.payload = options.payload;

        // `target: es2020` down-levels the subclass, which breaks `instanceof` without this.
        Object.setPrototypeOf(this, ButlerBotTurnError.prototype);
    }
}

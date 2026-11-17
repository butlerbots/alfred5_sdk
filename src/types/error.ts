/**
 * The codes a failed turn's payload can carry (`data.code` when `success` is false).
 *
 * Three sources, all listed here: the server's own codes, the SDK's for a stream that failed
 * before the server could say anything (`SDK_*`), and the Link transport's (lower case). Branch on
 * the code, never on the message, which is written for a person and changes.
 */
export const TURN_ERROR_CODES = [
    // The server: the turn was refused, or failed while it ran.
    "NO_AUTH",
    "NO_SUPP",
    "INTERNAL_ERROR",
    "SERVER_ENDPOINT_DEPRECATED",
    "DG_NO_CHATID_ARG",
    "DG_NO_MESSAGE_ARG",
    "DG_NO_MODEL_ARG",
    "DG_INVALID_MODEL",
    "DG_NO_CHAT_PROFILE",
    "DG_NO_TIER",
    /** The `chatId` names no conversation of this user's. */
    "DG_CONVO_NOT_FOUND",
    /** This conversation is already answering: wait, or `steer()` the message into that turn. */
    "DG_TURN_IN_PROGRESS",
    /** The server is restarting and took no new turn: send it again in a few seconds. */
    "DG_SERVER_DRAINING",
    /** The turn moved to another server instance; the stream reconnects and carries on by itself. */
    "DG_TURN_SUSPENDED",
    "DG_AGENT_CONVO_LOCKED",
    "DG_MODERATION_BANNED",
    "DG_OVER_FREE_TIER_MSG_LIMIT",
    "DG_OVER_DAY_USAGE",
    "DG_OVER_WEEK_USAGE",
    "CORE_AI_IMPOSSIBLE",
    "CORE_AI_NO_INIT",
    "CORE_AI_EXTERNAL",
    "CORE_AI_SEQ_TOOL_LIMIT",
    "CORE_AI_NO_MODEL",
    "CORE_AI_MODEL_404",
    "CORE_AI_CONVO_404",
    "CORE_AI_BUSY",
    "CORE_AI_NO_USER",
    "CORE_AI_DB_FAIL",
    "CORE_AI_CONVO_DISABLED",
    "CORE_AI_MODEL_OVERLOADED",
    "CORE_AI_MODEL_CALL_FAILED",

    // The SDK: the stream failed before, or instead of, a word from the server.
    /** The server refused the key (HTTP 401). */
    "SDK_UNAUTHORIZED",
    /** The key is valid but lacks a scope this call needs (HTTP 403); `error` names it. */
    "SDK_FORBIDDEN",
    /** The server refused a parameter (HTTP 400); `error` says which and why. */
    "SDK_BAD_REQUEST",
    /** Too many requests on this key (HTTP 429). */
    "SDK_RATE_LIMITED",
    /** Any other refusal or failure the server answered with an HTTP status. */
    "SDK_HTTP_ERROR",
    /** The server ended the stream for good without saying the turn was done. */
    "SDK_STREAM_CLOSED",
    /** The server could not be reached, again and again. */
    "SDK_UNREACHABLE",
    /** Nothing arrived within the `timeout` the conversation was given. The turn may still be running. */
    "SDK_TIMEOUT",

    // The Link transport.
    "link_error",
    "disconnected",
    "timeout",
    "closed",
    "bad_frame",
    "turn_failed",
] as const;

/** A code this SDK knows, from the list above. */
export type KnownErrorCode = typeof TURN_ERROR_CODES[number];

/**
 * A failed turn's code. Every known code is offered by name; any other string is still accepted,
 * because a newer server may send a code this SDK predates, and a client should treat one it does
 * not know as a plain failure rather than fail to compile.
 */
export type ErrorCode = KnownErrorCode | (string & {});

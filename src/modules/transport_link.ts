import type { Link } from "../link/link";
import { LinkError, LinkServerFrame } from "../link/protocol";
import { ConversationEvent } from "../types/response/v5";
import {
    completedPayload,
    ConversationStream,
    ConversationTransport,
    convoStartedPayload,
    failurePayload,
    noticePayload,
    TransportHandlers,
    TransportTurnRequest,
} from "./transport";

export type LinkSessionConfig = {
    model?: string;
    personality?: string;
    instructions?: string;
    platform?: string;
};

/**
 * Carries a turn over an existing Link connection.
 *
 * Sessions are ephemeral: the server drops them when the socket goes, so one is
 * opened on demand and reopened transparently after a reconnect. The conversation
 * itself is persisted server-side, so nothing is lost when that happens.
 */
export class LinkConversationTransport implements ConversationTransport {
    private sessionId?: string;
    private sessionChatId?: string;

    constructor(private readonly link: Link, private readonly config: () => LinkSessionConfig) {
        // A session cannot outlive the connection it was opened on.
        link.on("disconnect", () => { this.sessionId = undefined; });
    }

    send(request: TransportTurnRequest, handlers: TransportHandlers): ConversationStream {
        let closed = false;
        const deliver: TransportHandlers = {
            payload: (payload) => { if (!closed) handlers.payload(payload); },
            convoId: (convoId) => { if (!closed) handlers.convoId(convoId); },
        };

        void this.runTurn(request, deliver, true).catch((error: unknown) => {
            const failure = error instanceof LinkError
                ? failurePayload(error.code, error.message, error.message, request.chatId)
                : failurePayload("link_error", String(error), "I'm afraid the connection to Alfred failed.", request.chatId);

            deliver.payload(failure);
        });

        return { close: () => { closed = true; } };
    }

    /** Ends the session, if one is open. The conversation can still be resumed later. */
    async end(): Promise<void> {
        const sessionId = this.sessionId;
        if (!sessionId) return;

        this.sessionId = undefined;
        await this.link.exchange("conversation.end", { sessionId });
    }

    private async runTurn(request: TransportTurnRequest, handlers: TransportHandlers, mayRetry: boolean): Promise<void> {
        const sessionId = await this.session(request);

        let chatId = request.chatId ?? this.sessionChatId;
        let announcedChatId = false;
        let sawCompletion = false;

        const learnChatId = (candidate?: string) => {
            if (!candidate) return;

            chatId = candidate;
            this.sessionChatId = candidate;
            handlers.convoId(candidate);

            // Mirrors the HTTP transport's first byte, which tells a client which
            // conversation it is now in. A brand new conversation only has an id once
            // its first turn has begun.
            if (!announcedChatId) {
                announcedChatId = true;
                handlers.payload(convoStartedPayload(candidate));
            }
        };

        learnChatId(chatId);

        const done = await this.link.exchange("conversation.chat", {
            sessionId,
            message: request.message,
            ...(request.model ? { model: request.model } : {}),
            ...(request.instructions ? { instructions: request.instructions } : {}),
            ...(request.personality ? { personality: request.personality } : {}),
        }, {
            // A turn takes as long as it takes; only the transport dying ends it early.
            timeoutMs: 0,
            isDone: (frame) => frame.type === "conversation.done",
            onFrame: (frame) => {
                if (frame.type === "conversation.event") {
                    const payload = (frame as LinkServerFrame<"conversation.event">).payload;
                    learnChatId(payload.chatId);

                    const event = payload.event as ConversationEvent;
                    const final = event.type === "response_status" && Boolean(event.payload?.completed);
                    if (final) sawCompletion = true;

                    handlers.payload({
                        success: true,
                        data: {
                            response: event,
                            ...(payload.chatId ?? chatId ? { convoId: payload.chatId ?? chatId } : {}),
                            ...(final ? { quitStream: true } : {}),
                        },
                    });
                    return;
                }

                if (frame.type === "conversation.notice") {
                    const payload = (frame as LinkServerFrame<"conversation.notice">).payload;
                    learnChatId(payload.chatId);
                    handlers.payload(noticePayload(payload.message, payload.chatId ?? chatId));
                }
            },
        });

        const payload = (done as LinkServerFrame<"conversation.done">).payload;
        learnChatId(payload.chatId);

        if (payload.ok) {
            // Nearly always the pipeline's own completion event has already closed the
            // stream; this is for the turn that ended without one.
            if (!sawCompletion) handlers.payload(completedPayload(payload.chatId ?? chatId));
            return;
        }

        // The session died with a connection we have since replaced. Reopening it is
        // invisible to the caller, and the message has not been delivered yet.
        if (payload.code === "unknown_session" && mayRetry) {
            this.sessionId = undefined;
            await this.runTurn(request, handlers, false);
            return;
        }

        handlers.payload(failurePayload(
            // `turn_failed` means the dialogue itself failed, and then `error` holds the
            // code the HTTP transport would have reported.
            payload.code === "turn_failed" ? payload.error ?? payload.code : payload.code ?? "link_error",
            payload.error ?? "The turn failed.",
            payload.message ?? payload.error ?? "I'm afraid that turn could not be completed.",
            payload.chatId ?? chatId,
        ));
    }

    /** Opens a session, or reuses the open one when it is for the same conversation. */
    private async session(request: TransportTurnRequest): Promise<string> {
        const chatId = request.chatId ?? this.sessionChatId;

        if (this.sessionId && this.sessionChatId === chatId) return this.sessionId;
        if (this.sessionId) await this.end();

        const config = this.config();
        const opened = await this.link.exchange("conversation.start", {
            ...(chatId ? { chatId } : {}),
            ...(request.model ?? config.model ? { model: request.model ?? config.model } : {}),
            ...(request.personality ?? config.personality ? { personality: request.personality ?? config.personality } : {}),
            ...(request.instructions ?? config.instructions ? { instructions: request.instructions ?? config.instructions } : {}),
            ...(request.platform ?? config.platform ? { platform: request.platform ?? config.platform } : {}),
        }, {
            isDone: (frame) => frame.type === "conversation.open",
        });

        const payload = (opened as LinkServerFrame<"conversation.open">).payload;
        this.sessionId = payload.sessionId;
        this.sessionChatId = payload.chatId ?? chatId;

        return payload.sessionId;
    }
}

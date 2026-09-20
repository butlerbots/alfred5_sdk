import type { Link } from "../link/link";
import { LinkError, LinkServerFrame, LinkServerFrameOf } from "../link/protocol";
import { ConversationEvent } from "../types/response/v5";
import type { ConversationAddress } from "../types/conversation/address";
import {
    completedPayload,
    ConversationStream,
    ConversationTransport,
    convoStartedPayload,
    failurePayload,
    noticePayload,
    SteerResult,
    TransportAttachRequest,
    TransportHandlers,
    TransportSteerRequest,
    TransportStopRequest,
    TransportTurnRequest,
    TurnStopped,
} from "./transport";

export type LinkSessionConfig = {
    model?: string;
    personality?: string;
    instructions?: string;
    platform?: string;
    /** Where on the platform the conversation is: on Discord, the channel and thread. */
    address?: ConversationAddress;
};

/**
 * How long to keep trying to pick a lost turn back up before giving up on it.
 *
 * A turn belongs to its conversation, not to the socket that asked for one, so neither losing
 * the connection nor losing the instance answering it — which is what a deploy does — ends it.
 * Long enough to outlast a deploy of either service, short enough that a caller awaiting a
 * reply is not left there forever when the turn really is gone.
 */
const RESUME_WINDOW_MS = 60_000;

/** Waits between attempts to pick a turn back up. The last value repeats. */
const RESUME_BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000, 5_000];

/** What is known about a turn in flight, and everything a resume needs to rejoin it. */
type TurnProgress = {
    chatId?: string;
    /** The last event actually handed to the caller. A resume asks only for what came after it. */
    lastEventId?: string;
    /** Whether the caller has already been given the turn's completion. */
    sawCompletion: boolean;
};

/** Set when the caller stops listening, which also calls off a resume still trying on its behalf. */
type Listening = { closed: boolean };

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
        const listening: Listening = { closed: false };
        const deliver: TransportHandlers = {
            payload: (payload) => { if (!listening.closed) handlers.payload(payload); },
            convoId: (convoId) => { if (!listening.closed) handlers.convoId(convoId); },
        };

        void this.runTurn(request, deliver, true, listening).catch((error: unknown) => {
            const failure = error instanceof LinkError
                ? failurePayload(error.code, error.message, error.message, request.chatId)
                : failurePayload("link_error", String(error), "I'm afraid the connection to Alfred failed.", request.chatId);

            deliver.payload(failure);
        });

        return { close: () => { listening.closed = true; } };
    }

    /**
     * Stops a running turn.
     *
     * Addressed by conversation rather than by session, so a client that reconnected — losing
     * its session but not the turn — can still stop what it is watching. The turn's own stream
     * ends normally afterwards, carrying whatever the model produced before the stop.
     */
    async stop(request: TransportStopRequest): Promise<TurnStopped | undefined> {
        try {
            const frame = await this.link.exchange("conversation.stop", request, {
                isDone: (reply) => reply.type === "conversation.stopped" || reply.type === "ack" || reply.type === "error",
            });

            if (frame.type !== "conversation.stopped") return undefined;

            const { mode, requestedMode, by } = frame.payload;
            return { mode, requestedMode, by };
        } catch {
            // Nothing was running, or the link is gone. Either way there is no turn to stop and
            // nothing useful for the caller to do about it.
            return undefined;
        }
    }

    /**
     * Says something to a turn that is still running.
     *
     * A refusal is the interesting case: the caller is holding a message the user typed and
     * has to send it as an ordinary turn instead of dropping it.
     */
    async steer(request: TransportSteerRequest): Promise<SteerResult> {
        try {
            const frame = await this.link.exchange("conversation.steer", request, {
                isDone: (reply) => reply.type === "conversation.steered" || reply.type === "ack" || reply.type === "error",
            });

            if (frame.type === "conversation.steered") return { ok: true };
            return { ok: false, reason: "no_turn" };
        } catch (error) {
            const code = error instanceof LinkError ? error.code : undefined;
            return { ok: false, reason: code === "too_late" ? "too_late" : "no_turn" };
        }
    }

    /** Ends the session, if one is open. The conversation can still be resumed later. */
    async end(): Promise<void> {
        const sessionId = this.sessionId;
        if (!sessionId) return;

        this.sessionId = undefined;
        await this.link.exchange("conversation.end", { sessionId });
    }

    /**
     * Follows a turn that is already running, over the link this conversation already holds.
     *
     * A turn belongs to the conversation rather than to the socket that started it, so
     * reopening a conversation mid-answer — a reload, a second tab, a turn started from
     * another device or over HTTP — streams here instead of dropping to an SSE connection
     * just to watch. Needs no session: watching is not speaking.
     *
     * A conversation with nothing running ends the stream immediately, which is the
     * ordinary answer for one that is simply idle.
     */
    attach(request: TransportAttachRequest, handlers: TransportHandlers): ConversationStream {
        const listening: Listening = { closed: false };
        const deliver = (payload: unknown) => { if (!listening.closed) handlers.payload(payload); };
        const progress: TurnProgress = { chatId: request.chatId, lastEventId: request.afterEventId, sawCompletion: false };

        // Watching is allowed to end in silence, which is why `quietWhenGone` is true here and
        // false for a turn of our own: nobody is waiting on an answer to a question they asked.
        const resume = () => this.resume(request.chatId, progress, deliver, listening, { quietWhenGone: true });

        void this.watch(request.chatId, progress, deliver).then(async (payload) => {
            if (payload.ok) return;

            // Nothing running is not a failure: the caller asked to watch a conversation
            // that has nothing to watch, and the stream simply ends.
            if (payload.code === "no_active_turn") return;

            // The turn is alive, somewhere this connection can no longer see. Following it is
            // the entire point of being here.
            if (payload.code === "turn_suspended") {
                if (payload.lastEventId) progress.lastEventId = payload.lastEventId;
                await resume();
                return;
            }

            deliver(failurePayload(
                payload.code ?? "link_error",
                payload.error ?? "The turn could not be watched.",
                payload.message ?? payload.error ?? "I'm afraid I couldn't follow that response.",
                payload.chatId ?? request.chatId,
            ));
        }, async (error: unknown) => {
            if (error instanceof LinkError && error.code === "no_active_turn") return;

            // The socket went while we were watching. The turn did not go with it.
            if (error instanceof LinkError && error.code === "disconnected") {
                await resume();
                return;
            }

            deliver(error instanceof LinkError
                ? failurePayload(error.code, error.message, error.message, request.chatId)
                : failurePayload("link_error", String(error), "I'm afraid the connection to Alfred failed.", request.chatId));
        });

        return {
            close: () => {
                if (listening.closed) return;
                listening.closed = true;

                // Best-effort: a socket that has gone has already ended the watch for us.
                try {
                    this.link.send("conversation.detach", { chatId: request.chatId });
                } catch {
                    // Disconnected. The server drops the attachment with the connection.
                }
            },
        };
    }

    private async runTurn(request: TransportTurnRequest, handlers: TransportHandlers, mayRetry: boolean, listening: Listening): Promise<void> {
        const sessionId = await this.session(request);

        const progress: TurnProgress = { chatId: request.chatId ?? this.sessionChatId, sawCompletion: false };
        let announcedChatId = false;

        const learnChatId = (candidate?: string) => {
            if (!candidate) return;

            progress.chatId = candidate;
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

        learnChatId(progress.chatId);

        let done: LinkServerFrame;
        try {
            done = await this.link.exchange("conversation.chat", {
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
                        const payload = frame.payload;
                        learnChatId(payload.chatId);
                        if (payload.eventId) progress.lastEventId = payload.eventId;

                        const event = payload.event as ConversationEvent;
                        const final = event.type === "response_status" && Boolean(event.payload?.completed);
                        if (final) progress.sawCompletion = true;

                        handlers.payload({
                            success: true,
                            data: {
                                response: event,
                                ...(payload.chatId ?? progress.chatId ? { convoId: payload.chatId ?? progress.chatId } : {}),
                                ...(final ? { quitStream: true } : {}),
                            },
                        });
                        return;
                    }

                    if (frame.type === "conversation.notice") {
                        const payload = frame.payload;
                        learnChatId(payload.chatId);
                        handlers.payload(noticePayload(payload.message, payload.chatId ?? progress.chatId));
                    }
                },
            });
        } catch (error) {
            // The socket went while the turn was running. The turn did not go with it: it
            // belongs to the conversation, and the conversation outlives this connection.
            if (progress.chatId && error instanceof LinkError && error.code === "disconnected") {
                await this.resume(progress.chatId, progress, handlers.payload, listening, { quietWhenGone: false });
                return;
            }

            throw error;
        }

        const payload = (done as LinkServerFrameOf<"conversation.done">).payload;
        learnChatId(payload.chatId);

        if (payload.ok) {
            // Nearly always the pipeline's own completion event has already closed the
            // stream; this is for the turn that ended without one.
            if (!progress.sawCompletion) handlers.payload(completedPayload(payload.chatId ?? progress.chatId));
            return;
        }

        // The session died with a connection we have since replaced. Reopening it is
        // invisible to the caller, and the message has not been delivered yet.
        if (payload.code === "unknown_session" && mayRetry) {
            this.sessionId = undefined;
            await this.runTurn(request, handlers, false, listening);
            return;
        }

        // Core suspended the turn at a deploy and handed it to another instance, and the link
        // service followed it as far as it could. The answer is still being written; rejoining
        // it is the difference between a deploy costing a reply and costing nothing.
        if (payload.code === "turn_suspended" && progress.chatId) {
            if (payload.lastEventId) progress.lastEventId = payload.lastEventId;
            await this.resume(progress.chatId, progress, handlers.payload, listening, { quietWhenGone: false });
            return;
        }

        handlers.payload(failurePayload(
            // `turn_failed` means the dialogue itself failed, and then `error` holds the
            // code the HTTP transport would have reported.
            payload.code === "turn_failed" ? payload.error ?? payload.code : payload.code ?? "link_error",
            payload.error ?? "The turn failed.",
            payload.message ?? payload.error ?? "I'm afraid that turn could not be completed.",
            payload.chatId ?? progress.chatId,
        ));
    }

    /**
     * One `conversation.attach`: streams a turn's events to the caller and resolves with how
     * that watch ended.
     *
     * Shared by watching somebody else's turn and by rejoining one of our own, because from
     * here the two are the same act. `progress` is carried rather than returned: a watch that
     * dies halfway still has to leave behind where it got to, or a resume would replay from
     * the beginning and the caller would read the answer twice.
     */
    private async watch(chatId: string, progress: TurnProgress, deliver: (payload: unknown) => void): Promise<LinkServerFrameOf<"conversation.done">["payload"]> {
        const done = await this.link.exchange("conversation.attach", {
            chatId,
            ...(progress.lastEventId ? { afterEventId: progress.lastEventId } : {}),
        }, {
            // A turn takes as long as it takes; only the transport dying ends it early.
            timeoutMs: 0,
            isDone: (frame) => frame.type === "conversation.done",
            onFrame: (frame) => {
                if (frame.type === "conversation.event") {
                    const payload = frame.payload;
                    if (payload.eventId) progress.lastEventId = payload.eventId;

                    const event = payload.event as ConversationEvent;
                    const final = event.type === "response_status" && Boolean(event.payload?.completed);
                    if (final) progress.sawCompletion = true;

                    deliver({
                        success: true,
                        data: {
                            response: event,
                            convoId: payload.chatId ?? chatId,
                            ...(final ? { quitStream: true } : {}),
                        },
                    });
                    return;
                }

                if (frame.type === "conversation.notice") {
                    deliver(noticePayload(frame.payload.message, frame.payload.chatId ?? chatId));
                }
            },
        });

        return (done as LinkServerFrameOf<"conversation.done">).payload;
    }

    /**
     * Picks a turn back up after losing sight of it.
     *
     * Two ways to lose one, one way to get it back. The socket can go — a deploy of the link
     * service, a proxy timing out — which rejects the exchange carrying the turn. Or core can
     * suspend the turn at its own deploy and hand it to another instance, which the link
     * service follows for two minutes before giving up and saying `turn_suspended`. Either way
     * the turn is still being answered and the conversation still holds it, so this re-attaches
     * from the last event the caller was actually given and the stream reads as one answer.
     *
     * `no_active_turn` is the ambiguous reply and it is deliberately not treated as an ending:
     * during a handover it means "not picked up yet" far more often than it means "gone", and
     * the window is what decides between them.
     *
     * Nothing here throws. It runs behind a stream the caller already holds, so the outcomes
     * that matter are the ones delivered into it: a completion, or a failure that says plainly
     * that the answer was lost track of rather than that it failed.
     */
    private async resume(
        chatId: string,
        progress: TurnProgress,
        deliver: (payload: unknown) => void,
        listening: Listening,
        options: { quietWhenGone: boolean },
    ): Promise<void> {
        const deadline = Date.now() + RESUME_WINDOW_MS;

        for (let attempt = 0; !listening.closed && Date.now() < deadline; attempt++) {
            if (attempt > 0) await pause(RESUME_BACKOFF_MS[Math.min(attempt - 1, RESUME_BACKOFF_MS.length - 1)]!);
            if (listening.closed) return;

            try {
                // The link reconnects on its own; this waits for it rather than racing it.
                await this.link.ready();
            } catch (error) {
                // Closed for good means nobody is coming back. Anything else is the link still
                // being down, which is exactly what the window is for.
                if (error instanceof LinkError && error.code === "closed") break;
                continue;
            }

            // An attachment from before may still be registered against a connection that is
            // itself still alive, and the server allows only one per conversation. Dropping it
            // first costs nothing when there is none to drop.
            try {
                this.link.send("conversation.detach", { chatId });
            } catch {
                // Not connected. The server dropped the attachment with the socket.
            }

            let payload: LinkServerFrameOf<"conversation.done">["payload"];
            try {
                payload = await this.watch(chatId, progress, deliver);
            } catch (error) {
                if (error instanceof LinkError && error.code === "closed") break;
                if (error instanceof LinkError && error.code === "no_active_turn" && options.quietWhenGone) return;
                continue;
            }

            if (payload.ok) {
                if (!progress.sawCompletion) deliver(completedPayload(payload.chatId ?? chatId));
                return;
            }

            // Not picked up yet, or suspended again mid-hop. Both mean it is still moving.
            if (payload.code === "no_active_turn") {
                if (options.quietWhenGone) return;
                continue;
            }

            if (payload.code === "turn_suspended") {
                if (payload.lastEventId) progress.lastEventId = payload.lastEventId;
                continue;
            }

            deliver(failurePayload(
                payload.code ?? "link_error",
                payload.error ?? "The turn could not be picked back up.",
                payload.message ?? payload.error ?? "I'm afraid I couldn't follow that response.",
                payload.chatId ?? chatId,
            ));
            return;
        }

        if (listening.closed) return;
        // The completion already reached the caller; there is nothing left to say.
        if (progress.sawCompletion) return;
        if (options.quietWhenGone) return;

        deliver(failurePayload(
            "turn_suspended",
            "The turn could not be picked back up.",
            "I'm afraid I lost track of that answer. It may well have finished — reopen the conversation to see where it got to.",
            chatId,
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
            ...(request.address ?? config.address ? { address: request.address ?? config.address } : {}),
        }, {
            isDone: (frame) => frame.type === "conversation.open",
        });

        const payload = (opened as LinkServerFrameOf<"conversation.open">).payload;
        this.sessionId = payload.sessionId;
        this.sessionChatId = payload.chatId ?? chatId;

        return payload.sessionId;
    }
}

/** Waits, without keeping a Node process alive on its own. */
function pause(ms: number): Promise<void> {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        (timer as unknown as { unref?: () => void }).unref?.();
    });
}

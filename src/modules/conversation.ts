import { EventSource } from "eventsource";
import { CONFIG, APIPath } from "../config";
import type { Link } from "../link/link";
import { Emitter } from "../util/emitter";
import { ConversationStream, ConversationTransport } from "./transport";
import { LinkConversationTransport } from "./transport_link";
import { SSEConversationTransport, streamSSE } from "./transport_sse";
import { RequestResponseV3, RequestResponseV4 } from "../types/type_registry";
import { RequestResponseV5 } from "../types/response/v5/dialogue_response_v5";
import { ConversationStateResponse } from "../types/state/convo_state_response";
import { formatURL } from "../util/url_formatter";
import { TurnProgressEntry } from "../types/response/v4/turn_registry_v4";
import { TurnProgressEntryV5 } from "../types/response/v5/turn_registry_v5";

export type DialogueRequestParams = {
    /** Unique identifier for the chat session */
    chatId?: string;
    /** The message to be sent to the AI */
    message: string;
    /** AI model to use for generating responses */
    model?: string;
    /** Additional instructions for location-specific context */
    instructions?: string;
    /** Platform where the chat is occurring */
    platform?: string;
    /** Custom personality configuration for the AI */
    personality?: string;
}

export type DialogueRequestOptions = Omit<Omit<DialogueRequestParams, "message">, "chatId">;

export interface RequestResponseByVersion {
    v3: RequestResponseV3;
    v4: RequestResponseV4;
    v5: RequestResponseV5;
}

interface TurnProgressEntryByVersion {
    v4: TurnProgressEntry;
    v5: TurnProgressEntryV5;
}

export type TurnProgressEntryForVersion<V extends APIPath> =
    V extends keyof TurnProgressEntryByVersion ? TurnProgressEntryByVersion[V] : TurnProgressEntry;

export type ConversationOptions<V extends APIPath = "v4"> = {
    /** The conversation ID to load the conversation from, server will error if this convo id doesn't exist */
    convoId?: string;
    /** The API key to use */
    apiKey: string;
    /** The server URL to use */
    serverUrl?: string;
    /** 
     * The path to append to the server URL specifying the API endpoint to use (specifically for conversations) 
     * @deprecated use convoPath instead
    */
    path?: string;
    /** The path to append to the server URL specifying the conversation API endpoint to use */
    convoPath?: string;
    /** The path to append to the server URL specifying the history API endpoint to use */
    historyPath?: string;
    /** The path to append to the server URL specifying the progress API endpoint to use */
    progressPath?: string;
    /** The path to append to the server URL specifying the progress stream API endpoint to use */
    progressStreamPath?: string;
    /** Whether to enable debug logs */
    debug?: boolean;
    /** The API version to use */
    chatApiV?: V;
    /**
     * How turns are carried.
     *
     * `"sse"` (the default) opens an HTTP stream per turn. Passing a connected `Link`
     * instead carries turns over that websocket, reusing a connection you already
     * have — everything else, including the payloads you receive, is identical.
     */
    transport?: "sse" | Link;
}

const DEFAULT_CONVO_API_V: APIPath = "v4";

export class Conversation<V extends APIPath = "v4"> {
    convoId?: string;
    apiKey: string;
    private debug: boolean;
    private chatApiV: V;
    private options?: DialogueRequestOptions
    private events = new Emitter<{ convoId: [string] }>();
    private transport: ConversationTransport;
    /** The link carrying this conversation, when it is not on SSE. */
    readonly link?: Link;

    private endpoints: {
        conversation: string,
        history: string,
        progressStream: string,
        progress: string,
    }

    constructor(config: ConversationOptions<V>) {
        this.convoId = config.convoId;
        this.chatApiV = (config.chatApiV || DEFAULT_CONVO_API_V) as V;

        const serverUrl = config.serverUrl || CONFIG.server;

        const progressConfig = (CONFIG.paths.progress as Record<string, { base: string; stream: string } | undefined>)[this.chatApiV];

        this.endpoints = {
            conversation: serverUrl + (config.convoPath || config.path || CONFIG.paths.conversation[this.chatApiV].base),
            history: serverUrl + (config.historyPath || CONFIG.paths.history.chat.v1.base),
            progressStream: serverUrl + (config.progressStreamPath || (progressConfig?.stream ?? CONFIG.paths.progress.v4.stream)),
            progress: serverUrl + (config.progressPath || (progressConfig?.base ?? CONFIG.paths.progress.v4.base)),
        }

        this.apiKey = config.apiKey;
        this.debug = config.debug || false;

        if (config.transport && config.transport !== "sse") {
            this.link = config.transport;
            this.transport = new LinkConversationTransport(config.transport, () => ({
                model: this.options?.model,
                personality: this.options?.personality,
                instructions: this.options?.instructions,
                platform: this.options?.platform,
            }));
        } else {
            this.transport = new SSEConversationTransport({
                endpoint: () => this.endpoints.conversation,
                apiKey: this.apiKey,
                debug: this.debug,
            });
        }
    }

    // SETTERS

    /** 
     * Sets the endpoint where the request is sent to, appended to server URL
     * @deprecated Use setConversationEndpoint() instead
     */
    setEndpoint(endpoint: string) {
        this.endpoints.conversation = endpoint;
        return this;
    }

    /** Sets the conversation endpoint where the request is sent to, appended to server URL */
    setConversationEndpoint(conversationEndpoint: string) {
        this.endpoints.conversation = conversationEndpoint;
        return this;
    }

    /** Sets the history endpoint where the quest is sent to, appended to server URL */
    setHistoryEndpoint(historyEndpoint: string) {
        this.endpoints.history = historyEndpoint;
        return this;
    }

    /** Sets the progress stream endpoint where the request is sent to, appended to server URL */
    setProgressStreamEndpoint(progressStreamEndpoint: string) {
        this.endpoints.progressStream = progressStreamEndpoint;
        return this;
    }

    /** Sets the progress endpoint where the request is sent to, appended to server URL */
    setProgressEndpoint(progressEndpoint: string) {
        this.endpoints.progress = progressEndpoint;
        return this;
    }

    /** Sets the conversation ID, has to be an existing conversation ID, undefined otherwise */
    setConvoId(convoId: string | undefined) {
        this.convoId = convoId;
        return this;
    }

    /** Sets the AI model used for the next interaction, e.g Claude-Sonnet, GPT-4 */
    setModel(model: string) {
        this.options = { ...this.options, model };
        return this;
    }

    /** Sets additional instructions for location-specific context */
    setInstructions(instructions: string) {
        this.options = { ...this.options, instructions };
        return this;
    }

    /** Sets the platform where the chat is occurring, used internally for logging - ignore in most contexts */
    setPlatform(platform: string) {
        this.options = { ...this.options, platform };
        return this;
    }

    /** Sets a custom personality configuration for the AI */
    setPersonality(personality: string) {
        this.options = { ...this.options, personality };
        return this;
    }

    // GETTERS

    /** Gets the current conversation ID */
    getConvoId() {
        return this.convoId;
    }

    /** 
     * Gets the current endpoint 
     * @deprecated Use getConversationEndpoint() instead
    */
    getEndpoint() {
        return this.endpoints.conversation;
    }

    /** Gets the current conversation endpoint */
    getConversationEndpoint() {
        return this.endpoints.conversation;
    }

    /** Gets the current history endpoint */
    getHistoryEndpoint() {
        return this.endpoints.history;
    }

    /** Gets the current progress stream endpoint */
    getProgressStreamEndpoint() {
        return this.endpoints.progressStream;
    }

    /** Gets the current progress endpoint */
    getProgressEndpoint() {
        return this.endpoints.progress;
    }

    /** Gets the current options object */
    getModel() {
        return this.options?.model;
    }

    /** Gets the current location-specific instructions */
    getInstructions() {
        return this.options?.instructions;
    }

    /** Gets the current platform */
    getPlatform() {
        return this.options?.platform;
    }

    /** Gets the current personality configuration */
    getPersonality() {
        return this.options?.personality;
    }

    // EVENT EMITTER

    /** 
     * Fires when the conversation ID is set 
     * if convoId is already set when this is called, fires immediately
     * */
    onConvoId(cb: (convoId: string) => any): string {
        if (this.convoId) cb(this.convoId);
        return this.events.on("convoId", cb);
    }

    /** Removes a convoId listener */
    offConvoId(listenerId: string) {
        this.events.off("convoId", listenerId);
    }

    /** 
     * Fires once when the conversation ID is set, then removes the listener.
     * If convoId is already set, fires immediately
     */
    onceConvoId(cb: (convoId: string) => any) {
        if (this.convoId) {
            cb(this.convoId);
            return;
        }
        return this.events.once("convoId", cb);
    }

    // GETTERS

    /** Fetches the conversation state from the server, including message history and metadata */
    async fetchState() {
        if (!this.convoId) throw new Error("Conversation ID is not set");

        const url = formatURL(`${this.endpoints.history}/${this.convoId}`, undefined, { apiKey: this.apiKey, debug: this.debug });
        const response = await fetch(url);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to fetch conversation state: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const data = await response.json() as ConversationStateResponse;
        return data;
    }

    /** Fetches the conversation progress stream from the server */
    fetchProgressStream(cb: (chunk: RequestResponseByVersion[V]) => any) {
        if (!this.convoId) throw new Error("Conversation ID is not set");

        const url = formatURL(this.endpoints.progressStream, { chatId: this.convoId }, { apiKey: this.apiKey, debug: this.debug });
        return streamSSE(url, { debug: this.debug, onPayload: (payload) => cb(payload as RequestResponseByVersion[V]) });
    }

    /** 
     * Fetches the conversation progress from the server 
     * Returns undefined if no active turn progress
    */
    async fetchProgress(options?: { lastEventId?: string, includeCompleted?: boolean }): Promise<TurnProgressEntryForVersion<V>[] | undefined> {
        if (!this.convoId) throw new Error("Conversation ID is not set");

        const payload: Record<string, any> = {
            chatId: this.convoId,
        }

        if (options?.includeCompleted !== undefined) payload["includeCompleted"] = options.includeCompleted;

        const url = formatURL(this.endpoints.progress, payload, { apiKey: this.apiKey, debug: this.debug });
        const response = await fetch(url, { headers: options?.lastEventId ? { "last-event-id": options.lastEventId } : undefined });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to fetch conversation progress: ${response.status} ${response.statusText} - ${errorText}`);
        }

        if (response.status === 204) return undefined; // No content

        const data = await response.json() as { success: boolean, events: TurnProgressEntryForVersion<V>[] };
        return data.events;
    }

    // LIFE CYCLE

    /** Sends a message into the conversation */
    send(message: string, cb: (chunk: RequestResponseByVersion[V]) => any, options?: DialogueRequestOptions): ConversationStream {
        return this.transport.send({
            message,
            ...this.options, // options set for convo
            ...options,      // overwrite convo's for this call
            ...(this.convoId ? { chatId: this.convoId } : {}),
        }, {
            payload: (payload) => cb(payload as RequestResponseByVersion[V]),
            convoId: (convoId) => {
                if (this.convoId === convoId) return;
                this.convoId = convoId;
                this.events.emit("convoId", convoId);
            },
        });
    }

    /**
     * Sends a message and resolves with the finished reply.
     *
     * For when you want the answer rather than the stream. Every event still arrives
     * through `onEvent` if you pass one.
     */
    ask(message: string, options?: DialogueRequestOptions & { onEvent?: (chunk: RequestResponseByVersion[V]) => any }) {
        return new Promise<{ text: string; convoId?: string; events: RequestResponseByVersion[V][] }>((resolve, reject) => {
            const events: RequestResponseByVersion[V][] = [];
            let text = "";

            this.send(message, (chunk) => {
                events.push(chunk);
                options?.onEvent?.(chunk);

                if (!chunk.success) {
                    reject(new Error(chunk.data.message || chunk.data.error || chunk.data.code));
                    return;
                }

                const response = chunk.data.response as { type: string; payload?: { message?: string; participantId?: string } };
                const metadata = (chunk.data.response as { metadata?: { participantId?: string } }).metadata;

                // Message chunks arrive cumulative, and Alfred's own notices are not part
                // of the reply, so they are collected but not concatenated into it.
                if (response.type === "message" && metadata?.participantId !== "system" && response.payload?.message) {
                    text = response.payload.message;
                }

                if (chunk.data.quitStream) resolve({ text, convoId: this.convoId, events });
            }, options);
        });
    }
}

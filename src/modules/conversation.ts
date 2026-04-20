import { EventSource } from "eventsource";
import { CONFIG } from "../config";
import { RequestResponseV3, RequestResponseV4 } from "../types/type_registry";
import { ConversationStateResponse } from "../types/state/convo_state_response";
import { formatURL } from "../util/url_formatter";

type SSEHandlerOptions = {
    /** Handler for when the ConvoId is received */
    onConvoId?: (convoId: string) => any;
}

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

type APIPath = keyof typeof CONFIG.paths.conversation;

export type ConversationOptions = {
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
    chatApiV?: APIPath;
}

const DEFAULT_CONVO_API_V: APIPath = "v4";
export type RequestResponse = RequestResponseV4;

export class Conversation {
    convoId?: string;
    apiKey: string;
    private debug: boolean;
    private options?: DialogueRequestOptions
    private events: Map<string, Map<string, Function>> = new Map();

    private endpoints: {
        conversation: string,
        history: string,
        progressStream: string,
        progress: string,
    }

    constructor(config: ConversationOptions) {
        this.convoId = config.convoId;

        const serverUrl = config.serverUrl || CONFIG.server;
        this.endpoints = {
            conversation: serverUrl + (config.convoPath || config.path || CONFIG.paths.conversation[config.chatApiV || DEFAULT_CONVO_API_V].base),
            history: serverUrl + (config.historyPath || CONFIG.paths.history.chat.v1.base),
            progressStream: serverUrl + (config.progressStreamPath || CONFIG.paths.progress.v4.stream),
            progress: serverUrl + (config.progressPath || CONFIG.paths.progress.v4.base),
        }

        this.apiKey = config.apiKey;
        this.debug = config.debug || false;
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

    private hasEmitter(event: string) {
        return this.events.has(event);
    }

    private addEmitter(event: string) {
        if (!this.hasEmitter(event)) this.events.set(event, new Map());
    }

    private removeEmitter(event: string) {
        this.events.delete(event);
    }

    private addListener(event: string, cb: Function) {
        if (!this.hasEmitter(event)) this.addEmitter(event);
        const listeners = this.events.get(event)!;
        const id = crypto.randomUUID();
        listeners.set(id, cb);
        return id;
    }

    private removeListener(event: string, id: string) {
        const listeners = this.events.get(event);
        if (listeners) listeners.delete(id);
    }

    private emit(event: string, ...args: any[]) {
        const listeners = this.events.get(event);
        if (listeners) listeners.forEach(listener => listener(...args));
    }

    /** 
     * Fires when the conversation ID is set 
     * if convoId is already set when this is called, fires immediately
     * */
    onConvoId(cb: (convoId: string) => any): string {
        if (this.convoId) cb(this.convoId);
        return this.addListener("convoId", cb);
    }

    /** Removes a convoId listener */
    offConvoId(listenerId: string) {
        this.removeListener("convoId", listenerId);
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
        const id = this.addListener("convoId", (convoId: string) => {
            cb(convoId);
            this.offConvoId(id);
        });
        return id;
    }

    // SSE HANDLER

    private handleSSE(url: string, cb: (chunk: RequestResponse) => any, options: SSEHandlerOptions = {}) {
        const sse = new EventSource(url);

        sse.addEventListener("message", (event) => {
            const data = JSON.parse(event.data) as RequestResponse;

            const convoId = data.success ? data.data.convoId : undefined;
            if (convoId && options.onConvoId) options.onConvoId(convoId);

            cb(data);
            if (data.data.quitStream) sse.close();
        });

        sse.addEventListener("error", (event) => {
            if (this.debug) console.warn(`[Stream Error: ${url}]`, event);
        });

        return sse;
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
    fetchProgressStream(cb: (chunk: RequestResponse) => any) {
        if (!this.convoId) throw new Error("Conversation ID is not set");

        const url = formatURL(this.endpoints.progressStream, { chatId: this.convoId }, { apiKey: this.apiKey, debug: this.debug });
        return this.handleSSE(url, cb);
    }

    /** 
     * Fetches the conversation progress from the server 
     * Returns undefined if no active turn progress
    */
    async fetchProgress(): Promise<RequestResponse[] | undefined> {
        if (!this.convoId) throw new Error("Conversation ID is not set");

        const url = formatURL(this.endpoints.progress, { chatId: this.convoId }, { apiKey: this.apiKey, debug: this.debug });
        const response = await fetch(url)

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to fetch conversation progress: ${response.status} ${response.statusText} - ${errorText}`);
        }

        if (response.status === 204) return undefined; // No content

        const data = await response.json() as { success: boolean; events: RequestResponse[] };
        return data.events;
    }

    // LIFE CYCLE

    /** Sends a message into the conversation */
    send(message: string, cb: (chunk: RequestResponse) => any, options?: DialogueRequestOptions) {
        const payload: Record<string, any> = {
            message,
            ...this.options, // options set for convo
            ...options // overwrite convos for this call
        };

        if (this.convoId) payload.chatId = this.convoId;

        const url = formatURL(this.endpoints.conversation, payload, { apiKey: this.apiKey, debug: this.debug });
        return this.handleSSE(url, cb, {
            onConvoId: (convoId) => {
                this.convoId = convoId;
                this.emit("convoId", convoId);
            }
        });
    }
}
import { EventSource } from "eventsource";
import { CONFIG } from "../config";
import { RequestResponseV3 } from "../types/type_registry";
import { ConversationStateResponse } from "../types/state/convo_state_response";

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
    /** Whether to enable debug logs */
    debug?: boolean;
    /** The API version to use */
    chatApiV?: APIPath;
}

const DEFAULT_CONVO_API_V: APIPath = "v3";
export type RequestResponse = RequestResponseV3;

export class Conversation {
    convoId?: string;
    apiKey: string;
    private debug: boolean;
    private options?: DialogueRequestOptions

    private endpoints: {
        conversation: string,
        history: string,
    }

    constructor(config: ConversationOptions) {
        this.convoId = config.convoId;

        const serverUrl = config.serverUrl || CONFIG.server;
        this.endpoints = {
            conversation: serverUrl + (config.convoPath || config.path || CONFIG.paths.conversation[config.chatApiV || DEFAULT_CONVO_API_V].base),
            history: serverUrl + (config.historyPath || CONFIG.paths.history.chat.v1.base),
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

    // HELPERS

    formatURL(url: string, params: Object = {}) {
        const fParams: { api_key: string } = {
            api_key: this.apiKey,
            ...params
        }
        const paramQuery = new URLSearchParams(fParams as any).toString();
        const fUrl = `${url}?${paramQuery}`;

        if (this.debug) {
            const debugUrl = new URL(fUrl);
            const apiKey = debugUrl.searchParams.get('api_key');
            if (apiKey) {
                const obscuredKey = apiKey.length > 6 ? `${apiKey.slice(0, 3)}...${apiKey.slice(-3)}` : '***';
                debugUrl.searchParams.set('api_key', obscuredKey);
            }
            console.log(`[Formatting URL ${debugUrl.toString()}]`);
        }

        return fUrl;
    }

    // GETTERS

    /** Fetches the conversation state from the server, including message history and metadata */
    async fetchState() {
        if (!this.convoId) throw new Error("Conversation ID is not set");

        const url = this.formatURL(`${this.endpoints.history}/${this.convoId}`);
        const response = await fetch(url);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to fetch conversation state: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const data = await response.json() as ConversationStateResponse;
        return data;
    }

    // LIFE CYCLE

    /** Sends a message into the conversation */
    async send(message: string, cb: (chunk: RequestResponse) => any, options?: DialogueRequestOptions): Promise<void> {
        const url = this.formatURL(this.endpoints.conversation, {
            message,
            ...this.options, // options set for convo
            ...options // overwrite convos for this call
        });

        const sse = new EventSource(url);

        sse.addEventListener("message", (event) => {
            const data = JSON.parse(event.data) as RequestResponse;

            const convoId = data.success ? data.data.convoId : undefined;
            if (convoId) this.convoId = convoId; // update convo id from response

            cb(data);
            if (data.data.quitStream) sse.close();
        });

        sse.addEventListener("error", (event) => {
            if (this.debug) console.warn(`[Stream Error: ${url}]`, event);
            cb({
                success: false,
                data: {
                    code: "STREAM_ERROR",
                    error: "Stream error",
                    message: event.message || "An error occurred while streaming",
                    quitStream: true
                }
            });
            sse.close();
        });
    }
}
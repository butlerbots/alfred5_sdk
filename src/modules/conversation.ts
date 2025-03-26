import { EventSource } from "eventsource";
import { CONFIG } from "../config";
import { RequestResponse } from "../types/dialogue_response_v3";

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

export type ConversationOptions = {
    /** The conversation ID to load the conversation from, server will error if this convo id doesn't exist */
    convoId?: string;
    /** The API key to use */
    apiKey: string;
    /** The server URL to use */
    serverUrl?: string;
    /** The path to append to the server URL specifying the API endpoint to use */
    path?: string;
    /** Whether to enable debug logs */
    debug?: boolean;
}

export class Conversation {
    convoId?: string;
    apiKey: string;
    private debug: boolean;
    private options?: DialogueRequestOptions
    private endpoint: string;

    constructor(config: ConversationOptions) {
        this.convoId = config.convoId;
        this.endpoint = (config.serverUrl || CONFIG.server) + (config.path || CONFIG.paths.conversation.v3.base);
        this.apiKey = config.apiKey;
        this.debug = config.debug || false;
    }

    // SETTERS

    /** Sets the endpoint where the request is sent to, appended to server URL */
    setEndpoint(endpoint: string) {
        this.endpoint = endpoint;
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

    /** Gets the current endpoint */
    getEndpoint() {
        return this.endpoint;
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

    // LIFE CYCLE

    /** Sends a message into the conversation */
    async send(message: string, cb: (chunk: RequestResponse) => any, options?: DialogueRequestOptions): Promise<void> {
        const params: DialogueRequestParams & { api_key: string } = {
            message,
            api_key: this.apiKey,
            ...this.options, // options set for convo
            ...options // overwrite convos for this call
        }
        if (this.convoId) params.chatId = this.convoId;

        const paramQuery = new URLSearchParams(params as any).toString();
        const url = `${this.endpoint}?${paramQuery}`;

        if (this.debug) {
            const debugUrl = new URL(url);
            const apiKey = debugUrl.searchParams.get('api_key');
            if (apiKey) {
                const obscuredKey = apiKey.length > 6 ? `${apiKey.slice(0, 3)}...${apiKey.slice(-3)}` : '***';
                debugUrl.searchParams.set('api_key', obscuredKey);
            }
            console.log(`[Requesting URL ${debugUrl.toString()}]`);
        }

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
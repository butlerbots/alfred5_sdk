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

export type ConversationOptions = {
    /** The conversation ID to load the conversation from, server will error if this convo id doesn't exist */
    convoId?: string;
    /** The API key to use */
    apiKey: string;
    /** The server URL to use */
    serverUrl?: string;
    /** The path to append to the server URL specifying the API endpoint to use */
    path?: string;
}

export class Conversation {
    convoId?: string;
    endpoint: string;
    apiKey: string;

    constructor(config: ConversationOptions) {
        this.convoId = config.convoId;
        this.endpoint = (config.serverUrl || CONFIG.server) + (config.path || CONFIG.paths.conversation.v3.base);
        this.apiKey = config.apiKey;
    }

    /** Sends a message into the conversation */
    async send(message: string, cb: (chunk: RequestResponse) => any): Promise<void> {
        const params: DialogueRequestParams & { api_key: string } = {
            message,
            api_key: this.apiKey,
            chatId: this.convoId,
        }

        const paramQuery = new URLSearchParams(params as any).toString();
        const url = `${this.endpoint}?${paramQuery}`;

        const sse = new EventSource(url);

        sse.onmessage = (event) => {
            const data = JSON.parse(event.data) as RequestResponse;
            if (data.payload.quitStream) sse.close();
            cb(data);
        }

        sse.onerror = (event) => {
            console.error(event);
        }
    }
}
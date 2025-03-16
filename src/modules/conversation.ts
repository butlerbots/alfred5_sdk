import { CONFIG } from "../config";

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
    async send(prompt: string) {
        
    }
}
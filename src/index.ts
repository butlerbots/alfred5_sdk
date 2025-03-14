import { Conversation, ConversationOptions } from "./modules/conversation";

export type ButlerBotClientOptions = {
    /** The server endpoint, API calls are sent here */
    serverUrl?: string;
    /** The API key to use with ButlerBot */
    apiKey: string;
}

export class ButlerBotClient {
    private apiKey: string;
    private serverUrl?: string;

    constructor(config: ButlerBotClientOptions) {
        this.apiKey = config.apiKey;
        this.serverUrl = config.serverUrl;
    }

    /** Spawns a new Conversation, inherits api key and server URL */
    createConversation(config: ConversationOptions = {}) {
        return new Conversation({ apiKey: this.apiKey, serverUrl: this.serverUrl, ...config });
    }
}

// Example:
const client = new ButlerBotClient({ apiKey: "sss" });
const convo = client.createConversation();
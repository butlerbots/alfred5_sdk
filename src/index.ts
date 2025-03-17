import { Conversation, ConversationOptions } from "./modules/conversation";

type OptionalApiKey<T> = Omit<T, "apiKey"> & {
    /** Optional API key, defaults to API key specified in client */
    apiKey?: string
};

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

    /** Checks the health of the server returning true if server is alive */
    async healthCheck(healthCheckPath: string = "/health"): Promise<boolean> {
        const url = `${this.serverUrl}${healthCheckPath}`;
        try {
            const response = await fetch(url);
            return response.ok;
        } catch (error) { return false }
    }

    /** Spawns a new Conversation, inherits api key and server URL */
    createConversation(config: OptionalApiKey<ConversationOptions> = {}) {
        return new Conversation({ apiKey: this.apiKey, serverUrl: this.serverUrl, ...config });
    }
}
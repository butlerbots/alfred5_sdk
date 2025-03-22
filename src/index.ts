import { CONFIG } from "./config";
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
    /** Whether to enable debug logs */
    debug?: boolean;
}

export class ButlerBotClient {
    private apiKey: string;
    private serverUrl: string;
    private debug: boolean;

    constructor(config: ButlerBotClientOptions) {
        this.apiKey = config.apiKey;
        this.serverUrl = config.serverUrl || CONFIG.server;
        this.debug = config.debug || false;
    }

    /** Checks the health of the server returning true if server is alive */
    async healthCheck(healthCheckPath: string = CONFIG.healthcheckPath): Promise<boolean> {
        const url = `${this.serverUrl}${healthCheckPath}`;
        try {
            const response = await fetch(url);
            return response.ok;
        } catch (error) {
            if (this.debug) console.warn("[Healthcheck Failure]", error);
            return false;
        }
    }

    /** Spawns a new Conversation, inherits api key and server URL */
    createConversation(config: OptionalApiKey<ConversationOptions> = {}) {
        return new Conversation({ debug: this.debug, apiKey: this.apiKey, serverUrl: this.serverUrl, ...config });
    }
}

// Expose types from subsequent modules
export { Conversation, ConversationOptions };
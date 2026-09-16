import { CONFIG, APIPath, resolveLinkUrl } from "./config";
import { Link, LinkOptions } from "./link";
import { Conversation, ConversationOptions } from "./modules/conversation";
import { getUsagePolicyData, UsagePolicyDataOptions } from "./modules/usage";

type OptionalApiKey<T> = Omit<T, "apiKey"> & {
    /** Optional API key, defaults to API key specified in client */
    apiKey?: string
};

export type ButlerBotClientOptions = {
    /** The server endpoint, API calls are sent here */
    serverUrl?: string;
    /**
     * Where links connect. Defaults to the hosted link service.
     *
     * Links are no longer carried by the core server, so this is a second address rather than
     * a path on the first. A `serverUrl` pointing at your own stack is used for links too,
     * unless this names somewhere else.
     */
    linkUrl?: string;
    /** The API key to use with ButlerBot */
    apiKey: string;
    /** Whether to enable debug logs */
    debug?: boolean;
}

export class ButlerBotClient {
    private apiKey: string;
    private serverUrl: string;
    private linkUrl: string;
    private debug: boolean;

    constructor(config: ButlerBotClientOptions) {
        this.apiKey = config.apiKey;
        this.serverUrl = config.serverUrl || CONFIG.server;
        this.linkUrl = resolveLinkUrl(config);
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
    createConversation<V extends APIPath = "v4">(config: OptionalApiKey<ConversationOptions<V>> = {}): Conversation<V> {
        return new Conversation<V>({ debug: this.debug, apiKey: this.apiKey, serverUrl: this.serverUrl, ...config } as ConversationOptions<V>);
    }

    /**
     * Creates a Link: a live connection that can register tools and hooks, and carry
     * conversations. Inherits the client's API key and link URL.
     *
     * The link URL, not the server URL: links are served by their own service. Pass
     * `serverUrl` here, or `linkUrl` to the client, to point somewhere else.
     */
    createLink(config: OptionalApiKey<LinkOptions>): Link {
        return new Link({ debug: this.debug, apiKey: this.apiKey, serverUrl: this.linkUrl, ...config } as LinkOptions);
    }

    /** Get current usage policy data */
    getUsagePolicyData(config: OptionalApiKey<UsagePolicyDataOptions>) {
        return getUsagePolicyData({ serverURL: this.serverUrl, apiKey: this.apiKey, debug: this.debug, ...config });
    }
}

// Expose types from subsequent modules
export * from "./types/type_registry";
export * from "./link";
export { Conversation };
export type { ConversationOptions };
export type { APIPath };
export type {
    ConversationStream,
    ConversationTransport,
    TransportTurnRequest,
    TransportHandlers,
} from "./modules/transport";
export { LinkConversationTransport } from "./modules/transport_link";
export { SSEConversationTransport } from "./modules/transport_sse";
export type { SteerResult, TurnStopMode, TurnStopped } from "./modules/transport";
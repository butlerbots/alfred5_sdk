export type ConversationOptions = {
    /** The conversation ID to load the conversation from, server will error if this convo id doesn't exist */
    convoId?: string;
    /** The API key to use */
    apiKey?: string;
    /** The server URL to use */
    serverUrl?: string;
}

export class Conversation {
    convoId?: string;

    constructor(config: ConversationOptions = {}) {
        this.convoId = config.convoId;
    }


}
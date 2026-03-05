export interface ConversationV1 {
    version?: "1.0"
    conversationId: string
    ownerUserId: string
    /** The actual profile data */
    profile: Object
}
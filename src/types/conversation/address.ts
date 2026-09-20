/**
 * Where a conversation lives on the platform it is being held on.
 *
 * Anything Alfred has to say on a conversation outside a turn — a background task reporting
 * what it found — is delivered to the address the conversation named. A conversation that
 * names none is answered wherever the platform's own default is, which on Discord is the
 * user's direct messages.
 *
 * An address is whole: a new one replaces the old outright rather than being merged into it,
 * so a conversation that moves out of a thread stops naming the thread it was in.
 */
export type ConversationAddress = DiscordAddress;

/**
 * A place on Discord.
 *
 * `channelId` is the guild text or forum channel, or the literal `"DM"` for the user's direct
 * messages. `threadId` is the thread or forum post inside that channel, when the conversation
 * is in one — a forum post being a thread whose channel is the forum.
 */
export type DiscordAddress = {
    platform: "discord";
    channelId: string;
    threadId?: string;
};

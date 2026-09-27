/**
 * Something a platform attaches beside a user's message, never inside it: what the message
 * replies to, who it mentions, where it was sent, the conversation around it.
 *
 * The text the user typed stays exactly what they typed. The model reads the items as a
 * labelled block after it; a person sees them as chips under the message, titled by `title`
 * and expandable to `text`.
 *
 * ```ts
 * { kind: "reply",    title: "Replying to", text: "Sam: what time does the store close?" }
 * { kind: "mentions", title: "Mentions",    text: "Sam (@sam) = <@123>, Alfred = <@456> (this is you)" }
 * ```
 *
 * Bounds, enforced by the server, which refuses a request over them with what is wrong rather
 * than clipping it: at most 8 items on a message, a `title` of at most 80 characters, a `text`
 * of at most 4 000, and 12 000 characters in all.
 */
export type MessageContextItem = {
    /**
     * What the item is: `reply`, `mentions`, `place` or `channel` today. The server holds the
     * list and refuses an unknown kind with the real ones, so a new kind needs no SDK change.
     */
    kind: string;
    /** What a person sees on the chip and the model on the block's line. At most 80 characters. */
    title: string;
    /** The content, as plain text. At most 4 000 characters. */
    text: string;
};

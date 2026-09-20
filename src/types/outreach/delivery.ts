import type { ConversationAddress } from "../conversation/address";
/**
 * Outreach: what Alfred has told or asked this user outside a chat, and their answers.
 *
 * A delivery is the record itself, so the inbox listing is the delivery rather than a
 * notification about one. Answering closes it, and when it belongs to a job the answer is put
 * on that job's inbox.
 */

export const DELIVERY_INTENTS = ["question", "update", "approval", "statement"] as const;

export type DeliveryIntent = typeof DELIVERY_INTENTS[number];

/** The intents that leave something outstanding until the user answers. */
export const ANSWERABLE_DELIVERY_INTENTS: readonly DeliveryIntent[] = ["question", "approval"];

export const DELIVERY_SURFACES = ["web", "discord"] as const;

/** Where a delivery was put. */
export type DeliverySurfaceName = typeof DELIVERY_SURFACES[number];

export const DELIVERY_SURFACE_STATUSES = ["pending", "sent", "failed"] as const;

export type DeliverySurfaceStatus = typeof DELIVERY_SURFACE_STATUSES[number];

/** How one surface's send went. */
export type DeliverySurface = {
    surface: DeliverySurfaceName;
    status: DeliverySurfaceStatus;
    /**
     * Where on the surface it was addressed, whole, as the conversation named it.
     *
     * Null when the conversation named none, in which case it went wherever the surface
     * reaches its user by default: on Discord, their direct messages.
     */
    address?: ConversationAddress | null;
    /** What the channel called the message it sent. */
    messageId?: string | null;
    /** Why the last attempt failed. */
    error?: string | null;
    attempts: number;
    /** When the last attempt was made, in UTC milliseconds. */
    lastAt: number;
};

export const DELIVERY_ANSWER_VIA = ["web", "discord", "chat", "tool"] as const;

/** Which surface the answer came back on. */
export type DeliveryAnsweredVia = typeof DELIVERY_ANSWER_VIA[number];

export const DELIVERY_CLOSED_REASONS = ["job_done", "job_failed", "job_cancelled"] as const;

/** Why a delivery was closed with nobody having answered it: what became of the job that asked. */
export type DeliveryClosedReason = typeof DELIVERY_CLOSED_REASONS[number];

/** A delivery closed unanswered, and when. */
export type DeliveryClosed = {
    at: number;
    reason: DeliveryClosedReason;
};

export const DELIVERY_SOURCES = ["shift", "runtime", "gate"] as const;

/**
 * Who wrote the delivery: a job shift asking with `reach_user`, the runtime telling the user
 * where a job stands, or the autonomy gate asking for an approval. Only a shift's own ask
 * holds a finished job open until it is answered.
 */
export type DeliverySource = typeof DELIVERY_SOURCES[number];

export type DeliveryAnswer = {
    at: number;
    text: string;
    via: DeliveryAnsweredVia;
    /** On an approval, what the user decided. */
    decision?: "approve" | "deny";
};

/** One delivery, as the inbox reads it. */
export type Delivery = {
    deliveryId: string;
    ownerUserId: string;
    /** The chat this is about, so answering opens the conversation it belongs to. */
    originConversationId: string | null;
    /** The job this is about, when it is about one. */
    jobId: string | null;
    intent: DeliveryIntent;
    /** What the caller had to say, as they said it: ids, figures, outcomes. */
    facts: string;
    /** What the user reads: the persona's telling of the facts, or the facts themselves. */
    message: string;
    surfaces: DeliverySurface[];
    /** Null until somebody answers. Only ever set once. */
    answered: DeliveryAnswer | null;
    /**
     * Set when the job this belonged to ended before anyone answered, and null otherwise.
     *
     * A closed delivery is no longer open, and answering it is refused: the server answers a
     * 409 the same way it does one already answered.
     */
    closed: DeliveryClosed | null;
    /** Who wrote it. Rows from before this was recorded read as `runtime`. */
    source: DeliverySource;
    created: number;
};

/** Whether a delivery is still waiting on the user: unanswered, and not closed under it. */
export function isDeliveryOpen(delivery: Delivery): boolean {
    return ANSWERABLE_DELIVERY_INTENTS.includes(delivery.intent) && !delivery.answered && !delivery.closed;
}

export type DeliveryListResponse = {
    success: true;
    deliveries: Delivery[];
    page: number;
    limit: number;
    total: number;
};

/** What became of the answer once it was handed to the job that asked. */
export type DeliveryAnswerJobResult = {
    jobId: string;
    /** What the job did with it, or "dropped" when it could not take it. */
    delivered: string;
    /** Why it could not be delivered, when it could not. */
    error?: string;
};

export type DeliveryAnswerResponse = {
    success: true;
    delivery: Delivery;
    /** Present only when the delivery belonged to a job. */
    job?: DeliveryAnswerJobResult;
};

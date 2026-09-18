import { CONFIG } from "../config";
import type { DeliveryAnswerResponse, DeliveryListResponse } from "../types/outreach";
import { formatURL } from "../util/url_formatter";
import { requestAPI } from "./api_request";

/** What every outreach call needs: where the server is, and who is asking. */
export type OutreachRequestOptions = {
    serverURL?: string;
    /** The base path for outreach, when it is not the default. */
    path?: string;
    apiKey: string;
    debug?: boolean;
};

export type ListDeliveriesOptions = OutreachRequestOptions & {
    /** 1-based. The first page when it is not given. */
    page?: number;
    /** How many deliveries per page. */
    limit?: number;
};

export type AnswerDeliveryOptions = OutreachRequestOptions & {
    deliveryId: string;
    /** The user's answer, in their own words. */
    text: string;
    /** On an approval, what they decided. */
    decision?: "approve" | "deny";
};

function outreachBase(options: OutreachRequestOptions): string {
    return (options.serverURL || CONFIG.server) + (options.path || CONFIG.paths.outreach.base);
}

/** Only what was actually given: `URLSearchParams` would otherwise send the word "undefined". */
function query(params: Record<string, string | number | undefined>): Record<string, string> {
    const given: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) given[key] = String(value);
    }
    return given;
}

/** A page of the inbox: what Alfred has told or asked this user outside a chat. */
export async function listDeliveries(options: ListDeliveriesOptions): Promise<DeliveryListResponse> {
    const url = formatURL(
        outreachBase(options),
        query({ page: options.page, limit: options.limit }),
        { apiKey: options.apiKey, debug: options.debug },
    );

    return requestAPI<DeliveryListResponse>({ url, action: "list deliveries" });
}

/**
 * Answers one delivery, which closes it and wakes the job that asked.
 *
 * A delivery somebody has already answered is a 409: the call throws a `ButlerBotAPIError`
 * whose `isConflict` is true and whose `body` still carries the delivery with the answer on it.
 */
export async function answerDelivery(options: AnswerDeliveryOptions): Promise<DeliveryAnswerResponse> {
    const url = formatURL(
        `${outreachBase(options)}/${encodeURIComponent(options.deliveryId)}/answer`,
        {},
        { apiKey: options.apiKey, debug: options.debug },
    );

    return requestAPI<DeliveryAnswerResponse>({
        url,
        method: "POST",
        body: options.decision === undefined ? { text: options.text } : { text: options.text, decision: options.decision },
        action: `answer delivery ${options.deliveryId}`,
    });
}

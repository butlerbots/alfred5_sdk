import { afterEach, describe, expect, it } from "bun:test";

import { ButlerBotClient, ButlerBotAPIError } from "../index";
import { CONFIG } from "../config";
import { answerDelivery, listDeliveries } from "../modules/outreach";
import type { Delivery } from "../types/outreach";
import { fakeFetch, pathOf, queryOf, type FakeFetch } from "./support/fake_fetch";

// =============================================
// THE INBOX OVER HTTP
// =============================================

/**
 * What Alfred has told or asked this user outside a chat, and answering one. The listing is the
 * delivery itself, so there is nothing to reconcile between a notification and a record.
 */

const KEY = "ap-abc_123";

let http: FakeFetch | undefined;

afterEach(() => {
    http?.restore();
    http = undefined;
});

function delivery(overrides: Partial<Delivery> = {}): Delivery {
    return {
        deliveryId: "delivery_1",
        ownerUserId: "user_1",
        originConversationId: "convo_1",
        jobId: "job_1",
        intent: "question",
        message: "Which of these two flats should I book a viewing for?",
        surfaces: [{ surface: "discord", status: "sent", channelId: "DM", messageId: "m1", attempts: 1, lastAt: 1700000000000 }],
        answered: null,
        created: 1699999000000,
        ...overrides,
    };
}

describe("Listing deliveries", () => {
    it("asks the inbox with the key and the page it was given", async () => {
        http = fakeFetch({ body: { success: true, deliveries: [delivery()], page: 3, limit: 10, total: 21 } });

        const listed = await listDeliveries({ apiKey: KEY, serverURL: "https://core.test", page: 3, limit: 10 });

        const call = http.only();
        expect(call.method).toBe("GET");
        expect(pathOf(call)).toBe(`https://core.test${CONFIG.paths.outreach.base}`);
        expect(queryOf(call)).toEqual({ api_key: KEY, page: "3", limit: "10" });
        expect(listed.deliveries[0].deliveryId).toBe("delivery_1");
        expect(listed.deliveries[0].surfaces[0].surface).toBe("discord");
        expect(listed.total).toBe(21);
    });

    it("sends only the paging it was actually given, and defaults to the hosted core", async () => {
        http = fakeFetch({ body: { success: true, deliveries: [], page: 1, limit: 20, total: 0 } });

        await listDeliveries({ apiKey: KEY });

        expect(queryOf(http.only())).toEqual({ api_key: KEY });
        expect(pathOf(http.only())).toBe(`${CONFIG.server}${CONFIG.paths.outreach.base}`);
    });
});

describe("Answering a delivery", () => {
    it("posts the answer to the delivery's own path", async () => {
        http = fakeFetch({
            body: {
                success: true,
                delivery: delivery({ answered: { at: 1700000100000, text: "The one in Gardens", via: "web" } }),
                job: { jobId: "job_1", delivered: "woken" },
            },
        });

        const answered = await answerDelivery({ apiKey: KEY, serverURL: "https://core.test", deliveryId: "delivery_1", text: "The one in Gardens" });

        const call = http.only();
        expect(call.method).toBe("POST");
        expect(pathOf(call)).toBe("https://core.test/api/outreach/delivery_1/answer");
        expect(call.headers["Content-Type"]).toBe("application/json");
        expect(call.body).toEqual({ text: "The one in Gardens" });
        expect(answered.delivery.answered?.via).toBe("web");
        expect(answered.job?.delivered).toBe("woken");
    });

    it("sends a decision only when the answer is one", async () => {
        http = fakeFetch({ body: { success: true, delivery: delivery({ intent: "approval" }) } });

        await answerDelivery({ apiKey: KEY, deliveryId: "delivery_2", text: "Go ahead", decision: "approve" });

        expect(http.only().body).toEqual({ text: "Go ahead", decision: "approve" });
    });

    it("escapes the id rather than pasting it into the path", async () => {
        http = fakeFetch({ body: { success: true, delivery: delivery() } });

        await answerDelivery({ apiKey: KEY, deliveryId: "d 1/../2", text: "Yes" });

        expect(new URL(http.only().url).pathname).toBe("/api/outreach/d%201%2F..%2F2/answer");
    });

    it("tells one already answered apart from one that is missing", async () => {
        const already = delivery({ answered: { at: 1700000100000, text: "Already said so", via: "discord" } });
        http = fakeFetch({
            status: 409,
            statusText: "Conflict",
            body: { success: false, error: "Already answered", errormessage: "Delivery delivery_1 is not waiting on an answer", delivery: already },
        });

        const failure = await answerDelivery({ apiKey: KEY, deliveryId: "delivery_1", text: "The one in Gardens" }).catch(error => error);

        expect(failure).toBeInstanceOf(ButlerBotAPIError);
        expect(failure.isConflict).toBe(true);
        expect(failure.errormessage).toBe("Delivery delivery_1 is not waiting on an answer");
        // The refusal carries the delivery, so a caller can show the answer that got there first.
        expect((failure.body as { delivery: Delivery }).delivery.answered?.text).toBe("Already said so");
    });

    it("throws with the status when the delivery is not this key's", async () => {
        http = fakeFetch({ status: 404, statusText: "Not Found", body: { success: false, error: "Not found", errormessage: "No delivery delivery_9 belongs to you" } });

        const failure = await answerDelivery({ apiKey: KEY, deliveryId: "delivery_9", text: "Yes" }).catch(error => error);

        expect(failure.status).toBe(404);
        expect(failure.isNotFound).toBe(true);
        expect(failure.isConflict).toBe(false);
    });

    it("refuses an answer the server did not accept, whatever the status said", async () => {
        // A 200 that is not a success is still a failure; nothing downstream should read it as one.
        http = fakeFetch({ body: { success: false, error: "Nope" } });

        const failure = await listDeliveries({ apiKey: KEY }).catch(error => error);

        expect(failure).toBeInstanceOf(ButlerBotAPIError);
        expect(failure.error).toBe("Nope");
    });
});

describe("Through the client", () => {
    it("uses the client's key and server when the call names neither", async () => {
        http = fakeFetch({ body: { success: true, deliveries: [], page: 1, limit: 20, total: 0 } });
        const client = new ButlerBotClient({ apiKey: KEY, serverUrl: "https://core.test" });

        await client.listDeliveries();

        expect(pathOf(http.only())).toBe("https://core.test/api/outreach");
        expect(queryOf(http.only()).api_key).toBe(KEY);
    });

    it("carries a call's own key over the client's", async () => {
        http = fakeFetch({ body: { success: true, delivery: delivery() } });
        const client = new ButlerBotClient({ apiKey: KEY, serverUrl: "https://core.test" });

        await client.answerDelivery({ deliveryId: "delivery_1", text: "Yes", apiKey: "ap-other_999" });

        expect(queryOf(http.only()).api_key).toBe("ap-other_999");
    });
});

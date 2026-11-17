import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";

import { signWebhook, verifyWebhookSignature, WEBHOOK_TOLERANCE_SECONDS } from "../modules/webhooks";

// =============================================
// WEBHOOK SIGNATURES
// =============================================

/**
 * The same signatures the server checks on a user's inbound webhook: what `signWebhook` makes
 * verifies, a body changed by one byte does not, and each sender's own scheme reads as it sends it.
 */

const SECRET = "whsec_test";
const NOW = 1_780_000_000_000;
const hex = (payload: string) => createHmac("sha256", SECRET).update(payload).digest("hex");

describe("webhook signatures", () => {
    it("signs the alfred scheme so it verifies, and nothing else does", async () => {
        const body = JSON.stringify({ door: "open" });
        const headers = await signWebhook({ secret: SECRET, body, now: NOW });
        expect(headers["X-Alfred-Signature"]).toBe(`sha256=${hex(`${headers["X-Alfred-Timestamp"]}.${body}`)}`);
        expect(await verifyWebhookSignature({ scheme: "alfred", secret: SECRET, body, headers, now: NOW })).toEqual({ ok: true });
        expect((await verifyWebhookSignature({ scheme: "alfred", secret: SECRET, body: `${body} `, headers, now: NOW })).ok).toBe(false);
        expect(await verifyWebhookSignature({ scheme: "alfred", secret: SECRET, body, headers, now: NOW + (WEBHOOK_TOLERANCE_SECONDS + 1) * 1000 })).toEqual({ ok: false, reason: "the timestamp is too far from now" });
    });

    it("reads GitHub's and Stripe's headers as they send them, from a Headers or a plain object", async () => {
        const body = "{\"action\":\"opened\"}";
        expect(await verifyWebhookSignature({ scheme: "github", secret: SECRET, body, headers: new Headers({ "X-Hub-Signature-256": `sha256=${hex(body)}` }) })).toEqual({ ok: true });
        expect((await verifyWebhookSignature({ scheme: "github", secret: "other", body, headers: { "x-hub-signature-256": `sha256=${hex(body)}` } })).ok).toBe(false);
        const t = String(NOW / 1000);
        const stripe = { "Stripe-Signature": `t=${t},v1=00ff,v1=${hex(`${t}.${body}`)}` };
        expect(await verifyWebhookSignature({ scheme: "stripe", secret: SECRET, body: new TextEncoder().encode(body), headers: stripe, now: NOW })).toEqual({ ok: true });
        expect(await verifyWebhookSignature({ scheme: "stripe", secret: SECRET, body, headers: {}, now: NOW })).toEqual({ ok: false, reason: "Stripe-Signature is missing" });
    });
});

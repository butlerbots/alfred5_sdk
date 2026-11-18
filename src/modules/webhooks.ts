/**
 * WEBHOOK SIGNATURES
 * ==================
 *
 * The user's inbound webhooks (`POST <core>/api/hooks/in/<hookId>`, made by Alfred's
 * `webhook_create`) check a delivery's signature before it becomes a hook event. These helpers
 * make and check the same signatures, so an app can send to a webhook (`signWebhook`, the
 * `alfred` scheme) or check a delivery it receives itself (`verifyWebhookSignature`, any scheme):
 *
 * - `alfred`: `X-Alfred-Timestamp: <unix seconds>` and `X-Alfred-Signature: sha256=<hex>`, an
 *   HMAC-SHA256 under the secret of `"<timestamp>.<body>"`.
 * - `github`: `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256 of the body.
 * - `stripe`: `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=…]`, an HMAC-SHA256 of `"<t>.<body>"`.
 *
 * A timestamped scheme refuses a timestamp more than `toleranceSeconds` (300 by default) from now.
 * Web Crypto only, so it runs in Node 18+, Bun, Deno and browsers; every comparison is constant-time.
 */

export type WebhookScheme = "alfred" | "github" | "stripe";

/** The default for how far a signed timestamp may be from now, either way. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type WebhookVerification = { ok: true } | { ok: false; reason: string };

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

async function subtle(): Promise<SubtleCrypto> {
    const global = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto;
    if (global?.subtle) return global.subtle;
    const node = await import("node:crypto");
    return (node.webcrypto as unknown as { subtle: SubtleCrypto }).subtle;
}

function bytesOf(value: string | Uint8Array): Uint8Array {
    return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

async function hmacHex(secret: string, payload: Uint8Array): Promise<string> {
    const crypto = await subtle();
    const key = await crypto.importKey("raw", bytesOf(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = new Uint8Array(await crypto.sign("HMAC", key, payload as BufferSource));
    return Array.from(signature, byte => byte.toString(16).padStart(2, "0")).join("");
}

function sameText(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return difference === 0;
}

function header(headers: HeaderSource, name: string): string | undefined {
    if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
    const record = headers as Record<string, string | string[] | undefined>;
    const found = Object.keys(record).find(key => key.toLowerCase() === name);
    const value = found ? record[found] : undefined;
    return Array.isArray(value) ? value[0] : value;
}

function fresh(timestamp: string | undefined, nowSeconds: number, tolerance: number): boolean {
    return !!timestamp && /^\d{1,12}$/.test(timestamp) && Math.abs(nowSeconds - Number(timestamp)) <= tolerance;
}

/**
 * Whether a delivery carries its webhook's signature. `body` is the raw body exactly as it
 * arrived (a string or bytes), never a parsed and re-serialised object, since the signature is
 * over the bytes.
 */
export async function verifyWebhookSignature(options: {
    scheme: WebhookScheme;
    secret: string;
    body: string | Uint8Array;
    headers: HeaderSource;
    toleranceSeconds?: number;
    /** Now, in ms; for a test. */
    now?: number;
}): Promise<WebhookVerification> {
    const body = bytesOf(options.body);
    const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
    const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;

    if (options.scheme === "github") {
        const given = header(options.headers, "x-hub-signature-256");
        if (!given?.startsWith("sha256=")) return { ok: false, reason: "X-Hub-Signature-256 is missing" };
        return sameText(await hmacHex(options.secret, body), given.slice(7).toLowerCase()) ? { ok: true } : { ok: false, reason: "the signature does not match" };
    }

    if (options.scheme === "alfred") {
        const timestamp = header(options.headers, "x-alfred-timestamp");
        const given = header(options.headers, "x-alfred-signature");
        if (!timestamp || !given?.startsWith("sha256=")) return { ok: false, reason: "X-Alfred-Timestamp and X-Alfred-Signature are required" };
        if (!fresh(timestamp, nowSeconds, tolerance)) return { ok: false, reason: "the timestamp is too far from now" };
        const expected = await hmacHex(options.secret, concat(bytesOf(`${timestamp}.`), body));
        return sameText(expected, given.slice(7).toLowerCase()) ? { ok: true } : { ok: false, reason: "the signature does not match" };
    }

    const given = header(options.headers, "stripe-signature");
    if (!given) return { ok: false, reason: "Stripe-Signature is missing" };
    const parts = given.split(",").map(part => part.trim().split("="));
    const timestamp = parts.find(([key]) => key === "t")?.[1];
    const signatures = parts.filter(([key, value]) => key === "v1" && value).map(([, value]) => value!.toLowerCase());
    if (!timestamp || !signatures.length) return { ok: false, reason: "Stripe-Signature holds no t and v1" };
    if (!fresh(timestamp, nowSeconds, tolerance)) return { ok: false, reason: "the timestamp is too far from now" };
    const expected = await hmacHex(options.secret, concat(bytesOf(`${timestamp}.`), body));
    return signatures.some(signature => sameText(expected, signature)) ? { ok: true } : { ok: false, reason: "the signature does not match" };
}

/**
 * The headers that sign `body` for a webhook of the `alfred` scheme: send them with the body,
 * byte for byte as signed, to the webhook's URL.
 */
export async function signWebhook(options: { secret: string; body: string | Uint8Array; /** Now, in ms; for a test. */ now?: number }): Promise<{ "X-Alfred-Timestamp": string; "X-Alfred-Signature": string }> {
    const timestamp = String(Math.floor((options.now ?? Date.now()) / 1000));
    const signature = await hmacHex(options.secret, concat(bytesOf(`${timestamp}.`), bytesOf(options.body)));
    return { "X-Alfred-Timestamp": timestamp, "X-Alfred-Signature": `sha256=${signature}` };
}

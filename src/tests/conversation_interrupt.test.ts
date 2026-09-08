import { describe, expect, it } from "bun:test";

import { Conversation } from "../modules/conversation";

/**
 * Stopping and steering over the HTTP transport.
 *
 * The turn itself is a GET that streams until it is done, so an interruption travels on its
 * own request. These run against a real socket, like the rest of the SSE suite.
 */

type Request = { path: string; body: Record<string, unknown> };

function interruptServer(reply: (path: string) => Response) {
    const requests: Request[] = [];

    const server = Bun.serve({
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
            requests.push({ path: url.pathname, body: body as Record<string, unknown> });
            return reply(url.pathname);
        },
    });

    return { server, requests, url: `http://localhost:${server.port}` };
}

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function conversation(url: string) {
    const convo = new Conversation({ apiKey: "key", serverUrl: url, chatApiV: "v4" });
    convo.setConvoId("convo-1");
    return convo;
}

describe("stopping a turn over SSE", () => {
    it("asks the server to stop and reports how it was applied", async () => {
        const { server, requests, url } = interruptServer(() =>
            json(200, { success: true, stop: { mode: "hard", requestedMode: "hard", by: "user" } }));

        const stop = await conversation(url).stop("hard");

        expect(stop).toEqual({ mode: "hard", requestedMode: "hard", by: "user" });
        expect(requests[0].path).toBe("/api/alfred/v4/chat/stop");
        expect(requests[0].body).toMatchObject({ chatId: "convo-1", mode: "hard" });

        server.stop(true);
    });

    it("defaults to a soft stop", async () => {
        // The stop button's default: it keeps the text and works on every model.
        const { server, requests, url } = interruptServer(() =>
            json(200, { success: true, stop: { mode: "soft", requestedMode: "soft", by: "user" } }));

        await conversation(url).stop();

        expect(requests[0].body).toMatchObject({ mode: "soft" });
        server.stop(true);
    });

    it("reports the downgrade when the model could not be cut off", async () => {
        // Asked for hard, got soft: the provider bills the whole generation either way, so the
        // server finished it rather than paying for tokens nobody would ever see.
        const { server, url } = interruptServer(() =>
            json(200, { success: true, stop: { mode: "soft", requestedMode: "hard", by: "user" } }));

        const stop = await conversation(url).stop("hard");

        expect(stop).toMatchObject({ mode: "soft", requestedMode: "hard" });
        server.stop(true);
    });

    it("treats a turn that already finished as nothing to stop", async () => {
        const { server, url } = interruptServer(() => json(404, { success: false }));

        expect(await conversation(url).stop()).toBeUndefined();
        server.stop(true);
    });

    it("does not reach for the network before there is a conversation", async () => {
        const { server, requests, url } = interruptServer(() => json(200, { success: true }));
        const convo = new Conversation({ apiKey: "key", serverUrl: url, chatApiV: "v4" });

        expect(await convo.stop()).toBeUndefined();
        expect(requests).toEqual([]);

        server.stop(true);
    });
});

describe("steering a turn over SSE", () => {
    it("hands the message to the running turn", async () => {
        const { server, requests, url } = interruptServer(() => json(200, { success: true }));

        expect(await conversation(url).steer("actually, keep it short")).toEqual({ ok: true });
        expect(requests[0].path).toBe("/api/alfred/v4/chat/steer");
        expect(requests[0].body).toMatchObject({ chatId: "convo-1", message: "actually, keep it short" });

        server.stop(true);
    });

    it("says `too_late` so the caller resends rather than drops the message", async () => {
        // The whole contract of a refusal: the user typed something, and it must end up
        // somewhere. A 409 means send it as an ordinary turn instead.
        const { server, url } = interruptServer(() => json(409, { success: false }));

        expect(await conversation(url).steer("wait")).toEqual({ ok: false, reason: "too_late" });
        server.stop(true);
    });

    it("says `no_turn` when there is nothing running", async () => {
        const { server, url } = interruptServer(() => json(404, { success: false }));

        expect(await conversation(url).steer("hello?")).toEqual({ ok: false, reason: "no_turn" });
        server.stop(true);
    });
});

import { describe, expect, it } from "bun:test";

import { ButlerBotClient, LinkOptions } from "../index";
import { CONFIG, resolveLinkUrl } from "../config";
import { FakeSocket, flush } from "./support/fake_link";

// =============================================
// WHERE A LINK CONNECTS
// =============================================

/**
 * Links are not served by the core server any more: they are their own service. The SDK went
 * on dialling the core URL for them, so every link opened by a client that had not been told
 * otherwise went to a host that no longer answers them.
 */

describe("Choosing the link server", () => {
    it("uses the link service by default, not the core server", () => {
        expect(resolveLinkUrl({})).toBe("https://link.butler.now");
        expect(resolveLinkUrl({})).not.toBe(CONFIG.server);
    });

    it("takes a link URL at its word", () => {
        expect(resolveLinkUrl({ linkUrl: "https://link.example.test" })).toBe("https://link.example.test");
        expect(resolveLinkUrl({ linkUrl: "http://localhost:3100", serverUrl: "http://localhost:3000" })).toBe("http://localhost:3100");
    });

    it("follows a server URL that names somewhere other than the hosted core", () => {
        // A self-hosted stack is usually one address, and sending somebody's API key to a host
        // they never named would be a far worse surprise than a wrong path.
        expect(resolveLinkUrl({ serverUrl: "http://localhost:3000" })).toBe("http://localhost:3000");
        expect(resolveLinkUrl({ serverUrl: "https://alfred.example.test" })).toBe("https://alfred.example.test");
    });

    it("reads the hosted core as a request for the hosted platform, link included", () => {
        // Naming the production core explicitly is how most callers write it down, and it is
        // not a request to carry links there.
        expect(resolveLinkUrl({ serverUrl: CONFIG.server })).toBe(CONFIG.link);
        expect(resolveLinkUrl({ serverUrl: `${CONFIG.server}/` })).toBe(CONFIG.link);
    });

    it("dials the link service for a link the client creates", async () => {
        const urls: string[] = [];
        const client = new ButlerBotClient({ apiKey: "ap-abc_123" });
        const link = client.createLink({
            linkId: "coffee",
            reconnect: false,
            socketFactory: (url, protocols, handlers) => {
                urls.push(url);
                return new FakeSocket(url, protocols, handlers);
            },
        });

        void link.connect().catch(() => undefined);
        await flush();
        link.close();

        expect(urls).toHaveLength(1);
        expect(urls[0].startsWith("wss://link.butler.now/")).toBe(true);
    });
});

// =============================================
// AN OPTION THAT WAS NEVER SET
// =============================================

/**
 * Callers forward optional settings straight through — `createLink({ serverUrl: env.LINK_URL })`
 * — so a value nobody configured arrives as an explicit `undefined`. Spread over the client's
 * own resolved URL it used to erase it, which sent a self-hosted client's links to the hosted
 * service. Absent has to mean "not given".
 */

/** Dials a link through a socket that goes nowhere, and reports the URL it asked for. */
async function dialledUrl(client: ButlerBotClient, config: Partial<LinkOptions> = {}): Promise<string> {
    const urls: string[] = [];
    const link = client.createLink({
        linkId: "coffee",
        reconnect: false,
        socketFactory: (url, protocols, handlers) => {
            urls.push(url);
            return new FakeSocket(url, protocols, handlers);
        },
        ...config,
    });

    void link.connect().catch(() => undefined);
    await flush();
    link.close();

    expect(urls).toHaveLength(1);
    return urls[0];
}

describe("Passing an option that is not set", () => {
    it("still reaches the link service when a link's server URL is undefined", async () => {
        const client = new ButlerBotClient({ apiKey: "ap-abc_123" });

        expect(await dialledUrl(client, { serverUrl: undefined })).toStartWith("wss://link.butler.now/");
    });

    it("keeps a self-hosted client's server when a link's server URL is undefined", async () => {
        const client = new ButlerBotClient({ apiKey: "ap-abc_123", serverUrl: "http://localhost:3000" });

        expect(await dialledUrl(client, { serverUrl: undefined })).toStartWith("ws://localhost:3000/");
    });

    it("keeps the client's API key when a link's API key is undefined", async () => {
        const client = new ButlerBotClient({ apiKey: "ap-abc_123" });
        const link = client.createLink({ linkId: "coffee", reconnect: false, apiKey: undefined });

        expect((link as unknown as { options: LinkOptions }).options.apiKey).toBe("ap-abc_123");
    });

    it("lets a link's own server URL win over everything the client resolved", async () => {
        const client = new ButlerBotClient({ apiKey: "ap-abc_123", linkUrl: "https://link.example.test" });

        expect(await dialledUrl(client, { serverUrl: "wss://explicit.example.test" })).toStartWith("wss://explicit.example.test/");
    });

    it("keeps a self-hosted client's server for a conversation asked for with no URL", () => {
        const client = new ButlerBotClient({ apiKey: "ap-abc_123", serverUrl: "http://localhost:3000" });
        const convo = client.createConversation({ serverUrl: undefined });

        const endpoints = (convo as unknown as { endpoints: { conversation: string } }).endpoints;
        expect(endpoints.conversation.startsWith("http://localhost:3000/")).toBe(true);
    });
});

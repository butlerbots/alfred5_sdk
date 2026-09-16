import { describe, expect, it } from "bun:test";

import { ButlerBotClient } from "../index";
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

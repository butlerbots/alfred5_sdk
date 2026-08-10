import type { ServerWebSocket } from "bun";

import { Link } from "../link/link";
import { Tool } from "../link/tool";
import { LinkClientFrame } from "../link/protocol";

/**
 * The default socket path, end to end.
 *
 * Everything else stubs the socket, which cannot catch a wrong URL, a rejected
 * subprotocol, or framing that only breaks on a real connection.
 */

type Frame = LinkClientFrame & { id: string };

/** A server that speaks just enough of the protocol to get a link connected. */
function linkServer() {
    const received: Frame[] = [];
    const handshakes: { url: string; protocol: string | undefined }[] = [];

    const server = Bun.serve({
        port: 0,
        fetch(request, server) {
            handshakes.push({
                url: request.url,
                protocol: request.headers.get("sec-websocket-protocol") ?? undefined,
            });

            if (server.upgrade(request)) return undefined;
            return new Response("expected a websocket upgrade", { status: 400 });
        },
        websocket: {
            message(ws: ServerWebSocket<unknown>, raw: string | Buffer) {
                const frame = JSON.parse(String(raw)) as Frame;
                received.push(frame);

                const reply = (type: string, payload: unknown) =>
                    ws.send(JSON.stringify({ v: 1, id: `s${received.length}`, type, payload, replyTo: frame.id }));

                if (frame.type === "hello") {
                    reply("welcome", { connectionId: "conn-1", linkId: frame.payload.linkId, scope: "user", protocolVersion: 1 });
                    return;
                }

                if (frame.type === "tool.register") {
                    reply("ack", { ids: frame.payload.tools.map(tool => `link:${"coffee"}/${tool.localId}`) });

                    // Then use the tool, which is the whole point of registering it.
                    ws.send(JSON.stringify({
                        v: 1,
                        id: "call-frame",
                        type: "tool.call",
                        payload: {
                            callId: "call-1",
                            localId: frame.payload.tools[0].localId,
                            args: { cups: 2 },
                            meta: { userId: "us-aaa", runId: "run-1" },
                            timeoutMs: 5_000,
                        },
                    }));
                }
            },
        },
    });

    return { server, received, handshakes, url: `http://localhost:${server.port}` };
}

describe("A link over a real socket", () => {
    it("connects, registers, and answers a tool call", async () => {
        const { server, received, handshakes, url } = linkServer();

        try {
            const link = new Link({ apiKey: "ap-abc_123", linkId: "coffee", serverUrl: url, heartbeatMs: 0, reconnect: false });
            link.addTool(new Tool({
                id: "brew",
                description: "Brew coffee",
                run: ({ args, status }) => {
                    status.update("Grinding");
                    return `brewed ${(args as { cups: number }).cups}`;
                },
            }));

            await link.connect();
            expect(link.connectionId).toBe("conn-1");
            expect(link.scope).toBe("user");

            // The service and credential travel where a browser can put them.
            expect(handshakes[0].url).toContain("service=link");
            expect(handshakes[0].protocol).toContain("butler.service.link");
            expect(handshakes[0].protocol).toContain("butler.key.ap-abc_123");
            expect(handshakes[0].url).not.toContain("api_key");

            await Bun.sleep(50);

            const result = received.find(frame => frame.type === "tool.result");
            expect(result?.payload).toEqual({ ok: true, output: "brewed 2" });
            expect(received.find(frame => frame.type === "tool.status")?.payload).toMatchObject({ label: "Grinding" });

            link.close();
        } finally {
            server.stop(true);
        }
    });

    it("reconnects on its own after the connection is lost", async () => {
        // What a Railway deploy looks like from the client's side: the socket goes, the
        // server comes back, and the link has to re-declare everything unprompted.
        const first = linkServer();
        const port = first.server.port;

        const link = new Link({
            apiKey: "ap-abc_123",
            linkId: "coffee",
            serverUrl: `http://localhost:${port}`,
            heartbeatMs: 0,
            minReconnectDelayMs: 5,
            maxReconnectDelayMs: 20,
        });
        link.addTool(new Tool({ id: "brew", description: "Brew coffee", run: () => "done" }));

        try {
            await link.connect();
            expect(link.connectionId).toBe("conn-1");

            // `true` closes the open sockets too, which is what the client must notice.
            first.server.stop(true);

            const restarted = restartedLinkServer(port);
            try {
                await Bun.sleep(300);

                expect(restarted.received.some(frame => frame.type === "hello")).toBe(true);
                // The server keeps nothing between connections, so this must come back.
                expect(restarted.received.some(frame => frame.type === "tool.register")).toBe(true);
                expect(link.connectionId).toBe("conn-2");
            } finally {
                restarted.server.stop(true);
            }
        } finally {
            link.close();
            first.server.stop(true);
        }
    });
});

/** The same server again on the same port, standing in for a restarted deploy. */
function restartedLinkServer(port: number) {
    const received: Frame[] = [];

    const server = Bun.serve({
        port,
        fetch(request, server) {
            if (server.upgrade(request)) return undefined;
            return new Response("expected a websocket upgrade", { status: 400 });
        },
        websocket: {
            message(ws: ServerWebSocket<unknown>, raw: string | Buffer) {
                const frame = JSON.parse(String(raw)) as Frame;
                received.push(frame);

                if (frame.type === "hello") {
                    ws.send(JSON.stringify({
                        v: 1, id: "s1", type: "welcome", replyTo: frame.id,
                        payload: { connectionId: "conn-2", linkId: frame.payload.linkId, scope: "user", protocolVersion: 1 },
                    }));
                }

                if (frame.type === "tool.register") {
                    ws.send(JSON.stringify({ v: 1, id: "s2", type: "ack", replyTo: frame.id, payload: { ids: ["link:coffee/brew"] } }));
                }
            },
        },
    });

    return { server, received };
}

import { Link } from "../../link/link";
import { LinkClientFrame, LinkServerFrame, LinkServerFrameType, LinkServerPayloads } from "../../link/protocol";
import { SocketHandlers } from "../../link/socket";

type ClientFrameType = LinkClientFrame["type"];

/** A socket that goes nowhere, so a link can be driven frame by frame. */
export class FakeSocket {
    readonly sent: LinkClientFrame[] = [];
    closed?: { code?: number; reason?: string };
    private serverFrames = 0;

    constructor(readonly url: string, readonly protocols: string[], private readonly handlers: SocketHandlers) { }

    send(data: string): void {
        this.sent.push(JSON.parse(data) as LinkClientFrame);
    }

    close(code?: number, reason?: string): void {
        this.closed = { code, reason };
        this.handlers.onClose(code ?? 1000, reason ?? "");
    }

    open(): void {
        this.handlers.onOpen();
    }

    /** Pushes a server frame down the socket. */
    push<T extends LinkServerFrameType>(type: T, payload: LinkServerPayloads[T], replyTo?: string): void {
        const frame = { v: 1, id: `s${++this.serverFrames}`, type, payload, ...(replyTo ? { replyTo } : {}) } as LinkServerFrame;
        this.handlers.onMessage(JSON.stringify(frame));
    }

    /** Drops the connection the way a network failure would. */
    drop(code = 1006, reason = "abnormal"): void {
        this.handlers.onClose(code, reason);
    }

    ofType<T extends ClientFrameType>(type: T): Extract<LinkClientFrame, { type: T }>[] {
        return this.sent.filter(frame => frame.type === type) as Extract<LinkClientFrame, { type: T }>[];
    }

    last(): LinkClientFrame | undefined {
        return this.sent[this.sent.length - 1];
    }
}

/** Lets queued promise callbacks run. */
export function flush(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

export type LinkHarness = {
    link: Link;
    sockets: FakeSocket[];
    connect(): Promise<FakeSocket>;
    /** Drives the handshake on a socket the link opened by itself, such as a reconnect's. */
    handshake(socket: FakeSocket): Promise<FakeSocket>;
    /** Waits until the link has opened `count` sockets, and hands back the last of them. */
    nextSocket(count: number): Promise<FakeSocket>;
    answerRegistrations(socket: FakeSocket): Promise<void>;
};

/** A link wired to fake sockets, plus the handshake a test would otherwise repeat. */
export function createLinkHarness(
    options: { linkId?: string; reconnect?: boolean; heartbeatMs?: number; requestTimeoutMs?: number } = {},
): LinkHarness {
    const sockets: FakeSocket[] = [];
    const answered = new Set<string>();

    const link = new Link({
        apiKey: "ap-abc_123",
        linkId: options.linkId ?? "coffee",
        heartbeatMs: options.heartbeatMs ?? 0,
        reconnect: options.reconnect ?? false,
        minReconnectDelayMs: 1,
        maxReconnectDelayMs: 2,
        ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
        socketFactory: (url, protocols, handlers) => {
            const socket = new FakeSocket(url, protocols, handlers);
            sockets.push(socket);
            return socket;
        },
    });

    /**
     * Acks each registration frame with ids derived the way the server does.
     *
     * Registration is sequential — hooks are only sent once the tools are acked — so
     * this keeps answering until nothing new appears.
     */
    async function answerRegistrations(socket: FakeSocket): Promise<void> {
        for (let round = 0; round < 10; round++) {
            await flush();
            let answeredAny = false;

            for (const frame of socket.sent) {
                if (answered.has(frame.id)) continue;

                const ids = frame.type === "tool.register"
                    ? frame.payload.tools.map(tool => `link:${link.linkId}/${tool.localId}`)
                    : frame.type === "hook.register"
                        ? [`link:${link.linkId}/${frame.payload.localId}`]
                        : undefined;
                if (!ids) continue;

                answered.add(frame.id);
                answeredAny = true;
                socket.push("ack", { ids }, frame.id);
            }

            if (!answeredAny) return;
        }
    }

    async function connect(): Promise<FakeSocket> {
        const connecting = link.connect();
        const socket = await handshake(sockets[sockets.length - 1]);
        await connecting;
        return socket;
    }

    async function handshake(socket: FakeSocket): Promise<FakeSocket> {
        socket.open();

        await flush();
        socket.push("welcome", {
            connectionId: `conn-${sockets.indexOf(socket) + 1}`,
            linkId: link.linkId,
            scope: "user",
            protocolVersion: 1,
        }, socket.ofType("hello")[0].id);

        await answerRegistrations(socket);
        return socket;
    }

    async function nextSocket(count: number): Promise<FakeSocket> {
        for (let attempt = 0; attempt < 300 && sockets.length < count; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }

        if (sockets.length < count) throw new Error(`The link only ever opened ${sockets.length} socket(s)`);
        return sockets[count - 1];
    }

    return { link, sockets, connect, handshake, nextSocket, answerRegistrations };
}

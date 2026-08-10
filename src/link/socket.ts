/**
 * SOCKETS
 * =======
 *
 * A websocket handshake cannot carry headers in a browser, so the service and the
 * credential travel as subprotocols, with the credential falling back to the query
 * string when it contains characters a subprotocol token cannot hold.
 *
 * The global `WebSocket` is used where there is one (browsers, Node 22+). Node
 * before that gets the `ws` package if it is installed.
 */

export type SocketHandlers = {
    onOpen(): void;
    onMessage(data: string): void;
    onClose(code: number, reason: string): void;
    onError(error: unknown): void;
};

export type SocketConnection = {
    send(data: string): void;
    close(code?: number, reason?: string): void;
};

export type SocketFactory = (url: string, protocols: string[], handlers: SocketHandlers) => SocketConnection;

const SERVICE_PROTOCOL_PREFIX = "butler.service.";
const CREDENTIAL_PROTOCOL_PREFIX = "butler.key.";

/** HTTP token characters, which is all a subprotocol may contain. */
const TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type HandshakeTarget = { url: string; protocols: string[] };

/**
 * Builds the websocket URL and subprotocols for a service.
 *
 * The credential prefers the subprotocol because a URL ends up in access logs.
 */
export function buildHandshake(serverUrl: string, service: string, apiKey: string): HandshakeTarget {
    const url = new URL(serverUrl);
    url.protocol = url.protocol === "http:" ? "ws:" : url.protocol === "https:" ? "wss:" : url.protocol;
    url.searchParams.set("service", service);

    const protocols = [`${SERVICE_PROTOCOL_PREFIX}${service}`];

    if (TOKEN_PATTERN.test(apiKey)) protocols.push(`${CREDENTIAL_PROTOCOL_PREFIX}${apiKey}`);
    else url.searchParams.set("api_key", apiKey);

    return { url: url.toString(), protocols };
}

type WebSocketConstructor = new (url: string, protocols?: string[]) => {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: string, listener: (event: never) => void): void;
};

function resolveWebSocket(): WebSocketConstructor {
    const globalWebSocket = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (globalWebSocket) return globalWebSocket;

    try {
        // Only reached on Node versions without a global WebSocket.
        const load = eval("typeof require === 'function' ? require : undefined") as ((id: string) => unknown) | undefined;
        const ws = load?.("ws") as { WebSocket?: WebSocketConstructor } | WebSocketConstructor | undefined;
        const constructor = (ws as { WebSocket?: WebSocketConstructor })?.WebSocket ?? (ws as WebSocketConstructor);
        if (constructor) return constructor;
    } catch {
        // Falls through to the error below.
    }

    throw new Error(
        "No WebSocket implementation found. Use Node 22+, or install `ws`, "
        + "or pass your own `socketFactory` to the Link.",
    );
}

export const defaultSocketFactory: SocketFactory = (url, protocols, handlers) => {
    const WebSocketImpl = resolveWebSocket();
    const socket = new WebSocketImpl(url, protocols);

    socket.addEventListener("open", (() => handlers.onOpen()) as (event: never) => void);
    socket.addEventListener("message", ((event: { data: unknown }) => {
        handlers.onMessage(typeof event.data === "string" ? event.data : String(event.data));
    }) as (event: never) => void);
    socket.addEventListener("close", ((event: { code?: number; reason?: string }) => {
        handlers.onClose(event.code ?? 1006, event.reason ?? "");
    }) as (event: never) => void);
    socket.addEventListener("error", ((event: unknown) => handlers.onError(event)) as (event: never) => void);

    return {
        send: (data: string) => socket.send(data),
        close: (code?: number, reason?: string) => socket.close(code, reason),
    };
};

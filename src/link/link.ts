import { CONFIG } from "../config";
import { Emitter } from "../util/emitter";
import { AnyHook } from "./hook";
import {
    LINK_PROTOCOL_VERSION,
    LinkClientFrameType,
    LinkClientPayloads,
    LinkError,
    LinkScopeKind,
    LinkServerFrame,
    LinkServerFrameOf,
} from "./protocol";
import { buildHandshake, defaultSocketFactory, SocketConnection, SocketFactory } from "./socket";
import { AnyTool } from "./tool";

export type LinkState = "idle" | "connecting" | "open" | "closed";

export type LinkEvents = {
    /** The link is connected and everything it holds has been registered. */
    connect: [{ connectionId: string; scope: LinkScopeKind }];
    disconnect: [{ code: number; reason: string; willReconnect: boolean }];
    /** A protocol or transport error. Fatal ones also stop reconnection. */
    error: [Error];
    /** Server-side chatter, useful when debugging. */
    log: [string];
    /** The server is shutting this connection down deliberately. */
    goodbye: [{ reason: string; reconnectAfterMs: number }];
};

export type LinkOptions = {
    /** A user API key, or the service key for a global link. */
    apiKey: string;
    /**
     * This link's name, chosen by you and stable forever.
     *
     * Every id the link creates is derived from it, and those ids are what the
     * user's tool settings and background agent subscriptions point at — so changing
     * it silently orphans both. Pick a deliberate constant ("coffee-machine"), never
     * a hostname, a version, or a value generated at startup.
     *
     * Two live connections claiming the same linkId is last-writer-wins: the newer
     * one takes over and the older one's registrations are released.
     */
    linkId: string;
    serverUrl?: string;
    /** Informational, shown in server logs. Defaults to the SDK name. */
    client?: string;
    debug?: boolean;
    /** Reconnect automatically with backoff. Default true. */
    reconnect?: boolean;
    minReconnectDelayMs?: number;
    maxReconnectDelayMs?: number;
    /** Keeps idle connections alive through proxies. 0 disables. Default 30s. */
    heartbeatMs?: number;
    /** How long to wait for an acknowledgement. Turns are never timed out here. */
    requestTimeoutMs?: number;
    socketFactory?: SocketFactory;
};

type Pending = {
    isDone(frame: LinkServerFrame): boolean;
    onFrame?(frame: LinkServerFrame): void;
    resolve(frame: LinkServerFrame): void;
    reject(error: Error): void;
    timer?: ReturnType<typeof setTimeout>;
};

export type ExchangeOptions = {
    /** Which reply ends the exchange. Defaults to an `ack`. */
    isDone?(frame: LinkServerFrame): boolean;
    /** Called for every other reply, in order. */
    onFrame?(frame: LinkServerFrame): void;
    /** 0 waits forever, which is what a conversation turn needs. */
    timeoutMs?: number;
    /** Set false only for the handshake itself. */
    awaitReady?: boolean;
};

const DEFAULTS = {
    minReconnectDelayMs: 500,
    maxReconnectDelayMs: 30_000,
    heartbeatMs: 30_000,
    requestTimeoutMs: 30_000,
};

/**
 * A live connection to Alfred that carries tools, hooks and conversations.
 *
 * The server keeps no record of a link between connections: everything is
 * re-declared on connect, and ids are derived from your `linkId`, so a reconnect
 * anywhere lands on the same saved settings and subscriptions.
 */
export class Link {
    private readonly options: Required<Omit<LinkOptions, "socketFactory" | "client" | "serverUrl">> & {
        client: string;
        serverUrl: string;
        socketFactory: SocketFactory;
    };

    private readonly emitter = new Emitter<LinkEvents>();
    private readonly tools = new Map<string, AnyTool>();
    private readonly hooks = new Map<string, AnyHook>();
    private readonly pending = new Map<string, Pending>();
    private readonly calls = new Map<string, AbortController>();

    private socket: SocketConnection | null = null;
    private frameCounter = 0;
    private currentState: LinkState = "idle";
    private identity?: { connectionId: string; scope: LinkScopeKind };
    private connecting?: Promise<this>;
    private readySignal?: { promise: Promise<void>; resolve(): void; reject(error: Error): void };
    private reconnectAttempt = 0;
    private reconnectAfterMs = 0;
    private heartbeat?: ReturnType<typeof setInterval>;
    private closedByUs = false;

    constructor(options: LinkOptions) {
        this.options = {
            ...DEFAULTS,
            reconnect: true,
            debug: false,
            client: "@butlerbot/sdk",
            serverUrl: CONFIG.server,
            socketFactory: defaultSocketFactory,
            ...stripUndefined(options),
        } as Link["options"];
    }

    // =============================================
    // WHAT THE LINK HOLDS
    // =============================================

    /** Adds a tool Alfred can call. Registered on connect, or immediately if already open. */
    addTool(tool: AnyTool): this {
        this.tools.set(tool.id, tool);
        if (this.currentState === "open") void this.registerTools([tool]);
        return this;
    }

    /** Adds a hook that can wake the user's background agents. */
    addHook(hook: AnyHook): this {
        this.hooks.set(hook.id, hook);
        hook.attach(this);
        if (this.currentState === "open") void this.registerHook(hook);
        return this;
    }

    getTool(id: string): AnyTool | undefined {
        return this.tools.get(id);
    }

    getHook(id: string): AnyHook | undefined {
        return this.hooks.get(id);
    }

    // =============================================
    // STATE
    // =============================================

    get state(): LinkState {
        return this.currentState;
    }

    get linkId(): string {
        return this.options.linkId;
    }

    /** The ephemeral id of this connection. Changes on every reconnect. */
    get connectionId(): string | undefined {
        return this.identity?.connectionId;
    }

    /** Whether this link speaks for one user or for the whole service. */
    get scope(): LinkScopeKind | undefined {
        return this.identity?.scope;
    }

    on<K extends keyof LinkEvents>(event: K, listener: (...args: LinkEvents[K]) => unknown): string {
        return this.emitter.on(event, listener);
    }

    off<K extends keyof LinkEvents>(event: K, id: string): void {
        this.emitter.off(event, id);
    }

    // =============================================
    // LIFECYCLE
    // =============================================

    /** Connects, resolving once every tool and hook has been registered. */
    connect(): Promise<this> {
        if (this.currentState === "open") return Promise.resolve(this);
        if (this.connecting) return this.connecting;

        this.closedByUs = false;
        this.connecting = this.openSocket().then(() => this, error => {
            this.connecting = undefined;
            throw error;
        });

        return this.connecting;
    }

    /** Resolves when the link is usable, connecting first if it has not been asked to yet. */
    async ready(): Promise<void> {
        if (this.currentState === "open") return;
        if (this.currentState === "closed") throw new Error("This link has been closed.");
        await this.connect();
    }

    /** Closes for good. Registrations are released server-side as the socket drops. */
    close(reason = "client closed"): void {
        this.closedByUs = true;
        this.currentState = "closed";
        this.stopHeartbeat();
        this.failPending(new LinkError("closed", "The link was closed."));
        this.socket?.close(1000, reason);
        this.socket = null;
        this.connecting = undefined;
        this.readySignal = undefined;
    }

    private openSocket(): Promise<void> {
        this.currentState = "connecting";

        const signal = deferred();
        this.readySignal = signal;

        const { url, protocols } = buildHandshake(this.options.serverUrl, "link", this.options.apiKey);
        this.debug(`connecting to ${url.replace(/api_key=[^&]+/, "api_key=***")}`);

        try {
            this.socket = this.options.socketFactory(url, protocols, {
                onOpen: () => this.onOpen(),
                onMessage: (data) => this.onMessage(data),
                onClose: (code, reason) => this.onClose(code, reason),
                onError: (error) => this.emitter.emit("error", asError(error)),
            });
        } catch (error) {
            signal.reject(asError(error));
        }

        return signal.promise;
    }

    private onOpen(): void {
        // The handshake declares who we are; nothing else may be sent before it.
        void this.exchange("hello", {
            linkId: this.options.linkId,
            client: this.options.client,
            protocolVersion: LINK_PROTOCOL_VERSION,
        }, {
            awaitReady: false,
            isDone: (frame) => frame.type === "welcome",
        }).then(async (frame) => {
            const welcome = frame.payload as LinkEvents["connect"][0] & { protocolVersion: number };
            this.identity = { connectionId: welcome.connectionId, scope: welcome.scope };

            await this.registerAll();

            this.currentState = "open";
            this.reconnectAttempt = 0;
            this.reconnectAfterMs = 0;
            this.startHeartbeat();
            this.readySignal?.resolve();
            this.emitter.emit("connect", this.identity);
        }).catch((error: Error) => {
            this.emitter.emit("error", error);

            // A rejected claim or an unsupported protocol will not fix itself by
            // trying again, so this stops rather than looping.
            this.closedByUs = true;
            this.readySignal?.reject(error);
            this.socket?.close(1000, "handshake failed");
        });
    }

    private onClose(code: number, reason: string): void {
        const willReconnect = this.options.reconnect && !this.closedByUs;

        this.socket = null;
        this.identity = undefined;
        this.connecting = undefined;
        this.currentState = willReconnect ? "connecting" : "closed";
        this.stopHeartbeat();
        this.failPending(new LinkError("disconnected", `The link disconnected (${code}${reason ? `: ${reason}` : ""}).`));

        this.emitter.emit("disconnect", { code, reason, willReconnect });
        this.readySignal?.reject(new LinkError("disconnected", `The link disconnected (${code}).`));
        this.readySignal = undefined;

        if (willReconnect) this.scheduleReconnect();
    }

    /**
     * Reconnects with full jitter on top of any delay the server asked for.
     *
     * A fleet told to reconnect must not come back in unison, which is exactly what
     * a fixed delay produces.
     */
    private scheduleReconnect(): void {
        const ceiling = Math.min(
            this.options.maxReconnectDelayMs,
            this.options.minReconnectDelayMs * 2 ** this.reconnectAttempt,
        );
        const delay = this.reconnectAfterMs + Math.random() * ceiling;

        this.reconnectAttempt += 1;
        this.debug(`reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt})`);

        const timer = setTimeout(() => {
            if (this.closedByUs) return;
            this.openSocket().catch(error => this.emitter.emit("error", asError(error)));
        }, delay);

        unref(timer);
    }

    private startHeartbeat(): void {
        if (!this.options.heartbeatMs) return;

        this.heartbeat = setInterval(() => {
            // The reply is consumed by the exchange, so it never reaches log listeners.
            this.exchange("ping", {}, { isDone: (frame) => frame.type === "log" })
                .catch(() => undefined);
        }, this.options.heartbeatMs);

        unref(this.heartbeat);
    }

    private stopHeartbeat(): void {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = undefined;
    }

    // =============================================
    // REGISTRATION
    // =============================================

    private async registerAll(): Promise<void> {
        await this.registerTools(Array.from(this.tools.values()));
        for (const hook of this.hooks.values()) await this.registerHook(hook);
    }

    private async registerTools(tools: AnyTool[]): Promise<void> {
        if (!tools.length) return;

        const frame = await this.exchange("tool.register", { tools: tools.map(tool => tool.descriptor()) }, { awaitReady: false });
        const ids = (frame.payload as { ids?: string[] }).ids ?? [];

        // Ids come back in declaration order; taking them from the server rather than
        // rebuilding them here keeps the id format in one place.
        tools.forEach((tool, index) => { tool.linkedId = ids[index]; });
        this.debug(`registered ${tools.length} tool(s)`);
    }

    private async registerHook(hook: AnyHook): Promise<void> {
        const frame = await this.exchange("hook.register", hook.declaration(), { awaitReady: false });
        hook.sourceId = (frame.payload as { ids?: string[] }).ids?.[0];
        this.debug(`registered hook ${hook.id}`);
    }

    /** Called by `Hook.emit`. */
    async emitHook(hookId: string, event: string, payload?: Record<string, unknown>, ownerId?: string): Promise<void> {
        await this.ready();

        // Resolved after waiting, not before: an emit issued during startup would
        // otherwise carry the local id, which the server does not know.
        const sourceId = this.hooks.get(hookId)?.sourceId ?? hookId;

        this.send("hook.emit", {
            sourceId,
            event,
            ...(payload ? { payload } : {}),
            ...(ownerId ? { ownerId } : {}),
        });
    }

    // =============================================
    // FRAMES
    // =============================================

    /** Sends a frame without waiting for anything. Returns its id. */
    send<T extends LinkClientFrameType>(type: T, payload: LinkClientPayloads[T], replyTo?: string): string {
        const id = `c${++this.frameCounter}`;
        const frame = { v: LINK_PROTOCOL_VERSION, id, type, payload, ...(replyTo ? { replyTo } : {}) };

        if (!this.socket) throw new LinkError("disconnected", "The link is not connected.");
        this.socket.send(JSON.stringify(frame));
        return id;
    }

    /**
     * Sends a frame and waits for the reply that ends it.
     *
     * Intermediate replies (a turn's events, a status update) go to `onFrame`, and an
     * `error` frame rejects — so a caller handles one outcome, not a stream of maybes.
     */
    async exchange<T extends LinkClientFrameType>(
        type: T,
        payload: LinkClientPayloads[T],
        options: ExchangeOptions = {},
    ): Promise<LinkServerFrame> {
        if (options.awaitReady !== false) await this.ready();

        const isDone = options.isDone ?? ((frame: LinkServerFrame) => frame.type === "ack");
        const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;

        return new Promise<LinkServerFrame>((resolve, reject) => {
            let id: string;
            try {
                id = this.send(type, payload);
            } catch (error) {
                reject(asError(error));
                return;
            }

            const entry: Pending = {
                isDone,
                onFrame: options.onFrame,
                resolve: (frame) => { this.settle(id); resolve(frame); },
                reject: (error) => { this.settle(id); reject(error); },
            };

            if (timeoutMs > 0) {
                entry.timer = setTimeout(() => {
                    entry.reject(new LinkError("timeout", `No reply to "${type}" within ${timeoutMs}ms.`));
                }, timeoutMs);
                unref(entry.timer);
            }

            this.pending.set(id, entry);
        });
    }

    private settle(id: string): void {
        const entry = this.pending.get(id);
        if (entry?.timer) clearTimeout(entry.timer);
        this.pending.delete(id);
    }

    private failPending(error: Error): void {
        for (const entry of Array.from(this.pending.values())) entry.reject(error);
        this.pending.clear();

        for (const controller of Array.from(this.calls.values())) controller.abort();
        this.calls.clear();
    }

    private onMessage(raw: string): void {
        let frame: LinkServerFrame;
        try {
            frame = JSON.parse(raw) as LinkServerFrame;
        } catch {
            this.emitter.emit("error", new LinkError("bad_frame", `Unparseable frame from the server: ${raw.slice(0, 200)}`));
            return;
        }

        // A reply belongs to whoever is waiting on it, and never reaches the general
        // handlers below.
        const waiting = frame.replyTo ? this.pending.get(frame.replyTo) : undefined;
        if (waiting) {
            if (frame.type === "error") {
                const { code, error, fatal } = frame.payload;
                waiting.reject(new LinkError(code, error, fatal));
                return;
            }
            if (waiting.isDone(frame)) waiting.resolve(frame);
            else waiting.onFrame?.(frame);
            return;
        }

        switch (frame.type) {
            case "tool.call":
                this.handleToolCall(frame);
                return;
            case "tool.cancel": {
                const { callId, reason } = frame.payload;
                this.calls.get(callId)?.abort();
                this.calls.delete(callId);
                this.debug(`call ${callId} cancelled: ${reason}`);
                return;
            }
            case "log":
                this.emitter.emit("log", frame.payload.log);
                return;
            case "goodbye": {
                const payload = frame.payload;
                this.reconnectAfterMs = payload.reconnectAfterMs;
                this.emitter.emit("goodbye", payload);
                return;
            }
            case "error": {
                const payload = frame.payload;
                const error = new LinkError(payload.code, payload.error, payload.fatal);
                if (payload.fatal) this.closedByUs = true;
                this.emitter.emit("error", error);
                return;
            }
            default:
                this.debug(`unhandled frame "${frame.type}"`);
        }
    }

    private handleToolCall(frame: LinkServerFrameOf<"tool.call">): void {
        const { callId, localId, args, meta } = frame.payload;
        const tool = this.tools.get(localId);

        if (!tool) {
            this.send("tool.result", { ok: false, error: `This link has no tool "${localId}".` }, frame.id);
            return;
        }

        const controller = new AbortController();
        this.calls.set(callId, controller);

        const status = {
            update: (label: string) => this.send("tool.status", { label, state: "running" }, frame.id),
            fail: (label: string) => this.send("tool.status", { label, state: "failed" }, frame.id),
        };

        void tool.invoke(args, meta, status, controller.signal).then(result => {
            this.calls.delete(callId);

            // The socket may have gone while the tool ran; the server has already
            // given up on the call, so there is nothing to report to.
            if (!this.socket) return;

            this.send("tool.result", result.ok
                ? { ok: true, output: result.output }
                : { ok: false, error: result.error }, frame.id);
        });
    }

    private debug(message: string): void {
        if (this.options.debug) console.log(`[link:${this.options.linkId}] ${message}`);
    }
}

// =============================================
// HELPERS
// =============================================

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });

    // Rejections are surfaced through connect() and the error event; an unobserved
    // one here must not take the process down.
    promise.catch(() => undefined);
    return { promise, resolve, reject };
}

function asError(value: unknown): Error {
    if (value instanceof Error) return value;
    const message = (value as { message?: string })?.message;
    return new Error(message ?? "Unknown link error");
}

function stripUndefined<T extends object>(value: T): Partial<T> {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

/** Keeps timers from holding a Node process open. No-op in browsers. */
function unref(timer: unknown): void {
    (timer as { unref?: () => void })?.unref?.();
}

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
import { SubscriptionStore, type LinkSubscription } from "./subscriptions";

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
    /**
     * The set of things the server wants watched has changed.
     *
     * Fires on every snapshot and every delta, including the first one after connecting. Use it to
     * set up whatever your platform needs in order to watch — a channel listener, a poll — and note
     * that it can fire with an empty list, which means "nothing is subscribed right now".
     */
    subscriptions: [LinkSubscription[]];
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
    /**
     * How long the connection may be silent before it is pinged, which both proves it is
     * alive and keeps proxies from dropping it. A connection that is receiving frames is
     * never pinged. 0 disables. Default 30s.
     */
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

/** Somebody parked until the link is usable. See `wait`. */
type Waiter = {
    resolve(): void;
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
    private readonly subscriptionStore = new SubscriptionStore();
    private readonly pending = new Map<string, Pending>();
    private readonly calls = new Map<string, AbortController>();

    private socket: SocketConnection | null = null;
    /** Every socket this link has opened and not yet closed, by generation. */
    private readonly sockets = new Map<number, SocketConnection>();
    private frameCounter = 0;
    private currentState: LinkState = "idle";
    private identity?: { connectionId: string; scope: LinkScopeKind };
    /**
     * Which socket the callbacks below belong to.
     *
     * Every handler carries the generation it was made for and does nothing once that is
     * no longer current. Without it a late `close` from a socket we have already replaced
     * tears down its successor — one blip turning into a link that flaps for the life of
     * the process.
     */
    private generation = 0;
    /** True from the moment a socket is created until it is open or gone. */
    private attempting = false;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    /** Settled per attempt: this is what `connect()` awaits. */
    private readonly attemptWaiters: Waiter[] = [];
    /** Settled when the link opens, however many attempts that takes. `ready()` awaits these. */
    private readonly openWaiters: Waiter[] = [];
    private reconnectAttempt = 0;
    private reconnectAfterMs = 0;
    private heartbeat?: ReturnType<typeof setTimeout>;
    /**
     * When the server last said anything at all.
     *
     * Any frame is proof the connection is alive, so a link that is busy carrying a turn
     * never needs to ask.
     */
    private lastInboundAt = 0;

    /** Ids of keepalive pulses, so their pongs can be dropped instead of shown as logs. */
    private pulses = new Set<string>();
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

        // A gap means a delta was missed, and the answer is always the same: ask for the snapshot
        // again. Sent best-effort — if the socket has gone, the reconnect will bring a snapshot anyway.
        this.subscriptionStore.onResyncNeeded = (have) => {
            this.debug(`subscription epoch gap at ${have}, resyncing`);
            try {
                this.send("hook.subscriptions.resync", { have });
            } catch {
                // Disconnected mid-gap. The next connect re-declares and is told again.
            }
        };

        this.subscriptionStore.onChange = (subscriptions) => {
            this.emitter.emit("subscriptions", subscriptions);
        };
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

    /**
     * Connects, resolving once every tool and hook has been registered.
     *
     * Rejects if *this* attempt fails. When `reconnect` is on the link keeps trying in
     * the background regardless, so a caller can either await this again or just listen
     * for the `connect` event.
     */
    connect(): Promise<this> {
        if (this.currentState === "open") return Promise.resolve(this);

        this.closedByUs = false;
        if (this.currentState === "closed") this.currentState = "idle";

        // Joins whatever attempt is already in flight — or already scheduled — rather than
        // racing a second socket against it.
        const waited = this.wait(this.attemptWaiters, 0);
        this.ensureAttempting();

        return waited.then(() => this);
    }

    /**
     * Resolves when the link is usable, connecting first if it has not been asked to yet.
     *
     * Bounded by `requestTimeoutMs`, and it never opens a socket of its own while one is
     * in flight: the callers are hook emits and tool replies, which are worth sending now
     * or not at all. Waiting out a long outage here used to mean a new connection per
     * event.
     */
    async ready(): Promise<void> {
        if (this.currentState === "open") return;
        if (this.currentState === "closed") throw new LinkError("closed", "This link has been closed.");

        const waited = this.wait(this.openWaiters, this.options.requestTimeoutMs);
        this.ensureAttempting();

        await waited;
    }

    /** Closes for good. Registrations are released server-side as the socket drops. */
    close(reason = "client closed"): void {
        const closed = new LinkError("closed", "The link was closed.");

        this.closedByUs = true;
        this.currentState = "closed";
        // Orphans the live socket's callbacks, so its close cannot reopen anything.
        this.generation += 1;
        this.attempting = false;
        this.stopHeartbeat();
        this.clearReconnect();
        this.failPending(closed);
        this.settleWaiters(this.attemptWaiters, closed);
        this.settleWaiters(this.openWaiters, closed);

        // Every socket, not just the current one: a link that is being closed for good must not
        // leave anything of itself attached to the server.
        for (const generation of [...this.sockets.keys()]) this.abandon(generation, reason);
        this.socket = null;
    }

    /**
     * Starts an attempt, but only when there is nothing to join.
     *
     * The single door to opening a socket: an attempt in flight, or a reconnect already
     * waiting out its backoff, is the attempt.
     */
    private ensureAttempting(): void {
        if (this.closedByUs || this.currentState === "open") return;
        if (this.attempting || this.reconnectTimer) return;
        this.openSocket();
    }

    private openSocket(): void {
        this.currentState = "connecting";
        this.attempting = true;

        const generation = ++this.generation;
        const { url, protocols } = buildHandshake(this.options.serverUrl, "link", this.options.apiKey);
        this.debug(`connecting to ${url.replace(/api_key=[^&]+/, "api_key=***")}`);

        try {
            const socket = this.options.socketFactory(url, protocols, {
                onOpen: () => this.onOpen(generation),
                onMessage: (data) => { if (generation === this.generation) this.onMessage(data); },
                onClose: (code, reason) => {
                    this.sockets.delete(generation);
                    this.onClose(generation, code, reason);
                },
                onError: (error) => { if (generation === this.generation) this.emitter.emit("error", asError(error)); },
            });

            // Held by generation, not only as `this.socket`, so a socket that stops being the
            // current one can still be closed. One that is merely forgotten stays open at the far
            // end: it has already said hello and registered its tools, so the server goes on serving
            // it, and it answers websocket pings forever because the network stack does that for it.
            this.sockets.set(generation, socket);
            this.socket = socket;
        } catch (error) {
            // A factory that throws never produces a close event, so this failure is
            // reported and retried from here instead.
            const failure = asError(error);
            this.socket = null;
            this.attempting = false;
            this.emitter.emit("error", failure);
            this.settleWaiters(this.attemptWaiters, failure);
            this.retryOrGiveUp(failure);
        }
    }

    private onOpen(generation: number): void {
        if (generation !== this.generation) return;

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
            const identity = { connectionId: welcome.connectionId, scope: welcome.scope };
            this.identity = identity;

            await this.registerAll();
            // Registration is several round trips; the socket may have gone during them. It is fully
            // registered at the server by now, so abandoning it quietly would leave it serving tools
            // nothing here will ever answer.
            if (generation !== this.generation) return this.abandon(generation, "superseded during handshake");

            this.attempting = false;
            this.currentState = "open";
            this.reconnectAttempt = 0;
            this.reconnectAfterMs = 0;
            this.startHeartbeat(generation);
            this.settleWaiters(this.attemptWaiters);
            this.settleWaiters(this.openWaiters);
            this.emitter.emit("connect", identity);
        }).catch((error: Error) => {
            if (generation !== this.generation) return this.abandon(generation, "superseded during handshake");

            this.emitter.emit("error", error);
            this.settleWaiters(this.attemptWaiters, error);

            // Only the server saying "do not come back" stops us: a rejected claim or an
            // unsupported protocol will not fix itself. Everything else that can land here —
            // a timeout, a socket dropped mid-registration, a transient server error — is
            // precisely what reconnecting is for. Treating all of it as fatal left the link
            // dead for the life of the process.
            if (error instanceof LinkError && error.fatal) this.closedByUs = true;
            this.dropSocket(generation, 1000, "handshake failed");
        });
    }

    /**
     * Abandons a socket and treats it as closed right now.
     *
     * A connection that died without a close frame can take minutes to report it, or
     * never, so the close is synthesised rather than waited for. Bumping the generation
     * means the real event, whenever it turns up, is ignored.
     */
    private dropSocket(generation: number, code: number, reason: string): void {
        if (generation !== this.generation) return;

        this.onClose(generation, code, reason);
        // 1006 is reserved and rejected by browsers; anything else we raise is a valid
        // application code.
        this.abandon(generation, reason, code === 1006 ? 1000 : code);
    }

    /**
     * Closes a socket this end has stopped using, whatever generation it belongs to.
     *
     * Every path that walks away from a socket goes through here. Forgetting one is not harmless:
     * the server has no way to tell an abandoned connection from a live one — it has said hello,
     * registered its tools and claimed its link id — so it keeps it, keeps serving from it, and
     * hands the link id back and forth between it and its replacements.
     */
    private abandon(generation: number, reason: string, code = 1000): void {
        const socket = this.sockets.get(generation);
        if (!socket) return;

        this.sockets.delete(generation);
        if (this.socket === socket) this.socket = null;

        try {
            socket.close(code, reason);
        } catch {
            // Already gone, which is the outcome we wanted anyway.
        }
    }

    private onClose(generation: number, code: number, reason: string): void {
        if (generation !== this.generation) return;
        // Whatever else this socket has to say is now somebody else's news.
        this.generation += 1;

        const willReconnect = this.options.reconnect && !this.closedByUs;
        const error = new LinkError("disconnected", `The link disconnected (${code}${reason ? `: ${reason}` : ""}).`);

        this.socket = null;
        this.identity = undefined;
        this.attempting = false;
        this.currentState = willReconnect ? "connecting" : "closed";
        // Nothing about subscriptions survives a socket: the server re-sends the set on every
        // connect, so holding the old one would only risk reporting against ids that are gone.
        this.subscriptionStore.reset();
        this.stopHeartbeat();
        this.failPending(error);
        this.settleWaiters(this.attemptWaiters, error);

        this.emitter.emit("disconnect", { code, reason, willReconnect });

        if (willReconnect) this.scheduleReconnect();
        else this.settleWaiters(this.openWaiters, error);
    }

    /** Retries when it is allowed to, and tells everyone waiting when it is not. */
    private retryOrGiveUp(error: Error): void {
        if (this.options.reconnect && !this.closedByUs) {
            this.currentState = "connecting";
            this.scheduleReconnect();
            return;
        }

        this.currentState = "closed";
        this.settleWaiters(this.openWaiters, error);
    }

    /**
     * Reconnects with full jitter on top of any delay the server asked for.
     *
     * A fleet told to reconnect must not come back in unison, which is exactly what
     * a fixed delay produces.
     */
    private scheduleReconnect(): void {
        this.clearReconnect();

        const ceiling = Math.min(
            this.options.maxReconnectDelayMs,
            this.options.minReconnectDelayMs * 2 ** this.reconnectAttempt,
        );
        const delay = this.reconnectAfterMs + Math.random() * ceiling;

        this.reconnectAttempt += 1;
        this.debug(`reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt})`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (this.closedByUs || this.currentState === "open" || this.attempting) return;
            this.openSocket();
        }, delay);

        unref(this.reconnectTimer);
    }

    private clearReconnect(): void {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
    }

    /**
     * Pings a SILENT connection and, the important half, notices when a ping goes unanswered.
     *
     * A websocket can die without a close frame — a dropped route, a proxy that forgets
     * the connection, a suspended machine — leaving both ends convinced they are
     * connected while every frame sent into it vanishes. An unanswered ping is the only
     * evidence this end will ever get, so it is treated as a dead connection and
     * reconnected rather than swallowed.
     *
     * It only asks when nothing has arrived for a whole interval, because a connection
     * that is delivering frames has already answered the question. Pinging regardless
     * meant a busy link had to complete a round trip while the socket was carrying a
     * streaming turn: the reply queues behind everything already in flight, and a turn
     * big enough to take longer than the timeout to drain got its own connection torn
     * down with `4000 heartbeat timeout` — always mid-response, always on the longest
     * answers, which are the ones a user least wants to lose.
     *
     * Not asking is not the same as saying nothing, though. The server reaps connections
     * that have sent it no frames for 100s, because a socket the client walked away from
     * still answers websocket pings at the network layer and only the client's own frames
     * prove someone is still there. A link busy receiving a long turn used to go completely
     * silent for as long as the turn ran and got closed as idle — `1001 idle: no frames
     * received`, mid-response again. So a busy interval still sends a pulse; it just does
     * not wait for the reply, which is the half that could not survive a full send queue.
     */
    private startHeartbeat(generation: number): void {
        if (!this.options.heartbeatMs) return;
        this.stopHeartbeat();

        this.markInbound();
        this.scheduleHeartbeat(generation);
    }

    /** Wakes when the connection will have been silent for a full interval, not before. */
    private scheduleHeartbeat(generation: number): void {
        if (generation !== this.generation || !this.options.heartbeatMs) return;

        const silentFor = Date.now() - this.lastInboundAt;
        const due = Math.max(this.options.heartbeatMs - silentFor, 0);

        this.heartbeat = setTimeout(() => {
            if (generation !== this.generation) return;

            // Something arrived while this was pending: the connection is demonstrably
            // alive and there is nothing to ask. Tell the server we are still here and
            // wait out the rest of its silence instead.
            if (Date.now() - this.lastInboundAt < this.options.heartbeatMs) {
                this.pulse();
                return this.scheduleHeartbeat(generation);
            }

            this.ping(generation);
        }, due);

        unref(this.heartbeat);
    }

    /** One liveness round trip. Only ever sent to a connection that has gone quiet. */
    private ping(generation: number): void {
        const sentAt = Date.now();

        // The reply is consumed by the exchange, so it never reaches log listeners.
        this.exchange("ping", {}, {
            awaitReady: false,
            isDone: (frame) => frame.type === "log",
            timeoutMs: this.heartbeatTimeoutMs(),
        }).then(() => {
            this.scheduleHeartbeat(generation);
        }, () => {
            if (generation !== this.generation) return;

            // The pong is late but other frames are flowing, so the socket is fine and only
            // this reply is stuck behind them. Killing it here would throw away a working
            // connection — and whatever it was busy delivering.
            if (this.lastInboundAt > sentAt) {
                this.debug("heartbeat was slow but the connection is delivering frames, keeping it");
                return this.scheduleHeartbeat(generation);
            }

            this.debug("heartbeat went unanswered, treating the connection as dead");
            this.dropSocket(generation, 4000, "heartbeat timeout");
        });
    }

    /**
     * A ping sent with no deadline and no interest in the answer.
     *
     * Its only job is to land on the server so the connection does not look abandoned. A
     * failure here is not evidence of anything — inbound frames already proved the socket
     * works — so it stays quiet and lets the real heartbeat make that call.
     */
    private pulse(): void {
        try {
            this.pulses.add(this.send("ping", {}));
        } catch {
            this.debug("could not send the keepalive pulse, leaving it to the next heartbeat");
        }
    }

    /** Never longer than the interval itself: a second ping in flight tells us nothing new. */
    private heartbeatTimeoutMs(): number {
        return Math.max(250, Math.min(this.options.requestTimeoutMs, this.options.heartbeatMs));
    }

    /** Any frame from the server, of any kind, is proof the connection still works. */
    private markInbound(): void {
        this.lastInboundAt = Date.now();
    }

    private stopHeartbeat(): void {
        if (this.heartbeat) clearTimeout(this.heartbeat);
        this.heartbeat = undefined;

        // Pongs owed by a socket that is going away will never arrive.
        this.pulses.clear();
    }

    // =============================================
    // WAITING
    // =============================================

    /** Parks a caller until someone settles the list it was parked in. 0 waits forever. */
    private wait(waiters: Waiter[], timeoutMs: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const waiter: Waiter = { resolve, reject };

            if (timeoutMs > 0) {
                waiter.timer = setTimeout(() => {
                    const index = waiters.indexOf(waiter);
                    if (index >= 0) waiters.splice(index, 1);
                    reject(new LinkError("timeout", `The link was not open within ${timeoutMs}ms.`));
                }, timeoutMs);
                unref(waiter.timer);
            }

            waiters.push(waiter);
        });
    }

    private settleWaiters(waiters: Waiter[], error?: Error): void {
        for (const waiter of waiters.splice(0, waiters.length)) {
            if (waiter.timer) clearTimeout(waiter.timer);
            if (error) waiter.reject(error);
            else waiter.resolve();
        }
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

    /**
     * Called by `Hook.report`.
     *
     * Sends nothing when the event matched nothing, which is the entire volume story: a busy channel
     * produces thousands of events a day that no reflex asked about, and none of them reach the wire.
     *
     * The epoch travels with the frame so the server can tell a stale view from a bad one — an id
     * that was valid a moment ago is a race, not a bug worth complaining about.
     */
    async reportHookEvent(
        hookId: string,
        event: string,
        payload?: Record<string, unknown>,
        chosenIds?: string[],
    ): Promise<string[]> {
        // Not `ready()`: a report is only worth anything now, and while the link is down the
        // subscription set is empty anyway — so waiting would mean holding a busy guild's
        // events open to match them against nothing.
        if (this.currentState !== "open") {
            this.debug(`dropped ${event}: the link is not connected`);
            return [];
        }

        const sourceId = this.hooks.get(hookId)?.sourceId ?? hookId;

        // Explicit ids are still checked against what this link actually holds. Not out of distrust of
        // the caller — the server checks again anyway — but because an id it was never given can only
        // be a bug or a race with a removal, and both are better as a dropped report than as a frame
        // the server rejects. Dropped rather than thrown: a subscription vanishing mid-event is normal.
        const subscriptionIds = chosenIds
            ? chosenIds.filter(id => this.subscriptionStore.get(id)?.sourceId === sourceId)
            : this.subscriptionStore.match({ sourceId, event, payload });

        if (chosenIds && subscriptionIds.length !== chosenIds.length) {
            this.debug(`dropped ${chosenIds.length - subscriptionIds.length} unknown subscription id(s) on ${event}`);
        }

        if (subscriptionIds.length === 0) return [];

        this.send("hook.event", {
            sourceId,
            subscriptionIds,
            event,
            ...(payload ? { payload } : {}),
            epoch: this.subscriptionStore.epoch,
        });

        return subscriptionIds;
    }

    /** Called by `Hook.subscriptions`. */
    hookSubscriptions(hookId: string): LinkSubscription[] {
        const sourceId = this.hooks.get(hookId)?.sourceId;
        return sourceId ? this.subscriptionStore.forSource(sourceId) : [];
    }

    /** Everything this link has been asked to watch, across all of its hooks. */
    get subscriptions(): LinkSubscription[] {
        return this.subscriptionStore.all();
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
        this.markInbound();

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

        // The pong to a keepalive pulse. Nothing is waiting for it, and it is not a log
        // anyone asked to see.
        if (frame.replyTo && this.pulses.delete(frame.replyTo)) return;

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
            case "hook.subscriptions":
                this.subscriptionStore.applySnapshot(frame.payload);
                return;
            case "hook.subscriptions.delta":
                this.subscriptionStore.applyDelta(frame.payload);
                return;
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

        // Only a final status is kept in the conversation, so every call has to end on
        // one. The tool may send its own, with a better label than we could invent; if
        // it does not, we send one for it below rather than leave the call unfinished.
        let reported: "running" | "completed" | "failed" = "running";
        const report = (label: string, state: "running" | "completed" | "failed") => {
            if (reported !== "running") return;
            reported = state;
            this.send("tool.status", { label, state }, frame.id);
        };

        const status = {
            update: (label: string) => report(label, "running"),
            complete: (label: string) => report(label, "completed"),
            fail: (label: string) => report(label, "failed"),
        };

        void tool.invoke(args, meta, status, controller.signal).then(result => {
            this.calls.delete(callId);

            // The socket may have gone while the tool ran; the server has already
            // given up on the call, so there is nothing to report to.
            if (!this.socket) return;

            if (!result.ok && reported === "completed") {
                // The tool said it succeeded and then failed anyway. The outcome is the
                // part worth keeping, so let the failure replace what it claimed.
                reported = "running";
            }

            if (result.ok) report(`Finished ${tool.id}.`, "completed");
            else report(result.error, "failed");

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

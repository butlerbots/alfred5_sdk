import { Buffer } from "node:buffer";
import WebSocket, { RawData } from "ws";
import {
    AUDIO_CODEC_BYTE,
    AUDIO_FLAG,
    AUDIO_HEADER_BYTES,
    AudioClosePayload,
    AudioCodec,
    AudioOpenPayload,
    AudioOpenedPayload,
    AudioWakewordPayload,
    ClientLinkCapabilities,
    ClientLinkChannel,
    ClientLinkFrame,
    ClientLinkIdentity,
    ErrorPayload,
    HelloPayload,
    InboundAudioFrame,
    PingPayload,
    WelcomePayload,
} from "./types";

type ClientLinkEventMap = {
    connected: [];
    authenticated: [WelcomePayload];
    disconnected: [{ code?: number; explicit: boolean }];
    error: [Error | ErrorPayload];
    frame: [ClientLinkFrame];
    "audio.opened": [AudioOpenedPayload];
    "audio.closed": [{ roomId?: string; roomExternalRef?: string }];
    "audio.frame": [InboundAudioFrame];
    "audio.wakeword": [AudioWakewordPayload];
};

type ClientLinkEvent = keyof ClientLinkEventMap;
type ClientLinkListener<T extends ClientLinkEvent> = (...args: ClientLinkEventMap[T]) => void;

export type ClientLinkOptions = {
    url: string;
    token: string;
    identity: ClientLinkIdentity;
    capabilities?: ClientLinkCapabilities;
    pingIntervalMs?: number;
    autoReconnect?: boolean;
    reconnectInitialDelayMs?: number;
    debug?: boolean;
};

/**
 * Generic external-client transport for Alfred.
 *
 * Voice uses the `audio` channel, but the transport itself is not voice-specific.
 * The same link can negotiate `control`, `audio`, `tools`, and `events` channels.
 */
export class ClientLink {
    private readonly options: Required<Omit<ClientLinkOptions, "capabilities">> & {
        capabilities: ClientLinkCapabilities;
    };

    private ws: WebSocket | null = null;
    private authenticated = false;
    private explicitClose = false;
    private reconnectAttempts = 0;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private desiredAudioOpen: AudioOpenPayload | null = null;
    private currentRoomId: string | null = null;
    private outboundSeq = 0;
    private listeners: { [K in ClientLinkEvent]: Set<ClientLinkListener<K>> } = {
        connected: new Set(),
        authenticated: new Set(),
        disconnected: new Set(),
        error: new Set(),
        frame: new Set(),
        "audio.opened": new Set(),
        "audio.closed": new Set(),
        "audio.frame": new Set(),
        "audio.wakeword": new Set(),
    };

    constructor(options: ClientLinkOptions) {
        this.options = {
            ...options,
            capabilities: options.capabilities ?? { channels: ["control", "audio"], wakeword: "server" },
            pingIntervalMs: options.pingIntervalMs ?? 25_000,
            autoReconnect: options.autoReconnect ?? true,
            reconnectInitialDelayMs: options.reconnectInitialDelayMs ?? 1_000,
            debug: options.debug ?? false,
        };
    }

    on<T extends ClientLinkEvent>(event: T, listener: ClientLinkListener<T>): this {
        this.listeners[event].add(listener);
        return this;
    }

    off<T extends ClientLinkEvent>(event: T, listener: ClientLinkListener<T>): this {
        this.listeners[event].delete(listener);
        return this;
    }

    connect(): Promise<WelcomePayload> {
        this.explicitClose = false;

        return new Promise((resolve, reject) => {
            const handleAuth = (payload: WelcomePayload) => {
                this.off("authenticated", handleAuth);
                this.off("error", handleError);
                resolve(payload);
            };

            const handleError = (error: Error | ErrorPayload) => {
                this.off("authenticated", handleAuth);
                this.off("error", handleError);
                reject(error instanceof Error ? error : new Error(`${error.code}: ${error.message}`));
            };

            this.on("authenticated", handleAuth);
            this.on("error", handleError);
            this.openSocket();
        });
    }

    close(): void {
        this.explicitClose = true;
        this.clearReconnectTimer();
        this.clearPingTimer();

        if (!this.ws) return;

        if (this.ws.readyState === WebSocket.OPEN) {
            this.sendFrame("control", "bye", {});
        }

        this.ws.close();
        this.ws = null;
    }

    isAuthenticated(): boolean {
        return this.authenticated;
    }

    get roomId(): string | null {
        return this.currentRoomId;
    }

    /** Low-level JSON frame sender for any negotiated text channel. */
    sendFrame(channel: ClientLinkChannel, type: string, payload: unknown): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const frame: ClientLinkFrame = { channel, type, payload };
        this.ws.send(JSON.stringify(frame));
    }

    /** Convenience helper for opening the audio sub-channel used by voice flows. */
    openAudio(payload: AudioOpenPayload): void {
        this.desiredAudioOpen = payload;
        this.sendFrame("audio", "audio.open", payload);
    }

    /** Convenience helper for closing the audio sub-channel used by voice flows. */
    closeAudio(): void {
        if (!this.desiredAudioOpen) return;

        const payload: AudioClosePayload = {
            roomExternalRef: this.desiredAudioOpen.roomExternalRef,
        };

        this.desiredAudioOpen = null;
        this.currentRoomId = null;
        this.sendFrame("audio", "audio.close", payload);
    }

    /** Convenience helper for binary audio frames on the `audio` channel. */
    sendAudioFrame(
        data: Buffer,
        codec: AudioCodec = "pcm16",
        flags: { activityStart?: boolean; activityEnd?: boolean } = {},
    ): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const header = Buffer.allocUnsafe(AUDIO_HEADER_BYTES);
        this.outboundSeq = (this.outboundSeq + 1) & 0xffff;

        let flagByte = 0;
        if (flags.activityStart) flagByte |= AUDIO_FLAG.ACTIVITY_START;
        if (flags.activityEnd) flagByte |= AUDIO_FLAG.ACTIVITY_END;

        header.writeUInt16BE(this.outboundSeq, 0);
        header.writeUInt8(codec === "pcm16" ? AUDIO_CODEC_BYTE.pcm16 : AUDIO_CODEC_BYTE.opus, 2);
        header.writeUInt8(flagByte, 3);

        this.ws.send(concatBuffers(header, data));
    }

    sendWakeword(payload: AudioWakewordPayload): void {
        this.sendFrame("audio", "audio.wakeword", payload);
    }

    private openSocket(): void {
        this.clearReconnectTimer();
        this.authenticated = false;
        this.ws = new WebSocket(this.options.url);

        this.ws.on("open", () => {
            this.emit("connected");

            const hello: HelloPayload = {
                token: this.options.token,
                identity: this.options.identity,
                capabilities: this.options.capabilities,
            };

            this.sendFrame("control", "hello", hello);
        });

        this.ws.on("message", (data, isBinary) => {
            if (isBinary) {
                this.handleBinary(rawDataToBuffer(data));
                return;
            }

            this.handleText(data.toString("utf8"));
        });

        this.ws.on("close", (code) => {
            this.authenticated = false;
            this.clearPingTimer();
            this.emit("disconnected", { code, explicit: this.explicitClose });

            if (!this.explicitClose && this.options.autoReconnect) {
                this.scheduleReconnect();
            }
        });

        this.ws.on("error", (error) => {
            this.emit("error", error);
        });
    }

    private handleText(raw: string): void {
        let frame: ClientLinkFrame;
        try {
            frame = JSON.parse(raw) as ClientLinkFrame;
        } catch {
            this.emit("error", new Error("Invalid JSON frame received from ClientLink server"));
            return;
        }

        this.emit("frame", frame);

        if (frame.channel === "control") {
            this.handleControlFrame(frame);
            return;
        }

        if (frame.channel === "audio") {
            this.handleAudioFrame(frame);
        }
    }

    private handleControlFrame(frame: ClientLinkFrame): void {
        switch (frame.type) {
            case "welcome": {
                const payload = frame.payload as WelcomePayload;
                this.authenticated = true;
                this.reconnectAttempts = 0;
                this.startPingLoop();
                this.emit("authenticated", payload);

                if (this.desiredAudioOpen) {
                    this.sendFrame("audio", "audio.open", this.desiredAudioOpen);
                }
                return;
            }

            case "pong":
                return;

            case "error":
                this.emit("error", frame.payload as ErrorPayload);
                return;
        }
    }

    private handleAudioFrame(frame: ClientLinkFrame): void {
        switch (frame.type) {
            case "audio.opened": {
                const payload = frame.payload as AudioOpenedPayload;
                this.currentRoomId = payload.roomId;
                this.emit("audio.opened", payload);
                return;
            }

            case "audio.closed": {
                const payload = frame.payload as { roomId?: string; roomExternalRef?: string };
                this.currentRoomId = null;
                this.emit("audio.closed", payload);
                return;
            }

            case "audio.wakeword":
                this.emit("audio.wakeword", frame.payload as AudioWakewordPayload);
                return;
        }
    }

    private handleBinary(data: Buffer): void {
        if (data.length < AUDIO_HEADER_BYTES) return;

        const seqNum = data.readUInt16BE(0);
        const codecByte = data.readUInt8(2);
        const flags = data.readUInt8(3);
        const payload = data.subarray(AUDIO_HEADER_BYTES);

        this.emit("audio.frame", {
            speakerId: "assistant",
            data: payload,
            codec: codecByte === AUDIO_CODEC_BYTE.pcm16 ? "pcm16" : "opus",
            seqNum,
            activityStart: (flags & AUDIO_FLAG.ACTIVITY_START) !== 0,
            activityEnd: (flags & AUDIO_FLAG.ACTIVITY_END) !== 0,
        });
    }

    private startPingLoop(): void {
        this.clearPingTimer();
        this.pingTimer = setInterval(() => {
            const payload: PingPayload = { ts: Date.now() };
            this.sendFrame("control", "ping", payload);
        }, this.options.pingIntervalMs);
    }

    private clearPingTimer(): void {
        if (!this.pingTimer) return;
        clearInterval(this.pingTimer);
        this.pingTimer = null;
    }

    private scheduleReconnect(): void {
        this.clearReconnectTimer();

        const delay = Math.min(
            30_000,
            this.options.reconnectInitialDelayMs * Math.pow(2, this.reconnectAttempts),
        );

        this.reconnectAttempts += 1;
        this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
    }

    private clearReconnectTimer(): void {
        if (!this.reconnectTimer) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    private emit<T extends ClientLinkEvent>(event: T, ...args: ClientLinkEventMap[T]): void {
        for (const listener of this.listeners[event]) {
            try {
                listener(...args);
            } catch (error) {
                if (this.options.debug) {
                    console.warn(`[ClientLink:${event}] listener failed`, error);
                }
            }
        }
    }
}

function concatBuffers(left: Buffer, right: Buffer): Buffer {
    const out = Buffer.allocUnsafe(left.length + right.length);
    left.copy(out, 0);
    right.copy(out, left.length);
    return out;
}

function rawDataToBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (Array.isArray(data)) {
        return Buffer.concat(data.map((part) => rawDataToBuffer(part)));
    }

    const view = data as Uint8Array;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

export type {
    AudioClosePayload,
    AudioCodec,
    AudioOpenPayload,
    AudioOpenedPayload,
    AudioWakewordPayload,
    ClientLinkCapabilities,
    ClientLinkChannel,
    ClientLinkFrame,
    ClientLinkIdentity,
    ErrorPayload,
    InboundAudioFrame,
    WelcomePayload,
};
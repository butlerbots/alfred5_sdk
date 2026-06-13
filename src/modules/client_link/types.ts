import type { Buffer } from "node:buffer";

// =============================================
// CLIENT LINK WIRE TYPES
// =============================================
//
// These mirror the server-side wire protocol exactly
// (see server/src/AI3/client_link/types.ts).
// Audio-specific payloads live here too because `audio`
// is one of the negotiated ClientLink channels.

export type ClientLinkKind = "discord-bot" | "desktop" | "mobile" | "device" | "browser";

export type ClientLinkChannel = "control" | "audio" | "tools" | "events";

export type ClientLinkCapabilities = {
    channels: ClientLinkChannel[];
    /** Whether the client handles wakeword detection itself, or wants the server to */
    wakeword?: "client" | "server";
};

export type ClientLinkIdentity = {
    /** Stable UUID across reconnects for the same logical client */
    linkId: string;
    kind: ClientLinkKind;
    displayName: string;
};

// =============================================
// WIRE FRAMES
// =============================================

/** Text JSON frame envelope */
export type ClientLinkFrame = {
    channel: ClientLinkChannel;
    type: string;
    payload: unknown;
};

export const AUDIO_HEADER_BYTES = 4;

export const AUDIO_CODEC_BYTE = {
    opus: 0,
    pcm16: 1,
} as const;

export const AUDIO_FLAG = {
    ACTIVITY_START: 0b00000001,
    ACTIVITY_END: 0b00000010,
} as const;

export type AudioCodec = "opus" | "pcm16";

// =============================================
// CONTROL CHANNEL MESSAGES
// =============================================

export type HelloPayload = {
    /** JWT access token for the user that owns this link */
    token: string;
    identity: ClientLinkIdentity;
    capabilities: ClientLinkCapabilities;
};

export type WelcomePayload = {
    linkId: string;
    serverVersion: string;
};

export type PingPayload = { ts: number };
export type PongPayload = { ts: number; serverTs: number };
export type ErrorPayload = { code: string; message: string };

// =============================================
// AUDIO CHANNEL CONTROL MESSAGES
// =============================================

export type VoiceRoomMode = "off" | "transcribe" | "realtime";

export type AudioOpenPayload = {
    roomExternalRef: string;
    roomKind: "discord" | "phone" | "device";
    mode?: VoiceRoomMode;
    wakewordHandledBy?: "client" | "server";
};

export type AudioClosePayload = {
    roomExternalRef: string;
};

export type AudioOpenedPayload = {
    roomId: string;
    mode: VoiceRoomMode;
    inputSampleRate: number;
    outputSampleRate: number;
};

export type AudioWakewordPayload = {
    speakerId: string;
    confidence: number;
};

// =============================================
// CALLBACK PAYLOADS (decoded for SDK consumers)
// =============================================

export type InboundAudioFrame = {
    /** Server currently emits a fixed "assistant" speakerId for outbound model audio */
    speakerId: string;
    data: Buffer;
    codec: AudioCodec;
    seqNum: number;
    activityStart: boolean;
    activityEnd: boolean;
};
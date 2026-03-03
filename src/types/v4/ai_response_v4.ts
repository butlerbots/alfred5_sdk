import { AIToolStatusDataV4 } from "./ai_tools_v4";
import { ErrorCode } from "../error";

export type AIChatResultFailV4 = { success: false, errorcode: ErrorCode };
export type AIChatResultSuccessV4 = { success: true, response: AIResponseV4[], usage: any };
export type AIChatResultV4 = AIChatResultFailV4 | AIChatResultSuccessV4;

type AIChatProfileDisplayEntity = {
    name?: string;
    avatarUrl?: string;
}

export type BaseAIResponseMetadataV4 = {
    /** The model that generated this message */
    model: string;
    /** The actual model ID that generated this message */
    modelId: string;
    /** The time when this action started (represents time of first action, meaning in streamed messages it'll hold the time the first chunk was sent) */
    firstTimestamp: number;
    /** Epoch time for when this happened (represents time of last action, meaning in streamed messages it'll hold the time the last chunk was sent) */
    timestamp: number;
}

/** Response Metadata */
export type ResponseStatusMetadataV4 = {
    /** Human-readable model name (e.g. "Claude-Sonnet") */
    model: string;
    /** Provider model identifier (e.g. "claude-sonnet-4-6") */
    modelId: string;
    /** Token usage breakdown */
    tokens: {
        input: number;
        output: number;
        total: number;
        cachedInput: number;
        reasoningOutput: number;
    };
    /** Usage budget info */
    usage: {
        /** Current usage cost as a percentage of daily limit (0–1) */
        percentage: number;
        /** Human-readable percentage (e.g. "42.3%") */
        percentageDisplay: string;
        /** Name of the active usage stage */
        stageName: string;
    };
    /** Model switching info (tiered auto-downgrade) */
    modelSwitching: {
        /** Whether the model was switched from the user's request */
        switched: boolean;
        /** Originally requested model */
        requestedModel: string;
        /** Model that was actually used */
        activeModel: string;
        /** Usage stage that triggered the switch */
        stage?: string;
    };
    /** Response timing */
    timing: {
        /** Milliseconds from request start to first streamed event */
        firstEventMs: number;
        /** Total response time in milliseconds */
        totalMs: number;
    };
}

type AIMessageResponseV4 = {
    /** Specifies type to be a message */
    type: "message";
    payload: {
        /** Message to send to the user */
        message: string;
        /** The associated message id */
        messageId: string;
        /** Whether this message was completed */
        completed: boolean;
    };
    metadata: BaseAIResponseMetadataV4 & {
        /** Display data for this message response, such as the author's name and profile picture */
        display?: AIChatProfileDisplayEntity;
    };
}

export type AIReasoningResponseV4 = {
    /** Specifies type to be a reasoning update */
    type: "reasoning";
    payload: {
        /** The reasoning text */
        reasoning: string;
        /** The associated reasoning id */
        reasoningId: string;
        /** Whether this reasoning step is completed */
        completed: boolean;
    };
    metadata: BaseAIResponseMetadataV4;
}

export type AIFileResponseV4 = {
    /** Specifies type to be a message */
    type: "file";
    payload: {
        /** URL location of the file */
        url?: string;
        /** Base64 representation of the file */
        base64?: string;
        /** The media type of the file */
        mediaType: string;
    };
    metadata: BaseAIResponseMetadataV4 & {
        /** Display data for this message response, such as the author's name and profile picture */
        display?: AIChatProfileDisplayEntity;
    };
}
export type AIResponseStatusResponseV4 = {
    /** Specifies type to be a status update for the response */
    type: "response_status";
    payload: {
        /** Whether the entire AI response is completed */
        completed: boolean;
        /** Response status metadata on success */
        metadata?: ResponseStatusMetadataV4;
    };
}
export type AIConvoStatusResponseV4 = {
    /** Specifies type to be a status update for the conversation */
    type: "convo_status";
    payload: {
        /** Whether the entire AI convo has been disabled, a disabled convo cannot be restarted */
        disabled: boolean;
        /** Whether the AI convo has been stopped, a stopped convo can be restarted
         * although just because it's not stopped does not necasserily mean it's an ongoing conversation */
        stopped: boolean;
    };
}
export type AIToolResponseV4 = {
    /** Specifies type to be a tool use status update */
    type: "tool";
    payload: {
        status: string;
        info: AIToolStatusDataV4;
    };
    metadata: BaseAIResponseMetadataV4 & {};
}
export type AIResponseV4 = AIMessageResponseV4 | AIToolResponseV4 | AIConvoStatusResponseV4 | AIResponseStatusResponseV4 | AIFileResponseV4 | AIReasoningResponseV4;
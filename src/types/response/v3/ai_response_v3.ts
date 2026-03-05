import { AIToolStatusDataV3 } from "./ai_tools_v3";
import { ErrorCode } from "../../error";
import { AIChatProfileDisplayEntity } from "../../conversation/v2/conversation_v2";

export type AIChatResultFailV3 = { success: false, errorcode: ErrorCode };
export type AIChatResultSuccessV3 = { success: true, response: AIResponseV3[], usage: any };
export type AIChatResultV3 = AIChatResultFailV3 | AIChatResultSuccessV3;

export type BaseAIResponseMetadataV3 = {
    /** The model that generated this message */
    model: string;
    /** The actual model ID that generated this message */
    modelId: string;
    /** The time when this action started (represents time of first action, meaning in streamed messages it'll hold the time the first chunk was sent) */
    firstTimestamp: number;
    /** Epoch time for when this happened (represents time of last action, meaning in streamed messages it'll hold the time the last chunk was sent) */
    timestamp: number;
}

type AIMessageResponseV3 = {
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
    metadata: BaseAIResponseMetadataV3 & {
        /** Display data for this message response, such as the author's name and profile picture */
        display?: AIChatProfileDisplayEntity;
    };
}

export type AIReasoningResponseV3 = {
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
    metadata: BaseAIResponseMetadataV3;
}

export type AIFileResponseV3 = {
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
    metadata: BaseAIResponseMetadataV3 & {
        /** Display data for this message response, such as the author's name and profile picture */
        display?: AIChatProfileDisplayEntity;
    };
}
export type AIResponseStatusResponseV3 = {
    /** Specifies type to be a status update for the response */
    type: "response_status";
    payload: {
        /** Whether the entire AI response is completed */
        completed: boolean;
    };
}
export type AIConvoStatusResponseV3 = {
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
export type AIToolResponseV3 = {
    /** Specifies type to be a tool use status update */
    type: "tool";
    payload: {
        status: string;
        info: AIToolStatusDataV3;
    };
    metadata: BaseAIResponseMetadataV3 & {};
}
export type AIResponseV3 = AIMessageResponseV3 | AIToolResponseV3 | AIConvoStatusResponseV3 | AIResponseStatusResponseV3 | AIFileResponseV3 | AIReasoningResponseV3;
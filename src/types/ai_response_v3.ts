import { AIToolStatusData } from "./ai_tools_v3";
import { ErrorCode } from "./error";

type AIChatResultFail = { success: false, errorcode: ErrorCode };
type AIChatResultSuccess = { success: true, response: AIResponse[], usage: any };
export type AIChatResult = AIChatResultFail | AIChatResultSuccess;

type BaseAIResponseMetadata = {
    /** The model that generated this message */
    model: string;
    /** The actual model ID that generated this message */
    modelId: string;
    /** Epoch time for when this happened */
    timestamp: number;
}

type AIMessageResponse = {
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
    metadata: BaseAIResponseMetadata & {};
}
type AIResponseStatusResponse = {
    /** Specifies type to be a status update for the response */
    type: "response_status";
    payload: {
        /** Whether the entire AI response is completed */
        completed: boolean;
    };
}
type AIConvoStatusResponse = {
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
type AIToolResponse = {
    /** Specifies type to be a tool use status update */
    type: "tool";
    payload: {
        status: string;
        info: AIToolStatusData;
    };
    metadata: BaseAIResponseMetadata & {};
}
export type AIResponse = AIMessageResponse | AIToolResponse | AIConvoStatusResponse | AIResponseStatusResponse;
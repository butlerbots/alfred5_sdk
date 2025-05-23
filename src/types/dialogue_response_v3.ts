import { AIResponse } from "./ai_response_v3";
import { ErrorCode } from "./error";

export type RequestBaseResponsePayload = {
    /** Whether the conversation's ending */
    end?: boolean;
    /** Whether the stream is ending */
    quitStream?: boolean;
}

export type RequestFailResponse = {
    success: false;
    data: {
        /** Error code */
        code: ErrorCode;
        /** Error message */
        error: string;
        /** User facing message */
        message: string;
    } & RequestBaseResponsePayload;
}

export type RequestSuccessResponse = {
    success: true;
    data: {
        /** The AI's response */
        response: AIResponse;
        /** The convoId, passed in most responses */
        convoId?: string;
    } & RequestBaseResponsePayload;
}

export type RequestResponse = RequestFailResponse | RequestSuccessResponse;
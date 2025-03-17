import { AIResponse } from "./ai_response_v3";
import { ErrorCode } from "./error";

type RequestBaseResponsePayload = {
    /** Whether the conversation's ending */
    end?: boolean;
    /** Whether the stream is ending */
    quitStream?: boolean;
}

export type RequestFailResponse = {
    success: false;
    payload: {
        /** Error code */
        code: ErrorCode;
        /** Error message */
        error: string;
        /** User facing message */
        message: string;
    } & RequestBaseResponsePayload;
}

export type RequestSucessResponse = {
    success: true;
    payload: {
        /** The AI's response */
        response: AIResponse;
    } & RequestBaseResponsePayload;
}

export type RequestResponse = RequestFailResponse | RequestSucessResponse;
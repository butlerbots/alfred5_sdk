import { AIResponseV3 } from "./ai_response_v3";
import { ErrorCode } from "../../error";

export type RequestBaseResponsePayloadV3 = {
    /** Whether the conversation's ending */
    end?: boolean;
    /** Whether the stream is ending */
    quitStream?: boolean;
}

export type RequestFailResponseV3 = {
    success: false;
    data: {
        /** Error code */
        code: ErrorCode;
        /** Error message */
        error: string;
        /** User facing message */
        message: string;
    } & RequestBaseResponsePayloadV3;
}

export type RequestSuccessResponseV3 = {
    success: true;
    data: {
        /** The AI's response */
        response: AIResponseV3;
        /** The convoId, passed in most responses */
        convoId?: string;
    } & RequestBaseResponsePayloadV3;
}

export type RequestResponseV3 = RequestFailResponseV3 | RequestSuccessResponseV3;
import { AIResponseV4 } from "./ai_response_v4";
import { ErrorCode } from "../../error";

export type RequestBaseResponsePayloadV4 = {
    /** Whether the conversation's ending */
    end?: boolean;
    /** Whether the stream is ending */
    quitStream?: boolean;
}

export type RequestFailResponseV4 = {
    success: false;
    data: {
        /** Error code */
        code: ErrorCode;
        /** Error message */
        error: string;
        /** User facing message */
        message: string;
    } & RequestBaseResponsePayloadV4;
}

export type RequestSuccessResponseV4 = {
    success: true;
    data: {
        /** The AI's response */
        response: AIResponseV4;
        /** The convoId, passed in most responses */
        convoId?: string;
    } & RequestBaseResponsePayloadV4;
}

export type RequestResponseV4 = RequestFailResponseV4 | RequestSuccessResponseV4;
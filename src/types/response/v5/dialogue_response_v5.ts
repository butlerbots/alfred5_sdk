import { AIResponseV5 } from "./ai_response_v5";
import { ErrorCode } from "../../error";

export type RequestFailResponseV5 = {
    success: false;
    data: {
        code: ErrorCode;
        error: string;
        message: string;
        /** The HTTP status, when the stream failed on one before the server said anything */
        status?: number;
        quitStream?: boolean;
    };
};

export type RequestSuccessResponseV5 = {
    success: true;
    data: {
        response: AIResponseV5;
        convoId?: string;
        quitStream?: boolean;
    };
};

export type RequestResponseV5 = RequestFailResponseV5 | RequestSuccessResponseV5;

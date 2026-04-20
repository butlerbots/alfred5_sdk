import { RequestResponseV4 } from "./dialogue_response_v4";

export type TurnProgressEntry = {
    /** The ID of the buffered event */
    eventId: string;
    /** The actual event payload */
    event: RequestResponseV4
};
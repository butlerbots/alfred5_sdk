import { RequestResponseV5 } from "./dialogue_response_v5";

export type TurnProgressEntryV5 = {
    /** The ID of the buffered event */
    eventId: string;
    /** The actual event payload */
    event: RequestResponseV5;
};

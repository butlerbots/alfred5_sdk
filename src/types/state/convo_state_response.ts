import { ConversationV1 } from "../conversation/v1/conversation_v1"
import { ConversationV2 } from "../conversation/v2/conversation_v2"
import { ConversationV3 } from "../conversation/v3/conversation_v3"

export type ConversationStateResponse = {
    success: true;
    conversation: ConversationV1 | ConversationV2 | ConversationV3;
} | {
    success: false;
    error: string;
    errormessage: string;
}
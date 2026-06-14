import type {
    MessagePayload,
    ReasoningPayload,
    FilePayload,
    ToolPayload,
    ConvoStatusPayload,
    ResponseStatusPayload,
    BaseResponseMetadata,
    DisplayEntity,
} from "../../response/v5/ai_response_v5";
import type { ConversationMessage } from "./message_v4";

export type DialogueEntry = {
    from: "user" | "assistant";
    display?: DisplayEntity;
    timestamp: number;
    metadata?: BaseResponseMetadata;
} & (
    | { type: "message"; payload: MessagePayload }
    | { type: "reasoning"; payload: ReasoningPayload }
    | { type: "file"; payload: FilePayload }
    | { type: "tool"; payload: ToolPayload }
    | { type: "convo_status"; payload: ConvoStatusPayload }
    | { type: "response_status"; payload: ResponseStatusPayload }
);

export type ConversationState = {
    settings: {
        model?: string;
        title?: string;
        system?: string;
        location?: string;
        locationInstructions?: string;
        temperature?: number;
        disableAutoTitle?: boolean;
    };
    summary?: {
        shortSummary?: string;
        longSummary?: string;
    };
    messages: ConversationMessage[];
    dialogue: DialogueEntry[];
};

export interface ConversationV4 {
    version: "4.0";
    conversationId: string;
    ownerUserId: string;
    disableView?: boolean;
    state: ConversationState;
}

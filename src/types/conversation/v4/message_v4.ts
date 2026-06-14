export type ConversationMessageContentText = { type: "input_text"; text: string };
export type ConversationMessageContentOutputText = { type: "output_text"; text: string };

export type ConversationMessageMeta = {
    participantId?: string;
    attributedUserId?: string;
    summarized?: unknown;
    timestamp?: number;
};

export type ConversationMessage =
    | {
        type: "user_message";
        role: "user";
        content: string | ConversationMessageContentText[];
        ai4?: ConversationMessageMeta;
    }
    | {
        type: "system_message";
        role: "system";
        content: string;
        ai4?: ConversationMessageMeta;
    }
    | {
        type: "assistant_message";
        role: "assistant";
        content: ConversationMessageContentOutputText[];
        id: string;
        ai4?: ConversationMessageMeta;
    }
    | {
        type: "function_call";
        name: string;
        arguments: string;
        callId: string;
        id?: string;
        ai4?: ConversationMessageMeta;
    }
    | {
        type: "function_call_output";
        callId: string;
        output: string;
        id?: string;
        ai4?: ConversationMessageMeta;
    }
    | {
        type: "reasoning";
        content: Array<{ text: string; type?: string }>;
        summary?: Array<{ text: string; type?: string }>;
        id: string;
        ai4?: ConversationMessageMeta;
    }
    | {
        type: "web_search_call";
        id: string;
        status: string;
        action: Record<string, unknown>;
        ai4?: ConversationMessageMeta;
    }
    | {
        type: "file_search_call";
        id: string;
        queries: string[];
        status: string;
        ai4?: ConversationMessageMeta;
    }
    | {
        type: "image_generation_call";
        id: string;
        result?: string;
        status: string;
        image?: { b64_json?: string; url?: string; media_type?: string };
        ai4?: ConversationMessageMeta;
    }
    | {
        type: "server_tool_item";
        id: string;
        outputType: string;
        output: Record<string, unknown>;
        ai4?: ConversationMessageMeta;
    };

import { ModelMessage } from "./aisdk_types";

/** A message in the conversation, extending AI SDK's ModelMessage with AI3 metadata */
export type ConversationMessage = ModelMessage & {
    /** AI3-specific metadata */
    ai3?: {
        /** ID of the participant who sent this message */
        participantId?: string;
        /** Condensed/summarized version of this message content */
        summarized?: any;
        /** When this message was added */
        timestamp?: number;
    }
}

/** Display information for a participant */
export type DisplayEntity = {
    name?: string;
    avatarUrl?: string;
}

/** Rich content that can be attached to tool status updates.
 *  Clients can render these if supported, or fall back to just the `label` field on ToolStatus. */
export type ToolStatusContent =
    | { type: "text"; text: string }
    | { type: "code"; language: string; code: string }
    | { type: "image"; url: string; alt?: string }
    | { type: "progress"; current: number; total: number; label?: string }
    | { type: "data"; data: Record<string, unknown> };

/** Tool execution status. **/
export type ToolStatus = {
    /** Unique ID for this tool execution */
    id: string;
    /** Parent tool ID (for nested tool calls, e.g., agent sub-tools) */
    parentId?: string;
    /** Top-level status label — always available, suitable for minimal UI */
    label: string;
    /** Current state of the tool execution */
    state: "running" | "completed" | "failed";
    /** Optional rich content for clients that support it */
    content?: ToolStatusContent[];
    /** Whether this tool call is ending the conversation */
    endingConvo?: boolean;
}

export type TokenUsage = {

    /**
 * The total number of input (prompt) tokens used.
 */
    inputTokens: number | undefined;
    /**
     * Detailed information about the input tokens.
     */
    inputTokenDetails: {
        /**
         * The number of non-cached input (prompt) tokens used.
         */
        noCacheTokens: number | undefined;
        /**
         * The number of cached input (prompt) tokens read.
         */
        cacheReadTokens: number | undefined;
        /**
         * The number of cached input (prompt) tokens written.
         */
        cacheWriteTokens: number | undefined;
    };
    /**
     * The number of total output (completion) tokens used.
     */
    outputTokens: number | undefined;
    /**
     * Detailed information about the output tokens.
     */
    outputTokenDetails: {
        /**
         * The number of text tokens used.
         */
        textTokens: number | undefined;
        /**
         * The number of reasoning tokens used.
         */
        reasoningTokens: number | undefined;
    };
    /**
     * The total number of tokens used.
     */
    totalTokens: number | undefined;
    /**
     * Raw usage information from the provider.
     *
     * This is the usage information in the shape that the provider returns.
     * It can include additional information that is not part of the standard usage information.
     */
    raw?: any;
}

export type ModelMessageCost = {
    inputCost: number,
    outputCost: number,
    totalCost: number,
    inputCostDetails: {
        noCacheCost: number,
        cacheReadCost: number,
        cacheWriteCost: number,
    },
    outputCostDetails: {
        textCost: number,
        reasoningCost: number,
    },
}

/** Detailed metadata about a completed response. **/
export type ResponseMetadata = {
    /** Human-readable model name (e.g. "Claude-Sonnet") */
    model: string;
    /** Provider model identifier (e.g. "claude-sonnet-4-6") */
    modelId: string;
    /** Model-specific information */
    modelInfo: {
        /** Maximum context length for this model */
        contextLimit?: number;
    }
    /** Token usage breakdown */
    tokens: TokenUsage;
    /** The cost breakdown */
    cost: {
        /** The cost of the current turn */
        turnCost?: ModelMessageCost
        /** The current user's usage cost */
        dailyUsageCost: number;
        /** The user's cost limit for the conversation (e.g., daily limit) */
        dailyUsageCostLimit: number;
    };
    /** Usage budget info */
    limit: {
        /** Current usage cost as a percentage of daily limit (0–1) */
        percentage: number;
        /** Human-readable percentage (e.g. "42.3%") */
        percentageDisplay: string;
        /** Name of the active usage stage */
        stageName: string;
    };
    /** Model switching info (tiered auto-downgrade) */
    modelSwitching: {
        /** Whether the model was switched from the user's request */
        switched: boolean;
        /** Originally requested model */
        requestedModel: string;
        /** Model that was actually used */
        activeModel: string;
        /** Usage stage that triggered the switch */
        stage?: string;
    };
    /** Response timing */
    timing: {
        /** Milliseconds from request start to first streamed event */
        firstEventMs: number;
        /** Total response time in milliseconds */
        totalMs: number;
    };
}

export type MessagePayload = {
    /** The message content */
    message: string;
    /** The UUID of this message */
    messageId: string;
    /** Whether this message chunk is the final one */
    completed: boolean;
};

export type ReasoningPayload = {
    /** The reasoning content */
    reasoning: string;
    /** The UUID of this reasoning */
    reasoningId: string;
    /** Whether this reasoning chunk is the final one */
    completed: boolean;
};

export type FilePayload = {
    /** The file URL */
    url?: string;
    /** The media type of the file */
    mediaType: string
};

export type ToolPayload = {
    /** The tool status */
    status: ToolStatus
};

export type ConvoStatusPayload = {
    /** Whether the entire AI convo has been disabled, a disabled convo cannot be restarted */
    disabled?: boolean;
    /** Whether the AI convo has been stopped, a stopped convo can be restarted
         * although just because it's not stopped does not necasserily mean it's an ongoing conversation */
    stopped?: boolean;
    /** Short summary generated for this conversation */
    shortSummary?: string
};

export type ResponseStatusPayload = {
    completed: boolean;
    /** Rich response metadata — only present on the final `completed: true` event.
     *  Populated by the caller (e.g. gateway) after the response finishes and usage is available. */
    metadata?: ResponseMetadata;
};

export type BaseResponseMetadata = {
    /** Unique response ID */
    responseId: string;
    /** Model display name (e.g., "GPT-5") */
    model: string;
    /** Actual model ID (e.g., "gpt-5.2-2025-12-11") */
    modelId: string;
    /** Timestamp of first action (first stream chunk) */
    firstTimestamp: number;
    /** Timestamp of last action */
    timestamp: number;
    /** The participant who generated this response */
    participantId?: string;
}

export type MessageEvent = {
    type: "message";
    payload: MessagePayload;
    metadata: BaseResponseMetadata & {
        display?: DisplayEntity;
    };
}

export type ReasoningEvent = {
    type: "reasoning";
    payload: ReasoningPayload;
    metadata: BaseResponseMetadata;
}

export type FileEvent = {
    type: "file";
    payload: FilePayload & { base64?: string };
    metadata: BaseResponseMetadata & {
        display?: DisplayEntity;
    };
}

export type ToolEvent = {
    type: "tool";
    payload: ToolPayload;
    metadata: BaseResponseMetadata;
}

export type ResponseStatusEvent = {
    type: "response_status";
    payload: ResponseStatusPayload;
}

export type ConvoStatusEvent = {
    type: "convo_status";
    payload: ConvoStatusPayload;
}

/** An entry in the client-facing dialogue history.
 *  Unlike `ConversationMessage` (which stores raw AI SDK messages),
 *  dialogue entries are human-readable and intended for UI rendering. */
export type DialogueEntry = {
    /** Who sent this */
    from: "user" | "assistant";
    /** Display info for the sender */
    display?: DisplayEntity;
    /** When this happened */
    timestamp: number;
} & (
        | { type: "message"; payload: { message: string } }
        | { type: "reasoning"; payload: { reasoning: string; reasoningId: string } }
        | { type: "file"; payload: { url?: string; mediaType: string } }
        | { type: "tool"; payload: { status: ToolStatus } }
        | { type: "convo_status"; payload: { disabled?: boolean; stopped?: boolean; shortSummary?: string } }
        | { type: "response_status"; payload: { completed: boolean } }
    );

/** Serializable conversation state **/
export type ConversationState = {
    /** Conversation settings */
    settings: {
        /** Default AI model name */
        model?: string;
        /** Conversation title */
        title?: string;
        /** System prompt override (bypasses personality generation when set) */
        system?: string;
        /** Where this conversation takes place */
        location?: string;
        /** Location-specific formatting instructions (e.g., "use discord formatting") */
        locationInstructions?: string;
        /** AI temperature (0-1) */
        temperature?: number;
        /** Disable auto-title generation */
        disableAutoTitle?: boolean;
        /** Enable token caching */
        tokenCaching?: boolean;
    };
    /** Conversation summaries */
    summary?: {
        shortSummary?: string;
        longSummary?: string;
    };
    /** Raw message history (AI SDK compatible) */
    messages: ConversationMessage[];
    /** Client-facing dialogue history */
    dialogue: DialogueEntry[];
}

export interface ConversationV3 {
    version: "3.0"
    conversationId: string
    ownerUserId: string

    /** Whether to disable the ability for the user to view this conversation */
    disableView?: boolean

    /** AI3 conversation state */
    state: ConversationState
}
// =============================================
// DISPLAY
// =============================================

/** Display information for a participant */
export type DisplayEntity = {
    name?: string;
    avatarUrl?: string;
}

// =============================================
// TOOL STATUS (Enhanced)
// =============================================

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

// =============================================
// RESPONSE METADATA
// =============================================

export type BaseResponseMetadata = {
    /** Unique response ID */
    responseId: string;
    /** Model display name (e.g., "GPT-5") */
    model: string;
    /** Actual model ID (e.g., "openai/gpt-5.2") */
    modelId: string;
    /** Timestamp of first action (first stream chunk) */
    firstTimestamp: number;
    /** Timestamp of last action */
    timestamp: number;
    /** The participant who generated this response */
    participantId?: string;
}

// =============================================
// BASE PAYLOADS (single source of truth)
// =============================================

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
    mediaType: string;
};

export type ToolPayload = {
    /** The tool status */
    status: ToolStatus;
};

export type ConvoStatusPayload = {
    /** The state of the conversation.
     * - `disabled`: The conversation has been permanently disabled and cannot be restarted.
     * - `stopped`: The conversation has been stopped but can be restarted.
     * - `started`: The conversation has been started/restarted.
     */
    state?: "disabled" | "stopped" | "started";
    /** Short summary generated for this conversation */
    shortSummary?: string;
};

export type ResponseStatusPayload = {
    completed: boolean;
    /**
     * The reason why the engine finished the turn
     * 
     * Can be one of the following:
     * - `done`: model finished the turn
     * - `error`: turn stopped because of an error
     * - `max_steps`: turn finished because it reached the maximum number of steps defined in the conversation policy
     * - `other`: turn stopped for other reasons
     */
    turnFinishReason?: EngineTurnFinishReason;
    /** Rich response metadata — only present on the final `completed: true` event.
     *  Populated by the post-processor after the response finishes and usage is available. */
    metadata?: ResponseMetadata;
};

// =============================================
// TOKEN USAGE
// =============================================

/** Token usage information */
export type TokenUsage = {
    /** The total number of input (prompt) tokens used. */
    inputTokens: number;
    /** Detailed information about the input tokens. */
    inputTokensDetails: {
        /** The number of cached input tokens read. */
        cachedTokens: number;
    };
    /** The total number of output (completion) tokens used. */
    outputTokens: number;
    /** Detailed information about the output tokens. */
    outputTokensDetails: {
        /** The number of reasoning tokens used. */
        reasoningTokens: number;
    };
    /** The total number of tokens used. */
    totalTokens: number;
    /** Total cost of the turn in USD */
    cost?: number | null;
    /** Upstream cost breakdown from the provider. */
    costDetails?: {
        /** Total upstream inference cost. */
        upstreamInferenceCost?: number | null;
        /** Upstream input (prompt) cost. */
        upstreamInferenceInputCost: number;
        /** Upstream output (completion) cost. */
        upstreamInferenceOutputCost: number;
    };
};

// =============================================
// ENGINE TYPES
// =============================================

export type EngineTurnFinishReason = "error" | "done" | "max_steps" | "other";

// =============================================
// CONVERSATION EVENTS
// =============================================

/** A user message event */
export type UserMessageEvent = {
    type: "user_message";
    payload: MessagePayload;
    metadata: BaseResponseMetadata & { userId: string };
}

export type MessageEvent = {
    type: "message";
    payload: MessagePayload;
    metadata: BaseResponseMetadata & { display?: DisplayEntity };
}

export type ReasoningEvent = {
    type: "reasoning";
    payload: ReasoningPayload;
    metadata: BaseResponseMetadata;
}

export type FileEvent = {
    type: "file";
    payload: FilePayload & { base64?: string };
    metadata: BaseResponseMetadata & { display?: DisplayEntity };
}

export type ToolEvent = {
    type: "tool";
    event: "call";
    payload: ToolPayload;
    metadata: BaseResponseMetadata;
} | {
    type: "tool";
    event: "input";
    payload: {
        toolName: string;
        toolCallId: string;
        input: string;
        completed: boolean;
    };
}

export type ResponseStatusEvent = {
    type: "response_status";
    payload: ResponseStatusPayload;
}

export type ConvoStatusEvent = {
    type: "convo_status";
    payload: ConvoStatusPayload;
}

/** A single routing attempt */
export type RoutingAttempt = {
    /** The model ID attempted. */
    model: string;
    /** The provider slug (e.g., "anthropic", "google"). */
    provider: string;
    /** HTTP status code from the attempt. */
    status: number;
};

/** Routing metadata — shows how the request was routed across providers.
 *  The last entry in `attempts` is the provider that ultimately served the response. */
export type RoutingMetadata = {
    /** Routing strategy used (e.g., "auto", "direct", "pareto"). */
    strategy: string;
    /** Region the request was routed to. */
    region: string | null;
    /** All routing attempts in order — last entry is the successful provider. */
    attempts: RoutingAttempt[];
    /** Human-readable routing summary. */
    summary: string;
};

/** Detailed metadata about a completed response. **/
export type ResponseMetadata = {
    /** Unique response ID */
    responseId: string;
    /** Timestamp of first action (first stream chunk) */
    firstTimestamp: number;
    /** Timestamp of final response metadata creation */
    timestamp: number;
    /** The participant who generated this response */
    participantId?: string;
    /** Human-readable model name (e.g. "Claude-Sonnet") */
    model: string;
    /** Provider model identifier (e.g. "openai/gpt-5.2") */
    modelId: string;
    /** Model-specific information */
    modelInfo: {
        /** Maximum context length for this model */
        contextLimit?: number;
    };
    /** Token usage details including cost from the provider (OpenRouter). */
    usage: TokenUsage;
    /** Compact estimated attribution of prompt/tool/message tokens for UI/debugging. */
    usageBreakdown?: Record<string, unknown>;
    /** Response timing */
    timing: {
        /** Milliseconds from turn start to first streamed event */
        firstEventMs: number;
        /** Total turn time in milliseconds */
        totalMs: number;
    };
    /** Routing metadata — which providers were tried and who served the response. */
    routing?: RoutingMetadata;
}

/** All possible events emitted during a conversation turn */
export type ConversationEvent =
    | UserMessageEvent
    | MessageEvent
    | ReasoningEvent
    | FileEvent
    | ToolEvent
    | ResponseStatusEvent
    | ConvoStatusEvent;

/** Callback for streaming conversation events */
export type ConversationEventCallback = (event: ConversationEvent) => void;

export type AIResponseV5 = ConversationEvent;


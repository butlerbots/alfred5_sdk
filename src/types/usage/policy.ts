import { AI_MODEL } from "../model"

export type PolicyRule = {
    /** When the current usage exceeds this threshold */
    whenUsageAbove: {
        type: "percentage",
        value: number,
    },
    /** When the current chosen model is equal to this model */
    whenModelEquals?: {
        value: AI_MODEL,
    }
    /** The model to overwrite the convos as, 'null' means no overwrite - use user's choice */
    model: AI_MODEL | null,
    /** When this rule is activated, this message will be sent to the user */
    switchMessage?: string
    /** The message appended on the end of every message sent giving additional info */
    appendMessage?: string,
}

export type UsagePolicy = {
    rules: PolicyRule[],
    maxConvoLength?: number,
}

export type UsagePolicyData = {
    limit: {
        /** Current usage cost as a percentage of daily limit (0–1) */
        percentage: number;
    },
    /** Model switching info (tiered auto-downgrade) */
    modelSwitching: {
        /** Whether the model was switched from the user's request */
        switched: boolean;
        /** Originally requested model */
        requestedModel?: string;
        /** Model that was actually used */
        activeModel?: string;
    },
    /** Usage policy information */
    usagePolicy: UsagePolicy,
    daily: {
        /** The current user's usage cost */
        dailyUsageCost: number;
        /** The user's cost limit for the conversation (e.g., daily limit) */
        dailyUsageCostLimit: number;
    }
}
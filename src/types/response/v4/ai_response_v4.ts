import { ConvoStatusEvent, FileEvent, MessageEvent, ModelMessageCost, ReasoningEvent, ResponseMetadata, ResponseStatusEvent, TokenUsage, ToolEvent } from "../../conversation/v3/conversation_v3";
import { ErrorCode } from "../../error";

export type AIChatResultFailV4 = { success: false, errorcode: ErrorCode };
export type AIChatResultSuccessV4 = { success: true, response: AIResponseV4[], usage: any };
export type AIChatResultV4 = AIChatResultFailV4 | AIChatResultSuccessV4;

export type TokenUsageV4 = TokenUsage;
export type ModelMessageCostV4 = ModelMessageCost;
export type ResponseStatusMetadataV4 = ResponseMetadata;

export type AIMessageResponseV4 = MessageEvent;
export type AIReasoningResponseV4 = ReasoningEvent;
export type AIFileResponseV4 = FileEvent;
export type AIResponseStatusResponseV4 = ResponseStatusEvent;
export type AIConvoStatusResponseV4 = ConvoStatusEvent;
export type AIToolResponseV4 = ToolEvent;

export type AIResponseV4 = AIMessageResponseV4 | AIToolResponseV4 | AIConvoStatusResponseV4 | AIResponseStatusResponseV4 | AIFileResponseV4 | AIReasoningResponseV4;
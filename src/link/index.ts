export { Link } from "./link";
export type { LinkOptions, LinkEvents, LinkState, ExchangeOptions } from "./link";
export { Tool } from "./tool";
export type { ToolConfig, ToolRunContext, ToolCallMeta, ToolStatusReporter, ToolInvocation } from "./tool";
export { Hook } from "./hook";
export type { HookConfig, HookEmitter } from "./hook";
export { LINK_PROTOCOL_VERSION, LinkError } from "./protocol";
export type {
    LinkClientFrame,
    LinkClientFrameType,
    LinkServerFrame,
    LinkServerFrameType,
    LinkScopeKind,
    LinkToolDescriptor,
    LinkHookDeclaration,
    LinkHookEventDeclaration,
} from "./protocol";
export type { JSONSchema, StandardSchemaV1, ToolSchema, InferSchemaOutput } from "./schema";
export { buildHandshake, defaultSocketFactory } from "./socket";
export type { SocketFactory, SocketConnection, SocketHandlers } from "./socket";

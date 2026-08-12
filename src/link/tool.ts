import { LinkToolDescriptor } from "./protocol";
import { InferSchemaOutput, JSONSchema, ToolSchema, toJSONSchema, validateArgs } from "./schema";

/**
 * Reports progress while a tool runs. Shown live in Alfred's tool status feed.
 *
 * `update` is progress; `complete` and `fail` are final. Only a final status is kept
 * in the conversation once the turn ends — a status left at `update` is shown live
 * and then forgotten — so a tool that wants to leave a trace should finish with
 * `complete`. If it does not, the link sends a final status for it when `run`
 * returns, so the call is recorded either way.
 */
export type ToolStatusReporter = {
    /** Replaces the current status label. The call is still running. */
    update(label: string): void;
    /** Marks the tool as finished, with the label the conversation keeps. */
    complete(label: string): void;
    /** Marks the tool as failed in the UI. The thrown error still decides the result. */
    fail(label: string): void;
};

export type ToolCallMeta = {
    /** The user Alfred is acting for. */
    userId: string;
    /** The conversation the call came from, when it came from one. */
    chatId?: string;
    /** Unique per call, useful for logs. */
    runId: string;
    /**
     * The user's linked accounts, in namespaces you understand: `{ discord: "1897..." }`.
     *
     * Present only for global-scope links — a platform client acting *as* the user, which is the case
     * that needs it: to kick somebody as them you need their Discord id, and resolving that from an
     * Alfred user id is the server's job. A user-scoped link is already the user's own process and is
     * told nothing extra.
     *
     * Absent when the user has linked nothing. Refuse the call rather than guessing.
     */
    identities?: Record<string, string>;
};

export type ToolRunContext<S extends ToolSchema | undefined> = {
    /** Typed from `schema` when one was given. */
    args: S extends ToolSchema ? InferSchemaOutput<S> : Record<string, unknown>;
    meta: ToolCallMeta;
    status: ToolStatusReporter;
    /** Aborted when Alfred cancels the call or it times out server-side. */
    signal: AbortSignal;
};

export type ToolConfig<S extends ToolSchema | undefined> = {
    /**
     * This tool's id within the link. The public id becomes `link:<linkId>/<id>`,
     * which is what the user's saved settings refer to — so treat it as permanent.
     */
    id: string;
    /** What the tool does. This is what the model reads to decide whether to call it. */
    description: string;
    /** A zod 4 schema, any Standard Schema, or a plain JSON Schema object. */
    schema?: S;
    /** JSON Schema to send instead of deriving it from `schema`. */
    jsonSchema?: JSONSchema;
    /** Shown in Alfred's settings UI. Without it the tool is hidden there. */
    display?: {
        name: string;
        shortDescription: string;
        longDescription: string;
    };
    /** Whether the tool is on before the user has touched it. */
    defaultEnabled?: boolean;
    /**
     * Where in Alfred the tool is reachable, as platform ids. Defaults to the user's chat.
     *
     * Say this when your client mirrors a whole platform. A Discord bot offering seventy tools does
     * not want seventy entries in front of somebody having a conversation about their groceries — it
     * wants them behind Alfred's Discord agent, which is one entry and already knows how to decide
     * when Discord is relevant.
     *
     * Known values are Alfred's platform ids, e.g. `"platform.chat.user"` (the default) and
     * `"platform.agent.discord"`. An unknown one is rejected at registration rather than ignored,
     * because a tool reachable from nowhere is indistinguishable from a tool that is broken.
     */
    platforms?: string[];
    /** How long the server waits for a result before giving up. */
    timeoutMs?: number;
    /** Runs the tool. Return anything JSON-serialisable, or throw to fail the call. */
    run: (context: ToolRunContext<S>) => unknown | Promise<unknown>;
};

/**
 * A tool of any schema, which is what a link holds.
 *
 * `Tool<S>` mentions `S` in its config, so a collection of tools with different
 * schemas has no common `Tool<...>` type. This is the part a link actually uses,
 * and every `Tool` satisfies it whatever its schema.
 */
export interface AnyTool {
    readonly id: string;
    linkedId?: string;
    descriptor(): LinkToolDescriptor;
    invoke(
        args: unknown,
        meta: ToolCallMeta,
        status: ToolStatusReporter,
        signal: AbortSignal,
    ): Promise<ToolInvocation>;
}

/** The outcome of one call, as reported back to the server. */
export type ToolInvocation =
    | { ok: true; output: unknown }
    | { ok: false; error: string };

/**
 * A tool that runs on your machine and that Alfred can call.
 *
 * Registered tools belong to the *user*, not to a conversation: once a link is
 * connected Alfred can call them anywhere that user talks to it, including the web
 * app and Discord.
 */
export class Tool<S extends ToolSchema | undefined = undefined> {
    readonly id: string;

    /** The public id (`link:<linkId>/<id>`), known once the link has registered it. */
    linkedId?: string;

    constructor(private readonly config: ToolConfig<S>) {
        this.id = config.id;
    }

    get description(): string {
        return this.config.description;
    }

    /** The declaration sent to the server. */
    descriptor(): LinkToolDescriptor {
        const inputSchema = this.config.jsonSchema
            ?? (this.config.schema ? toJSONSchema(this.config.schema, this.id) : { type: "object", properties: {} });

        return {
            localId: this.id,
            description: this.config.description,
            inputSchema,
            ...(this.config.display ? { display: this.config.display } : {}),
            ...(this.config.defaultEnabled !== undefined ? { defaultEnabled: this.config.defaultEnabled } : {}),
            ...(this.config.platforms ? { platforms: this.config.platforms } : {}),
            ...(this.config.timeoutMs !== undefined ? { timeoutMs: this.config.timeoutMs } : {}),
        };
    }

    /**
     * Validates the arguments, runs the tool, and turns a throw into a failure.
     *
     * Never rejects: a call the server is waiting on must always get an answer, and
     * a thrown error is a result like any other.
     */
    async invoke(
        args: unknown,
        meta: ToolCallMeta,
        status: ToolStatusReporter,
        signal: AbortSignal,
    ): Promise<ToolInvocation> {
        const validated = await validateArgs<ToolRunContext<S>["args"]>(this.config.schema, args);
        if (!validated.ok) return { ok: false, error: validated.error };

        try {
            const output = await this.config.run({ args: validated.value, meta, status, signal });
            return { ok: true, output };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
}

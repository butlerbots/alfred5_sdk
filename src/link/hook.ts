import { LinkHookDeclaration, LinkHookEventDeclaration } from "./protocol";
import { JSONSchema, ToolSchema, toJSONSchema } from "./schema";

export type HookConfig<S extends ToolSchema | undefined> = {
    /**
     * This hook's id within the link. The public id becomes `link:<linkId>/<id>`,
     * which the user's background agents are subscribed to — so treat it as permanent.
     */
    id: string;
    /** Human name, shown wherever hooks are listed. */
    name: string;
    /** What makes this hook fire. Read by whoever wires an agent up to it. */
    description: string;
    /** The events this hook can emit. Emitting an undeclared event is refused. */
    events: LinkHookEventDeclaration[];
    /**
     * What an agent subscribing to this hook can configure — a filter, a threshold.
     * A zod 4 schema, any Standard Schema, or a plain JSON Schema object.
     */
    schema?: S;
    /** JSON Schema to send instead of deriving it from `schema`. */
    jsonSchema?: JSONSchema;
};

/** What a hook needs from its link in order to emit. Implemented by `Link`. */
export type HookEmitter = {
    /**
     * Emits on the hook with this local id. The link resolves the public source id,
     * which only exists once the hook has been registered.
     */
    emitHook(hookId: string, event: string, payload?: Record<string, unknown>, ownerId?: string): Promise<void>;
};

/**
 * A source of events that can wake the user's background agents.
 *
 * A hook does not run anything itself: it announces that something happened, and
 * the agents the user has subscribed to it decide what to do about that.
 */
export class Hook<S extends ToolSchema | undefined = undefined> {
    readonly id: string;

    /** The public id (`link:<linkId>/<id>`), known once the link has registered it. */
    sourceId?: string;

    private link?: HookEmitter;

    constructor(private readonly config: HookConfig<S>) {
        this.id = config.id;
    }

    get name(): string {
        return this.config.name;
    }

    get events(): LinkHookEventDeclaration[] {
        return this.config.events;
    }

    /** The declaration sent to the server. */
    declaration(): LinkHookDeclaration {
        return {
            localId: this.id,
            name: this.config.name,
            description: this.config.description,
            argsSchema: this.config.jsonSchema
                ?? (this.config.schema ? toJSONSchema(this.config.schema, this.id) : { type: "object", properties: {} }),
            events: this.config.events,
        };
    }

    /** Called by `Link.addHook`. */
    attach(link: HookEmitter): void {
        this.link = link;
    }

    /**
     * Announces that one of this hook's events happened.
     *
     * Waits for the link to be connected if it is still coming up, so a hook can
     * fire during startup without the caller sequencing it by hand.
     *
     * @param ownerId Global-scope links only: the user this event concerns. A
     * user-scoped link is always stamped with its own owner and may not name another.
     */
    async emit(event: string, payload?: Record<string, unknown>, ownerId?: string): Promise<void> {
        if (!this.link) {
            throw new Error(`Hook "${this.id}" is not on a link yet — call link.addHook(hook) first.`);
        }

        // Caught here rather than on the wire: a typo should fail where it was made.
        if (!this.config.events.some(declared => declared.name === event)) {
            const declared = this.config.events.map(entry => entry.name).join(", ") || "none";
            throw new Error(`Hook "${this.id}" does not declare an event named "${event}". Declared: ${declared}.`);
        }

        // The local id, not `sourceId`: emitting during startup gets here before
        // registration has assigned one, and the link fills it in once it knows.
        await this.link.emitHook(this.id, event, payload, ownerId);
    }
}

import { LinkHookDeclaration, LinkHookEventDeclaration } from "./protocol";
import type { LinkSubscription } from "./subscriptions";
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

/**
 * A hook of any schema, which is what a link holds. See `AnyTool` for why this
 * exists rather than a `Hook<...>`.
 */
export interface AnyHook {
    readonly id: string;
    sourceId?: string;
    declaration(): LinkHookDeclaration;
    attach(link: HookEmitter): void;
}

/** What a hook needs from its link in order to emit. Implemented by `Link`. */
export type HookEmitter = {
    /**
     * Emits on the hook with this local id. The link resolves the public source id,
     * which only exists once the hook has been registered.
     */
    emitHook(hookId: string, event: string, payload?: Record<string, unknown>, ownerId?: string): Promise<void>;
    /**
     * Reports an event against the subscriptions it matched, sending nothing when it
     * matched none. Returns the ids that were reported.
     */
    reportHookEvent(
        hookId: string,
        event: string,
        payload?: Record<string, unknown>,
        subscriptionIds?: string[],
    ): Promise<string[]>;
    /** The subscriptions the server has pushed for this hook's source. */
    hookSubscriptions(hookId: string): LinkSubscription[];
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

    /**
     * Reports that something happened, to whoever asked to be told.
     *
     * The difference from `emit` is where the filtering lives. `emit` hands the event to the server
     * and lets it decide who cares, which means the server needs to understand your platform's
     * payloads. `report` matches locally against the subscriptions the server pushed down, and sends
     * only the ids that matched — so "messages in #support from non-bots" stays knowledge that lives
     * in your code, and an event nobody subscribed to costs nothing at all.
     *
     * Returns the subscription ids reported, which is `[]` when nothing matched. `[]` is the common
     * case in a busy channel and is not an error.
     *
     * Match it yourself when the condition is more than field equality — `subscriptions` gives you the
     * list, including `identities` for "is this about *my* user" questions — and pass the ids to
     * `reportTo`.
     */
    async report(event: string, payload?: Record<string, unknown>): Promise<string[]> {
        if (!this.link) {
            throw new Error(`Hook "${this.id}" is not on a link yet — call link.addHook(hook) first.`);
        }

        // Caught here rather than on the wire: a typo should fail where it was made.
        if (!this.config.events.some(declared => declared.name === event)) {
            const declared = this.config.events.map(entry => entry.name).join(", ") || "none";
            throw new Error(`Hook "${this.id}" does not declare an event named "${event}". Declared: ${declared}.`);
        }

        return this.link.reportHookEvent(this.id, event, payload);
    }

    /**
     * What the server has asked this hook to watch.
     *
     * Empty until the link is connected and the snapshot has arrived, and empty again after a
     * disconnect — nothing is persisted, because the server re-sends it on every connect.
     */
    get subscriptions(): LinkSubscription[] {
        return this.link?.hookSubscriptions(this.id) ?? [];
    }

    /**
     * Reports an event to subscriptions you picked yourself.
     *
     * The escape hatch from the prefilter, for conditions that are not field equality: "mentions my
     * user", "within 50 metres", "the third time today". Read `subscriptions`, decide with real code —
     * `identities` is there for the "is this about my user" half — and pass the ids you chose.
     *
     * The prefilter is deliberately not applied to these: you already decided. What is checked is that
     * each id is one this link currently holds for this hook, so a stale id is dropped rather than sent
     * and rejected. Unknown ids are dropped quietly, because a subscription disappearing between your
     * decision and this call is a race, not a mistake.
     */
    async reportTo(subscriptionIds: string[], event: string, payload?: Record<string, unknown>): Promise<string[]> {
        if (!this.link) {
            throw new Error(`Hook "${this.id}" is not on a link yet — call link.addHook(hook) first.`);
        }

        if (!this.config.events.some(declared => declared.name === event)) {
            const declared = this.config.events.map(entry => entry.name).join(", ") || "none";
            throw new Error(`Hook "${this.id}" does not declare an event named "${event}". Declared: ${declared}.`);
        }

        if (subscriptionIds.length === 0) return [];

        return this.link.reportHookEvent(this.id, event, payload, subscriptionIds);
    }
}

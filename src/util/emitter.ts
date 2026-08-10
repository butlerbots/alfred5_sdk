/**
 * A tiny typed event emitter.
 *
 * `on` returns an id used to remove the listener again, which is the convention
 * the SDK already used for conversation events.
 */
export class Emitter<Events extends Record<string, unknown[]>> {
    private listeners = new Map<keyof Events, Map<string, (...args: never[]) => unknown>>();
    private nextId = 0;

    on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => unknown): string {
        let forEvent = this.listeners.get(event);
        if (!forEvent) {
            forEvent = new Map();
            this.listeners.set(event, forEvent);
        }

        const id = `l${++this.nextId}`;
        forEvent.set(id, listener as (...args: never[]) => unknown);
        return id;
    }

    once<K extends keyof Events>(event: K, listener: (...args: Events[K]) => unknown): string {
        const id = this.on(event, ((...args: Events[K]) => {
            this.off(event, id);
            return listener(...args);
        }) as (...args: Events[K]) => unknown);
        return id;
    }

    off<K extends keyof Events>(event: K, id: string): void {
        this.listeners.get(event)?.delete(id);
    }

    emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
        const forEvent = this.listeners.get(event);
        if (!forEvent) return;

        // Copied first: a listener may remove itself, or another, while we iterate.
        for (const listener of Array.from(forEvent.values())) {
            (listener as (...a: Events[K]) => unknown)(...args);
        }
    }

    clear(event?: keyof Events): void {
        if (event === undefined) this.listeners.clear();
        else this.listeners.delete(event);
    }
}

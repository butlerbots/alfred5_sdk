/**
 * The prefilter, client side.
 *
 * A deliberate reimplementation rather than a shared package: the server's copy is the reference,
 * and the point of keeping the language this dumb is that any client in any language can rewrite it
 * in twenty lines. A shared dependency would make that claim untestable and would couple every
 * platform's release cycle to the server's.
 *
 * It is a volume gate, not an expressiveness mechanism. **Nothing may depend on it.** A client that
 * ignores prefilters and reports every event is still correct, just louder — the server evaluates
 * the same condition again before spending anything.
 *
 * Every condition is ANDed. No OR, no regex, no arithmetic, no code.
 */

export type PrefilterScalar = string | number | boolean | null;

export type PrefilterCondition =
    | PrefilterScalar
    | PrefilterScalar[]
    | { not: PrefilterScalar | PrefilterScalar[] }
    | { exists: boolean };

/** Dot-path to condition. An empty or absent prefilter matches everything. */
export type Prefilter = Record<string, PrefilterCondition>;

export function matchesPrefilter(payload: unknown, prefilter?: Prefilter | null): boolean {
    if (!prefilter) return true;

    for (const [path, condition] of Object.entries(prefilter)) {
        if (!matchesCondition(readPath(payload, path), condition)) return false;
    }

    return true;
}

function matchesCondition(value: unknown, condition: PrefilterCondition): boolean {
    if (Array.isArray(condition)) return condition.some(candidate => value === candidate);

    if (condition && typeof condition === "object") {
        if ("exists" in condition) return (value !== undefined) === condition.exists;
        if ("not" in condition) return !matchesCondition(value, condition.not);
    }

    return value === condition;
}

/** Reads `author.bot` out of `{ author: { bot: true } }`. Missing paths read as `undefined`. */
export function readPath(payload: unknown, path: string): unknown {
    let current: unknown = payload;

    for (const segment of path.split(".")) {
        if (current === null || current === undefined) return undefined;
        if (typeof current !== "object") return undefined;
        current = (current as Record<string, unknown>)[segment];
    }

    return current;
}

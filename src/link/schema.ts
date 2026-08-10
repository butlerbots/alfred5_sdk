/**
 * SCHEMAS
 * =======
 *
 * A tool needs two things from its schema: JSON Schema to describe itself to the
 * model, and a way to check the arguments that come back. Both are obtained
 * without depending on any validation library — a Standard Schema (zod 3.24+,
 * valibot, arktype, ...) provides validation through `~standard`, and a plain
 * JSON Schema object is accepted as-is.
 */

export type JSONSchema = Record<string, unknown>;

/**
 * The Standard Schema v1 interface, vendored so this SDK needs no dependency.
 * @see https://standardschema.dev
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly "~standard": {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (value: unknown) =>
            | { value: Output; issues?: undefined }
            | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> }
            | Promise<
                | { value: Output; issues?: undefined }
                | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> }
            >;
        readonly types?: { readonly input: Input; readonly output: Output };
    };
}

/** Anything accepted as a tool or hook schema. */
export type ToolSchema =
    | StandardSchemaV1
    | { toJSONSchema(): JSONSchema }
    | JSONSchema;

/**
 * The argument type a schema produces, so `run({ args })` is typed from the
 * schema rather than left as a bag of unknowns. Falls back to a loose record for
 * a raw JSON Schema, which carries no type information.
 */
export type InferSchemaOutput<S> =
    S extends StandardSchemaV1<unknown, infer Output> ? Output
    : S extends { _output: infer Output } ? Output
    : Record<string, unknown>;

function isStandardSchema(schema: unknown): schema is StandardSchemaV1 {
    return typeof schema === "object" && schema !== null && "~standard" in schema;
}

function hasOwnConverter(schema: unknown): schema is { toJSONSchema(): JSONSchema } {
    return typeof (schema as { toJSONSchema?: unknown })?.toJSONSchema === "function";
}

function looksLikeJSONSchema(schema: unknown): schema is JSONSchema {
    if (typeof schema !== "object" || schema === null) return false;
    const keys = ["type", "properties", "$schema", "anyOf", "oneOf", "allOf", "enum", "const", "$ref"];
    return keys.some(key => key in (schema as Record<string, unknown>));
}

/** Loads zod only if the caller already has it, without upsetting bundlers. */
function loadZod(): { toJSONSchema?: (schema: unknown, options?: unknown) => JSONSchema } | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const load = eval("typeof require === 'function' ? require : undefined") as ((id: string) => unknown) | undefined;
        return load?.("zod") as { toJSONSchema?: (schema: unknown, options?: unknown) => JSONSchema } | undefined;
    } catch {
        return undefined;
    }
}

/**
 * Derives JSON Schema from whatever the caller supplied.
 *
 * Order matters: an explicit converter or a raw JSON Schema is used verbatim, and
 * zod is only reached for when nothing else can answer.
 */
export function toJSONSchema(schema: ToolSchema, label: string): JSONSchema {
    if (hasOwnConverter(schema)) return schema.toJSONSchema();

    if (isStandardSchema(schema)) {
        const zod = loadZod();
        if (typeof zod?.toJSONSchema === "function") {
            try {
                return zod.toJSONSchema(schema, { io: "input" });
            } catch (error) {
                throw new Error(
                    `Could not convert the schema for "${label}" to JSON Schema: ${(error as Error).message}. `
                    + `Pass \`jsonSchema\` explicitly instead.`,
                );
            }
        }

        throw new Error(
            `The schema for "${label}" needs zod 4+ to be converted to JSON Schema (zod 3 cannot). `
            + `Either upgrade zod or pass \`jsonSchema\` alongside \`schema\`.`,
        );
    }

    if (looksLikeJSONSchema(schema)) return schema;

    throw new Error(
        `The schema for "${label}" is neither a JSON Schema nor a Standard Schema. `
        + `Pass a zod 4 schema, any Standard Schema, or a plain JSON Schema object.`,
    );
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Validates arguments if the schema can validate at all.
 *
 * The server deliberately does not check a client's tool arguments — the client
 * authored the schema, so it owns the check. This is the only place it can happen,
 * which is why a Standard Schema is worth passing.
 */
export async function validateArgs<T>(schema: ToolSchema | undefined, args: unknown): Promise<ValidationResult<T>> {
    if (!schema || !isStandardSchema(schema)) return { ok: true, value: args as T };

    const result = await schema["~standard"].validate(args);
    if (!result.issues) return { ok: true, value: result.value as T };

    const described = result.issues
        .map(issue => {
            const path = (issue.path ?? [])
                .map(segment => (typeof segment === "object" && segment !== null ? String(segment.key) : String(segment)))
                .join(".");
            return path ? `${path}: ${issue.message}` : issue.message;
        })
        .join("; ");

    return { ok: false, error: `Invalid arguments — ${described}` };
}

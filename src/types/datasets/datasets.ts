/**
 * The shapes of the datasets API (`data.butler.now/v1`): a user's typed records, which an app
 * reads and writes with an API key holding `datasets.read`, `datasets.write` or `datasets.admin`
 * and a grant on each dataset it touches.
 */

export type DatasetFieldKind = "text" | "number" | "boolean" | "datetime" | "date" | "select" | "multiselect" | "ref" | "geo" | "json";

export type DatasetField = {
    /** `^[a-z][a-z0-9_]{0,40}$`, unique in the dataset, never reused once retired. */
    id: string;
    label: string;
    kind: DatasetFieldKind;
    description?: string;
    required?: boolean;
    /** What a record with no value reads as, and what a filter matches it as. */
    default?: unknown;
    /** At most six per dataset; what a large dataset is filtered and sorted by. */
    indexed?: boolean;
    /** text: 1-4000. */
    maxLength?: number;
    /** number */
    min?: number;
    max?: number;
    integer?: boolean;
    unit?: string;
    /** select, multiselect */
    options?: string[];
    /** ref: another dataset's name. */
    ref?: string;
    /** The schema version it was retired at; a retired field is left out of every read. */
    retired?: number;
};

export type DatasetSettings = {
    /** Hook events for record writes. */
    emit?: "each" | "off";
    /** ISO 8601 duration; records older than this (by `at`) expire. */
    keepFor?: string;
    /** A public place's visitors may append. */
    visitorInput?: boolean;
};

/** A dataset as a listing names it. */
export type DatasetSummary = {
    name: string;
    title?: string;
    description: string;
    records?: number;
    [extra: string]: unknown;
};

/** A dataset as `describe` answers it: its schema, settings and counts, and more the service adds. */
export type DatasetDescription = {
    name: string;
    title?: string;
    description: string;
    fields: DatasetField[];
    schemaVersion: number;
    settings: DatasetSettings;
    counters?: { records: number; bytes: number };
    [extra: string]: unknown;
};

/** Who wrote a record, as an app is shown it: the kind, and an id only when it is the app's own key. */
export type DatasetProvenance = {
    kind: "owner" | "alfred" | "reflex" | "place" | "visitor" | "app" | "job";
    id?: string;
    [extra: string]: unknown;
};

export type DatasetRecord<D extends Record<string, unknown> = Record<string, unknown>> = {
    /** `rec-<hex>`, sorting by creation. */
    recordId: string;
    /** The writer's own id for it, which makes a retried insert harmless. */
    key?: string;
    /** When it happened, ISO 8601 UTC. */
    at: string;
    rev: number;
    by: DatasetProvenance;
    createdBy: DatasetProvenance;
    createdAt: string;
    updatedAt: string;
    data: D;
};

/** A field compared one way: equal, in a list, a range, present, or a text test. */
export type DatasetCondition = {
    eq?: unknown;
    ne?: unknown;
    in?: unknown[];
    nin?: unknown[];
    gt?: unknown;
    gte?: unknown;
    lt?: unknown;
    lte?: unknown;
    exists?: boolean;
    contains?: string;
    startsWith?: string;
};

/** Each field (or `key`, `by.kind`, `by.id`) maps to a value, a list of values (any of them), or a condition; all ANDed. */
export type DatasetWhere = Record<string, unknown | unknown[] | DatasetCondition>;

export type DatasetQuery = {
    where?: DatasetWhere;
    /** Bounds on `at`, ISO 8601. */
    from?: string;
    to?: string;
    /** `at` (newest first by default) or an indexed field; `-field` for descending. */
    sort?: string;
    /** Default 50, at most 1000. */
    limit?: number;
    /** The previous page's `cursor`. */
    cursor?: string;
    /** Only these fields of each record's data. */
    fields?: string[];
    /** Add the total, counted to at most 10,000. */
    count?: boolean;
};

export type DatasetQueryResult<D extends Record<string, unknown> = Record<string, unknown>> = {
    records: DatasetRecord<D>[];
    /** Whether there is another page; ask for it with `cursor`. */
    more: boolean;
    cursor?: string;
    total?: number;
    totalCapped?: boolean;
};

export type DatasetMeasureOp = "count" | "sum" | "avg" | "min" | "max" | "first" | "last" | "distinct";

export type DatasetMeasure = { op: DatasetMeasureOp; field?: string };

/** A field to group by, or one time bucket of `at`. */
export type DatasetGroupBy = string | { at: "hour" | "day" | "week" | "month" | "year" } | Record<string, unknown>;

export type DatasetAggregate = {
    where?: DatasetWhere;
    from?: string;
    to?: string;
    groupBy?: DatasetGroupBy[];
    measures: DatasetMeasure[];
    /** The zone buckets are cut in; the owner's by default. */
    timezone?: string;
};

export type DatasetAggregateResult = {
    groups: Array<{ key: Record<string, unknown>; values: Record<string, unknown> }>;
    timezone: string;
    [extra: string]: unknown;
};

/** One record to insert: the writer's key (what makes a retry harmless), when it happened, and its data. */
export type DatasetInsertRecord<D extends Record<string, unknown> = Record<string, unknown>> = {
    key?: string;
    at?: string | number;
    data: D;
};

/** What happens to a record whose key is already there: left (the default), replaced, or merged. */
export type DatasetOnConflict = "skip" | "replace" | "merge";

export type DatasetInsertOutcome = {
    status: "created" | "skipped" | "replaced" | "merged" | "expired" | "error";
    recordId?: string;
    key?: string;
    rev?: number;
    unchanged?: boolean;
    code?: string;
    [extra: string]: unknown;
};

export type DatasetInsertResult = { results: DatasetInsertOutcome[] };

export type DatasetUpdate = {
    set?: Record<string, unknown>;
    unset?: string[];
    /** Adds to number fields atomically; refused past the field's min or max. */
    inc?: Record<string, number>;
    at?: string | number;
    /** Refused with 409 and the current record when it moved on. */
    ifRev?: number;
};

export type DatasetUpdateResult<D extends Record<string, unknown> = Record<string, unknown>> = {
    record: DatasetRecord<D>;
    changed: string[];
    unchanged: boolean;
};

/** What creating a dataset takes. The key needs `datasets.admin` and an `admin` pattern grant matching the name. */
export type DatasetCreate = {
    /** `^[a-z][a-z0-9-]{0,62}$`; never changes. */
    name: string;
    title?: string;
    /** What it is for, 1-1000 characters. */
    description: string;
    fields: DatasetField[];
    settings?: DatasetSettings;
};

/** A schema or settings change. Needs `datasets.admin` and an `admin` grant. */
export type DatasetAlter = {
    title?: string;
    description?: string;
    settings?: DatasetSettings;
    add?: DatasetField[];
    change?: Array<Partial<DatasetField> & { id: string }>;
    retire?: string[];
};

/** One thing wrong with a refused request, with the real ids. */
export type DatasetIssue = { path: string; message: string; [extra: string]: unknown };

/** What `describeDataset` answers: the dataset, the key's access to it, and its latest records. */
export type DatasetDescribeResult = {
    dataset: DatasetDescription;
    access: "read" | "append" | "write" | "admin";
    latest: DatasetRecord[];
    [extra: string]: unknown;
};

/** What `alterDataset` answers: the dataset as changed, whether anything did, and what in words. */
export type DatasetAlterResult = { dataset: DatasetDescription; changed: boolean; summary: string[] };

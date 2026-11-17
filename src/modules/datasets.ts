import { CONFIG } from "../config";
import type {
    DatasetAggregate,
    DatasetAggregateResult,
    DatasetAlter,
    DatasetAlterResult,
    DatasetCreate,
    DatasetDescribeResult,
    DatasetDescription,
    DatasetInsertRecord,
    DatasetInsertResult,
    DatasetOnConflict,
    DatasetQuery,
    DatasetQueryResult,
    DatasetSummary,
    DatasetUpdate,
    DatasetUpdateResult,
} from "../types/datasets";
import { formatURL } from "../util/url_formatter";
import { requestAPI } from "./api_request";

/**
 * THE DATASETS API
 * ================
 *
 * A user's typed records, at `data.butler.now/v1`: an app reads and writes them straight with its
 * API key, which needs a `datasets.*` scope (`read` for queries, `write` for records, `admin` to
 * create a dataset or change its schema, each implying the ones before) and a grant on each
 * dataset, set by the user or Alfred when the key is made (`{ "sensor-readings": "append" }`, or
 * `{ "myapp-*": "admin" }` for datasets the app makes itself). A dataset the key has no grant on
 * is a 404 naming those it has.
 *
 * Every call throws `ButlerBotAPIError` on a refusal, with the service's `code`, its `issues`
 * (every one at once, with the real field ids and options) and `retryAfter` on a 429 or 503.
 */

/** Where the datasets service is and who is asking. */
export type DatasetsRequestOptions = {
    /** The datasets service, when it is not the hosted one. */
    dataURL?: string;
    apiKey: string;
    debug?: boolean;
};

export type DatasetOptions = DatasetsRequestOptions & {
    /** The dataset's name. */
    dataset: string;
};

function datasetsURL(options: DatasetsRequestOptions, ...segments: string[]): string {
    const base = (options.dataURL || CONFIG.data).replace(/\/+$/, "") + CONFIG.paths.datasets.base;
    return formatURL([base, ...segments.map(encodeURIComponent)].join("/"), {}, { debug: options.debug });
}

/** The datasets this key has a grant on. Needs `datasets.read`. */
export async function listDatasets(options: DatasetsRequestOptions): Promise<DatasetSummary[]> {
    const response = await requestAPI<{ datasets: DatasetSummary[] }>({ url: datasetsURL(options), apiKey: options.apiKey, action: "list datasets" });
    return response.datasets;
}

/** One dataset: its schema, settings and counts, the key's access to it and its latest records. */
export async function describeDataset(options: DatasetOptions): Promise<DatasetDescribeResult> {
    const { success: _success, ...result } = await requestAPI<DatasetDescribeResult & { success: true }>({ url: datasetsURL(options, options.dataset), apiKey: options.apiKey, action: `describe the dataset ${options.dataset}` });
    return result as DatasetDescribeResult;
}

/** A new dataset. Needs `datasets.admin` and an `admin` pattern grant matching its name. */
export async function createDataset(options: DatasetsRequestOptions & { definition: DatasetCreate }): Promise<DatasetDescription> {
    const response = await requestAPI<{ dataset: DatasetDescription }>({ url: datasetsURL(options), apiKey: options.apiKey, method: "POST", body: options.definition, action: `create the dataset ${options.definition.name}` });
    return response.dataset;
}

/**
 * A schema or settings change. Needs `datasets.admin` and an `admin` grant. Adding a field, a
 * label, options or a wider bound is free; a change that would reinterpret records (a kind, an
 * id) is refused with what to do instead.
 */
export async function alterDataset(options: DatasetOptions & { changes: DatasetAlter }): Promise<DatasetAlterResult> {
    const { success: _success, ...result } = await requestAPI<DatasetAlterResult & { success: true }>({ url: datasetsURL(options, options.dataset), apiKey: options.apiKey, method: "PATCH", body: options.changes, action: `change the dataset ${options.dataset}` });
    return result as DatasetAlterResult;
}

/**
 * Inserts one record or a batch (up to 500 and 1 MB). A record with a `key` already in the
 * dataset is left (`skip`, the default), replaced or merged, so a retried send is harmless. Each
 * record answers on its own; one that could not be written is `error` beside the rest. Needs
 * `datasets.write` and an `append` grant (`write` for `replace` and `merge`).
 */
export async function insertRecords<D extends Record<string, unknown>>(options: DatasetOptions & { records: DatasetInsertRecord<D>[]; onConflict?: DatasetOnConflict }): Promise<DatasetInsertResult> {
    const response = await requestAPI<DatasetInsertResult>({
        url: datasetsURL(options, options.dataset, "records"),
        apiKey: options.apiKey,
        method: "POST",
        body: { records: options.records, ...(options.onConflict ? { onConflict: options.onConflict } : {}) },
        action: `insert into the dataset ${options.dataset}`,
    });
    return { results: response.results };
}

/** Which record: by its id, or by the writer's key. */
export type RecordLocator = { recordId: string; key?: never } | { key: string; recordId?: never };

function recordURL(options: DatasetOptions & RecordLocator): string {
    if (options.recordId) return datasetsURL(options, options.dataset, "records", options.recordId);
    return `${datasetsURL(options, options.dataset, "records")}?${new URLSearchParams({ key: String(options.key) })}`;
}

/** Changes one record: `set`, `unset`, an atomic `inc`, and `ifRev` to refuse when it moved on (409). Needs `datasets.write` and a `write` grant. */
export async function updateRecord<D extends Record<string, unknown>>(options: DatasetOptions & RecordLocator & { change: DatasetUpdate }): Promise<DatasetUpdateResult<D>> {
    const { success: _success, ...result } = await requestAPI<DatasetUpdateResult<D> & { success: true }>({ url: recordURL(options), apiKey: options.apiKey, method: "PATCH", body: options.change, action: `update a record in ${options.dataset}` });
    return result as DatasetUpdateResult<D>;
}

/** Deletes one record. Needs `datasets.write` and a `write` grant. */
export async function deleteRecord(options: DatasetOptions & RecordLocator): Promise<{ recordId: string; key?: string }> {
    const response = await requestAPI<{ removed: { recordId: string; key?: string } }>({ url: recordURL(options), apiKey: options.apiKey, method: "DELETE", action: `delete a record from ${options.dataset}` });
    return response.removed;
}

/**
 * Records, newest first by default, a page at a time (`more`, then `cursor`). A dataset over
 * 10,000 records needs a bound: a range on `at` (`from`/`to`) or a filter on an indexed field.
 * Needs `datasets.read`.
 */
export async function queryRecords<D extends Record<string, unknown> = Record<string, unknown>>(options: DatasetOptions & { query?: DatasetQuery }): Promise<DatasetQueryResult<D>> {
    const { success: _success, ...result } = await requestAPI<DatasetQueryResult<D> & { success: true }>({ url: datasetsURL(options, options.dataset, "query"), apiKey: options.apiKey, method: "POST", body: options.query ?? {}, action: `query the dataset ${options.dataset}` });
    return result as DatasetQueryResult<D>;
}

/** Groups and measures (count, sum, avg, …), bucketed by time in the owner's zone. Always needs an `at` bound or an indexed filter on a large dataset. Needs `datasets.read`. */
export async function aggregateRecords(options: DatasetOptions & { aggregate: DatasetAggregate }): Promise<DatasetAggregateResult> {
    const { success: _success, ...result } = await requestAPI<DatasetAggregateResult & { success: true }>({ url: datasetsURL(options, options.dataset, "aggregate"), apiKey: options.apiKey, method: "POST", body: options.aggregate, action: `aggregate the dataset ${options.dataset}` });
    return result as DatasetAggregateResult;
}

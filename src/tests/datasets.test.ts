import { afterEach, describe, expect, it } from "bun:test";

import { CONFIG } from "../config";
import { aggregateRecords, createDataset, deleteRecord, describeDataset, insertRecords, listDatasets, queryRecords, updateRecord } from "../modules/datasets";
import { ButlerBotAPIError } from "../util/api_error";
import { fakeFetch, type FakeFetch } from "./support/fake_fetch";

// =============================================
// THE DATASETS API
// =============================================

/**
 * The datasets module is a URL on the datasets service, a method, a body and what the service
 * said; what is worth asserting is the call that went out, the answer handed back without the
 * envelope, and a refusal carried whole: its code, every issue and when to retry.
 */

const KEY = "ap-abc_123";
let http: FakeFetch | undefined;

afterEach(() => {
    http?.restore();
    http = undefined;
});

describe("the datasets calls", () => {
    it("lists and describes on the hosted service, with the key in the header", async () => {
        http = fakeFetch({ body: { success: true, datasets: [{ name: "sensor-readings", description: "Garden sensor" }] } });
        const datasets = await listDatasets({ apiKey: KEY });
        expect(datasets).toEqual([{ name: "sensor-readings", description: "Garden sensor" }]);
        const call = http.only();
        expect(call.url).toBe(`${CONFIG.data}/v1/datasets`);
        expect(call.headers.Authorization).toBe(`Bearer ${KEY}`);
        expect(call.url).not.toContain(KEY);
        http.restore();

        http = fakeFetch({ body: { success: true, dataset: { name: "sensor-readings", fields: [], schemaVersion: 1, settings: {}, description: "x" }, access: "append", latest: [] } });
        const described = await describeDataset({ apiKey: KEY, dataset: "sensor-readings", dataURL: "http://localhost:3010/" });
        expect(described.access).toBe("append");
        expect(described).not.toHaveProperty("success");
        expect(http.only().url).toBe("http://localhost:3010/v1/datasets/sensor-readings");
    });

    it("inserts a batch with its conflict rule, and creates under the key's pattern", async () => {
        http = fakeFetch({ body: { success: true, results: [{ status: "created", recordId: "rec-1", key: "r1" }, { status: "skipped", recordId: "rec-0", key: "r0" }] } });
        const inserted = await insertRecords({ apiKey: KEY, dataset: "sensor-readings", records: [{ key: "r1", at: "2026-11-17T08:00:00Z", data: { celsius: 21.5 } }, { key: "r0", data: { celsius: 20 } }], onConflict: "skip" });
        expect(inserted.results.map(result => result.status)).toEqual(["created", "skipped"]);
        expect(http.only()).toMatchObject({ method: "POST", url: `${CONFIG.data}/v1/datasets/sensor-readings/records`, body: { onConflict: "skip", records: [{ key: "r1" }, { key: "r0" }] } });
        http.restore();

        http = fakeFetch({ status: 201, body: { success: true, dataset: { name: "myapp-events", description: "Events", fields: [], schemaVersion: 1, settings: {} } } });
        const created = await createDataset({ apiKey: KEY, definition: { name: "myapp-events", description: "Events", fields: [{ id: "kind", label: "Kind", kind: "text" }] } });
        expect(created.name).toBe("myapp-events");
        expect(http.only()).toMatchObject({ method: "POST", url: `${CONFIG.data}/v1/datasets`, body: { name: "myapp-events" } });
    });

    it("finds a record by id or by key, and queries and aggregates with the body as given", async () => {
        http = fakeFetch({ body: { success: true, record: { recordId: "rec-1", data: { n: 3 } }, changed: ["n"], unchanged: false } });
        const updated = await updateRecord({ apiKey: KEY, dataset: "counts", key: "a b", change: { inc: { n: 2 }, ifRev: 4 } });
        expect(updated.changed).toEqual(["n"]);
        expect(http.only()).toMatchObject({ method: "PATCH", url: `${CONFIG.data}/v1/datasets/counts/records?key=a+b`, body: { inc: { n: 2 }, ifRev: 4 } });
        http.restore();

        http = fakeFetch({ body: { success: true, removed: { recordId: "rec-1" } } });
        expect(await deleteRecord({ apiKey: KEY, dataset: "counts", recordId: "rec-1" })).toEqual({ recordId: "rec-1" });
        expect(http.only()).toMatchObject({ method: "DELETE", url: `${CONFIG.data}/v1/datasets/counts/records/rec-1` });
        http.restore();

        http = fakeFetch({ body: { success: true, records: [], more: false } });
        const page = await queryRecords({ apiKey: KEY, dataset: "counts", query: { where: { kind: { in: ["a", "b"] } }, from: "2026-11-01T00:00:00Z", limit: 10 } });
        expect(page).toEqual({ records: [], more: false });
        expect(http.only().body).toEqual({ where: { kind: { in: ["a", "b"] } }, from: "2026-11-01T00:00:00Z", limit: 10 });
        http.restore();

        http = fakeFetch({ body: { success: true, groups: [{ key: { at: "2026-11-17" }, values: { count: 4 } }], timezone: "Europe/London" } });
        const groups = await aggregateRecords({ apiKey: KEY, dataset: "counts", aggregate: { groupBy: [{ at: "day" }], measures: [{ op: "count" }], from: "2026-11-01T00:00:00Z" } });
        expect(groups.groups[0].values.count).toBe(4);
        expect(http.only().url).toBe(`${CONFIG.data}/v1/datasets/counts/aggregate`);
    });

    it("throws the service's refusal whole: its code, every issue, and when to retry", async () => {
        http = fakeFetch({ status: 400, body: { success: false, code: "invalid", error: "The records were refused", issues: [{ path: "records.0.data.celsius", message: "A number" }, { path: "records.1.data.unit", message: "One of: c, f" }] } });
        const refused = await insertRecords({ apiKey: KEY, dataset: "sensor-readings", records: [{ data: { celsius: "hot" } }, { data: { unit: "k" } }] }).catch(error => error);
        expect(refused).toBeInstanceOf(ButlerBotAPIError);
        expect(refused.isBadRequest).toBe(true);
        expect(refused.code).toBe("invalid");
        expect(refused.issues.map((issue: { path: string }) => issue.path)).toEqual(["records.0.data.celsius", "records.1.data.unit"]);
        http.restore();

        http = fakeFetch({ status: 429, body: { success: false, code: "rate_limited", error: "Too many requests", retryAfter: 3 } });
        const limited = await queryRecords({ apiKey: KEY, dataset: "x" }).catch(error => error);
        expect(limited.isRateLimited).toBe(true);
        expect(limited.retryAfter).toBe(3);
        http.restore();

        http = fakeFetch({ status: 403, body: { success: false, code: "forbidden", error: "This key lacks the datasets.admin scope", need: "datasets.admin" } });
        const forbidden = await createDataset({ apiKey: KEY, definition: { name: "myapp-x", description: "x", fields: [] } }).catch(error => error);
        expect(forbidden.isForbidden).toBe(true);
        expect(forbidden.message).toContain("datasets.admin");
    });
});

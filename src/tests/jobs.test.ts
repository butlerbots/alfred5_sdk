import { afterEach, describe, expect, it } from "bun:test";

import { ButlerBotClient, ButlerBotAPIError } from "../index";
import { CONFIG } from "../config";
import { cancelJob, getJob, listJobs, updateJob, updateJobSettings } from "../modules/jobs";
import type { JobView } from "../types/jobs";
import { fakeFetch, pathOf, queryOf, type FakeFetch } from "./support/fake_fetch";

// =============================================
// JOBS OVER HTTP
// =============================================

/**
 * The jobs routes, as the SDK calls them. The modules are a URL, a method, a body and what the
 * server said, so the assertions are the call that went out and the value that came back.
 */

const KEY = "ap-abc_123";

let http: FakeFetch | undefined;

afterEach(() => {
    http?.restore();
    http = undefined;
});

function job(overrides: Partial<JobView> = {}): JobView {
    return {
        jobId: "job_1",
        title: "Find a flat",
        goal: "Find me a flat in Cape Town",
        status: "running",
        statusDetail: null,
        progress: "Reading listings",
        currentPhaseId: "search",
        shiftsRun: 3,
        reviewRounds: 0,
        spentUsd: 0.42,
        spendTodayUsd: 0.12,
        openQuestions: 0,
        lastRunAt: 1700000000000,
        wakeAt: 0,
        created: 1699999000000,
        planCardUri: "card://workspace/jobs/job_1/plan.md",
        journalCardUri: "card://workspace/jobs/job_1/journal.md",
        originConversationId: "convo_1",
        autonomy: null,
        autonomyUntil: null,
        alwaysAsk: [],
        effectiveAutonomy: "ask",
        ...overrides,
    };
}

describe("Listing jobs", () => {
    it("asks the jobs collection with the key and the page it was given", async () => {
        http = fakeFetch({ body: { success: true, jobs: [job()], page: 2, limit: 5, total: 11, allowance: { perDayUsd: 5, source: "tier", remainingUsd: 4.5 }, spentTodayUsd: 0.5 } });

        const listed = await listJobs({ apiKey: KEY, serverURL: "https://core.test", page: 2, limit: 5, status: "running" });

        const call = http.only();
        expect(call.method).toBe("GET");
        expect(pathOf(call)).toBe(`https://core.test${CONFIG.paths.jobs.base}`);
        expect(queryOf(call)).toEqual({ api_key: KEY, page: "2", limit: "5", status: "running" });
        expect(listed.jobs[0].jobId).toBe("job_1");
        expect(listed.total).toBe(11);
        expect(listed.allowance).toEqual({ perDayUsd: 5, source: "tier", remainingUsd: 4.5 });
    });

    it("sends only the paging it was actually given", async () => {
        // A `URLSearchParams` built from the options as they stand would send the word
        // "undefined" as a page number, and the server would refuse the lot.
        http = fakeFetch({ body: { success: true, jobs: [], page: 1, limit: 20, total: 0, allowance: { perDayUsd: 0, source: null, refused: "tier", message: "Jobs are not in your plan" }, spentTodayUsd: 0 } });

        const listed = await listJobs({ apiKey: KEY });

        expect(queryOf(http.only())).toEqual({ api_key: KEY });
        expect(listed.allowance).toEqual({ perDayUsd: 0, source: null, refused: "tier", message: "Jobs are not in your plan" });
    });

    it("defaults to the hosted core", async () => {
        http = fakeFetch({ body: { success: true, jobs: [], page: 1, limit: 20, total: 0, allowance: { perDayUsd: 1, source: "user", remainingUsd: 1 }, spentTodayUsd: 0 } });

        await listJobs({ apiKey: KEY });

        expect(pathOf(http.only())).toBe(`${CONFIG.server}${CONFIG.paths.jobs.base}`);
    });
});

describe("Reading one job", () => {
    it("names the job in the path and hands back its plan and journal", async () => {
        http = fakeFetch({
            body: {
                success: true,
                job: job(),
                autonomyLine: "Asks before acting outward.",
                plan: { ok: true, raw: "# Plan", phases: [{ id: "search", kind: "work", model: "sonnet", status: "running" }] },
                journal: [{ at: 1700000000000, kind: "handover", body: "Read 20 listings" }],
                openDeliveries: [],
            },
        });

        const detail = await getJob({ apiKey: KEY, serverURL: "https://core.test", jobId: "job_1" });

        expect(pathOf(http.only())).toBe("https://core.test/api/jobs/job_1");
        expect(detail.autonomyLine).toBe("Asks before acting outward.");
        expect(detail.plan.ok).toBe(true);
        if (detail.plan.ok) expect(detail.plan.phases[0].id).toBe("search");
        expect(detail.journal[0].body).toBe("Read 20 listings");
    });

    it("escapes the id rather than pasting it into the path", async () => {
        http = fakeFetch({ body: { success: true, job: job(), autonomyLine: "", plan: { ok: false, reason: "missing" }, journal: [], openDeliveries: [] } });

        await getJob({ apiKey: KEY, serverURL: "https://core.test", jobId: "job 1/../2" });

        expect(new URL(http.only().url).pathname).toBe("/api/jobs/job%201%2F..%2F2");
    });

    it("throws with the status when the job is not this key's", async () => {
        // Somebody else's job is answered exactly as one that does not exist.
        http = fakeFetch({ status: 404, statusText: "Not Found", body: { success: false, error: "Not found", errormessage: "No job job_9 belongs to you" } });

        const failure = await getJob({ apiKey: KEY, jobId: "job_9" }).catch(error => error);

        expect(failure).toBeInstanceOf(ButlerBotAPIError);
        expect(failure.status).toBe(404);
        expect(failure.isNotFound).toBe(true);
        expect(failure.errormessage).toBe("No job job_9 belongs to you");
        expect(failure.message).toContain("No job job_9 belongs to you");
    });
});

describe("Cancelling a job", () => {
    it("posts to the job's cancel path with no body", async () => {
        http = fakeFetch({ body: { success: true, job: job({ status: "cancelled" }) } });

        const cancelled = await cancelJob({ apiKey: KEY, serverURL: "https://core.test", jobId: "job_1" });

        const call = http.only();
        expect(call.method).toBe("POST");
        expect(pathOf(call)).toBe("https://core.test/api/jobs/job_1/cancel");
        expect(call.body).toBeUndefined();
        expect(cancelled.job.status).toBe("cancelled");
    });

    it("tells a job that had already finished apart from one that is missing", async () => {
        http = fakeFetch({
            status: 409,
            statusText: "Conflict",
            body: { success: false, error: "Already finished", errormessage: "Job job_1 had already done", job: job({ status: "done" }) },
        });

        const failure = await cancelJob({ apiKey: KEY, jobId: "job_1" }).catch(error => error);

        expect(failure).toBeInstanceOf(ButlerBotAPIError);
        expect(failure.isConflict).toBe(true);
        expect(failure.isNotFound).toBe(false);
        // The refusal still carries the job, so a caller can show what it settled as.
        expect((failure.body as { job: JobView }).job.status).toBe("done");
    });
});

describe("Updating a job", () => {
    it("patches only the fields it was given", async () => {
        http = fakeFetch({ body: { success: true, job: job({ autonomy: "free" }), autonomyLine: "Acts freely until Friday." } });

        const updated = await updateJob({ apiKey: KEY, serverURL: "https://core.test", jobId: "job_1", autonomy: "free", autonomyUntil: null });

        const call = http.only();
        expect(call.method).toBe("PATCH");
        expect(pathOf(call)).toBe("https://core.test/api/jobs/job_1");
        expect(call.headers["Content-Type"]).toBe("application/json");
        // `alwaysAsk` was not named, so it is not sent: an absent field leaves the job's alone.
        expect(call.body).toEqual({ autonomy: "free", autonomyUntil: null });
        expect(updated.autonomyLine).toBe("Acts freely until Friday.");
    });

    it("carries the server's words when a value is refused", async () => {
        http = fakeFetch({ status: 400, statusText: "Bad Request", body: { success: false, error: "Bad Request", errormessage: "Unknown autonomy 'wild'. One of: ask, free, auto" } });

        const failure = await updateJob({ apiKey: KEY, jobId: "job_1", autonomy: "wild" as never }).catch(error => error);

        expect(failure.status).toBe(400);
        expect(failure.isBadRequest).toBe(true);
        expect(failure.errormessage).toBe("Unknown autonomy 'wild'. One of: ask, free, auto");
    });
});

describe("Job settings", () => {
    it("patches the user's settings, not a job's", async () => {
        http = fakeFetch({ body: { success: true, jobs: { allowanceUsd: 5, autonomy: "ask" } } });

        const saved = await updateJobSettings({ apiKey: KEY, serverURL: "https://core.test", allowanceUsd: 5, alwaysAsk: null });

        const call = http.only();
        expect(call.method).toBe("PATCH");
        expect(pathOf(call)).toBe(`https://core.test${CONFIG.paths.jobs.settings}`);
        expect(queryOf(call)).toEqual({ api_key: KEY });
        // Null is a value — it clears a setting — so it is sent, while an absent field is not.
        expect(call.body).toEqual({ allowanceUsd: 5, alwaysAsk: null });
        expect(saved.jobs.allowanceUsd).toBe(5);
    });
});

describe("Through the client", () => {
    it("uses the client's key and server when the call names neither", async () => {
        http = fakeFetch({ body: { success: true, jobs: [], page: 1, limit: 20, total: 0, allowance: { perDayUsd: 1, source: "user", remainingUsd: 1 }, spentTodayUsd: 0 } });
        const client = new ButlerBotClient({ apiKey: KEY, serverUrl: "https://core.test" });

        await client.listJobs();

        expect(pathOf(http.only())).toBe("https://core.test/api/jobs");
        expect(queryOf(http.only()).api_key).toBe(KEY);
    });

    it("keeps the client's key when a caller forwards an option nobody set", async () => {
        http = fakeFetch({ body: { success: true, job: job(), autonomyLine: "", plan: { ok: false, reason: "missing" }, journal: [], openDeliveries: [] } });
        const client = new ButlerBotClient({ apiKey: KEY, serverUrl: "https://core.test" });

        await client.getJob({ jobId: "job_1", apiKey: undefined, serverURL: undefined });

        expect(queryOf(http.only()).api_key).toBe(KEY);
        expect(pathOf(http.only())).toBe("https://core.test/api/jobs/job_1");
    });
});

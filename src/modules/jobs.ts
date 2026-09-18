import { CONFIG } from "../config";
import type {
    JobAutonomy,
    JobCancelResponse,
    JobDetailResponse,
    JobListResponse,
    JobSettingsResponse,
    JobSettingsUpdate,
    JobStatus,
    JobUpdateResponse,
} from "../types/jobs";
import { formatURL } from "../util/url_formatter";
import { requestAPI } from "./api_request";

/** What every jobs call needs: where the server is, and who is asking. */
export type JobsRequestOptions = {
    serverURL?: string;
    /** The base path for jobs, when it is not the default. */
    path?: string;
    apiKey: string;
    debug?: boolean;
};

export type ListJobsOptions = JobsRequestOptions & {
    /** 1-based. The first page when it is not given. */
    page?: number;
    /** How many jobs per page. */
    limit?: number;
    /** Only jobs in this status. */
    status?: JobStatus;
};

export type GetJobOptions = JobsRequestOptions & { jobId: string };

export type CancelJobOptions = JobsRequestOptions & { jobId: string };

export type UpdateJobOptions = JobsRequestOptions & {
    jobId: string;
    /** How far this job may act outward on its own. */
    autonomy?: JobAutonomy;
    /** When that autonomy lapses back to asking. Null clears it. */
    autonomyUntil?: string | number | null;
    /** Things this job asks about however free it otherwise is. */
    alwaysAsk?: string[];
};

export type UpdateJobSettingsOptions = JobsRequestOptions & JobSettingsUpdate;

function jobsBase(options: JobsRequestOptions): string {
    return (options.serverURL || CONFIG.server) + (options.path || CONFIG.paths.jobs.base);
}

/** Only what was actually given: `URLSearchParams` would otherwise send the word "undefined". */
function query(params: Record<string, string | number | undefined>): Record<string, string> {
    const given: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) given[key] = String(value);
    }
    return given;
}

/** Only the keys a caller set, so an omitted field is not sent as an explicit `undefined`. */
function body<T extends object>(fields: T): Partial<T> {
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** A page of the caller's jobs, newest first, with what their jobs may spend today. */
export async function listJobs(options: ListJobsOptions): Promise<JobListResponse> {
    const url = formatURL(
        jobsBase(options),
        query({ page: options.page, limit: options.limit, status: options.status }),
        { apiKey: options.apiKey, debug: options.debug },
    );

    return requestAPI<JobListResponse>({ url, action: "list jobs" });
}

/** One job with its plan, its journal and the questions of its nobody has answered. */
export async function getJob(options: GetJobOptions): Promise<JobDetailResponse> {
    const url = formatURL(
        `${jobsBase(options)}/${encodeURIComponent(options.jobId)}`,
        {},
        { apiKey: options.apiKey, debug: options.debug },
    );

    return requestAPI<JobDetailResponse>({ url, action: `read job ${options.jobId}` });
}

/**
 * Stops a job.
 *
 * A job that had already finished is a 409: the call throws a `ButlerBotAPIError` whose
 * `isConflict` is true and whose `body` still carries the job as it stands.
 */
export async function cancelJob(options: CancelJobOptions): Promise<JobCancelResponse> {
    const url = formatURL(
        `${jobsBase(options)}/${encodeURIComponent(options.jobId)}/cancel`,
        {},
        { apiKey: options.apiKey, debug: options.debug },
    );

    return requestAPI<JobCancelResponse>({ url, method: "POST", action: `cancel job ${options.jobId}` });
}

/** Changes one job's autonomy: how far it may act, until when, and what it always asks about. */
export async function updateJob(options: UpdateJobOptions): Promise<JobUpdateResponse> {
    const url = formatURL(
        `${jobsBase(options)}/${encodeURIComponent(options.jobId)}`,
        {},
        { apiKey: options.apiKey, debug: options.debug },
    );

    return requestAPI<JobUpdateResponse>({
        url,
        method: "PATCH",
        body: body({ autonomy: options.autonomy, autonomyUntil: options.autonomyUntil, alwaysAsk: options.alwaysAsk }),
        action: `update job ${options.jobId}`,
    });
}

/** Changes the owner's job settings: their daily allowance and the autonomy new jobs start with. */
export async function updateJobSettings(options: UpdateJobSettingsOptions): Promise<JobSettingsResponse> {
    const endpoint = (options.serverURL || CONFIG.server) + (options.path || CONFIG.paths.jobs.settings);
    const url = formatURL(endpoint, {}, { apiKey: options.apiKey, debug: options.debug });

    return requestAPI<JobSettingsResponse>({
        url,
        method: "PATCH",
        body: body({
            allowanceUsd: options.allowanceUsd,
            allowancePercent: options.allowancePercent,
            autonomy: options.autonomy,
            alwaysAsk: options.alwaysAsk,
        }),
        action: "update job settings",
    });
}

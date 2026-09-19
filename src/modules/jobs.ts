import { CONFIG } from "../config";
import type {
    JobAutonomy,
    JobCancelResponse,
    JobDetailResponse,
    JobJournalPage,
    JobListResponse,
    JobPhaseModelResponse,
    JobResumeResponse,
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

export type GetJobJournalOptions = JobsRequestOptions & {
    jobId: string;
    /** 1-based, newest page first. The first page when it is not given. */
    page?: number;
    /** How many entries per page; the server caps it. */
    limit?: number;
};

export type CancelJobOptions = JobsRequestOptions & { jobId: string };

export type ResumeJobOptions = JobsRequestOptions & { jobId: string };

export type UpdateJobOptions = JobsRequestOptions & {
    jobId: string;
    /** A new short name for the job, a few words at most. */
    title?: string;
    /** How far this job may act outward on its own. */
    autonomy?: JobAutonomy;
    /** When that autonomy lapses back to asking. Null clears it. */
    autonomyUntil?: string | number | null;
    /** Things this job asks about however free it otherwise is. */
    alwaysAsk?: string[];
    /** A ceiling on what the job may spend in all, in dollars. Null clears it. */
    capUsd?: number | null;
};

export type SetPhaseModelOptions = JobsRequestOptions & {
    jobId: string;
    /** The phase's id as the plan names it. */
    phaseId: string;
    /** One of the detail's `phaseModels`. */
    model: string;
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

/** A page of one job's journal, newest page first, each page in the order it was written. */
export async function getJobJournal(options: GetJobJournalOptions): Promise<JobJournalPage> {
    const url = formatURL(
        `${jobsBase(options)}/${encodeURIComponent(options.jobId)}/journal`,
        query({ page: options.page, limit: options.limit }),
        { apiKey: options.apiKey, debug: options.debug },
    );

    return requestAPI<JobJournalPage>({ url, action: `read the journal of job ${options.jobId}` });
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

/**
 * Continues a job that is parked waiting for budget, when there is room for it again.
 *
 * The answer says what happened either way: `resumed` is the job queued again, and otherwise
 * `reason`, `action` and `message` say why it is still parked and what would change that. A
 * job in any other status is a 409: the call throws a `ButlerBotAPIError` whose `isConflict`
 * is true and whose `body` still carries the job as it stands.
 */
export async function resumeJob(options: ResumeJobOptions): Promise<JobResumeResponse> {
    const url = formatURL(
        `${jobsBase(options)}/${encodeURIComponent(options.jobId)}/resume`,
        {},
        { apiKey: options.apiKey, debug: options.debug },
    );

    return requestAPI<JobResumeResponse>({ url, method: "POST", action: `resume job ${options.jobId}` });
}

/** Changes one job's name, and its autonomy: how far it may act, until when, and what it always asks about. */
export async function updateJob(options: UpdateJobOptions): Promise<JobUpdateResponse> {
    const url = formatURL(
        `${jobsBase(options)}/${encodeURIComponent(options.jobId)}`,
        {},
        { apiKey: options.apiKey, debug: options.debug },
    );

    return requestAPI<JobUpdateResponse>({
        url,
        method: "PATCH",
        body: body({ title: options.title, autonomy: options.autonomy, autonomyUntil: options.autonomyUntil, alwaysAsk: options.alwaysAsk, capUsd: options.capUsd }),
        action: `update job ${options.jobId}`,
    });
}

/**
 * Changes the model one phase of a job's plan runs on.
 *
 * Only a phase that has not started or is blocked: a running or done phase's model is what its
 * work ran on. A model the owner's plan cannot run is a 400 whose body names the ones it can.
 */
export async function setPhaseModel(options: SetPhaseModelOptions): Promise<JobPhaseModelResponse> {
    const url = formatURL(
        `${jobsBase(options)}/${encodeURIComponent(options.jobId)}/plan/${encodeURIComponent(options.phaseId)}`,
        {},
        { apiKey: options.apiKey, debug: options.debug },
    );

    return requestAPI<JobPhaseModelResponse>({
        url,
        method: "PATCH",
        body: { model: options.model },
        action: `set the model of phase ${options.phaseId} of job ${options.jobId}`,
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

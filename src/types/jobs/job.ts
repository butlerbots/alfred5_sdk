import type { Delivery } from "../outreach/delivery";

/**
 * A job: long-running work Alfred does on its own, run as a sequence of short shifts.
 *
 * These are the shapes the jobs routes answer with. The server flattens a job row into a
 * `JobView` before it leaves, and this is that view rather than the row.
 */

export const JOB_STATUSES = [
    "queued",
    "running",
    "blocked",
    "waiting_user",
    "waiting_approval",
    "waiting_child",
    "waiting_budget",
    "review",
    "done",
    "failed",
    "cancelled",
] as const;

export type JobStatus = typeof JOB_STATUSES[number];

/** The statuses a job never leaves. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["done", "failed", "cancelled"];

export const JOB_AUTONOMY_MODES = ["ask", "free", "auto"] as const;

/** How far a job may act outward on its own: ask first, act freely, or act and report. */
export type JobAutonomy = typeof JOB_AUTONOMY_MODES[number];

/** One job as a listing or a detail read shows it. */
export type JobView = {
    jobId: string;
    /** A short name for listings, derived from the goal when nobody gave one. */
    title: string;
    /** The user's words, verbatim: what the job was asked to do. */
    goal: string;
    status: JobStatus;
    /** Why it is where it is, specific enough to act on. */
    statusDetail: string | null;
    /** A one-line note the running shift may leave. */
    progress: string | null;
    /** The phase being worked, or the last one that was. */
    currentPhaseId: string | null;
    shiftsRun: number;
    /** How many times the job has been reviewed. */
    reviewRounds: number;
    /** What the job has spent in total, in USD. */
    spentUsd: number;
    /** What the job has spent today, in USD. */
    spendTodayUsd: number;
    /** How many questions of this job's are waiting on the user. */
    openQuestions: number;
    lastRunAt: number;
    /** The earliest the runner may pick it up again. */
    wakeAt: number;
    created: number;
    /** `card://…/plan.md`, once a planning shift has written it. */
    planCardUri: string | null;
    /** `card://…/journal.md`, appended to as the job runs. */
    journalCardUri: string | null;
    /** The chat the job was asked for in, and where it reports back. */
    originConversationId: string | null;
    /** What was chosen for this job, or null when nothing was. */
    autonomy: JobAutonomy | null;
    /** When `autonomy` lapses back to asking, in UTC milliseconds. */
    autonomyUntil: number | null;
    /** Things this job asks about however free it otherwise is. */
    alwaysAsk: string[];
    /** What the gate actually reads, with the owner's setting and any lapse applied. */
    effectiveAutonomy: JobAutonomy;
};

/** What the owner's jobs may spend today, and where that figure comes from. */
export type JobAllowanceGranted = {
    perDayUsd: number;
    /** What set the figure: the owner's own allowance, or their tier. */
    source: string;
    remainingUsd: number;
};

/** Why the owner's jobs may not run at all. */
export type JobAllowanceRefused = {
    perDayUsd: 0;
    source: null;
    /** The reason in a word, such as a tier that does not include jobs. */
    refused: string;
    /** The same thing in a sentence, for showing a user. */
    message: string;
};

export type JobAllowance = JobAllowanceGranted | JobAllowanceRefused;

/** Whether an allowance is a refusal rather than a grant. */
export function isJobAllowanceRefused(allowance: JobAllowance): allowance is JobAllowanceRefused {
    return allowance.source === null;
}

export type JobPlanPhaseKind = "plan" | "work" | "review";
export type JobPlanPhaseStatus = "pending" | "running" | "blocked" | "done";

/** One phase of a job's plan, as the plan card spells it out. */
export type JobPlanPhase = {
    id: string;
    kind: JobPlanPhaseKind;
    /** The model this phase is run on. */
    model: string;
    status: JobPlanPhaseStatus;
    /** The card this phase has to leave behind before it may be done. */
    artifact?: string;
    /** What finishing it means, in the plan's own words. */
    acceptance?: string;
    /** Phase ids that have to be done first. */
    dependsOn?: string[];
    /** What the shift working this phase is told. */
    brief?: string;
};

/**
 * What is wrong with a plan card that could not be read.
 *
 * The parse issue names the line and what is wrong with it; a plain string is what a server
 * that only has a sentence about it sends.
 */
export type JobPlanIssue = string | { line: number; message: string };

export type JobPlanRead =
    | { ok: true; raw: string; phases: JobPlanPhase[] }
    | { ok: false; reason: string; issue?: JobPlanIssue };

/**
 * One line of a job's journal.
 *
 * The index signature is there on purpose: the journal is a card the model writes as well as
 * the runtime, and a reader that dropped the keys it did not know would hide exactly the
 * entries worth reading.
 */
export type JobJournalEntry = {
    /** When it was written, in epoch milliseconds. */
    at: number;
    /** Who wrote it: the runtime's own bookkeeping, or the model working the shift. */
    author: "runtime" | "model";
    /** The shift the entry belongs to, 1-based. Absent for anything written between shifts. */
    shiftIndex?: number | null;
    /** A few words naming what this entry is: "shift start", "phase done", "handover: continue". */
    heading: string;
    text: string;
    [key: string]: unknown;
};

/** What may be written to the owner's job settings. */
export type JobSettingsUpdate = {
    /** A flat daily allowance, in USD. */
    allowanceUsd?: number | null;
    /** A daily allowance as a percentage of the owner's usage limit. */
    allowancePercent?: number | null;
    /** The autonomy new jobs start with. */
    autonomy?: JobAutonomy | null;
    /** Things every job of theirs asks about. */
    alwaysAsk?: string[] | null;
};

/**
 * The owner's job settings as they now stand.
 *
 * Open on purpose: the settings pipeline owns this document, and a setting it grows is worth
 * handing back rather than dropping because the SDK has not been rebuilt.
 */
export type JobSettings = JobSettingsUpdate & {
    [key: string]: unknown;
};

export type JobListResponse = {
    success: true;
    jobs: JobView[];
    page: number;
    limit: number;
    total: number;
    /** The status the listing was filtered to, when it was. */
    status?: JobStatus;
    allowance: JobAllowance;
    spentTodayUsd: number;
};

export type JobDetailResponse = {
    success: true;
    job: JobView;
    /** The job's autonomy in a sentence, ready to show. */
    autonomyLine: string;
    plan: JobPlanRead;
    journal: JobJournalEntry[];
    /** Questions of this job's nobody has answered yet. */
    openDeliveries: Delivery[];
};

export type JobCancelResponse = {
    success: true;
    job: JobView;
};

export type JobUpdateResponse = {
    success: true;
    job: JobView;
    autonomyLine: string;
};

export type JobSettingsResponse = {
    success: true;
    jobs: JobSettings;
};

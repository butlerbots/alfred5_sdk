import { CONFIG, APIPath, resolveLinkUrl } from "./config";
import { Link, LinkOptions } from "./link";
import { Conversation, ConversationOptions } from "./modules/conversation";
import { getUsagePolicyData, UsagePolicyDataOptions } from "./modules/usage";
import {
    cancelJob,
    getJob,
    getJobJournal,
    listJobs,
    resumeJob,
    setPhaseModel,
    updateJob,
    updateJobSettings,
    type CancelJobOptions,
    type GetJobJournalOptions,
    type GetJobOptions,
    type SetPhaseModelOptions,
    type ListJobsOptions,
    type ResumeJobOptions,
    type UpdateJobOptions,
    type UpdateJobSettingsOptions,
} from "./modules/jobs";
import {
    answerDelivery,
    listDeliveries,
    type AnswerDeliveryOptions,
    type ListDeliveriesOptions,
} from "./modules/outreach";
import { judge, type JudgeOptions } from "./modules/judge";
import {
    aggregateRecords,
    alterDataset,
    createDataset,
    deleteRecord,
    describeDataset,
    insertRecords,
    listDatasets,
    queryRecords,
    updateRecord,
    type DatasetOptions,
    type DatasetsRequestOptions,
    type RecordLocator,
} from "./modules/datasets";
import type { DatasetAggregate, DatasetAlter, DatasetCreate, DatasetInsertRecord, DatasetOnConflict, DatasetQuery, DatasetUpdate } from "./types/datasets";
import type { JudgeQuestions } from "./types/judge";

type OptionalApiKey<T> = Omit<T, "apiKey"> & {
    /** Optional API key, defaults to API key specified in client */
    apiKey?: string
};

export type ButlerBotClientOptions = {
    /** The server endpoint, API calls are sent here */
    serverUrl?: string;
    /**
     * Where links connect. Defaults to the hosted link service.
     *
     * Links are no longer carried by the core server, so this is a second address rather than
     * a path on the first. A `serverUrl` pointing at your own stack is used for links too,
     * unless this names somewhere else.
     */
    linkUrl?: string;
    /**
     * The datasets service, when it is not the hosted one (`data.butler.now`). The datasets
     * methods go there directly, with the client's key.
     */
    dataUrl?: string;
    /** The API key to use with ButlerBot */
    apiKey: string;
    /** Whether to enable debug logs */
    debug?: boolean;
}

/**
 * The options a caller actually gave, with the keys they left out removed.
 *
 * A client's own API key and URLs are the fallback for whatever a factory call omits, and the
 * usual way to omit something is to forward an optional setting that happens to be unset —
 * `createLink({ serverUrl: process.env.LINK_URL })`. Spread as it stands, that `undefined`
 * lands on top of the client's resolved value and erases it, so the link ends up at the hosted
 * service rather than the self-hosted stack the client was pointed at. Absent means "not given".
 */
function given<T extends object>(config: T): Partial<T> {
    return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)) as Partial<T>;
}

export class ButlerBotClient {
    private apiKey: string;
    private serverUrl: string;
    private linkUrl: string;
    private dataUrl: string;
    private debug: boolean;

    constructor(config: ButlerBotClientOptions) {
        this.apiKey = config.apiKey;
        this.serverUrl = config.serverUrl || CONFIG.server;
        this.linkUrl = resolveLinkUrl(config);
        this.dataUrl = config.dataUrl || CONFIG.data;
        this.debug = config.debug || false;
    }

    /** Checks the health of the server returning true if server is alive */
    async healthCheck(healthCheckPath: string = CONFIG.healthcheckPath): Promise<boolean> {
        const url = `${this.serverUrl}${healthCheckPath}`;
        try {
            const response = await fetch(url);
            return response.ok;
        } catch (error) {
            if (this.debug) console.warn("[Healthcheck Failure]", error);
            return false;
        }
    }

    /** Spawns a new Conversation, inherits api key and server URL */
    createConversation<V extends APIPath = "v4">(config: OptionalApiKey<ConversationOptions<V>> = {}): Conversation<V> {
        return new Conversation<V>({ debug: this.debug, apiKey: this.apiKey, serverUrl: this.serverUrl, ...given(config) } as ConversationOptions<V>);
    }

    /**
     * Creates a Link: a live connection that can register tools and hooks, and carry
     * conversations. Inherits the client's API key and link URL.
     *
     * The link URL, not the server URL: links are served by their own service. Pass
     * `serverUrl` here, or `linkUrl` to the client, to point somewhere else.
     */
    createLink(config: OptionalApiKey<LinkOptions>): Link {
        return new Link({ debug: this.debug, apiKey: this.apiKey, serverUrl: this.linkUrl, ...given(config) } as LinkOptions);
    }

    /** Get current usage policy data */
    getUsagePolicyData(config: OptionalApiKey<UsagePolicyDataOptions>) {
        return getUsagePolicyData({ serverURL: this.serverUrl, apiKey: this.apiKey, debug: this.debug, ...config });
    }

    /** A page of this user's jobs, with what their jobs may spend today */
    listJobs(config: OptionalApiKey<ListJobsOptions> = {}) {
        return listJobs(this.forRequest(config));
    }

    /** One job, with its plan, its journal and the questions waiting on the user */
    getJob(config: OptionalApiKey<GetJobOptions>) {
        return getJob(this.forRequest(config));
    }

    /** A page of one job's journal, newest page first */
    getJobJournal(config: OptionalApiKey<GetJobJournalOptions>) {
        return getJobJournal(this.forRequest(config));
    }

    /** Stops a job. Throws a `ButlerBotAPIError` with `isConflict` when it had already finished */
    cancelJob(config: OptionalApiKey<CancelJobOptions>) {
        return cancelJob(this.forRequest(config));
    }

    /** Continues a job parked waiting for budget. Throws a `ButlerBotAPIError` with `isConflict` when it is in any other status */
    resumeJob(config: OptionalApiKey<ResumeJobOptions>) {
        return resumeJob(this.forRequest(config));
    }

    /** Changes one job's name, the model it runs on, its spending cap and its autonomy: how far it may act, until when, and what it always asks about */
    updateJob(config: OptionalApiKey<UpdateJobOptions>) {
        return updateJob(this.forRequest(config));
    }

    /** Changes the model one phase of a job's plan runs on; only a phase that has not started */
    setPhaseModel(config: OptionalApiKey<SetPhaseModelOptions>) {
        return setPhaseModel(this.forRequest(config));
    }

    /** Changes this user's job settings: their daily allowance and what new jobs start with */
    updateJobSettings(config: OptionalApiKey<UpdateJobSettingsOptions> = {}) {
        return updateJobSettings(this.forRequest(config));
    }

    /** A page of the inbox: what Alfred has told or asked this user outside a chat */
    listDeliveries(config: OptionalApiKey<ListDeliveriesOptions> = {}) {
        return listDeliveries(this.forRequest(config));
    }

    /** Answers a delivery. Throws a `ButlerBotAPIError` with `isConflict` when it was already answered */
    answerDelivery(config: OptionalApiKey<AnswerDeliveryOptions>) {
        return answerDelivery(this.forRequest(config));
    }

    /**
     * Asks the judge: a yes/no, pick-one or score decision on facts you state, by a decision
     * model, in well under a second for a fraction of a cent. Answers come back keyed by
     * question id and typed by the question. Throws a `ButlerBotAPIError` with `isBadRequest`
     * on a question the judge cannot ask, carrying its message
     */
    judge<Q extends JudgeQuestions>(config: OptionalApiKey<JudgeOptions<Q>>) {
        return judge<Q>(this.forRequest(config));
    }

    /** The datasets this key has a grant on. Needs `datasets.read` */
    listDatasets(config: OptionalApiKey<DatasetsRequestOptions> = {}) {
        return listDatasets(this.forData(config));
    }

    /** One dataset: schema, settings, counts, this key's access and the latest records */
    describeDataset(config: OptionalApiKey<DatasetOptions>) {
        return describeDataset(this.forData(config));
    }

    /** Creates a dataset. Needs `datasets.admin` and an `admin` pattern grant matching its name (`myapp-*`) */
    createDataset(config: OptionalApiKey<DatasetsRequestOptions & { definition: DatasetCreate }>) {
        return createDataset(this.forData(config));
    }

    /** Changes a dataset's schema or settings. Needs `datasets.admin` and an `admin` grant */
    alterDataset(config: OptionalApiKey<DatasetOptions & { changes: DatasetAlter }>) {
        return alterDataset(this.forData(config));
    }

    /** Inserts records, one or up to 500; a record whose `key` is there already is skipped, replaced or merged */
    insertRecords<D extends Record<string, unknown>>(config: OptionalApiKey<DatasetOptions & { records: DatasetInsertRecord<D>[]; onConflict?: DatasetOnConflict }>) {
        return insertRecords<D>(this.forData(config));
    }

    /** Changes one record, by `recordId` or `key` */
    updateRecord<D extends Record<string, unknown>>(config: OptionalApiKey<DatasetOptions & RecordLocator & { change: DatasetUpdate }>) {
        return updateRecord<D>(this.forData(config) as DatasetOptions & RecordLocator & { change: DatasetUpdate });
    }

    /** Deletes one record, by `recordId` or `key` */
    deleteRecord(config: OptionalApiKey<DatasetOptions & RecordLocator>) {
        return deleteRecord(this.forData(config) as DatasetOptions & RecordLocator);
    }

    /** Records, a page at a time */
    queryRecords<D extends Record<string, unknown> = Record<string, unknown>>(config: OptionalApiKey<DatasetOptions & { query?: DatasetQuery }>) {
        return queryRecords<D>(this.forData(config));
    }

    /** Groups and measures over a dataset */
    aggregateRecords(config: OptionalApiKey<DatasetOptions & { aggregate: DatasetAggregate }>) {
        return aggregateRecords(this.forData(config));
    }

    /** The client's datasets service and key underneath whatever the call named itself. */
    private forData<T extends { dataURL?: string; apiKey: string; debug?: boolean }>(config: OptionalApiKey<T>): T {
        return { dataURL: this.dataUrl, apiKey: this.apiKey, debug: this.debug, ...given(config) } as T;
    }

    /** The client's own server and key underneath whatever the call named itself. */
    private forRequest<T extends { serverURL?: string; apiKey: string; debug?: boolean }>(config: OptionalApiKey<T>): T {
        return { serverURL: this.serverUrl, apiKey: this.apiKey, debug: this.debug, ...given(config) } as T;
    }
}

// Expose types from subsequent modules
export * from "./types/type_registry";
export * from "./link";
export { Conversation };
export type { ConversationOptions };
export type { APIPath };
export type {
    ConversationStream,
    ConversationTransport,
    TransportTurnRequest,
    TransportHandlers,
} from "./modules/transport";
export { ButlerBotAPIError } from "./util/api_error";
export { ButlerBotTurnError } from "./util/turn_error";
export type { DialogueRequestOptions, DialogueRequestParams, SendOptions, TurnTimeout } from "./modules/conversation";
export { STREAM_RECONNECT_ATTEMPTS } from "./modules/transport_sse";
export { listJobs, getJob, cancelJob, resumeJob, updateJob, updateJobSettings } from "./modules/jobs";
export type {
    JobsRequestOptions,
    ListJobsOptions,
    GetJobOptions,
    CancelJobOptions,
    ResumeJobOptions,
    UpdateJobOptions,
    UpdateJobSettingsOptions,
} from "./modules/jobs";
export { listDeliveries, answerDelivery } from "./modules/outreach";
export type {
    OutreachRequestOptions,
    ListDeliveriesOptions,
    AnswerDeliveryOptions,
} from "./modules/outreach";
export { judge } from "./modules/judge";
export { listDatasets, describeDataset, createDataset, alterDataset, insertRecords, updateRecord, deleteRecord, queryRecords, aggregateRecords } from "./modules/datasets";
export type { DatasetsRequestOptions, DatasetOptions, RecordLocator } from "./modules/datasets";
export { verifyWebhookSignature, signWebhook, WEBHOOK_TOLERANCE_SECONDS } from "./modules/webhooks";
export type { WebhookScheme, WebhookVerification } from "./modules/webhooks";
export type { JudgeRequestOptions, JudgeOptions } from "./modules/judge";
export { LinkConversationTransport } from "./modules/transport_link";
export { SSEConversationTransport } from "./modules/transport_sse";
export type { SteerResult, TurnStopMode, TurnStopped } from "./modules/transport";
export { RESERVED_TURN_FIELDS } from "./modules/transport";

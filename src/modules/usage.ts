import { CONFIG } from "../config";
import { UsagePolicyData } from "../types/usage/policy";
import { ButlerBotAPIError } from "../util/api_error";
import { formatURL } from "../util/url_formatter";
import { requestAPI } from "./api_request";

export type UsagePolicyDataOptions = {
    serverURL?: string;
    path?: string;
    apiKey: string;
    debug?: boolean;
}

/**
 * Fetches the current usage policy data from the server.
 *
 * Throws a `ButlerBotAPIError` when the server refuses or fails, and when it answers without a
 * policy.
 */
export async function getUsagePolicyData(options: UsagePolicyDataOptions): Promise<UsagePolicyData> {
    const useEndpoint = (options.serverURL || CONFIG.server) + (options.path || CONFIG.paths.usage.policy.v3.base);
    const url = formatURL(useEndpoint, {}, { debug: options.debug });

    const data = await requestAPI<{ success: true; policy?: UsagePolicyData; error?: string }>({
        url,
        apiKey: options.apiKey,
        action: "fetch usage policy data",
    });

    if (!data.policy) {
        throw new ButlerBotAPIError({ action: "fetch usage policy data", status: 200, statusText: "OK", error: data.error || "No policy in the response", body: data });
    }

    return data.policy;
}

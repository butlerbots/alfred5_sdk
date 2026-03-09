import { CONFIG } from "../config";
import { UsagePolicyData } from "../types/usage/policy";
import { formatURL } from "../util/url_formatter";

export type UsagePolicyDataOptions = {
    serverURL?: string;
    path?: string;
    apiKey: string;
    debug?: boolean;
}

/** Fetches the current usage policy data from the server */
export async function getUsagePolicyData(options: UsagePolicyDataOptions): Promise<UsagePolicyData> {
    const useEndpoint = (options.serverURL || CONFIG.server) + (options.path || CONFIG.paths.usage.policy.v3.base);

    const url = formatURL(useEndpoint, {}, { apiKey: options.apiKey, debug: options.debug });
    const response = await fetch(url);
    const data = await response.json() as { success: boolean; policy?: UsagePolicyData; error?: string };

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to fetch usage policy data: ${response.status} ${response.statusText} - ${errorText}`);
    }

    if (!data.success) {
        throw new Error(`API error while fetching usage policy data: ${data.error || 'Unknown error'}`);
    }

    if (!data.policy) {
        throw new Error(`API error while fetching usage policy data: ${data.error || 'Unknown error'}`);
    }

    return data.policy as UsagePolicyData;
}
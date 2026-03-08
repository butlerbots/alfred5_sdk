import { CONFIG } from "../config";
import { UsagePolicyData } from "../types/usage/policy";
import { formatURL } from "../util/url_formatter";

/** Fetches the current usage policy data from the server */
export async function getUsagePolicyData(endpoint: { serverURL: string, path?: string }, apiKey: string, debug?: boolean): Promise<UsagePolicyData> {
    const useEndpoint = endpoint.serverURL + (endpoint.path || CONFIG.paths.usage.policy.v3.base);

    const url = formatURL(useEndpoint, {}, { apiKey, debug });
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to fetch usage policy data: ${response.status} ${response.statusText} - ${errorText}`);
    }

    if (!data.success) {
        throw new Error(`API error while fetching usage policy data: ${data.error || 'Unknown error'}`);
    }

    return data as UsagePolicyData;
}
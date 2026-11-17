/**
 * A server URL with its query.
 *
 * The API key is never part of it: a URL lands in access logs, proxy logs and browser history,
 * so the key travels in the `Authorization` header instead (`authHeaders`), which every route
 * that takes a key reads.
 */
export function formatURL(url: string, params: Record<string, string> = {}, config: { debug?: boolean } = {}) {
    const paramQuery = new URLSearchParams(params).toString();
    const fUrl = paramQuery ? `${url}?${paramQuery}` : url;

    if (config.debug) console.log(`[Formatting URL ${fUrl}]`);

    return fUrl;
}

/** The header that carries an API key to the server. */
export function authHeaders(apiKey: string): Record<string, string> {
    return { Authorization: `Bearer ${apiKey}` };
}

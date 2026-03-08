export function formatURL(url: string, params: Object = {}, config: { apiKey: string, debug?: boolean }) {
    const fParams: { api_key: string } = {
        api_key: config.apiKey,
        ...params
    }
    const paramQuery = new URLSearchParams(fParams as any).toString();
    const fUrl = `${url}?${paramQuery}`;

    if (config.debug) {
        const debugUrl = new URL(fUrl);
        const apiKey = debugUrl.searchParams.get('api_key');
        if (apiKey) {
            const obscuredKey = apiKey.length > 6 ? `${apiKey.slice(0, 3)}...${apiKey.slice(-3)}` : '***';
            debugUrl.searchParams.set('api_key', obscuredKey);
        }
        console.log(`[Formatting URL ${debugUrl.toString()}]`);
    }

    return fUrl;
}
export const CONFIG = {
    server: "https://core.butler.now",
    /**
     * Where links connect.
     *
     * Not the core server: links are carried by their own service, so the SDK holds two
     * addresses rather than one.
     */
    link: "https://link.butler.now",
    healthcheckPath: "/api/healthcheck",
    paths: {
        conversation: {
            v3: { base: "/api/alfred/v3/chat" },
            v4: { base: "/api/alfred/v4/chat" },
            v5: { base: "/api/alfred/v5/chat" },
        },
        history: {
            chat: {
                v1: { base: "/api/convo/chat" },
            },
            chats: {
                v1: { base: "/api/convo/get/history" }
            }
        },
        interrupt: {
            v4: {
                stop: "/api/alfred/v4/chat/stop",
                steer: "/api/alfred/v4/chat/steer",
            },
            v5: {
                stop: "/api/alfred/v5/chat/stop",
                steer: "/api/alfred/v5/chat/steer",
            },
        },
        progress: {
            v4: {
                base: "/api/alfred/v4/chat/progress",
                stream: "/api/alfred/v4/chat/progress/stream",
            },
            v5: {
                base: "/api/alfred/v5/chat/progress",
                stream: "/api/alfred/v5/chat/progress/stream",
            },
        },
        usage: {
            policy: {
                v3: { base: "/api/user/usage/v3/policy" },
            }
        },
        jobs: {
            /** The collection. One job is `${base}/${jobId}`, its cancel `${base}/${jobId}/cancel` and its resume `${base}/${jobId}/resume`. */
            base: "/api/jobs",
            /** The owner's job settings, which live on the user rather than on a job. */
            settings: "/api/user/jobs-settings",
        },
        outreach: {
            /** The inbox. One delivery's answer is `${base}/${deliveryId}/answer`. */
            base: "/api/outreach",
        }
    }
}

export type APIPath = keyof typeof CONFIG.paths.conversation;

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, "");

/**
 * Which server a link should connect to.
 *
 * `linkUrl` names it outright and always wins. Failing that, a `serverUrl` pointing anywhere
 * other than the hosted core is taken at its word: a self-hosted stack is usually one address,
 * and sending an API key to a host nobody named would be a worse surprise than a wrong path.
 * Otherwise it is the hosted link service, which is what the core server used to be and is not.
 */
export function resolveLinkUrl(config: { linkUrl?: string; serverUrl?: string }): string {
    if (config.linkUrl) return config.linkUrl;
    if (config.serverUrl && withoutTrailingSlash(config.serverUrl) !== withoutTrailingSlash(CONFIG.server)) return config.serverUrl;
    return CONFIG.link;
}

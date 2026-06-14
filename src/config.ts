export const CONFIG = {
    server: "https://core.butlerbot.net",
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
        }
    }
}

export type APIPath = keyof typeof CONFIG.paths.conversation;

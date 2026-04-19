export const CONFIG = {
    server: "https://core.butlerbot.net",
    healthcheckPath: "/api/healthcheck",
    paths: {
        conversation: {
            v3: { base: "/api/alfred/v3/chat" },
            v4: { base: "/api/alfred/v4/chat" },
        },
        history: {
            chat: {
                v1: { base: "/api/convo/chat" },
            },
            chats: {
                v1: { base: "/api/convo/get/history" }
            }
        },
        stream: {
            v4: { base: "/api/alfred/v4/chat/stream" }
        },
        usage: {
            policy: {
                v3: { base: "/api/user/usage/v3/policy" },
            }
        }
    }
}
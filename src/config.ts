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
                v1: { base: "/api/history/chat" },
            },
            chats: {
                v1: { base: "/convo/get/history" }
            }
        }
    }
}
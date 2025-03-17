import { ButlerBotClient } from "../src";

const client = new ButlerBotClient({
    apiKey: "your_api_key_here"
});

const convo = client.createConversation();

convo.send("Hello, world!", (response) => {
    console.log(response);
});
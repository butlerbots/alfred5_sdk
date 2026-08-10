import { ButlerBotClient, Hook, Tool } from "../src";
import { z } from "zod";

/**
 * A Link: a live connection that lets Alfred call your code, lets your code wake
 * Alfred's background agents, and can carry conversations.
 */

const client = new ButlerBotClient({ apiKey: "your_api_key_here" });

// `linkId` is yours and permanent: every id this link creates is derived from it,
// and those ids are what the user's saved tool settings point at.
const link = client.createLink({ linkId: "coffee-machine" });

// ── A tool Alfred can call ──
// Registered tools belong to the user, not to a conversation: Alfred can call this
// anywhere they talk to it, including the web app and Discord.
link.addTool(new Tool({
    id: "brew",
    description: "Brew a coffee for the user. Ask how many cups if they didn't say.",
    schema: z.object({
        cups: z.number().int().min(1).max(4).describe("How many cups to brew"),
        strength: z.enum(["mild", "normal", "strong"]).default("normal"),
    }),
    display: {
        name: "Brew coffee",
        shortDescription: "Brews coffee on the kitchen machine",
        longDescription: "Lets Alfred start the coffee machine in the kitchen.",
    },
    defaultEnabled: true,
    run: async ({ args, status }) => {
        // `args` is typed from the schema above.
        status.update(`Grinding beans for ${args.cups}`);
        await new Promise(resolve => setTimeout(resolve, 1000));

        return `Brewed ${args.cups} ${args.strength} cup(s).`;
    },
}));

// ── A hook that can wake the user's background agents ──
const waterLow = new Hook({
    id: "water-low",
    name: "Water tank low",
    description: "Fires when the coffee machine's water tank drops below a quarter full.",
    events: [{ name: "low", description: "The tank needs refilling", payloadShape: { level: "Remaining level, 0-1" } }],
});
link.addHook(waterLow);

async function main() {
    await link.connect();
    console.log(`Connected as ${link.connectionId}, speaking for a ${link.scope}`);

    // Fires whenever it needs to; agents subscribed to this hook decide what to do.
    await waterLow.emit("low", { level: 0.2 });

    // ── A conversation over the same connection ──
    const convo = client.createConversation({ transport: link });

    const answer = await convo.ask("Is there any coffee on?");
    console.log(answer.text);

    // The streaming form is identical to the HTTP transport, payload for payload.
    convo.send("Make me a strong one", (chunk) => {
        if (!chunk.success) return console.error(chunk.data.message);

        const { type, payload } = chunk.data.response;
        console.log(type, payload);
    });
}

void main();

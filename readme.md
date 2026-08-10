# ButlerBot SDK

ButlerBot SDK is a JavaScript library that provides a simple way to interact with the [ButlerBot](https://butlerbot.net/) API.

## Quickstart

Grab an API key at [ButlerBot](https://butlerbot.net/) and install the package:

```bash
npm i @butlerbot/sdk
```

> NOTE: API key is currently not available on the ButlerBot UI

## Prerequisites

- ButlerBot API key

## Talking to Alfred

```typescript
import { ButlerBotClient } from "@butlerbot/sdk";

const client = new ButlerBotClient({
  apiKey: "your_api_key_here",
});

const convo = client.createConversation();

convo.send("Hey there Alfred!", (res) => {
  if (!res.success) return;

  const { type, payload } = res.data.response;
  console.log(type, payload); // message { message: "Good day", ... }
});
```

Or, when you only want the answer:

```typescript
const { text } = await convo.ask("Hey there Alfred!");
```

## Link

A Link is a live connection to Alfred. It does three things:

- **Tools** — Alfred calls code that runs on your machine
- **Hooks** — your code wakes the user's background agents when something happens
- **Conversations** — turns are carried over the same connection instead of an HTTP stream

```typescript
import { ButlerBotClient, Tool, Hook } from "@butlerbot/sdk";
import { z } from "zod";

const client = new ButlerBotClient({ apiKey: "your_api_key_here" });
const link = client.createLink({ linkId: "coffee-machine" });

link.addTool(new Tool({
  id: "brew",
  description: "Brew a coffee for the user",
  schema: z.object({ cups: z.number().int().min(1).max(4) }),
  run: async ({ args, status }) => {
    status.update("Grinding beans");
    return `Brewed ${args.cups} cup(s).`;   // args is typed from the schema
  },
}));

const waterLow = new Hook({
  id: "water-low",
  name: "Water tank low",
  description: "Fires when the water tank drops below a quarter full",
  events: [{ name: "low", description: "The tank needs refilling" }],
});
link.addHook(waterLow);

await link.connect();
await waterLow.emit("low", { level: 0.2 });
```

See [`examples/link.ts`](./examples/link.ts) for a fuller version.

### linkId is permanent

`linkId` is yours to choose and must never change. Every id the link creates is derived
from it (`link:coffee-machine/brew`), and those ids are what the user's saved tool
settings and background agent subscriptions point at — so changing it silently orphans
both. Pick a deliberate constant; never a hostname, a version, or something generated at
startup.

Nothing else is stored on either side: the server keeps no record of a link between
connections, and the SDK re-declares everything on connect. A link can reconnect from
anywhere and land on the same settings.

Two live connections using the same `linkId` is last-writer-wins — the newer one takes
over and the older one's registrations are released. That is deliberate, so a half-dead
socket cannot lock out a fresh one during a deploy, but it does mean two genuinely
different clients must not share an id.

### Tools belong to the user, not to a conversation

Once a tool is registered, Alfred can call it anywhere that user talks to it — the web
app and Discord included, not just conversations you started. `defaultEnabled` decides
whether it is on before the user has touched it; after that their own setting wins.

### Schemas

`schema` takes a [zod](https://zod.dev) 4 schema, any
[Standard Schema](https://standardschema.dev), or a plain JSON Schema object. The SDK has
no dependency on any of them.

With a schema that can validate, arguments are checked before your tool runs (the server
deliberately doesn't — you wrote the schema, so you own the check) and `args` is typed
from it. With zod 3, pass `jsonSchema` alongside `schema`, since zod 3 cannot produce
JSON Schema itself.

## Conversations over a Link

Pass a connected Link as the transport. Everything else is identical — the same methods,
the same payloads — so nothing that consumes a conversation needs to change:

```typescript
const convo = client.createConversation({ transport: link });    // over the websocket
const overHttp = client.createConversation();                    // over SSE, the default
```

Which to use:

- **SSE** is the simplest thing that works and needs no connection to manage. Best for a
  one-off request, a serverless function, or a page that just wants an answer.
- **A Link** reuses a connection you already have and avoids a new HTTP stream per turn.
  Best when you are already running a link for tools or hooks, or holding many
  conversations at once — one socket carries them all.

Two differences to know about:

- Sessions are ephemeral. If the connection drops mid-turn the SDK reopens the session
  and resends transparently; the conversation itself is persisted server-side, so
  nothing is lost.
- The HTTP transport replays your own message back to you (it exists so a browser
  reconnecting mid-turn sees it). A Link does not, since it has nothing to replay.

Neither transport can cancel a turn: `close()` stops delivery locally, and the reply is
still generated and stored.

## Environment

Node 18+. Node 22 and every browser have a built-in WebSocket; on older Node, install
`ws` or pass your own `socketFactory`.

Browsers are supported: a websocket handshake cannot carry headers there, so the SDK
sends the service and credential as subprotocols instead of putting the key in the URL.

## Development

```bash
npm install
npm test         # bun test
npm run typecheck
npm run build
```

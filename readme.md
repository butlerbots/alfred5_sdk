# ButlerBot SDK

ButlerBot SDK is a JavaScript library that provides a simple way to interact with the [Butler](https://butler.now/) API.

## Quickstart

Grab an API key at [Butler](https://butler.now/) (Dashboard -> Account Dropdown -> API Keys) and install the package:

```bash
npm i @butlerbot/sdk
```

## Prerequisites

- Butler API key

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
    status.update("Grinding beans");           // progress, shown while it runs
    status.complete("Brewed the coffee");      // the label the conversation keeps
    return `Brewed ${args.cups} cup(s).`;      // args is typed from the schema
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

### Hooks: emit, or report what matched

`emit` hands an event to the server and lets it work out who cares. That is fine for a source
that fires rarely — a water tank, a build finishing — and it is what already-deployed clients do.

For a busy source, prefer `report`. The server pushes down the list of things it wants watched,
your client matches locally, and only the subscriptions that matched are sent:

```ts
link.on("subscriptions", (subscriptions) => {
  // Called on connect and whenever the set changes. Set up whatever you need to watch.
  for (const subscription of subscriptions) {
    console.log(subscription.name, subscription.prefilter, subscription.identities);
  }
});

// Report an event. Sends nothing at all if no subscription matched.
const matched = await doorbell.report("rang", { camera: "front" });
```

Why this is the better path:

- **Nothing irrelevant is sent.** A channel with 10,000 messages a day that nobody subscribed to
  costs one local comparison per message and zero frames.
- **Your platform's semantics stay in your code.** "Messages in #support from non-bots" is
  knowledge Alfred's server never has to learn.
- **Fan-out is one frame.** Five people watching one channel is one `hook.event` with five ids.
- **You never name a user.** A subscription id is a handle the server issued and already bound to
  an owner, so ownership is not something your client can get wrong or forge.

`subscription.prefilter` is applied for you by `report` — a dot-path map of conditions, all ANDed,
scalars or arrays (`{ "author.bot": false, "channel.id": ["1", "2"] }`). It is a volume gate, not a
query language. Ignoring prefilters entirely is still *correct*, just louder — the server evaluates
them again before spending anything.

For a condition that is not field equality — "mentions my user", "within 50 metres", "the third time
today" — decide with real code and use `reportTo`:

```ts
const mine = doorbell.subscriptions.filter(
  (s) => s.identities?.discord && message.mentions.users.has(s.identities.discord),
);

await doorbell.reportTo(mine.map((s) => s.subscriptionId), "rang", payload);
```

`reportTo` does not apply the prefilter — you already decided. It does drop any id this link isn't
currently holding, so a subscription that disappeared between your decision and the call is a
dropped report rather than a rejected frame.

`subscription.identities` is how you answer "is this event about *my* user": a plain string map in
namespaces you understand, e.g. `{ discord: "1897..." }`, present only for owners who have linked
that account. Nothing else about the user is exposed.

Subscriptions are never persisted by the SDK. They arrive on connect, follow deltas while
connected, and are dropped on disconnect — so there is nothing to reconcile, and a restart is
correct by construction.

### Tools can belong to an agent instead of a chat

By default a tool shows up where a user is talking to Alfred. If your client mirrors a whole
platform, say so instead:

```ts
new Tool({
    id: "discord_member_kick",
    description: "Kick a member from a server.",
    platforms: ["platform.agent.discord"],
    run: async ({ args, meta }) => kick(meta.identities?.discord, args),
});
```

Seventy tools in front of somebody asking about their groceries is not a feature. Behind Alfred's
Discord agent they are one entry that already knows when Discord is relevant — and the agent keeps
whatever tier and permission gating it carries, which tools bolted onto the chat would quietly skip.

An unknown platform is rejected when you register, not ignored: a tool reachable from nowhere looks
exactly like a tool that is broken.

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

One difference to know about: sessions are ephemeral. If the connection drops mid-turn
the SDK reopens the session and resends transparently; the conversation itself is
persisted server-side, so nothing is lost.

### Rejoining a turn already in progress

A turn belongs to the conversation, not to whoever started it, so reopening a
conversation mid-answer picks the reply back up as it is written:

```typescript
const convo = client.createConversation({ convoId, transport: link });
const watching = convo.fetchProgressStream(chunk => render(chunk));
// ...later
watching.close();       // stop watching; the turn keeps running
```

Over a Link this rides the connection you already hold; over SSE it opens the HTTP
progress stream. The payloads are identical either way, including your own message and
the conversation's start — everything a client that arrived late needs to draw the turn
from the beginning. Pass `{ afterEventId }` to be sent only what you have not already
seen. A conversation with nothing running simply ends the stream.

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

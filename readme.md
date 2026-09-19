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

### Streaming

Alfred streams a reply as it writes it. A message opens with a whole value, is extended a
piece at a time, and finishes whole again. No event carries both:

```jsonc
{ "messageId": "m1", "message": "Good day", "completed": false, "metadata": {...} }
{ "messageId": "m1", "delta": " to you", "completed": false }
{ "messageId": "m1", "message": "Good day to you", "completed": true, "metadata": {...} }
```

Deltas travel bare — no metadata block, since it is identical on every frame of a message
and many times the size of the few characters a delta carries. The SDK remembers it from
the frame that opened the message and puts it back, so **every event you receive has both
the whole message and its metadata**, exactly as it always did:

```typescript
convo.send("Tell me a story", (res) => {
  if (!res.success || res.data.response.type !== "message") return;

  const { message, delta } = res.data.response.payload;
  // message — everything written so far
  // delta   — just what this event added, when it added anything
});
```

Render `message` and you need do nothing else. Render `delta` and you never re-draw text
you already have, which for a long reply is the difference between a smooth stream and a
stuttering one — append it when it is there, and replace with `message` when it is not.
`delta` is absent in two cases: the last event of a message, and whatever catches you up
after a reconnect. Do not read `completed` to tell the two apart — a whole message arrives
with `completed: false` whenever you are being caught up mid-answer.

`accumulateStream: false` hands you the wire payloads untouched: deltas with no `message`
beside them and no metadata. Only worth it if you are appending anyway and want nothing
between you and the socket.

## Link

A Link is a live connection to Alfred, served by its own endpoint — `link.butler.now`,
not the core API server. `createLink` goes there by default; pass `linkUrl` to the client
(or `serverUrl` to `createLink`) to point somewhere else. A client given a `serverUrl` of
its own — a self-hosted stack — uses that for links too.

It does three things:

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

### Agents: your tools behind a worker of your own

When your client has more tools than a chat should see, or tools that only make sense together,
declare an agent. It lives on the server for as long as the link does, works with tools that run
here, and to Alfred it is one tool:

```ts
import { Agent, Tool } from "@butlerbot/sdk";

const grind = new Tool({ id: "grind", description: "Grind beans.", run: async () => grinder.run() });
const brew = new Tool({ id: "brew", description: "Brew from the ground beans.", run: async () => machine.brew() });

const barista = new Agent({
    id: "barista",
    name: "Barista",
    description: "Runs the kitchen coffee machine: grinding, brewing, cleaning.",
    prompt: "You operate a coffee machine. Always grind before you brew. Report what you made.",
    model: "DeepSeek-V4-Flash",
    tools: [grind, brew],
});
link.addAgent(barista);
```

The tools come with the agent — no `addTool` for them, and Alfred never sees them directly. The
prompt is where a thousand tools become one coherent worker.

You can talk to the agent yourself. The run happens on the server, on your account; the question
and the answer live here:

```ts
const { text } = await barista.chat("Make me a flat white.");
```

One `Agent` remembers across `chat` calls; pass `{ thread }` to name the conversation yourself, or
`newThread()` to start over. This is what makes a hook callback useful on its own: something
happens, your code notices, and you ask an agent what to do about it.

Needs `link.tools.register` to declare agents, and `tools.run` to talk to one directly.

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

A turn survives losing the connection it was asked for on. Sessions are ephemeral — the
server drops one with its socket — but the turn belongs to the conversation, so when the
socket goes mid-answer the SDK reconnects, rejoins the turn from the last event it gave
you, and carries on into the same stream. The same holds when the platform deploys
mid-turn and the answer is handed to another instance. A message that had not been
delivered yet is simply sent again on a fresh session; one that had is never sent twice.

If the turn cannot be picked back up within a minute, the stream ends with a failure that
says so — the reply may still have finished, and reopening the conversation will show it.

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

## Jobs

A job is long-running work Alfred does on its own, run as a sequence of short shifts against
a plan it writes. The client reads them and steers them; it does not run them.

```typescript
const { jobs, allowance, spentTodayUsd } = await client.listJobs({ status: "running", page: 1, limit: 20 });
const { job, plan, journal, journalTotal, openDeliveries, autonomyLine } = await client.getJob({ jobId });
const { entries, hasMore } = await client.getJobJournal({ jobId, page: 2 });

await client.updateJob({ jobId, title: "Flat hunt", autonomy: "free", autonomyUntil: Date.now() + 86_400_000 });
await client.cancelJob({ jobId });
```

`getJob` carries the newest page of the journal and `journalTotal`; `getJobJournal` pages the rest,
newest page first, with each page in the order its entries were written and `hasMore` saying whether
an older page exists. Each entry says which shift wrote it (`shiftIndex`, `shiftKind`) and on which
model. A job's `title` is a few words of its own, set at start or renamed with `updateJob`.

Paging is 1-based, and every listing answers with `page`, `limit` and `total`. A listing also
carries `allowance` — what this user's jobs may spend today and what is left of it, or
`{ perDayUsd: 0, source: null, refused, message }` when their plan does not include jobs.

`autonomy` is how far a job may act outward without asking: `ask`, `free` or `auto`.
`autonomyUntil` is when a loosened setting lapses back to asking, and `alwaysAsk` is what the
job asks about however free it otherwise is. `effectiveAutonomy` on a job is what the gate
actually reads, with the owner's default and any lapse already applied. What new jobs start
with, and what they may spend, is the user's own setting:

```typescript
await client.updateJobSettings({ allowanceUsd: 5, autonomy: "ask", alwaysAsk: ["spending money"] });
```

## Outreach

Outreach is what Alfred has told or asked this user outside a chat. The record is the inbox —
there is no separate notification — so a question a job is parked on is a delivery with
`intent: "question"` and no `answered`:

```typescript
const { deliveries } = await client.listDeliveries({ page: 1, limit: 20 });
const { delivery, job } = await client.answerDelivery({ deliveryId, text: "The one in Gardens" });
```

Answering closes the delivery, and when it belongs to a job the answer is put on that job's
inbox, which wakes a job that was parked waiting for it — `job.delivered` says what became of
it. An approval takes `decision: "approve" | "deny"` alongside the text.

### When a call fails

Every jobs and outreach call throws `ButlerBotAPIError` when the server does not answer with a
success. The status is on the error, so the cases worth branching on are told apart without
reading a message, and the parsed body is kept — a rejected cancel still carries the job, a
rejected answer still carries the delivery:

```typescript
import { ButlerBotAPIError } from "@butlerbot/sdk";

try {
    await client.cancelJob({ jobId });
} catch (error) {
    if (error instanceof ButlerBotAPIError && error.isConflict) {
        // 409: it had already finished. `error.body.job` is how it settled.
    } else throw error;
}
```

`isNotFound` (404), `isConflict` (409) and `isBadRequest` (400) are the three; `status`,
`error` and `errormessage` are the server's own words. A job or delivery that is not this key's
is answered exactly as one that does not exist, so a 404 means either.

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

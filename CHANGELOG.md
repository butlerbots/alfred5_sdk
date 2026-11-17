# Changelog

Every release of `@butlerbot/sdk`, newest first.

Versions are `0.0.PATCH`, and every release bumps the patch number, whatever it changes. A
release that changes behaviour a caller relies on says so under **Changed**.

## 0.0.49 (unreleased)

### Changed

- **A turn is a POST.** Its parameters travel as a JSON body (the address as an object, the
  context and the tools as arrays) and the API key in the `Authorization` header, so neither
  lands in an access log or against the server's 16 KB header limit. A dropped connection
  reconnects by sending the same request again with its `Last-Event-ID`, as before. Needs a
  server that accepts `POST /api/alfred/v4/chat`; against an older one pass
  `turnMethod: "GET"` to `createConversation()`.
- **No URL carries the key.** Every call (history, progress, the progress stream, usage, jobs,
  outreach, judge, stop and steer) sends it as `Authorization: Bearer <key>`, which every
  route that takes a key reads. `formatURL` builds the URL and query only.
- **A failed stream ends the turn instead of going quiet.** A refusal (a bad key, a missing
  scope, a refused parameter), a stream the server closes for good, or a server unreachable for
  `STREAM_RECONNECT_ATTEMPTS` attempts in a row now ends with a failure payload carrying
  `quitStream`, a `code` and, for a refusal, the HTTP `status` and what the server said. Before,
  it was logged only with `debug` on and `ask()` never settled.
- **`ask()` rejects with a `ButlerBotTurnError`** (`code`, `error`, `userMessage`, `status`,
  `convoId`, `payload`) rather than a plain `Error`. Its `message` is what it was.
- **`fetchState()`, `fetchProgress()` and `getUsagePolicyData()` throw `ButlerBotAPIError`**,
  as every other call does, rather than a plain `Error`.
- **The `zod` peer range is `^4.0.0`.** The schemas need zod 4; the old `>=3.24.0` admitted a
  version they fail on.

### Added

- **Datasets.** `listDatasets`, `describeDataset`, `createDataset`, `alterDataset`,
  `insertRecords`, `updateRecord`, `deleteRecord`, `queryRecords` and `aggregateRecords`, on the
  client and as functions, against the datasets service's `/v1` API (`CONFIG.data`, or `dataUrl`
  on the client), with their types (`DatasetRecord`, `DatasetQuery`, `DatasetAggregate`, …).
  Keys need `datasets.read`, `datasets.write` or `datasets.admin` and a grant on each dataset.
- **Webhook signatures.** `verifyWebhookSignature` (the `alfred`, `github` and `stripe` schemes)
  and `signWebhook` (the `alfred` scheme), on Web Crypto.
- `ButlerBotAPIError` reads `code`, `issues` and `retryAfter` off a refusal's body, and says
  `isForbidden` (403) and `isRateLimited` (429).
- `guildId` on `DiscordAddress`: the server a Discord channel belongs to, so a persona set for
  that server applies across its channels.
- `timeout: { firstEventMs, idleMs }` on `createConversation()` and on each `send()`/`ask()`:
  a silent stream ends with `SDK_TIMEOUT`. Off unless set. Only the stream gives up; the turn
  goes on and `fetchProgressStream()` picks it back up.
- `ErrorCode` is the union of every code this SDK knows (`TURN_ERROR_CODES`, `KnownErrorCode`),
  still open to codes a newer server sends.
- `status` on a failure payload's `data`, when the stream failed on an HTTP status.
- Exports: `ButlerBotTurnError`, `TURN_ERROR_CODES`, `KnownErrorCode`, `SendOptions`,
  `TurnTimeout`, `DialogueRequestOptions`, `DialogueRequestParams`, `STREAM_RECONNECT_ATTEMPTS`.
- The readme documents `stop()`, `steer()`, `setAddress()` and the per-turn `wake`, `tools`,
  `context` and `extra`.

### Fixed

- `getUsagePolicyData()` read the response body twice, so a refusal threw a body-used error
  instead of what the server said.
- The readme said neither transport could cancel a turn; both can, with `stop()`.

## 0.0.48 and earlier

Not recorded here; `git log` has them. 0.0.48 added the per-turn `tools`.

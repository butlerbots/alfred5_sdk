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

## Example

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

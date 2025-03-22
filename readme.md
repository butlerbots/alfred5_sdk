# ButlerBot SDK

ButlerBot SDK is a JavaScript library that provides a simple way to interact with the [ButlerBot](https://butlerbot.net/) API.

## Prerequisites

- ButlerBot API key

## Example

```typescript
import { ButlerBotClient } from "butlerbot";

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

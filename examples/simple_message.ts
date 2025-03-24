import { ButlerBotClient } from "../src";

const client = new ButlerBotClient({
  apiKey: "your_api_key_here"
});

const convo = client.createConversation();

convo.send("Hello there, what's 1+1", (res) => {
  if (!res.success) return;

  const { type, payload } = res.data.response;
  console.log(type, payload);
})

/*
RESPONSE EXAMPLE [Requesting URL https://core.butlerbot.net/api/alfred/v3/chat?message=Hello+there%2C+what%27s+1%2B1&api_key=you...ere]
message {
  message: 'Good',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day,',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day, Hend',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day, Hendrik',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day, Hendrik.',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day, Hendrik. The',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day, Hendrik. The sum',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day, Hendrik. The sum of',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day, Hendrik. The sum of ',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day, Hendrik. The sum of 1',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day, Hendrik. The sum of 1 and',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day, Hendrik. The sum of 1 and ',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day, Hendrik. The sum of 1 and 1',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day, Hendrik. The sum of 1 and 1 is',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day, Hendrik. The sum of 1 and 1 is ',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day, Hendrik. The sum of 1 and 1 is 2',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day, Hendrik. The sum of 1 and 1 is 2.',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: false
}
message {
  message: 'Good day, Hendrik. The sum of 1 and 1 is 2.',
  messageId: 'msg-6XVNlz43zm7Nw2WGGzCqJTHE',
  completed: true
}
response_status { completed: true }
*/
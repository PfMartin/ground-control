# Frontend chat integration guide

This guide describes the browser-facing contract implemented by this repository, using the server's `pi-rpc-v1` WebSocket protocol and Pi 1.5.0. It is intended for the team implementing the frontend chat application.

## 1. What the frontend is connecting to

- One authenticated WebSocket connection owns one fresh, in-memory Pi session. Messages and events are scoped to that connection.
- The frontend sends **one JSON object per WebSocket text message**. Each received WebSocket text message is one JSON object. The server handles Pi's internal JSONL framing; the browser must not add or split on newlines.
- Ordinary commands are allowed only after `server_ready`. A WebSocket `open` event alone does **not** mean Pi is ready. Extension UI requests can arrive before readiness and must still be handled.
- Disconnecting destroys the Pi session. A new connection creates a new session; neither `connectionId` nor Pi's `sessionId` can be used to resume it through this server. Preserve any local transcript separately and make clear that the new agent no longer has the old context. Do not silently replay prompts: they may have invoked tools or made changes.
- The server is for trusted users of a **shared workspace**. The configured Pi tools and extensions can execute code and access the workspace, network, and server environment. Anyone holding the shared bearer token has those capabilities. This is not a multi-tenant isolation boundary.

The server's command allowlist is narrower than Pi's full RPC API. Do not implement unsupported Pi commands just because they appear in upstream Pi documentation.

## 2. Deployment prerequisites

The frontend needs:

1. The server's HTTP(S) origin, such as `https://pi.example.com`, and an authorized bearer token supplied securely at runtime.
2. The exact browser page origin, including scheme and non-default port, configured in the server's comma-separated `ALLOWED_ORIGINS`. An empty list disables browser ticket access. The browser supplies `Origin` automatically; JavaScript cannot set it manually.
3. HTTPS for the ticket exchange and WSS for the socket in deployed environments. The server itself speaks HTTP/WS; terminate TLS at a trusted proxy. Configure the proxy to forward both `POST /auth/ws-ticket` and WebSocket upgrades, preserve `Origin`, and avoid logging ticket-bearing query strings or Authorization headers. If a proxy uses a path prefix, adapt the URLs below and configure its rewrite rules.
4. A single server instance or sticky routing between ticket exchange and WebSocket upgrade. Tickets are stored only in the issuing server process.

The bearer token is a shared server secret, not an ordinary per-user access token. Do not bake it into a public frontend bundle, commit it, put it in a URL, or write it to logs or analytics. A browser cannot keep a shared secret from its user or from successful XSS; only provide it to trusted users through an approved runtime mechanism. If that is unacceptable, an independently authenticated backend/proxy is needed; the server does not currently provide per-user browser authentication.

## 3. Connect from a browser

Native browser `WebSocket` cannot set an `Authorization` header. Use a single-use ticket instead:

1. Send an **empty** `POST /auth/ws-ticket` with `Authorization: Bearer <AUTH_TOKEN>`. Do not send a JSON body or `Content-Type` header. A cross-origin browser request uses the server's CORS preflight support for `Authorization`.
2. On HTTP 200, read `{ "ticket": "...", "expiresIn": 30 }`. The response has `Cache-Control: no-store`.
3. Immediately connect to `wss://<server>/?ticket=<URL-encoded-ticket>` using subprotocol **`pi-rpc-v1`**. For local HTTP development, use `ws://` instead.
4. Install message and close handlers immediately, including the extension UI handler. Wait for `{ "type": "server_ready", "protocolVersion": 1, "connectionId": "..." }` before ordinary commands.
5. For every new connection or retry, request a **new** ticket. Tickets expire after 30 seconds, are origin-bound and single-use. A failed presentation can consume the ticket, including when a different allowed origin presents it; discard it after any attempt. The server caps outstanding tickets at 1,000 per process. Do not send both a ticket and an Authorization header on the same upgrade.

The ticket endpoint returns 401 for a bad bearer token, 403 for a missing/disallowed origin, 400 for a request body, and 503 when shutting down or at ticket capacity. A failed CORS preflight or a 403 without CORS headers may appear to `fetch` only as a generic network error. The WebSocket handshake can reject with HTTP 400, 401, 403, 426, or 503, but browser WebSocket APIs generally do **not** expose the handshake status or response body. Show a generic connection error and use server/proxy diagnostics rather than assuming a specific HTTP status.

### Minimal browser transport in TypeScript

This example is framework-independent. It exposes raw frames to the application, does not automatically retry, and deliberately does not pretend that uncorrelated `server_error` frames are command responses. The UI should keep its own connection, transcript, dialog, and pending-request state as described below.

```ts
type Frame = Record<string, unknown> & { type: string };

type Command =
  | { type: "prompt"; message: string; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string }
  | { type: "follow_up"; message: string }
  | { type: "abort" }
  | { type: "get_state" }
  | { type: "new_session" };

type DialogReply =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

type Options = {
  serverOrigin: string; // e.g. https://pi.example.com; endpoints below are at /
  token: string;        // supplied securely at runtime, never a URL parameter
  maxMessageBytes?: number; // must match deployment; default server limit below
  onFrame: (frame: Frame, reply: (value: DialogReply) => void) => void;
  onClose: (event: CloseEvent) => void;
  onError: (message: string) => void;
};

export async function connectPiChat(options: Options) {
  const base = new URL(options.serverOrigin);
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new Error("serverOrigin must use HTTP or HTTPS");
  }

  const ticketResponse = await fetch(new URL("/auth/ws-ticket", base), {
    method: "POST",
    headers: { Authorization: `Bearer ${options.token}` },
    cache: "no-store",
    credentials: "omit",
  });
  if (!ticketResponse.ok) {
    throw new Error(`Ticket request failed (HTTP ${ticketResponse.status})`);
  }
  const body: unknown = await ticketResponse.json();
  if (!body || typeof body !== "object" || !("ticket" in body) || typeof body.ticket !== "string") {
    throw new Error("Invalid ticket response");
  }

  const wsUrl = new URL("/", base);
  wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("ticket", body.ticket);
  const socket = new WebSocket(wsUrl, "pi-rpc-v1");
  let ready = false;
  const maxBytes = options.maxMessageBytes ?? 131072;

  function sendRaw(value: Command | (Command & { id: string }) | DialogReply) {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not open");
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("Command exceeds the configured WebSocket message limit");
    }
    socket.send(text);
  }

  // Dialog responses are the only messages allowed before server_ready.
  const replyToDialog = (reply: DialogReply) => sendRaw(reply);

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      options.onError("Unexpected non-text server frame");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      options.onError("Invalid JSON from server");
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !("type" in value) || typeof value.type !== "string") {
      options.onError("Invalid server frame");
      return;
    }
    const frame = value as Frame;
    if (frame.type === "server_ready") {
      if (frame.protocolVersion !== 1) {
        options.onError("Unsupported server protocol version");
        socket.close(4002, "Unsupported protocol");
        return;
      }
      ready = true;
    }
    options.onFrame(frame, replyToDialog);
  });
  socket.addEventListener("error", () => options.onError("WebSocket connection error"));
  socket.addEventListener("close", (event) => {
    ready = false;
    options.onClose(event);
  });

  return {
    isReady: () => ready && socket.readyState === WebSocket.OPEN,
    send(command: Command): string {
      if (!ready) throw new Error("Pi session is not ready");
      if ("message" in command && (command.message.length < 1 || command.message.length > 131072)) {
        throw new Error("Message length is outside the server's allowed range");
      }
      const id = crypto.randomUUID();
      sendRaw({ ...command, id });
      return id; // match a later response.id; events normally have no command id
    },
    replyToDialog,
    close() {
      ready = false;
      socket.close(1000, "Client disconnect");
    },
  };
}
```

Attach UI state handling in `onFrame` **before** sending anything. `connectPiChat()` returns after creating the socket, not after `server_ready`; use `isReady()` or the received frame to enable normal controls. Use the `reply` callback in `onFrame` for a startup dialog, even before the returned client is ready. `crypto.randomUUID()` requires a secure browser context; supply another unique nonempty ID generator if the application's environment lacks it.

## 4. Commands and responses

The server strictly validates keys: do not include extra properties, even if an upstream Pi version supports them. Optional command IDs are strings of 1–128 characters; generate a unique ID per outstanding command. Message strings must be nonempty and at most 131,072 JavaScript UTF-16 code units. The whole serialized UTF-8 WebSocket message must also fit `MAX_MESSAGE_BYTES` (default **131,072 bytes**, deployment-configurable), including JSON syntax, escaping, and the ID. Use `TextEncoder`, not `string.length`, to count wire bytes.

| Command | Example | Behavior |
|---|---|---|
| `prompt` | `{"type":"prompt","id":"p1","message":"Hello"}` | Submit text. During an active run, specify `streamingBehavior: "steer"` or `"followUp"` if deliberately queuing; otherwise Pi can reject it. |
| `steer` | `{"type":"steer","id":"s1","message":"Focus on tests"}` | Queue an instruction to steer the running agent. |
| `follow_up` | `{"type":"follow_up","id":"f1","message":"Then summarize"}` | Queue a message for after current work. |
| `abort` | `{"type":"abort","id":"a1"}` | Request cancellation of the current operation. |
| `get_state` | `{"type":"get_state","id":"g1"}` | Fetch Pi state such as `isStreaming`, `isCompacting`, `sessionId`, and optionally `model`. |
| `new_session` | `{"type":"new_session","id":"n1"}` | Request a fresh session within the current connection. |

Images, file attachments, client-supplied workspace/session paths, `new_session.parentSession`, model changes, direct `bash`, `get_messages`, `clear_queue`, and other Pi commands are **not accepted**. Disable UI features that depend on them; a pathname typed into normal prompt text is not a server-selected workspace and is subject to Pi's configured tools and permissions.

For supported commands, Pi replies asynchronously, normally with the same `id`:

```json
{"type":"response","command":"prompt","id":"p1","success":true,"data":{"disposition":"started"}}
{"type":"response","command":"get_state","id":"g1","success":false,"error":"Example error"}
```

Correlate by `id`, not arrival order. Events generally **do not** carry the command ID; do not assume there is a one-to-one mapping between a prompt and a single event or assistant message. Maintain pending commands with a client-side timeout and clear them on disconnect. A timeout is an *unknown outcome*, not proof that Pi did not execute the command.

For `prompt`, successful `data.disposition` can be:

- `started`: the prompt was accepted to start a run; continue listening for events and `agent_settled`.
- `queued`: the message was queued for an active run; acceptance is not execution or completion.
- `handled`: an extension or input handler consumed the prompt. It may not start a run, so do not wait indefinitely for a new `agent_settled`. It can still trigger independent extension work.

For `new_session`, wait for a successful response with `data.cancelled === false` before clearing or archiving the current transcript. An extension may prompt the user and return `cancelled: true`, leaving the current session in place. A failed response also does not confirm a new session.

`abort` stops the current operation, but Pi may continue messages already queued by `steer` or `follow_up`. This server does not expose `clear_queue`. A simple chat UI can avoid surprising behavior by disabling queuing and allowing one normal prompt at a time; if it implements queuing, display that limitation clearly. `get_state` is useful for inspection but is not a replacement for listening to lifecycle events.

### Server-generated errors are not correlated

Invalid JSON, extra keys, disallowed commands, premature ordinary commands, and invalid dialog responses produce:

```json
{"type":"server_error","code":"INVALID_COMMAND"}
```

This frame has **no command ID** and does not say which of several outstanding commands caused it. Display a generic protocol error; do not attach it to an arbitrary request. Use client-side validation, timeouts, and conservative single-flight submission where precise error attribution matters. Other server errors are `PI_UNAVAILABLE`, `TOOL_TIMEOUT`, and `IDLE_TIMEOUT`, normally followed by connection closure. Frames may be lost when a connection fails.

## 5. Render a streamed chat turn

A typical successful exchange is shown below. These are illustrative subsets: actual Pi frames can contain additional fields, and the frontend must tolerate unknown frame types and fields.

```text
server -> {"type":"server_ready","protocolVersion":1,"connectionId":"..."}
client -> {"type":"prompt","id":"p1","message":"Hello"}
server -> {"type":"response","command":"prompt","id":"p1","success":true,"data":{"disposition":"started"}}
server -> {"type":"agent_start"}
server -> {"type":"message_start","message":{"role":"assistant","content":[]}}
server -> {"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
server -> {"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello"}}
server -> {"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}],"stopReason":"stop"}}
server -> {"type":"agent_end","willRetry":false}
server -> {"type":"agent_settled","aborted":false}
```

Do not depend on the exact ordering of the command response relative to streaming events. Subscribe before sending the prompt.

Recommended reducer behavior:

1. Track connection state separately from run state. On `agent_start`, show activity; on `agent_end`, do **not** conclude the session is idle, because retries, compaction, steering, or follow-ups may continue. On `agent_settled`, mark the session idle and inspect `aborted`.
2. On `message_start` with `message.role === "assistant"`, start a new assistant message. A run can contain multiple assistant messages and tool calls. Handle user and tool-result messages separately; user `content` may be a string or content-block array. If the UI displays an optimistic user message, reconcile or suppress Pi's corresponding user event to avoid duplicates. There is no guaranteed command ID on that event, and extensions can transform or consume prompts, so a simple one-prompt-at-a-time UI is easiest to reconcile.
3. For `message_update.assistantMessageEvent.type === "text_delta"`, append `delta` to the current assistant message's text block identified by `contentIndex`. Updates are deltas, **not** cumulative snapshots. On `text_end`, replace that block with its authoritative `content` rather than appending it again.
4. On `message_end`, replace the partial assistant message with the authoritative `message`. Its `content` may contain `text`, `thinking`, and `toolCall` blocks; not every block is display text. A terminal `stopReason` of `error` or `aborted` and an optional `errorMessage` must be shown as an error or cancellation, even if the earlier prompt response succeeded. `agent_settled` alone does not mean the provider succeeded.
5. The server forwards thinking deltas and blocks unchanged. Only render or persist them if the product explicitly permits it; signatures and provider metadata are opaque. Treat all model output, extension text, tool arguments, and tool results as untrusted: sanitize rendered Markdown/HTML and avoid putting sensitive content into logs or analytics.

### Tool activity and other events

- Correlate `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` by `toolCallId`. They can include `toolName`, `args`, `partialResult`, `result`, `isError`, and `durationMs`. Tool outputs can be large or sensitive; show them only according to the product's policy. A `partialResult` is not universally an append-only delta.
- `queue_update` contains the current `steering` and `followUp` queues. `compaction_start`/`compaction_end`, `auto_retry_start`/`auto_retry_end`, and other retry events can explain why a run continues. `extension_error` reports an extension failure. Render appropriate status if useful, but tolerate unfamiliar events.
- `message_update.usage` may contain the latest cumulative usage; it can remain zero until completion. Do not add cumulative values together on every delta.

## 6. Extension dialogs

An approved extension can send `extension_ui_request` before or after readiness. Track dialogs by their server-provided `id`. Display at most one response for each pending dialog; never automatically approve a potentially dangerous action. A dialog can include a positive `timeout` in milliseconds. Pi can resolve it automatically and the server expires the pending ID; dismiss the UI when it times out and do not send a late response. Network delay means a response near the deadline may still be rejected.

| Request `method` | UI | Valid response, preserving the request ID |
|---|---|---|
| `select` | Choose one string from `options` | `{"type":"extension_ui_response","id":"...","value":"Allow"}`; the value must match an offered option. |
| `confirm` | Yes/no confirmation | `{"type":"extension_ui_response","id":"...","confirmed":true}` or `false`. |
| `input` | Single-line text, optionally using `placeholder` | `{"type":"extension_ui_response","id":"...","value":"text"}`. |
| `editor` | Multiline text, optionally initialized from `prefill` | `{"type":"extension_ui_response","id":"...","value":"text"}`. |
| Any dialog | User cancels | `{"type":"extension_ui_response","id":"...","cancelled":true}`. |

Send **exactly one** of `value`, `confirmed`, or `cancelled: true` and no extra fields. The ID is mandatory and must match a pending request on this connection. A `value` is limited to 131,072 JavaScript UTF-16 code units, and the complete response is subject to the same configurable UTF-8 message-size limit as commands. A dialog response does not produce a normal Pi `response`; duplicate, unknown, mismatched, or expired replies produce an uncorrelated `INVALID_COMMAND` error. A dialog may wait indefinitely if the extension supplies no timeout, so provide a cancel control.

Other UI methods are one-way: `notify`, `setStatus`, `setWidget`, `setTitle`, and `set_editor_text` require no response. They can be displayed or ignored according to product policy; for example, do not overwrite a user's unsent draft without an appropriate UX. Terminal-only Pi extension UI features are not supported over RPC.

## 7. Disconnects, recovery, and limits

On any close, disable sending, resolve or fail pending requests as **outcome unknown**, dismiss pending extension dialogs, and mark the active run interrupted unless it had already settled. The client should keep any visible transcript clearly labeled as historical. Reconnect only by obtaining a new ticket, and tell the user that it creates a fresh session. Use bounded exponential backoff with jitter if implementing automatic reconnect; stop retrying on explicit user disconnect or persistent configuration/authentication errors. Do not automatically replay a command that might have executed.

Useful close codes include:

| Code | Typical meaning |
|---|---|
| `1000` | Normal close or clean Pi exit; still ends the session. |
| `1001` | Server shutdown or idle timeout. |
| `1003` | Client sent a binary frame. |
| `1009` | Inbound message exceeded the configured limit. |
| `1011` | Pi startup/process/protocol failure or tool timeout. |
| `1013` | Client was too slow to consume output. |
| `1006` | Browser-observed abnormal closure; not a code the server sends. |

Codes and preceding `server_error` frames are not guaranteed to reach the browser. The default idle timeout is 15 minutes while no agent run is active, and the default per-tool timeout is 10 minutes; operators can change both. The server has connection, message-size, and output-buffer limits. Do not assume a ping, client-side timer, or retained transcript keeps the Pi session alive.

## 8. Frontend acceptance checklist

- [ ] Obtain a ticket with an empty authorized POST; connect with the correct origin, `pi-rpc-v1`, and a fresh ticket on each connection. Handle CORS and opaque WebSocket handshake failures.
- [ ] Keep ordinary input disabled until `server_ready`; still display and answer extension dialogs received during startup.
- [ ] Send only allowlisted command shapes, use unique IDs, count UTF-8 bytes, correlate responses, and handle uncorrelated server errors without blaming a random request.
- [ ] Render multiple assistant messages and content blocks from deltas; replace with final content, avoid duplicate user/tool entries, and surface provider errors and cancellation.
- [ ] Distinguish prompt acceptance, `agent_end`, and `agent_settled`; handle `handled`, retries, queued work, `new_session` cancellation, and extension UI timeouts.
- [ ] Handle 1000/1001/1003/1009/1011/1013 and abnormal closes; clear pending work, obtain a new ticket for reconnection, and never imply that the old agent session was resumed.
- [ ] Treat the bearer token, ticket, prompts, tool data, and model output as sensitive; sanitize rendered content and avoid logging secrets or ticket URLs.

For the implementation's authoritative details, see [`README.md`](./README.md), [`src/application/command-policy.ts`](./src/application/command-policy.ts), [`src/application/connection-handler.ts`](./src/application/connection-handler.ts), and [`src/adapters/transport/ws-transport.ts`](./src/adapters/transport/ws-transport.ts). After `npm ci`, the pinned Pi 1.5.0 references are available under `node_modules/@earendil-works/pi-coding-agent/docs/` (`rpc.md`, `rpc-commands.md`, `json.md`, `message-types.md`, and `rpc-extension-ui.md`); remember that this server exposes only the subset listed above.

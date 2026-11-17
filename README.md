# Ground Control

A minimal browser chat client for the **pi-rpc-v1** WebSocket server described in [FRONTEND_INTEGRATION.md](./FRONTEND_INTEGRATION.md). It supports streamed Markdown, backend selection, local transcript history, tool status, and Pi extension dialogs.

## Run the local demonstration

Requires Node.js 22.12+ on the Node 22 line, Node 24, or Node 26+.

```sh
npm install
npm run example                                      # terminal 1
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort  # terminal 2
```

Open `http://127.0.0.1:5173`, select **Local example**, click **Connect**, and enter the demo-only token `local-example-token`. The example server listens on `http://127.0.0.1:8787` and allows exactly that browser origin. It streams deterministic replies; it does **not** call an AI model and is **not** production infrastructure. Send `/demo-dialog` to try an extension confirmation dialog.

```sh
npm test       # unit, UI, and example-backend integration tests
npm run build  # type-check and create production build in dist/
```

## Connect to a real server

Add a named backend using its HTTP(S) base URL, e.g. `https://pi.example.com/`. Enter its shared bearer token when connecting. The app exchanges it for a short-lived single-use WebSocket ticket, then waits for `server_ready` before allowing prompts. Every connection or retry obtains a new ticket; there is no automatic reconnect or replay.

The server must allow the browser's **exact page origin**, including scheme and port, in `ALLOWED_ORIGINS`. Deployed configurations should use HTTPS and WSS via a trusted proxy. For a proxy prefix such as `https://example.com/pi/`, the app POSTs to `/pi/auth/ws-ticket` and upgrades `/pi/?ticket=...`; configure the proxy to rewrite those paths to the server's `/auth/ws-ticket` and `/`, preserve `Origin`, and forward WebSocket upgrades. Ticket issuance and upgrade must reach the same server instance, or use sticky routing. Prevent proxy logs or tracing from recording Authorization headers or ticket-bearing URLs. HTTP to non-loopback hosts requires explicit confirmation because it exposes the bearer token.

The default per-backend WebSocket message limit is 131,072 bytes. If the server's `MAX_MESSAGE_BYTES` differs, edit the backend to match. The whole UTF-8 JSON frame, not just prompt text, must fit; messages and dialog values also have the server's 131,072 UTF-16 code-unit limit.

## Sessions and interaction

- Earth & Linen is the default light theme. Use the theme switch in the header to choose the original SSP dark theme; the choice is stored locally in your browser.
- One connection owns one fresh in-memory Pi session. Disconnecting, switching backends, reloading, or a server timeout destroys it. Retained local transcripts are labeled historical; a new agent does not see them. Prompts are never replayed automatically.
- Send with Enter and insert a newline with Shift+Enter. One prompt is allowed at a time; the UI waits for `agent_settled`, not merely a prompt response or `agent_end`. A timed-out command has an **unknown outcome** and is never automatically resent. Wait for a late response or disconnect to start a fresh session.
- **Stop** requests `abort`; it does not imply immediate completion. **New session** asks Pi to reset and clears prior local history only after Pi confirms success; an extension can cancel that request. When disconnected, **Clear history** only removes the local historical transcript.
- Extension `select`, `confirm`, `input`, and `editor` dialogs can appear even before readiness. They require a deliberate user response or cancellation and may expire. Tool names and status are displayed transiently; arguments, results, thinking blocks, and provider metadata are not displayed or stored. Steering, follow-ups, attachments, model selection, and client-specified workspaces are not supported.

## Security and privacy

The bearer token is a **shared server secret**, not a per-user credential. It grants trusted users access to Pi's configured tools and shared workspace, potentially including code execution and access to server files, environment, and network. Do not expose the server to untrusted users. The app keeps entered tokens only in memory until reload and does not store them in URLs or browser storage, but a browser cannot hide a shared secret from its user or from successful XSS. Use an independently authenticated proxy if that is unacceptable.

Endpoint settings and transcript text, including partial responses and provider errors, are stored unencrypted in browser local storage for this app's origin. Anyone with access to the browser profile can read them. Multiple tabs are not synchronized and can overwrite one another's changes. Storage failures are shown in the UI. Older provisional-protocol endpoint and transcript data is migrated; legacy non-root URLs or URLs that had query strings must be reviewed before connecting, and old query strings are discarded.

Raw HTML is not rendered in Markdown and unsafe link schemes are filtered. Markdown images can still request remote URLs and disclose network information to image hosts. The application does not display or persist tool arguments, tool results, or thinking data, although the backend sends such events to the browser.

For exact message and extension dialog contracts, browser ticket requirements, and backend operational guidance, see [FRONTEND_INTEGRATION.md](./FRONTEND_INTEGRATION.md).

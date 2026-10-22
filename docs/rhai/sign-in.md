# ChatGPT connection on a VPS

LittleSpaces uses one connection method: **device-code sign-in through Codex app-server**. In Settings, ChatGPT is always the first card. Choose **Continue with ChatGPT**, open the displayed OpenAI link, and enter the one-time code. Complete approval there and return to LittleSpaces; Settings polls for completion. No localhost callback, SSH tunnel, copied callback URL, or manual token import is required.

If OpenAI requires it, enable device-code authentication in ChatGPT Settings → Security (or ask the workspace administrator). Codes expire after ten minutes. Cancel or retry from the card. Starting again cancels the previous attempt. A pending authorization is bound to the originating owner session; expiry or revocation prevents completion through LittleSpaces. Guests cannot start, inspect, cancel, or disconnect the connection.

Codex CLI **0.163.0** is pinned in `runtime/package-lock.json` and included in the production app image. It runs over private stdin/stdout, never a public app-server socket. Its own credential store is `/data/workspace/codex/auth.json`, inside the named workspace volume and an owner-only directory. These credentials are private files, not browser storage or applet secrets; protect workspace backups accordingly. Container replacement preserves them. Offline workspace backups include this file. A revoked or expired provider session may still need reconnecting.

The Rust host owns conversations, durable tool checkpoints, app authorization, cancellation and backend execution. It creates isolated ephemeral Codex turns with environment access disabled; only declared application tool requests return to the host dispatcher. Partial text, crashed streams and failed turns cannot become app actions. Complete dynamic-tool RPC requests are checkpointed before execution, and results are included in the next round's conversation history. Unexpected tools and approvals are rejected. Codex manages model transport and token renewal. Model listing is a catalog, not a guarantee of account entitlement; a completed request verifies that model's access.

Disconnect clears the local Codex connection; LittleSpaces does not claim provider-side revocation. Manage provider grants in ChatGPT if remote revocation is needed. Existing direct-SIWC connections from 0.1.0 require reconnecting once through the new code flow; their tokens are not imported or repurposed.

The maintained upstream app-server and dynamic-tool protocol contain experimental surfaces. Pinning, synthetic regressions and host qualification reduce deployment risk; they do not establish a guarantee of production reliability. Device authorization must be completed by the owner, and real inference/refresh must be checked with their account.

Official references: [headless device-code authentication](https://learn.chatgpt.com/docs/auth#login-on-headless-devices), [app-server account and dynamic-tool protocol](https://learn.chatgpt.com/docs/app-server).

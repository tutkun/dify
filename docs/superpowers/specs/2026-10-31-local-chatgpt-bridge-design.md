# Local ChatGPT bridge

The user authorized connecting local Docker Dify to their personal ChatGPT account without a Platform API key, including request parameter handling.

Use OpenAI SIWC local SDK pinned at 0a36fefeb913055c8c7a1a29b63d82b96b2e841a. Run the SDK on macOS so credentials can be encrypted with a key held in Keychain and the OAuth callback can bind to the host loopback. Dify calls a bearer-protected HTTP listener at host.docker.internal:8099/v1. No account tokens cross into Dify.

Alternatives: a Dify provider plugin requires a separate authentication runtime anyway; a container would need a separate OS credential broker and callback forwarder. Choose the native local service for this personal Mac deployment.

Provide CLI setup/start/status/login/models/verify/disconnect/stop/config commands. Store runtime dependencies, encrypted SDK state, local bearer key and logs under ignored .runtime/. No credentials in source, browser storage or logs. Use the unmodified official SDK for PKCE, identity verification, token rotation, locks, reauthorization and revocation. Account login and consent remain user-operated.

Adapt text Chat Completions and Responses requests into SDK text messages; map system guidance to developer instructions, force upstream store=false and stream=true via SDK, omit unsupported generation parameters. Convert SSE into either streaming or completed downstream responses. Require upstream response.completed, propagate cancellation and sanitized errors; never finish a truncated stream as success. Reject unsupported tools, media and structured output rather than silently dropping them. Enforce bounded request/response sizes and HTTP timeouts. Discover models from the connected account; do not invent model aliases.

This is a personal local text-generation bridge, not a hosted multi-user provider. The SDK dependency has its own noncommercial license and remains unvendored. Provide reproducible dependency installation, regression tests and Dify field instructions. Do not modify Dify account data or obtain user passwords.

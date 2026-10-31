# Local ChatGPT account for Docker Dify (macOS)

This personal local bridge connects Docker Dify to your ChatGPT account without an OpenAI Platform API key. It runs on macOS so the official OpenAI Sign in with ChatGPT SDK can use a host loopback callback and a Keychain-backed encryption key. Docker reaches it at `host.docker.internal:8099` (verified with this Colima deployment). The HTTP listener binds to `127.0.0.1`; it is not a LAN service.

Requires macOS, Node.js >=22.12, Python >=3.12, and an eligible ChatGPT plan. Your account must grant **ChatGPT plan usage**, not just identity sign-in. Model availability and limits come from your account. The separately installed official SDK has a **noncommercial license**; its source and license remain in `.runtime/sdk/`. This setup targets personal local use.

From the Dify repository root:

```sh
python3 docker/chatgpt-bridge/setup.py
node docker/chatgpt-bridge/manage.mjs start
node docker/chatgpt-bridge/manage.mjs login
```

Complete the official OpenAI browser login and approve plan usage. If your browser is already signed in, select that same account. This creates a separate authorized connection; it does not copy browser cookies or Codex credentials. For a saved connection that lacks plan permission, run `login --enable-plan`. For another account, run `login --new-account`.

```sh
node docker/chatgpt-bridge/manage.mjs status
node docker/chatgpt-bridge/manage.mjs models
node docker/chatgpt-bridge/manage.mjs verify
node docker/chatgpt-bridge/manage.mjs config
python3 docker/chatgpt-bridge/configure_dify.py
```

`verify` makes one small real request using your ChatGPT plan. `config` intentionally prints the **local bridge key**, which is not an OpenAI API key or OAuth token. Keep that key private; it authorizes requests against your connected account through this local service.

`configure_dify.py` uses the running local API container's provider service to save a credential named **Local ChatGPT**, activate it, select the discovered model as the workspace default LLM, and verify a real invocation through Dify's plugin runtime. It preserves other saved credentials and updates its own named entry on reruns. This is an administrator operation for the local Docker deployment; no console password is extracted or requested. It refuses to guess when there are multiple workspaces; pass `--workspace UUID`. Use `--model SLUG` to select a particular account model.

For manual setup in the installed **OpenAI** provider under **Settings → Model Providers**:

1. Add a credential named **Local ChatGPT** with API Base URL `http://host.docker.internal:8099/v1` and the local API key printed by `config`.
2. Set **Validate Model** to an exact model slug printed by `models`. The default validation model may be unavailable to ChatGPT accounts.
3. Select **Chat Completions** as API Protocol, and leave request metadata disabled.
4. Save, activate this credential, and select an available account model for your chatflow. The provider's advertised API models and capabilities may exceed your ChatGPT account/bridge access: use text generation only, without tools, vision, structured output or Pro reasoning controls.

This was verified against the installed official OpenAI plugin 1.1.0. If another plugin version lacks **Validate Model** or **API Protocol**, use its custom-model credential form or the **OpenAI-API-compatible** provider with the exact available model. Model slugs and context sizes come from the selected model; the bridge does not invent aliases or context capacities.

## Behavior

Supported: `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`; text history; system guidance mapped to developer messages; streaming and nonstreaming downstream callers. Upstream always uses `store: false`, `stream: true`, the complete input history, and waits for `response.completed` through the official SDK. Tokens are refreshed and rotations serialized by that SDK.

Only model, normalized text history, and instructions are passed to the SDK. Generation settings such as temperature, top-p, token limits, penalties, metadata, and user identifiers are omitted. **Dify's token-limit slider does not enforce an upstream output cap on this route.** This follows the ChatGPT plan route's parameter restrictions. Usage counts are omitted because the SDK does not return them; Dify cannot use this bridge's output to calculate authoritative token usage or costs.

Tools/function calls, images/audio/files, structured output, stop sequences, multiple choices, background requests, and remote conversation state are rejected explicitly. Embeddings, speech, and image generation need a different provider. This is a text-generation bridge, not a full replacement for OpenAI's API.

All model routes require the local bearer key. Cross-origin browser calls are rejected. Requests are limited to 1 MiB, 8 concurrent operations, and a 240-second outer deadline (the SDK has its own 180-second inference deadline). A disconnected caller cancels its inference. Interrupted/failed streams never receive a successful completion marker. Prompt content and authorization URLs are not logged.

## Lifecycle and storage

```sh
node docker/chatgpt-bridge/manage.mjs stop
node docker/chatgpt-bridge/manage.mjs disconnect
```

`stop` stops the local bridge process. `disconnect` attempts remote session revocation and removes the selected account's local tokens, retaining its registration. You can also revoke access or set limits in [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).

`start` launches a background process that survives the terminal; run it again after a Mac restart. This setup does not install a login item or system daemon. Use `.runtime/bridge.log` for sanitized startup errors. Do not run multiple bridge instances against the same account state. The CLI and bridge may share the state; the SDK serializes storage and refreshes across processes.

`.runtime/` is ignored by Git and has owner-only permissions. It contains dependencies, an encrypted account store, the nonsecret host ID, a local bearer key, logs, and PID. The account encryption key lives in macOS Keychain under service `ai.dify.local-chatgpt-bridge`, account `local-credential-encryption`. Unlock Keychain if access fails. Do not delete this key while you still need the saved account data. Deleting/reinstalling the SDK does not reset the account state or local key.

If another Docker runtime cannot reach a host loopback listener, configure its supported host networking path before using the bridge. Do not replace the Dify base URL with container-local `localhost`.

## Verification

```sh
npm test --prefix docker/chatgpt-bridge
```

The suite uses synthetic account transport data and real local HTTP requests. It verifies the adapter and authenticated encryption without signing in or consuming plan usage. Browser consent, account eligibility, real inference, and the final Dify chat are separate checks.

References: [OpenAI integration guide](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt), [request restrictions](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [official SDK](https://github.com/openai/sign-in-with-chatgpt-devkit).

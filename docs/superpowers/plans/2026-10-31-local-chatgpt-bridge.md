# Local ChatGPT Bridge Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline.

**Goal:** Connect local Docker Dify to a local ChatGPT account without a Platform API key.
**Architecture:** A native Node service delegates OAuth and inference to the pinned official SIWC SDK; macOS Keychain protects the encryption key. Docker accesses its authenticated compatibility API through host.docker.internal.
**Tech Stack:** Node >=22.12, node:test, macOS security, Python setup helper.
**Spec:** docs/superpowers/specs/2026-10-31-local-chatgpt-bridge-design.md

## Global Constraints

- Never read or reuse browser cookies or Codex credentials.
- OAuth tokens stay in encrypted local SDK storage.
- Text generation only; reject unsupported semantic features.
- Do not change the default Compose environment or reset user data.

## Review Focus

- Reject malformed, unauthorized and oversized requests before inference.
- Preserve Unicode/chunk boundaries and detect interrupted upstream streams.
- Cancel inference on client disconnect without discarding token rotation.
- Persist a single Keychain identity across runtime restarts.
- Avoid leaking prompts, tokens or authorization URLs to logs.

### Task 1: HTTP adapter

Files: docker/chatgpt-bridge/adapter.mjs, server.mjs, test/bridge.test.mjs
Interface: createBridge({client, apiKey}) returns an HTTP server; client exposes official SDK methods listModels/getSession/streamResponse.
- [x] Write behavior tests for parameter omission, instructions, streaming/nonstreaming output, errors, auth, malformed payloads, model discovery and cancellation. Run node --test; observe RED.
- [x] Implement pure request normalization and the bearer-protected HTTP adapter. Run the standalone test suite; observe GREEN.

### Task 2: Runtime and account management

Files: runtime.mjs, manage.mjs, setup.py, package.json, README.md
Interface: createClient() loads the pinned SDK and Keychain encryption; manage.mjs implements setup/start/login/status/models/verify/disconnect/config/stop.
- [x] Write encryption round-trip/tamper tests with a synthetic key and runtime startup/error tests. Observe RED.
- [x] Implement native Keychain provisioning, encrypted runtime, pinned dependency preparation and lifecycle commands. Run the complete standalone suite.

### Task 3: Local deployment and review

- [x] Install and build the pinned official SDK with its lockfile, start the bridge, verify authentication and reachability from Dify containers.
- [x] Review with a fresh reviewer; fix material findings and rerun tests.
- [x] Launch browser OAuth through the login command for the user, then verify the granted model catalog and a small real inference if consent completes.
- [x] Report evidence and any remaining user-operated connection steps precisely.

## Execution ledger

Ruling: Work in the existing checkout on a feature branch so local Docker deployment paths remain valid; no extra worktree. The user explicitly authorized all necessary local setup.
Ruling: Use native macOS runtime rather than Docker for the bridge because the official SDK requires OS-backed encryption and a host loopback OAuth listener.

Task 1: HTTP normalization and compatibility API verified RED→GREEN with real local HTTP tests.
Task 2: Official SDK installed from checksum-verified pinned archive; Keychain encryption round-trip/tamper tests RED→GREEN; actual OAuth completed with plan sharing enabled.
Task 3: Docker API reached host loopback bridge; unauthenticated model access rejected with 401; account catalog fetched and real inference returned Connection works.
Final review: one Important slow-client exception issue reproduced RED, fixed GREEN; no Critical findings or deferred minors. Malformed array validation also verified RED→GREEN. Full standalone suite: 14/14 passing.
Ruling: Configure the already installed official OpenAI provider 1.1.0 using its Validate Model and Chat Completions controls instead of installing another plugin. This avoids extra dependencies; provider schema advertises capabilities beyond the text-only bridge, so those are explicitly documented as unsupported.
Ruling: Local administrator setup uses Dify public provider services inside its API container, selecting only the sole workspace or an explicit UUID. Writes do not bypass provider validation, and existing other named credentials are preserved.
Dify integration: Local ChatGPT credential activated; workspace default LLM set to gpt-6.1-sol. Dify model runtime returned Dify connection works.

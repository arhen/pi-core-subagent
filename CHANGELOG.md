# Changelog

## Unreleased

## 1.3.3

- `poll_agent_messages` dump capped at 4000 chars, multibyte-safe (was returned uncapped).
- `await_subagent` timeout resolves with a snapshot; the completion notice still fires on settle.
- `notifyPerTask` enforced background-only (blocking runs can't be woken mid-tool).
- Task input types derived from TypeBox schemas via `Static` (no hand-maintained mirror).
- `tools` allowlist exposed in single-mode `subagent` schema (was accepted but never sent).

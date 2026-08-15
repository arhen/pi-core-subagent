# minimalist-subagents

Minimalist pi extension: **fast in-process subagents** with single / parallel / chain modes, background runs, cancellation, intercom (child↔leader) and an agent↔agent mailbox.

Built for one job: delegate work to isolated subagents **without bloating the parent context**.

## Design principles

- **In-process** — children are `AgentSession`s in the same runtime. No process spawn, no context bleed.
- **Small parent footprint** — 6 slim tools, one-line agent catalog injected per request (cached), background completions notify with a 3-line summary (full output only on demand).
- **Throttled updates** — widget/stream updates coalesce to ~6/s; no per-event deep clones.
- **No silent hangs** — watchdog aborts children that produce no events for 90s; per-task timeout 10min.

## Install

```sh
pi install /path/to/minimalist-subagents
# or: npm publish && pi install npm:minimalist-subagents
```

> Conflicts with other extensions that register a `subagent` tool (e.g. `@gotgenes/pi-subagents`, `@narumitw/pi-subagents`). Run one at a time.

## Agents

Markdown files in `~/.pi/agent/agents/*.md` (user) or `.pi/agents/*.md` (project):

```markdown
---
name: reviewer
description: Reviews code for correctness and edge cases
tools: read,grep,find,ls
---
You are a thorough code reviewer. Be concise and specific.
```

`tools` defaults to read-only (`read, grep, find, ls`). Optional frontmatter: `model` (`provider/model-id`), `thinking`.

## Tools

| Tool | Purpose |
|---|---|
| `subagent` | single / `tasks` (parallel) / `chain` (`{previous}`); `background:true` fire-and-forget; `allowIntercom:true` enables child talk tools |
| `subagent_status` | live per-task snapshot (non-blocking) |
| `subagent_result` | full output of a run or one task |
| `await_subagent` | block until a run finishes (optional `timeoutMs`) |
| `reply_subagent` | answer a child's `ask_parent` question |
| `subagent_cancel` | abort a running/queued run |

### Child talk tools (when `allowIntercom: true`)

| Tool | Meaning |
|---|---|
| `ask_parent` | blocking question to the leader; parent answers via `reply_subagent` |
| `notify_parent` | one-way message to the leader |
| `update_progress` | phase hint for the widget |
| `send_agent_message` | message to a sibling subagent's mailbox (`to` = its task id, or `"leader"`) |
| `poll_agent_messages` | drain this subagent's mailbox |

## Context budget

- Parent tools: 6 schemas with short descriptions.
- Catalog: ~50-80 tokens/request, cached (15s TTL + dir-mtime), injected once per request.
- Background completion: 3-line notice. Full text only via `subagent_result`.
- Children: isolated sessions; talk tools injected only when `allowIntercom`.

## Development

```sh
bun install        # dev deps (typecheck/test only; runtime uses pi's bundled SDK)
npx tsc --noEmit
bun test           # pure-logic smoke tests (mailbox, failure classification, watchdog)
```

Runtime state: runs persist to `<parent-session>.subagents.json` sidecar; restored (non-terminal → aborted) on session start.

## License

MIT. Derived from `@ghoulm370/pi-subagent-ui` (MIT) — see LICENSE.

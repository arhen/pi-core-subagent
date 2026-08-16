/**
 * minimalist-subagents — pi extension.
 *
 * Fast in-process subagents (isolated AgentSessions, no process spawn).
 * Modes: single / parallel / chain. Background runs, cancel, intercom
 * (ask/notify/update the leader) and agent↔agent mailbox (send/poll).
 *
 * Context discipline: 6 slim parent tools, one-line catalog injected per
 * request (cached), background completions notify with a 3-line summary
 * instead of full outputs, and run updates are throttled (no per-event
 * deep clones).
 *
 * Layout: schemas → schemas.ts, scheduler/graph → graph.ts, rendering →
 * format.ts, run lifecycle → manager.ts, this file = entry + registrations.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	compactLines,
	formatUsage,
	makeSummary,
	statusIcon,
	taskLine,
	themedTaskLine,
	truncateText,
} from "./format.ts";
import { waveNotation } from "./graph.ts";
import { cloneRun, SubagentManager } from "./manager.ts";
import { createPeekPane, type PeekTask } from "./peek.ts";
import {
	AwaitParam,
	ReplyParam,
	ResultParam,
	RunIdParam,
	SubagentParams,
	type SubagentParamsShape,
} from "./schemas.ts";
import { type RunDetails, type RunSnapshot, TERMINAL } from "./types.ts";

export default function (pi: ExtensionAPI) {
	const manager = new SubagentManager(pi);

	/** Read-only peek: browse agents, enter to tail one. Never mutates run state. */
	const openPeek = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const getTasks = (): PeekTask[] =>
			manager
				.listRuns()
				.flatMap((run) => run.tasks)
				.map((task) => ({
					runId: task.runId,
					taskId: task.id,
					agent: task.agent,
					status: task.status,
					running: !TERMINAL.includes(task.status),
					sessionFile: task.sessionFile,
					line: taskLine(task),
				}));
		if (getTasks().length === 0) {
			ctx.ui.notify("No subagents in this session.", "info");
			return;
		}
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) =>
				createPeekPane(
					getTasks,
					theme,
					() => tui.requestRender(),
					() => done(undefined),
					(t) => {
						if (manager.cancelTask(t.runId, t.taskId, ctx)) ctx.ui.notify(`Aborted subagent ${t.agent}.`, "warning");
					},
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "70%", margin: 2 } },
		);
	};
	pi.registerCommand("subagents", {
		description: "List subagent runs. `/subagents peek` opens the browsable pane.",
		handler: async (args, ctx) => {
			if (
				String(args ?? "")
					.trim()
					.toLowerCase() === "peek"
			)
				return openPeek(ctx);
			const runs = manager.listRuns().slice(0, 10);
			if (runs.length === 0) {
				ctx.ui.notify("No subagent runs in this session.", "info");
				return;
			}
			ctx.ui.notify(runs.flatMap((run) => compactLines(run).concat("")).join("\n"), "info");
		},
	});
	// ctrl+shift+s belongs to pi-web-access (search curator); 'a' for agents is free.
	pi.registerShortcut("ctrl+shift+a", { description: "Peek at running subagents", handler: openPeek });

	pi.on("agent_start", (_event, ctx) => {
		if (!manager.turnActivity && !manager.hasActiveRun()) manager.clearWidget(ctx);
		manager.turnActivity = false;
	});

	pi.on("session_start", async (_event, ctx) => {
		await manager.restoreFromSidecar(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx?.hasUI) {
			try {
				ctx.ui.setWidget("subagents", [], { placement: "aboveEditor" });
			} catch {
				/* ignore */
			}
		}
		manager.clearRuns();
	});

	pi.registerTool<typeof SubagentParams, RunDetails>({
		name: "subagent",
		label: "Subagent",
		// ponytail: this string is billed on every request. One example — the graph one —
		// covers ids, needs, write and Verify; the simpler shapes are subsets of it.
		description:
			'Run isolated subagents (own context, own session). You invent each agent: name, optional system prompt, toolset (read-only default, write:true to edit). Use `agent`+`task` for one, `tasks` for many. `needs` declares dependency edges: a task waits for its needs and receives their outputs prepended to its prompt. background is the default (returns a runId immediately); set background:false when you need the result inline in this turn. allowIntercom:true lets children talk to you and each other.\n\nsubagent({ tasks: [{ id: "api", agent: "api-mapper", task: "Map API routes" }, { id: "db", agent: "db-mapper", task: "Map DB schema" }, { id: "doc", agent: "writer", needs: ["api", "db"], write: true, task: "Write ARCHITECTURE.md. Verify: test -s ARCHITECTURE.md" }] })',
		promptSnippet: "Define and delegate work to specialized subagents.",
		promptGuidelines: [
			"Use subagent when independent review, testing, research, or parallel analysis improves quality.",
			"Put every sub-task in ONE call: subagent({ tasks: [...] }). Never make multiple parallel subagent calls — one call, one run, N tasks.",
			"Order comes from `needs`, not from separate calls: give tasks an `id`, list the ids each depends on. Tasks with no unmet needs run in parallel; dependents receive their upstream outputs automatically — do not restate them.",
			"End each task with a runnable check, e.g. 'Verify: npx tsc --noEmit && bun test'. A subagent's claim of success is not evidence.",
			"Define each agent yourself: invented name, focused system prompt, and read-only (default) or write:true. Prefer read-only.",
			"Use background:true for long work; allowIntercom:true only when a child may need to ask you something.",
		],
		parameters: SubagentParams,
		executionMode: "parallel", // sibling subagent calls run concurrently, not serialized
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const typed = params as SubagentParamsShape;
			if (typed.background) {
				const details = manager.startInBackground(typed, ctx);
				return {
					content: [
						{
							type: "text",
							text: `Background run started: ${details.run.id} (${details.run.mode}, ${details.run.tasks.length} task${details.run.tasks.length > 1 ? "s" : ""}).\nUse subagent_status / subagent_result / await_subagent / reply_subagent / subagent_cancel to interact.`,
						},
					],
					details,
				};
			}
			const details = await manager.runBlocking(typed, signal, onUpdate, ctx);
			return { content: [{ type: "text", text: makeSummary(details.run) }], details };
		},
		renderCall(args, theme) {
			// ponytail: args stream in partially, so mode is unknowable until JSON closes. Show "preparing…" instead of a wrong "single ?".
			const hasEdges = args.tasks?.some((t) => t.needs?.length);
			const mode = args.chain?.length
				? `chain ${args.chain.length}`
				: args.tasks?.length
					? `${hasEdges ? "graph" : "parallel"} ${args.tasks.length}`
					: args.agent
						? `single ${args.agent}`
						: "preparing…";
			const flags = [args.background ? "background" : "", args.allowIntercom ? "can ask" : ""]
				.filter(Boolean)
				.join(", ");
			// Params used, dimmed: model, thinking, toolset, per-task write count.
			const tasks = args.tasks ?? args.chain ?? [];
			const writeCount = tasks.filter((t) => t.write).length;
			const parts: string[] = [];
			if (args.model) parts.push(args.model);
			if (args.thinking) parts.push(args.thinking);
			if (args.write) parts.push("can edit");
			if (writeCount > 0) parts.push(`${writeCount} can edit`);
			if (args.concurrency) parts.push(`${args.concurrency} at a time`);
			if (args.maxRuntimeMs) parts.push(`${Math.round(args.maxRuntimeMs / 60000)}m limit`);
			const params = parts.length > 0 ? `\n  ${theme.fg("dim", parts.join(" · "))}` : "";
			const notation = waveNotation(tasks);
			const graphLine = notation ? `\n  ${theme.fg("muted", notation)}` : "";
			// The plan the model actually wrote: ids, edges, toolset. Streams in as args arrive,
			// so a graph is visible before the first child spawns.
			const plan = tasks
				.filter((t) => t.agent || t.id)
				.map((t, i: number) => {
					const id = t.id ?? `task_${i + 1}`;
					const edge = t.needs?.length ? theme.fg("muted", ` ← ${t.needs.join(", ")}`) : "";
					const mark = t.write ? theme.fg("warning", " ✎") : "";
					// Plain clip, not truncateText — that one appends a multi-line session-file notice.
					const flat = String(t.task ?? "")
						.replace(/\s+/g, " ")
						.trim();
					const what = flat ? theme.fg("dim", ` ${flat.length > 64 ? `${flat.slice(0, 64)}…` : flat}`) : "";
					return `\n  ${theme.fg("muted", id)} ${theme.fg("accent", t.agent ?? "…")}${mark}${edge}${what}`;
				})
				.join("");
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", mode)}${flags ? ` ${theme.fg("muted", `[${flags}]`)}` : ""}${params}${graphLine}${plan}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const run = result.details?.run;
			if (!run) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
			// ponytail: mode/count already shown on the call line above; result header only adds progress + status.
			const header = `${statusIcon(run.status)} ${theme.fg("accent", `${run.tasks.filter((t) => t.status === "completed").length}/${run.tasks.length} done`)}${run.background ? ` ${theme.fg("muted", "(background)")}` : ""} ${theme.fg("muted", run.status)}`;
			if (!expanded) {
				const lines = [header, ...run.tasks.map((task) => `  ${themedTaskLine(task, theme)}`)];
				const usage = formatUsage(run.aggregateUsage);
				if (usage) lines.push(theme.fg("dim", usage));
				return new Text(lines.join("\n"), 0, 0);
			}
			const lines = [header];
			for (const task of run.tasks) {
				lines.push(
					`  ${statusIcon(task.status)} ${theme.fg("accent", task.agent)}${task.sessionId ? ` ${theme.fg("muted", task.sessionId)}` : ""}`,
				);
				if (task.error) lines.push(`    ${theme.fg("error", task.error)}`);
				else if (task.finalText) lines.push(`    ${truncateToWidth(theme.fg("dim", task.finalText.trim()), 120, "…")}`);
				const usage = formatUsage(task.usage);
				if (usage) lines.push(`    ${theme.fg("dim", usage)}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerTool<typeof RunIdParam, { run?: RunSnapshot }>({
		name: "subagent_status",
		label: "Subagent Status",
		description:
			"Live status of a subagent run (non-blocking): per-task state, plus each child's session file path (JSONL) so you can tail it from outside — e.g. in a terminal multiplexer pane.",
		promptSnippet: "Check progress of a subagent run.",
		parameters: RunIdParam,
		async execute(_id, params) {
			const { runId } = params as { runId: string };
			const run = manager.getRun(runId);
			if (!run) return { content: [{ type: "text", text: `Unknown runId: ${runId}` }], isError: true, details: {} };
			// Session file paths are the one primitive an outside tool needs: `tail -f` it in a
			// multiplexer pane, a log viewer, anything. Cheaper than owning a pane integration.
			const files = run.tasks.filter((t) => t.sessionFile).map((t) => `${t.id} (${t.agent}): ${t.sessionFile}`);
			const text = [
				compactLines(run).join("\n"),
				...(files.length > 0 ? ["", "Live session files (tail -f to watch):", ...files] : []),
			].join("\n");
			return { content: [{ type: "text", text }], details: { run: cloneRun(run) } };
		},
	});

	pi.registerTool<typeof ResultParam, { run?: RunSnapshot }>({
		name: "subagent_result",
		label: "Subagent Result",
		description: "Full result (finalText + usage) of a run or one task. Non-blocking.",
		parameters: ResultParam,
		async execute(_id, params) {
			const { runId, taskId } = params as { runId: string; taskId?: string };
			const run = manager.getRun(runId);
			if (!run) return { content: [{ type: "text", text: `Unknown runId: ${runId}` }], isError: true, details: {} };
			const tasks = taskId ? run.tasks.filter((t) => t.id === taskId) : run.tasks;
			const text = [
				`Run ${run.id} — ${run.status}`,
				...tasks.map(
					(t) =>
						`\n## ${t.agent} ${statusIcon(t.status)}\n${t.error ? `Error: ${t.error}` : t.finalText || "(no output yet)"}\n${formatUsage(t.usage)}`,
				),
			].join("\n");
			return { content: [{ type: "text", text: truncateText(text) }], details: { run: cloneRun(run) } };
		},
	});

	pi.registerTool<typeof AwaitParam, { run?: RunSnapshot }>({
		name: "await_subagent",
		label: "Await Subagent",
		description: "Block until a run finishes (or timeoutMs elapses). Use when you need the result before proceeding.",
		parameters: AwaitParam,
		async execute(_id, params) {
			const { runId, timeoutMs } = params as { runId: string; timeoutMs?: number };
			const run = await manager.awaitRun(runId, timeoutMs);
			if (!run) return { content: [{ type: "text", text: `Unknown runId: ${runId}` }], isError: true, details: {} };
			return { content: [{ type: "text", text: makeSummary(run) }], details: { run } };
		},
	});

	pi.registerTool<typeof ReplyParam, { run?: RunSnapshot }>({
		name: "reply_subagent",
		label: "Reply Subagent",
		description: "Answer a child's ask_parent question; resumes its run.",
		parameters: ReplyParam,
		async execute(_id, params) {
			const { runId, taskId, message } = params as { runId: string; taskId: string; message: string };
			const ok = manager.deliverReply(runId, taskId, message);
			if (!ok)
				return {
					content: [{ type: "text", text: `No pending question for ${runId}/${taskId}.` }],
					isError: true,
					details: {},
				};
			return {
				content: [{ type: "text", text: `Reply delivered to ${runId}/${taskId}. The child will resume.` }],
				details: {},
			};
		},
	});

	pi.registerTool<typeof RunIdParam, { aborted?: number }>({
		name: "subagent_cancel",
		label: "Subagent Cancel",
		description: "Abort a running/queued subagent run. Children are killed; run becomes aborted.",
		promptSnippet: "Cancel a subagent run.",
		parameters: RunIdParam,
		async execute(_id, params) {
			const { runId } = params as { runId: string };
			const { aborted } = manager.cancelRun(runId);
			if (aborted === 0 && !manager.getRun(runId))
				return { content: [{ type: "text", text: `Unknown runId: ${runId}` }], isError: true, details: {} };
			return {
				content: [{ type: "text", text: `Canceled ${aborted} task${aborted === 1 ? "" : "s"} in run ${runId}.` }],
				details: { aborted },
			};
		},
	});
}

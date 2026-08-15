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
 */

import type { AgentSessionEvent, ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	getMarkdownTheme,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { CHILD_TALK_TOOLS, createChildTools, createWatchdog, type ChildHandlers } from "./child.ts";
import { createMailbox, type Mailbox } from "./mailbox.ts";

const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 8;
const MAX_TASKS = 16;
const DEFAULT_RUNTIME_MS = 10 * 60 * 1000;
const DEFAULT_STALL_MS = 90_000;
const READONLY_TOOLS = ["read", "grep", "find", "ls"];
const WRITE_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const FINAL_OUTPUT_CAP = 24 * 1024;
const WIDGET_THROTTLE_MS = 150;

type RunMode = "single" | "parallel" | "chain";
type TaskStatus = "queued" | "starting" | "running" | "awaiting_parent" | "completed" | "failed" | "aborted";
type RunStatus = "queued" | "running" | "awaiting_parent" | "completed" | "failed" | "aborted";

const TERMINAL: TaskStatus[] = ["completed", "failed", "aborted"];

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface TaskInput {
	id?: string;
	/** Name the leader invents for this subagent (display + mailbox addressing). */
	agent: string;
	desc?: string;
	task: string;
	/** System prompt the leader writes for this agent. Optional — a minimal default is used. */
	prompt?: string;
	/** true = write toolset; false/omitted = read-only toolset. */
	write?: boolean;
	tools?: string[];
	model?: string;
	thinking?: string;
	maxRuntimeMs?: number;
}

interface TaskSnapshot {
	id: string;
	runId: string;
	agent: string;
	task: string;
	cwd: string;
	status: TaskStatus;
	agentSource?: string;
	sessionId?: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	startedAt?: number;
	endedAt?: number;
	currentTool?: { toolName: string };
	progressPhase?: string;
	intercomQuestion?: string;
	toolCalls: number;
	lastActivity?: string;
	usage: UsageStats;
	finalText?: string;
	error?: string;
}

interface RunSnapshot {
	id: string;
	mode: RunMode;
	status: RunStatus;
	background: boolean;
	allowIntercom: boolean;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	concurrency: number;
	/** True once the parent awaited this run — completion notices are redundant then. */
	awaited?: boolean;
	tasks: TaskSnapshot[];
	aggregateUsage: UsageStats;
}

interface RunDetails {
	run: RunSnapshot;
	background?: boolean;
}

interface PendingReply {
	resolve: (answer: string) => void;
}

// ── helpers ──────────────────────────────────────────────────────────────

function newId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}
function aggregateUsage(tasks: TaskSnapshot[]): UsageStats {
	const total = emptyUsage();
	for (const task of tasks) {
		total.input += task.usage.input;
		total.output += task.usage.output;
		total.cacheRead += task.usage.cacheRead;
		total.cacheWrite += task.usage.cacheWrite;
		total.cost += task.usage.cost;
		total.turns += task.usage.turns;
	}
	return total;
}
function truncateText(text: string, max = FINAL_OUTPUT_CAP): string {
	if (Buffer.byteLength(text, "utf8") <= max) return text;
	return `${text.slice(0, max)}\n\n[Output truncated. Full child session is available in the session file.]`;
}
function getFirstText(message: AssistantMessage): string {
	for (const part of message?.content ?? []) {
		if (part?.type === "text" && typeof part.text === "string") return part.text;
	}
	return "";
}
function getParentSessionFile(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionFile?.();
	} catch {
		return undefined;
	}
}
/**
 * pi 0.84 StopReason enum: "stop" is NORMAL completion (was "end" in older pi).
 * Only length/error/aborted/deferred/pending/toolUse-as-final are failures.
 */
export function classifyFailure(stopReason: string | undefined, errorMessage?: string): { status: "failed" | "aborted"; message: string } | undefined {
	if (!stopReason || stopReason === "stop" || stopReason === "end") return undefined;
	if (stopReason === "aborted") return { status: "aborted", message: errorMessage || "Subagent was aborted." };
	return { status: "failed", message: errorMessage || `Subagent ended with stopReason "${stopReason}".` };
}
function lastAssistantFailure(messages: AssistantMessage[] | undefined): { status: "failed" | "aborted"; message: string } | undefined {
	for (const message of [...(messages ?? [])].reverse()) {
		if (message?.role !== "assistant") continue;
		return classifyFailure(message.stopReason, message.errorMessage);
	}
	return undefined;
}
function failureError(failure: { status: "failed" | "aborted"; message: string }): Error {
	const error = new Error(failure.message);
	(error as Error & { subagentStatus?: string }).subagentStatus = failure.status;
	return error;
}
function updateUsageFromMessage(task: TaskSnapshot, message: AssistantMessage): void {
	if (message?.role !== "assistant") return;
	task.usage.turns += 1;
	const usage = message.usage;
	if (!usage) return;
	task.usage.input += usage.input ?? 0;
	task.usage.output += usage.output ?? 0;
	task.usage.cacheRead += usage.cacheRead ?? 0;
	task.usage.cacheWrite += usage.cacheWrite ?? 0;
	task.usage.cost += usage.cost?.total ?? 0;
	if (message.model && !task.model) task.model = message.model;
}
function fmtTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}
function formatUsage(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑ ${fmtTokens(usage.input)}`);
	if (usage.output) parts.push(`↓ ${fmtTokens(usage.output)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" · ");
}
function statusIcon(status: TaskStatus | RunStatus): string {
	if (status === "completed") return "✓";
	if (status === "failed") return "✗";
	if (status === "aborted") return "⏹";
	if (status === "awaiting_parent") return "❓";
	if (status === "queued") return "○";
	return "•";
}
function fmtDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "–";
	const s = Math.max(0, Math.round(ms / 1000));
	return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}
function taskTimer(task: TaskSnapshot): string {
	if (task.startedAt === undefined) return "–";
	const end = task.endedAt ?? Date.now();
	const running = !TERMINAL.includes(task.status);
	return `${running ? "running " : ""}${fmtDuration(end - task.startedAt)}`;
}
function taskStatsWithUsage(task: TaskSnapshot): string {
	const stats = `${task.toolCalls ?? 0} tools`;
	const usage = formatUsage(task.usage);
	return `${stats}${usage ? ` · ${usage}` : ""}`;
}
function taskLine(task: TaskSnapshot): string {
	return `${statusIcon(task.status)} ${task.agent} · ${taskStatsWithUsage(task)} · ${taskTimer(task)}`;
}
function argsSuffix(args: unknown): string {
	try {
		const s = JSON.stringify(args);
		if (!s || s === "{}") return "";
		return ` ${s.length > 60 ? `${s.slice(0, 60)}…` : s}`;
	} catch {
		return "";
	}
}
function activitySnippet(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}
/** Static compact lines (tool-result stream, subagent_status, /subagents). */
function compactLines(run: RunSnapshot): string[] {
	const lines: string[] = [];
	for (const task of run.tasks.slice(0, 8)) {
		lines.push(taskLine(task));
	}
	if (run.tasks.length > 8) lines.push(`… +${run.tasks.length - 8} more`);
	return lines;
}
/**
 * Above-editor widget, todo-tree style:
 *   ● Subagents (0/1)
 *   ├─ • code-sleuth · 4 tools · 12s
 *   │    → read src/auth.ts
 *   └─ ✓ reviewer · 6 tools · 44s
 * Static icons (no animation); latest activity + tool count + runtime per agent.
 */
class SubagentsWidget implements Component {
	constructor(
		private readonly getRun: () => RunSnapshot | undefined,
		private readonly theme: Theme,
	) {}

	invalidate(): void {
		// no cached strings; render() reads live state
	}

	render(width: number): string[] {
		const run = this.getRun();
		if (!run || run.tasks.length === 0) return [];
		const done = run.tasks.filter((t) => TERMINAL.includes(t.status)).length;
		const active = !TERMINAL.includes(run.status);
		const head = active ? "accent" : "dim";
		const lines = [truncateToWidth(`${this.theme.fg(head, active ? "●" : "○")} ${this.theme.fg(head, `Subagents (${done}/${run.tasks.length})`)}`, width, "…")];
		const visible = run.tasks.slice(0, 8);
		visible.forEach((task, i) => {
			const last = i === visible.length - 1 && run.tasks.length <= 8;
			const conn = this.theme.fg("dim", last ? "└─" : "├─");
			const activity =
				!TERMINAL.includes(task.status) && task.lastActivity
					? `${this.theme.fg("dim", `→ ${task.lastActivity}`)} · `
					: "";
			const line = `${statusIcon(task.status)} ${task.agent} · ${activity}${taskStatsWithUsage(task)} · ${taskTimer(task)}`;
			lines.push(truncateToWidth(`${conn} ${line}`, width, "…"));
		});
		if (run.tasks.length > 8) lines.push(`${this.theme.fg("dim", "└─")} ${this.theme.fg("dim", `+${run.tasks.length - 8} more`)}`);
		return lines;
	}
}
/** Blocking-call summary: full text, because the model asked for it. */
function makeSummary(run: RunSnapshot): string {
	const succeeded = run.tasks.filter((t) => t.status === "completed").length;
	const failed = run.tasks.filter((t) => t.status === "failed").length;
	const aborted = run.tasks.filter((t) => t.status === "aborted").length;
	const lines = [`Run ${run.id}: Subagents ${run.mode}${run.background ? " (background)" : ""} finished: ${succeeded}/${run.tasks.length} succeeded${failed ? `, ${failed} failed` : ""}${aborted ? `, ${aborted} aborted` : ""}.`];
	const usage = formatUsage(run.aggregateUsage);
	if (usage) lines.push(`Usage: ${usage}`);
	for (const task of run.tasks) {
		lines.push(`\n## ${task.agent} ${statusIcon(task.status)}${task.error ? `\nError: ${task.error}` : `\n${truncateText(task.finalText || "(no output)")}`}`);
	}
	return lines.join("\n");
}
/** Notification: 3 lines max. Full output stays out of parent context. */
function makeNotice(run: RunSnapshot, kind: string): string {
	const lines = [`Background subagent run ${run.id} ${kind}: ${run.tasks.filter((t) => t.status === "completed").length}/${run.tasks.length} succeeded.`];
	for (const task of run.tasks) {
		lines.push(`- ${task.agent}: ${task.status}${task.error ? ` — ${truncateText(task.error, 200)}` : ""}`);
	}
	lines.push(`Use subagent_result(runId: "${run.id}") for full output.`);
	return lines.join("\n");
}
function cloneRun(run: RunSnapshot): RunSnapshot {
	return JSON.parse(JSON.stringify(run)) as RunSnapshot;
}
function parseModelRef(ref: string | undefined): { provider: string; modelId: string } | undefined {
	if (!ref) return undefined;
	const index = ref.indexOf("/");
	if (index <= 0 || index === ref.length - 1) return undefined;
	return { provider: ref.slice(0, index), modelId: ref.slice(index + 1) };
}

// Cached catalog removed: agents are defined inline by the leader per call,
// so there is nothing to inject into the parent context. Zero per-request cost.

async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
		while (next < items.length) {
			const index = next++;
			await fn(items[index] as T, index);
		}
	});
	await Promise.all(workers);
}

// ── manager ──────────────────────────────────────────────────────────────

class SubagentManager {
	private runs = new Map<string, RunSnapshot>();
	private settlers = new Map<string, (run: RunSnapshot) => void>();
	private pendingReplies = new Map<string, PendingReply>();
	private liveChildren = new Map<string, { abort: () => void; dispose: () => void; touchWatchdog: () => void }>();
	private mailboxes: Mailbox = createMailbox();
	private widgetTimer: ReturnType<typeof setTimeout> | undefined;
	private widgetRun: RunSnapshot | undefined;

	constructor(private readonly pi: ExtensionAPI) {}

	listRuns(): RunSnapshot[] {
		return Array.from(this.runs.values()).sort((a, b) => b.createdAt - a.createdAt);
	}
	getRun(runId: string | undefined): RunSnapshot | undefined {
		return runId ? this.runs.get(runId) : undefined;
	}
	clearRuns(): void {
		this.runs.clear();
		this.settlers.clear();
		this.pendingReplies.clear();
		this.mailboxes = createMailbox();
		if (this.widgetTimer) clearTimeout(this.widgetTimer);
		this.widgetTimer = undefined;
		this.widgetRun = undefined;
	}

	// ── persistence (sidecar per parent session) ────────────────────────
	async restoreFromSidecar(ctx: ExtensionContext): Promise<void> {
		const parentFile = getParentSessionFile(ctx);
		if (!parentFile) return;
		const sidecar = parentFile.replace(/\.jsonl$/, ".subagents.json");
		let runs: RunSnapshot[];
		try {
			const { readFileSync, existsSync } = await import("fs");
			if (!existsSync(sidecar)) return;
			const raw = JSON.parse(readFileSync(sidecar, "utf-8"));
			if (!Array.isArray(raw)) return;
			runs = (raw as RunSnapshot[]).map((run) => ({
				...run,
				tasks: run.tasks.map((t) => (TERMINAL.includes(t.status) ? t : { ...t, status: "aborted" as TaskStatus, error: t.error || "Interrupted by session reload" })),
			}));
		} catch {
			return;
		}
		let added = 0;
		for (const run of runs) {
			if (!run?.id || this.runs.has(run.id)) continue;
			this.runs.set(run.id, run);
			added += 1;
		}
		if (added > 0) {
			this.emit("subagent:runs-restored", { count: added });
			this.scheduleWidget(this.listRuns()[0], ctx);
		}
	}
	private persist(ctx: ExtensionContext): void {
		try {
			const parentFile = getParentSessionFile(ctx);
			if (!parentFile) return;
			const sidecar = parentFile.replace(/\.jsonl$/, ".subagents.json");
			import("fs").then(({ writeFileSync }) => writeFileSync(sidecar, JSON.stringify(this.listRuns().map(cloneRun), null, 2)));
		} catch {
			/* ignore */
		}
	}

	private emit(type: string, payload: Record<string, unknown>): void {
		this.pi.events.emit(type, { type, timestamp: Date.now(), ...payload });
	}

	/** Wake the parent with a 3-line notice. Full text stays out of context.
	 *  deliverAs followUp queues the message if the parent is mid-stream
	 *  (e.g. inside await_subagent) instead of throwing/aborting. */
	private notifyParent(run: RunSnapshot, kind: "completed" | "failed" | "aborted" | "asked", extra?: { taskId?: string; question?: string }): void {
		if (kind !== "asked" && run.awaited) return; // parent already got the result via await_subagent
		const body = kind === "asked"
			? `A background subagent is asking you a question (task ${extra?.taskId}): ${extra?.question ?? ""}\nReply with reply_subagent(runId: "${run.id}", taskId: "${extra?.taskId}", message: ...).`
			: makeNotice(run, kind);
		try {
			this.pi.sendUserMessage(body, { deliverAs: "followUp" });
		} catch {
			/* parent mid-stream; consumers can poll subagent_status */
		}
		this.emit("subagent:notification", { runId: run.id, kind, body });
	}

	// Widget: register-once + requestRender (todo-overlay pattern).
	// The component self-animates the spinner via its own 100ms interval;
	// scheduleWidget just throttles status changes into requestRender calls.
	private widgetTui: TUI | null = null;
	private scheduleWidget(run: RunSnapshot | undefined, ctx?: ExtensionContext, onUpdate?: (partial: any) => void): void {
		if (run) this.widgetRun = run;
		if (this.widgetTimer || !this.widgetRun) return;
		const target = this.widgetRun;
		this.widgetTimer = setTimeout(() => {
			this.widgetTimer = undefined;
			if (ctx?.hasUI) {
				ctx.ui.setStatus("subagents", `subagents: ${target.tasks.filter((t) => !TERMINAL.includes(t.status)).length} running`);
				this.ensureWidget(ctx);
				this.widgetTui?.requestRender();
			}
			onUpdate?.({ content: [{ type: "text", text: compactLines(target).join("\n") }] });
		}, WIDGET_THROTTLE_MS);
	}
	private flushWidget(ctx?: ExtensionContext, onUpdate?: (partial: any) => void): void {
		if (this.widgetTimer) {
			clearTimeout(this.widgetTimer);
			this.widgetTimer = undefined;
		}
		const run = this.widgetRun;
		if (!run) return;
		if (ctx?.hasUI) {
			ctx.ui.setStatus("subagents", `subagents: ${run.status}`);
			this.ensureWidget(ctx);
			this.widgetTui?.requestRender();
		}
		onUpdate?.({ content: [{ type: "text", text: compactLines(run).join("\n") }] });
	}
	private ensureWidget(ctx: ExtensionContext): void {
		if (this.widgetTui !== null || !ctx.hasUI) return;
		ctx.ui.setWidget(
			"subagents",
			(tui, theme) => {
				this.widgetTui = tui;
				return new SubagentsWidget(() => this.widgetRun, theme);
			},
			{ placement: "aboveEditor" },
		);
	}

	private updateRun(run: RunSnapshot, ctx?: ExtensionContext, onUpdate?: (partial: any) => void): void {
		run.aggregateUsage = aggregateUsage(run.tasks);
		this.runs.set(run.id, run);
		this.emit("subagent:run-updated", { runId: run.id, status: run.status, live: run.tasks.filter((t) => !TERMINAL.includes(t.status)).length });
		this.scheduleWidget(run, ctx, onUpdate);
	}
	private updateTask(run: RunSnapshot, task: TaskSnapshot, patch: Partial<TaskSnapshot>, ctx: ExtensionContext, onUpdate?: (partial: any) => void): void {
		Object.assign(task, patch);
		this.emit("subagent:task-updated", { runId: run.id, taskId: task.id, status: task.status });
		this.updateRun(run, ctx, onUpdate);
	}

	// ── intercom + mailbox ──────────────────────────────────────────────
	private makeChildHandlers(run: RunSnapshot, task: TaskSnapshot, ctx: ExtensionContext): ChildHandlers {
		return {
			onAskParent: async (_taskId, question) => {
				this.updateTask(run, task, { status: "awaiting_parent", intercomQuestion: question }, ctx);
				this.liveChildren.get(`${run.id}:${task.id}`)?.touchWatchdog();
				this.notifyParent(run, "asked", { taskId: task.id, question });
				const reply = await this.awaitParentReply(run.id, task.id);
				this.updateTask(run, task, { status: "running", intercomQuestion: undefined }, ctx);
				this.liveChildren.get(`${run.id}:${task.id}`)?.touchWatchdog();
				return reply;
			},
			onNotifyParent: (_taskId, message, level) => {
				this.emit("subagent:intercom", { runId: run.id, taskId: task.id, kind: "notify", level, message });
			},
			onUpdateProgress: (_taskId, phase, note) => {
				this.updateTask(run, task, { progressPhase: phase + (note ? ` — ${note}` : "") }, ctx);
			},
			onSendMessage: (_taskId, to, text) => {
				if (to === "leader") {
					this.emit("subagent:intercom", { runId: run.id, taskId: task.id, kind: "notify", level: "info", message: text });
					return true;
				}
				return this.mailboxes.send(task.id, to, text);
			},
			onPollMailbox: (taskId) => this.mailboxes.poll(taskId),
		};
	}
	private awaitParentReply(runId: string, taskId: string): Promise<string> {
		return new Promise<string>((resolve) => {
			this.pendingReplies.set(`${runId}:${taskId}`, { resolve });
		});
	}
	deliverReply(runId: string, taskId: string, message: string): boolean {
		const pending = this.pendingReplies.get(`${runId}:${taskId}`);
		if (!pending) return false;
		this.pendingReplies.delete(`${runId}:${taskId}`);
		pending.resolve(message);
		return true;
	}

	// ── child execution ─────────────────────────────────────────────────
	private async runChild(
		run: RunSnapshot,
		task: TaskSnapshot,
		input: TaskInput,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onUpdate?: (partial: any) => void,
	): Promise<void> {
		if (TERMINAL.includes(task.status)) return; // canceled while queued

		this.updateTask(run, task, {
			status: "starting",
			startedAt: Date.now(),
			model: input.model,
			thinking: input.thinking,
			tools: [...(input.tools ?? (input.write ? WRITE_TOOLS : READONLY_TOOLS)), ...(run.allowIntercom ? CHILD_TALK_TOOLS : [])],
		}, ctx, onUpdate);

		let child: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		let unsubscribe: (() => void) | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let abortListener: (() => void) | undefined;
		let watchdog = createWatchdog(DEFAULT_STALL_MS, `Subagent ${task.agent}`);
		let pendingFailure: ReturnType<typeof classifyFailure>;
		let failChildEnd: ((error: Error) => void) | undefined;
		let childEndResolve: (() => void) | undefined;

		const key = `${run.id}:${task.id}`;
		try {
			const modelRef = parseModelRef(input.model);
			const model = modelRef ? ctx.modelRegistry.find(modelRef.provider, modelRef.modelId) : undefined;
			if (modelRef && !model) throw new Error(`Model not found: ${modelRef.provider}/${modelRef.modelId}`);

			const subagentInstruction = run.allowIntercom
				? "You are running as a subagent. Do not call subagent/delegation tools unless the parent explicitly asks. Return a concise final answer. You MAY use ask_parent only when truly blocked on information only the parent has; notify_parent for one-way updates; send_agent_message/poll_agent_messages to coordinate with sibling subagents."
				: "You are running as a subagent. Do not call subagent/delegation tools unless the parent explicitly asks. Return a concise final answer for the parent agent.";

			const loader = new DefaultResourceLoader({
				cwd: task.cwd,
				agentDir: getAgentDir(),
				noExtensions: true,
				appendSystemPromptOverride: (base) => [...base, [input.prompt?.trim(), subagentInstruction].filter(Boolean).join("\n\n")],
			});
			await loader.reload();

			const customTools: ToolDefinition[] = run.allowIntercom ? createChildTools(task.id, this.makeChildHandlers(run, task, ctx)) : [];
			// pi filters custom tools through the `tools` allowlist — talk tools must be listed.
			const childTools = [...(input.tools ?? (input.write ? WRITE_TOOLS : READONLY_TOOLS)), ...(run.allowIntercom ? CHILD_TALK_TOOLS : [])];

			const created = await createAgentSession({
				cwd: task.cwd,
				agentDir: getAgentDir(),
				resourceLoader: loader,
				sessionManager: SessionManager.create(task.cwd, undefined, { parentSession: getParentSessionFile(ctx) }),
				model,
				thinkingLevel: (input.thinking ?? undefined) as ThinkingLevel | undefined,
				tools: childTools,
				customTools,
			});
			child = created.session;
			child.setSessionName?.(`subagent: ${task.agent}`);
			this.updateTask(run, task, { status: "running", sessionId: child.sessionId, sessionFile: child.sessionFile }, ctx, onUpdate);

			const childFailurePromise = new Promise<never>((_, reject) => {
				failChildEnd = reject;
			});
			const childEndPromise = new Promise<void>((resolve) => {
				childEndResolve = resolve;
			});

			unsubscribe = child.subscribe((event: AgentSessionEvent) => {
				const active = event.type === "message_end" || event.type === "tool_execution_start" || event.type === "tool_execution_end";
				if (active) {
					watchdog.touch();
					this.emit("subagent:session-event", { runId: run.id, taskId: task.id, seq: eventSeq++, event: { type: event.type } });
				}
				if (event.type === "tool_execution_start") {
					this.updateTask(run, task, { toolCalls: task.toolCalls + 1, lastActivity: `${event.toolName}${argsSuffix(event.args)}` }, ctx, onUpdate);
				} else if (event.type === "tool_execution_end") {
					this.updateTask(run, task, {}, ctx, onUpdate);
				} else if (event.type === "message_end") {
					const message = event.message as AssistantMessage;
					updateUsageFromMessage(task, message);
					const text = getFirstText(message);
					if (text) {
						task.finalText = truncateText(text);
						task.lastActivity = activitySnippet(text);
					}
					pendingFailure = classifyFailure(message.stopReason, message.errorMessage);
					this.updateRun(run, ctx, onUpdate);
				} else if (event.type === "agent_end") {
					if (event.willRetry) {
						pendingFailure = undefined; // retry in flight — don't trust stale failures
					} else {
						const failure = lastAssistantFailure(event.messages as AssistantMessage[]);
						if (failure) {
							pendingFailure = failure;
							failChildEnd?.(failureError(failure));
						} else {
							childEndResolve?.();
						}
					}
				}
			});

			if (signal) {
				const listener = () => void child?.abort();
				signal.addEventListener("abort", listener, { once: true });
				abortListener = () => signal.removeEventListener("abort", listener);
			}
			this.liveChildren.set(key, { abort: () => void child?.abort(), dispose: () => watchdog.dispose(), touchWatchdog: () => watchdog.touch() });

			const maxRuntimeMs = input.maxRuntimeMs ?? DEFAULT_RUNTIME_MS;
			const promptPromise = child.prompt(task.task, { source: "extension" });
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error(`Subagent timed out after ${maxRuntimeMs}ms`)), maxRuntimeMs);
			});
			await Promise.race([promptPromise, childFailurePromise, childEndPromise, watchdog.promise, timeoutPromise]);
			if (timeout) clearTimeout(timeout);

			pendingFailure ??= lastAssistantFailure(child.messages as AssistantMessage[]);
			if (pendingFailure) throw failureError(pendingFailure);

			const finalText = task.finalText || truncateText((child.messages as AssistantMessage[]).map(getFirstText).filter(Boolean).at(-1) || "");
			this.updateTask(run, task, { status: "completed", finalText, endedAt: Date.now() }, ctx, onUpdate);
		} catch (err) {
			if (timeout) clearTimeout(timeout);
			const aborted = signal?.aborted;
			const subagentStatus = (err as Error & { subagentStatus?: string })?.subagentStatus;
			try {
				await child?.abort();
			} catch {
				/* ignore */
			}
			this.updateTask(run, task, {
				status: aborted ? "aborted" : (subagentStatus as TaskStatus) ?? "failed",
				error: err instanceof Error ? err.message : String(err),
				endedAt: Date.now(),
			}, ctx, onUpdate);
		} finally {
			this.liveChildren.delete(key);
			this.pendingReplies.delete(key);
			abortListener?.();
			unsubscribe?.();
			watchdog.dispose();
			if (timeout) clearTimeout(timeout);
			child?.dispose();
		}
	}

	// ── run lifecycle ───────────────────────────────────────────────────
	createRun(params: SubagentParamsShape, ctx: ExtensionContext): { run: RunSnapshot; inputs: TaskInput[] } {
		const hasChain = (params.chain?.length ?? 0) > 0;
		const hasTasks = (params.tasks?.length ?? 0) > 0;
		const hasSingle = Boolean(params.agent && params.task);
		if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
			throw new Error(`Provide exactly one subagent mode (single, tasks, or chain).`);
		}

		const mode: RunMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
		const inputs: TaskInput[] = hasSingle
			? [{ agent: params.agent as string, desc: params.desc, task: params.task as string, prompt: params.prompt, write: params.write, model: params.model, thinking: params.thinking, tools: params.tools, maxRuntimeMs: params.maxRuntimeMs }]
			: hasTasks
				? params.tasks!
				: params.chain!;
		if (inputs.length > MAX_TASKS) throw new Error(`Too many subagent tasks (${inputs.length}). Max is ${MAX_TASKS}.`);

		const run: RunSnapshot = {
			id: newId("run"),
			mode,
			status: "queued",
			background: Boolean(params.background),
			allowIntercom: Boolean(params.allowIntercom),
			createdAt: Date.now(),
			concurrency: Math.max(1, Math.min(params.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY)),
			tasks: inputs.map((input, index) => ({
				id: input.id ?? `task_${index + 1}`,
				runId: "",
				agent: input.agent,
				task: input.task,
				cwd: ctx.cwd,
				status: "queued" as TaskStatus,
				model: input.model,
				thinking: input.thinking,
				tools: input.tools ?? (input.write ? WRITE_TOOLS : READONLY_TOOLS),
				toolCalls: 0,
				usage: emptyUsage(),
			})),
			aggregateUsage: emptyUsage(),
		};
		run.tasks.forEach((t) => (t.runId = run.id));
		this.runs.set(run.id, run);
		this.settlers.set(run.id, () => {});
		for (const task of run.tasks) this.mailboxes.open(task.id);
		this.emit("subagent:run-created", { run: cloneRun(run) });
		return { run, inputs };
	}

	private async executeTasks(run: RunSnapshot, inputs: TaskInput[], ctx: ExtensionContext, signal: AbortSignal | undefined, onUpdate?: (partial: any) => void): Promise<void> {
		run.status = "running";
		run.startedAt = Date.now();
		this.updateRun(run, ctx, onUpdate);

		if (run.mode === "chain") {
			let previous = "";
			for (let i = 0; i < inputs.length; i++) {
				const task = run.tasks[i]!;
				if (TERMINAL.includes(task.status)) continue; // canceled
				const input = { ...inputs[i]!, task: inputs[i]!.task.replace(/\{previous\}/g, previous) };
				task.task = input.task;
				await this.runChild(run, task, input, ctx, signal, onUpdate);
				if (task.status !== "completed") break;
				previous = task.finalText ?? "";
			}
		} else {
			await mapWithConcurrency(run.tasks, run.mode === "single" ? 1 : run.concurrency, async (task) => {
				const index = run.tasks.indexOf(task);
				await this.runChild(run, task, inputs[index]!, ctx, signal, onUpdate);
			});
		}

		const failed = run.tasks.some((t) => t.status === "failed");
		const aborted = run.tasks.some((t) => t.status === "aborted") || Boolean(signal?.aborted);
		run.status = aborted ? "aborted" : failed ? "failed" : "completed";
		run.endedAt = Date.now();
		this.flushWidget(ctx, onUpdate);
		this.emit("subagent:run-completed", { runId: run.id, status: run.status, run: cloneRun(run), aggregateUsage: run.aggregateUsage });
		this.settlers.get(run.id)?.(cloneRun(run));
		for (const task of run.tasks) this.mailboxes.close(task.id);
		this.persist(ctx);
	}

	async runBlocking(params: SubagentParamsShape, signal: AbortSignal | undefined, onUpdate: ((partial: any) => void) | undefined, ctx: ExtensionContext): Promise<RunDetails> {
		const { run, inputs } = this.createRun(params, ctx);
		await this.executeTasks(run, inputs, ctx, signal, onUpdate);
		return { run: cloneRun(run) };
	}

	startInBackground(params: SubagentParamsShape, ctx: ExtensionContext): RunDetails {
		const { run, inputs } = this.createRun(params, ctx);
		void this.executeTasks(run, inputs, ctx, undefined, undefined).then(() => {
			this.notifyParent(run, run.status === "completed" ? "completed" : run.status === "aborted" ? "aborted" : "failed");
		});
		return { run: cloneRun(run), background: true };
	}

	cancelRun(runId: string): { aborted: number } {
		const run = this.runs.get(runId);
		if (!run) return { aborted: 0 };
		let aborted = 0;
		for (const [key, child] of this.liveChildren) {
			if (key.startsWith(`${runId}:`)) {
				child.abort();
				aborted += 1;
			}
		}
		for (const task of run.tasks) {
			if (TERMINAL.includes(task.status)) continue;
			task.status = "aborted";
			task.error = task.error || "Canceled by subagent_cancel";
			task.endedAt = Date.now();
			aborted += 1;
		}
		run.status = "aborted";
		run.endedAt = Date.now();
		this.settlers.get(runId)?.(cloneRun(run));
		this.emit("subagent:run-completed", { runId: run.id, status: "aborted", run: cloneRun(run) });
		return { aborted };
	}

	awaitRun(runId: string, timeoutMs?: number): Promise<RunSnapshot | undefined> {
		const run = this.runs.get(runId);
		if (!run) return Promise.resolve(undefined);
		run.awaited = true;
		if (TERMINAL.includes(run.status)) return Promise.resolve(cloneRun(run));
		const settled = new Promise<RunSnapshot | undefined>((resolve) => {
			const prev = this.settlers.get(runId);
			this.settlers.set(runId, (r) => {
				prev?.(r);
				resolve(r);
			});
		});
		if (!timeoutMs) return settled;
		return Promise.race([
			settled,
			new Promise<RunSnapshot | undefined>((resolve) =>
				setTimeout(() => resolve(this.runs.get(runId) ? cloneRun(this.runs.get(runId)!) : undefined), timeoutMs),
			),
		]);
	}
}

let eventSeq = 0;

// ── tool schemas (slim: short descriptions, no rarely-used knobs) ────────

const TaskItem = Type.Object({
	id: Type.Optional(Type.String({ description: "Optional stable task id" })),
	agent: Type.String({ description: "Name you invent for this subagent" }),
	desc: Type.Optional(Type.String({ description: "One-line description of this agent's role" })),
	task: Type.String({ description: "Task for this agent" }),
	prompt: Type.Optional(Type.String({ description: "System prompt defining this agent's behavior. Optional — a minimal default is used." })),
	write: Type.Optional(Type.Boolean({ description: "true = write toolset (read, bash, edit, write); default false = read-only (read, grep, find, ls)" })),
	model: Type.Optional(Type.String({ description: "Model override (provider/model-id)" })),
	thinking: Type.Optional(Type.String({ description: "Thinking level override" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Explicit tool allowlist (overrides the toolset)" })),
	maxRuntimeMs: Type.Optional(Type.Number({ description: "Per-task timeout (ms)" })),
});

type SubagentParamsShape = {
	agent?: string;
	desc?: string;
	task?: string;
	prompt?: string;
	write?: boolean;
	tasks?: TaskInput[];
	chain?: TaskInput[];
	model?: string;
	thinking?: string;
	tools?: string[];
	concurrency?: number;
	maxRuntimeMs?: number;
	background?: boolean;
	allowIntercom?: boolean;
};

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name you invent for this subagent (single mode)" })),
	desc: Type.Optional(Type.String({ description: "One-line description (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task (single mode)" })),
	prompt: Type.Optional(Type.String({ description: "System prompt for this agent (single mode)" })),
	write: Type.Optional(Type.Boolean({ description: "true = write toolset; default false = read-only (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks" })),
	chain: Type.Optional(Type.Array(TaskItem, { description: "Sequential tasks; {previous} = prior output" })),
	model: Type.Optional(Type.String({ description: "Model override (single mode)" })),
	thinking: Type.Optional(Type.String({ description: "Thinking override (single mode)" })),
	concurrency: Type.Optional(Type.Number({ description: `Parallel concurrency (default ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY})` })),
	maxRuntimeMs: Type.Optional(Type.Number({ description: `Per-task timeout, ms (default ${DEFAULT_RUNTIME_MS / 60000} min)` })),
	background: Type.Optional(Type.Boolean({ description: "Fire-and-forget: return immediately with a runId; you'll be notified on completion" })),
	allowIntercom: Type.Optional(Type.Boolean({ description: "Let children ask you questions, notify you, and message sibling subagents" })),
});

const RunIdParam = Type.Object({ runId: Type.String({ description: "Run id from subagent()" }) });
const ResultParam = Type.Object({
	runId: Type.String(),
	taskId: Type.Optional(Type.String({ description: "Specific task id; defaults to all" })),
});
const AwaitParam = Type.Object({
	runId: Type.String(),
	timeoutMs: Type.Optional(Type.Number({ description: "Max wait (ms); default: until finished" })),
});
const ReplyParam = Type.Object({
	runId: Type.String(),
	taskId: Type.String(),
	message: Type.String({ description: "Answer for the child" }),
});

// ── extension entry ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const manager = new SubagentManager(pi);

	pi.registerCommand("subagents", {
		description: "Show recent subagent runs",
		handler: async (_args, ctx) => {
			const runs = manager.listRuns().slice(0, 10);
			if (runs.length === 0) {
				ctx.ui.notify("No subagent runs in this session.", "info");
				return;
			}
			ctx.ui.setWidget("subagents", runs.flatMap((run) => compactLines(run).concat("")), { placement: "aboveEditor" });
			ctx.ui.notify(`Showing ${runs.length} subagent run(s).`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await manager.restoreFromSidecar(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx?.hasUI) {
			try {
				ctx.ui.setStatus("subagents", "");
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
		description: "Define and run isolated subagents (own context, own session). You invent the agent: give it a name, an optional system prompt, and a toolset (read-only by default, write:true for edit access). Modes: single, parallel (tasks), chain ({previous}). background:true fire-and-forgets with completion notice. allowIntercom:true lets children ask you questions and message each other.",
		promptSnippet: "Define and delegate work to specialized subagents.",
		promptGuidelines: [
			"Use subagent when independent review, testing, research, or parallel analysis improves quality.",
			"Define each subagent yourself: an invented name, a focused system prompt (prompt:), and a toolset — read-only (default) or write (write:true).",
			"Prefer read-only subagents unless the task explicitly needs edits.",
			"Use background:true for long-running work; you'll be notified on completion.",
			"Use allowIntercom:true only when a child may need to ask you something; keep children autonomous otherwise.",
		],
		parameters: SubagentParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const typed = params as unknown as SubagentParamsShape;
			if (typed.background) {
				const details = manager.startInBackground(typed, ctx);
				return {
					content: [{ type: "text", text: `Background run started: ${details.run.id} (${details.run.mode}, ${details.run.tasks.length} task${details.run.tasks.length > 1 ? "s" : ""}).\nUse subagent_status / subagent_result / await_subagent / reply_subagent / subagent_cancel to interact.` }],
					details,
				};
			}
			const details = await manager.runBlocking(typed, signal, onUpdate, ctx);
			return { content: [{ type: "text", text: makeSummary(details.run) }], details };
		},
		renderCall(args, theme) {
			const mode = args.chain?.length ? `chain ${args.chain.length}` : args.tasks?.length ? `parallel ${args.tasks.length}` : `single ${args.agent ?? "?"}`;
			const flags = [args.background ? "bg" : "", args.allowIntercom ? "talk" : ""].filter(Boolean).join(" ");
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", mode)}${flags ? ` ${theme.fg("muted", `[${flags}]`)}` : ""}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const run = result.details?.run;
			if (!run) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
			const header = `${statusIcon(run.status)} ${theme.fg("toolTitle", theme.bold(`subagents ${run.mode}${run.background ? " (bg)" : ""}`))} ${theme.fg("accent", `${run.tasks.filter((t) => t.status === "completed").length}/${run.tasks.length}`)} ${theme.fg("muted", run.status)}`;
			if (!expanded) {
				const lines = [header, ...run.tasks.map((task) => `  ${taskLine(task)}`)];
				const usage = formatUsage(run.aggregateUsage);
				if (usage) lines.push(theme.fg("dim", usage));
				return new Text(lines.join("\n"), 0, 0);
			}
			const container = new Container();
			container.addChild(new Text(header, 0, 0));
			const mdTheme = getMarkdownTheme();
			for (const task of run.tasks) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(`${statusIcon(task.status)} ${theme.fg("accent", task.agent)} ${theme.fg("muted", task.sessionId ?? "")}`, 0, 0));
				if (task.error) container.addChild(new Text(theme.fg("error", task.error), 0, 0));
				else if (task.finalText) container.addChild(new Markdown(task.finalText.trim(), 0, 0, mdTheme));
				const usage = formatUsage(task.usage);
				if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
			}
			return container;
		},
	});

	pi.registerTool<typeof RunIdParam, { run?: RunSnapshot }>({
		name: "subagent_status",
		label: "Subagent Status",
		description: "Live status of a subagent run (non-blocking): per-task state.",
		promptSnippet: "Check progress of a subagent run.",
		parameters: RunIdParam,
		async execute(_id, params) {
			const { runId } = params as { runId: string };
			const run = manager.getRun(runId);
			if (!run) return { content: [{ type: "text", text: `Unknown runId: ${runId}` }], isError: true, details: {} };
			return { content: [{ type: "text", text: compactLines(run).join("\n") }], details: { run: cloneRun(run) } };
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
			const text = [`Run ${run.id} — ${run.status}`, ...tasks.map((t) => `\n## ${t.agent} ${statusIcon(t.status)}\n${t.error ? `Error: ${t.error}` : t.finalText || "(no output yet)"}\n${formatUsage(t.usage)}`)].join("\n");
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
			if (!ok) return { content: [{ type: "text", text: `No pending question for ${runId}/${taskId}.` }], isError: true, details: {} };
			return { content: [{ type: "text", text: `Reply delivered to ${runId}/${taskId}. The child will resume.` }], details: {} };
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
			if (aborted === 0 && !manager.getRun(runId)) return { content: [{ type: "text", text: `Unknown runId: ${runId}` }], isError: true, details: {} };
			return { content: [{ type: "text", text: `Canceled ${aborted} task${aborted === 1 ? "" : "s"} in run ${runId}.` }], details: { aborted } };
		},
	});
}

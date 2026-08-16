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
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { CHILD_TALK_TOOLS, createChildTools, createWatchdog, type ChildHandlers } from "./child.ts";
import { createMailbox, type Mailbox } from "./mailbox.ts";

const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 8;
const MAX_TASKS = 16;
const DEFAULT_RUNTIME_MS = 10 * 60 * 1000;
const DEFAULT_STALL_MS = 180_000; // 3 min: long model thinking streams emit message_update, not message_end
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
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
	task: string;
	/** System prompt the leader writes for this agent. Optional — a minimal default is used. */
	prompt?: string;
	/** true = write toolset; false/omitted = read-only toolset. */
	write?: boolean;
	tools?: string[];
	model?: string;
	thinking?: string;
	cwd?: string;
	maxRuntimeMs?: number;
}

interface TaskSnapshot {
	id: string;
	runId: string;
	agent: string;
	task: string;
	cwd: string;
	status: TaskStatus;
	sessionId?: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	startedAt?: number;
	endedAt?: number;
	toolCalls: number;
	/** Address + sibling roster, injected into the child so mailbox tools can address them. */
	roster?: string;
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
	/** Wake the parent (queued follow-up turn) as each task completes. Default false. */
	notifyPerTask: boolean;
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
	let out = text.slice(0, max);
	while (Buffer.byteLength(out, "utf8") > max) out = out.slice(0, -1); // multibyte-safe
	return `${out}\n\n[Output truncated. Full child session is available in the session file.]`;
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
	if (usage.cost > 0) parts.push(usage.cost >= 0.0001 ? `$${usage.cost.toFixed(4)}` : "$<0.0001");
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
	for (const task of run.tasks.slice(0, MAX_TASKS)) {
		lines.push(taskLine(task));
	}
	if (run.tasks.length > MAX_TASKS) lines.push(`… +${run.tasks.length - MAX_TASKS} more`);
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
const WIDGET_MAX_LINES = 10;

class SubagentsWidget implements Component {
	constructor(
		private readonly getRuns: () => RunSnapshot[],
		private readonly theme: Theme,
	) {}

	invalidate(): void {
		// no cached strings; render() reads live state
	}

	render(width: number): string[] {
		// ONE flat tree: every run's tasks concatenated under a single heading.
		// Whether the model spawned N runs or one tasks[] call, the pane reads the same.
		const runs = this.getRuns().filter((r) => r.tasks.length > 0);
		if (runs.length === 0) return [];
		const total = runs.reduce((n, r) => n + r.tasks.length, 0);
		const done = runs.reduce((n, r) => n + r.tasks.filter((t) => TERMINAL.includes(t.status)).length, 0);
		const live = total - done;
		const head = live > 0 ? "accent" : "dim";
		const lines = [truncateToWidth(`${this.theme.fg(head, live > 0 ? "●" : "○")} ${this.theme.fg(head, `Subagents (${done}/${total})`)}`, width, "…")];
		const budget = WIDGET_MAX_LINES - 1;
		let shown = 0;
		outer: for (const run of runs) {
			const allDone = TERMINAL.includes(run.status);
			for (const task of run.tasks) {
				if (shown >= budget) break outer;
				shown += 1;
				const activity =
					!TERMINAL.includes(task.status) && task.lastActivity
						? `${this.theme.fg("dim", `→ ${task.lastActivity}`)} · `
						: "";
				// Tasks of a finished run: dim everything except the agent name.
				const line = allDone
					? `${this.theme.fg("dim", `${statusIcon(task.status)} `)}${task.agent} ${this.theme.fg("dim", `· ${taskStatsWithUsage(task)} · ${taskTimer(task)}`)}`
					: `${statusIcon(task.status)} ${task.agent} · ${activity}${taskStatsWithUsage(task)} · ${taskTimer(task)}`;
				lines.push(truncateToWidth(`${this.theme.fg("dim", "├─")} ${line}`, width, "…"));
			}
		}
		const hidden = total - shown;
		if (hidden > 0) {
			lines.push(`${this.theme.fg("dim", "└─")} ${this.theme.fg("dim", `+${hidden} more`)}`);
		} else if (lines.length > 1) {
			lines[lines.length - 1] = lines[lines.length - 1]!.replace("├─", "└─");
		}
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
	// Ceiling on the WHOLE summary — 16 tasks × 24KB would otherwise flood the parent context.
	return truncateText(lines.join("\n"));
}
/** Per-task notice: one task's outcome, small. Full output stays out of parent context. */
function makeTaskNotice(run: RunSnapshot, task: TaskSnapshot, kind: string): string {
	const detail = task.error ? task.error : truncateText(task.finalText || "(no output)", 200);
	return [
		`Task ${task.agent} (${task.id}) ${kind} in run ${run.id}: ${detail}`,
		`Use subagent_result(runId: "${run.id}", taskId: "${task.id}") for full output.`,
	].join("\n");
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
/** Resolve a child model from the pi model registry.
 *  Order: explicit "provider/model-id" or bare id (searched across available
 *  models) → agent file model → parent's current model (ctx.model) → undefined
 *  (createAgentSession falls back to settings). */
function resolveChildModel(ctx: ExtensionContext, explicit: string | undefined) {
	if (explicit?.trim()) {
		const ref = explicit.trim();
		const slash = ref.indexOf("/");
		if (slash > 0 && slash < ref.length - 1) {
			const model = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
			if (!model) throw new Error(`Model not found: ${ref}`);
			return model;
		}
		const byId = ctx.modelRegistry.getAvailable().find((m) => m.id === ref);
		if (!byId) throw new Error(`Model not found: ${ref}`);
		return byId;
	}
	return ctx.model; // inherit the parent's active model
}

/** Validate a thinking level against the RESOLVED model's registry entry.
 *  thinkingLevelMap: null = unsupported, missing key = provider default,
 *  absent map = provider defaults. Non-reasoning models only accept "off". */
export function validateThinking(model: Model<Api> | undefined, level: string | undefined): void {
	if (!level || level === "off") return;
	if (!model) return;
	const map = model.thinkingLevelMap;
	if (map && level in map && map[level as keyof typeof map] === null) {
		const supported = Object.keys(map).filter((k) => map[k as keyof typeof map] !== null);
		throw new Error(
			`Thinking level "${level}" is not supported by ${model.provider}/${model.id}. Supported: ${supported.length ? supported.join(" | ") : "none — use thinking: \"off\""}.`,
		);
	}
	if (!model.reasoning) {
		throw new Error(`Model ${model.provider}/${model.id} does not support thinking. Use thinking: "off".`);
	}
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
	private runControllers = new Map<string, AbortController>();
	private widgetTimers = new Map<string, ReturnType<typeof setTimeout>>(); // per-run stream throttle
	private widgetRuns: RunSnapshot[] = [];

	turnActivity = false;

	constructor(private readonly pi: ExtensionAPI) {}

	/** Any run still has queued/running tasks? */
	hasActiveRun(): boolean {
		for (const run of this.runs.values()) {
			if (run.tasks.some((t) => !TERMINAL.includes(t.status))) return true;
		}
		return false;
	}

	/** Hide the widget + clear the footer status entry. */
	clearWidget(ctx: ExtensionContext): void {
		this.widgetRuns = [];
		this.widgetTui = null;
		if (ctx.hasUI) {
			try {
				ctx.ui.setWidget("subagents", undefined);
			} catch {
				/* ignore */
			}
		}
	}

	listRuns(): RunSnapshot[] {
		return Array.from(this.runs.values()).sort((a, b) => b.createdAt - a.createdAt);
	}
	getRun(runId: string | undefined): RunSnapshot | undefined {
		return runId ? this.runs.get(runId) : undefined;
	}
	clearRuns(): void {
		for (const child of this.liveChildren.values()) {
			child.abort();
			child.dispose();
		}
		this.liveChildren.clear();
		this.runs.clear();
		this.settlers.clear();
		this.pendingReplies.clear();
		this.runControllers.clear();
		this.mailboxes = createMailbox();
		this.widgetTui = null; // force re-registration on the next session
		for (const t of this.widgetTimers.values()) clearTimeout(t);
		this.widgetTimers.clear();
		this.widgetRuns = [];
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
			runs = (raw as RunSnapshot[]).map((run) => {
				const interrupted = run.tasks.some((t) => !TERMINAL.includes(t.status));
				// A persisted "running" run whose tasks are all terminal (crash between
				// task end and run end) must not stay "running" forever.
				let status = interrupted ? ("aborted" as RunStatus) : run.status;
				if (!TERMINAL.includes(status)) {
					const anyFailed = run.tasks.some((t) => t.status === "failed");
					const anyAborted = run.tasks.some((t) => t.status === "aborted");
					status = anyFailed ? "failed" : anyAborted ? "aborted" : "completed";
				}
				return {
					...run,
					status,
					endedAt: interrupted ? Date.now() : run.endedAt,
					tasks: run.tasks.map((t) => (TERMINAL.includes(t.status) ? t : { ...t, status: "aborted" as TaskStatus, error: t.error || "Interrupted by session reload" })),
				};
			});
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
			import("fs").then(({ writeFileSync }) => writeFileSync(sidecar, JSON.stringify(this.listRuns().slice(0, 50).map(cloneRun), null, 2)));
		} catch {
			/* ignore */
		}
	}

	private emit(type: string, payload: Record<string, unknown>): void {
		this.pi.events.emit(type, { type, timestamp: Date.now(), ...payload });
	}

	/** Per-task wake-up: queued follow-up so the parent can interleave responses. */
	private notifyTask(run: RunSnapshot, task: TaskSnapshot, kind: "completed" | "failed" | "aborted"): void {
		const body = makeTaskNotice(run, task, kind);
		try {
			this.pi.sendUserMessage(body, { deliverAs: "followUp" });
		} catch {
			/* parent mid-stream; consumers can poll subagent_status */
		}
		this.emit("subagent:notification", { runId: run.id, taskId: task.id, kind, body });
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
	/** Upsert a run into the widget's visible set (all runs, not just the latest). */
	private upsertWidgetRun(run: RunSnapshot | undefined): void {
		if (!run) return;
		const idx = this.widgetRuns.findIndex((r) => r.id === run.id);
		if (idx >= 0) this.widgetRuns[idx] = run;
		else this.widgetRuns.push(run);
	}
	private scheduleWidget(run: RunSnapshot | undefined, ctx?: ExtensionContext, onUpdate?: (partial: any) => void): void {
		this.upsertWidgetRun(run);
		if (!run || this.widgetTimers.has(run.id)) return;
		this.widgetTimers.set(run.id, setTimeout(() => {
			this.widgetTimers.delete(run.id);
			if (ctx?.hasUI) {
				this.ensureWidget(ctx);
				this.widgetTui?.requestRender();
			}
			onUpdate?.({ content: [{ type: "text", text: compactLines(run).join("\n") }] });
		}, WIDGET_THROTTLE_MS));
	}
	private flushWidget(run: RunSnapshot | undefined, ctx?: ExtensionContext, onUpdate?: (partial: any) => void): void {
		if (run) {
			const t = this.widgetTimers.get(run.id);
			if (t) {
				clearTimeout(t);
				this.widgetTimers.delete(run.id);
			}
		}
		if (!run || this.widgetRuns.length === 0) return;
		if (ctx?.hasUI) {
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
				return new SubagentsWidget(() => [...this.widgetRuns], theme);
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
				this.updateTask(run, task, { status: "awaiting_parent" }, ctx);
				this.liveChildren.get(`${run.id}:${task.id}`)?.touchWatchdog();
				this.notifyParent(run, "asked", { taskId: task.id, question });
				// A blocking run's parent can't reply mid-tool (followUp only fires after the
				// tool returns) — only background runs can truly wait for the answer.
				if (!run.background) {
					this.updateTask(run, task, { status: "running" }, ctx);
					this.liveChildren.get(`${run.id}:${task.id}`)?.touchWatchdog();
					return "Parent cannot answer while this run is blocking. Continue autonomously with your best judgment.";
				}
				const reply = await this.awaitParentReply(run.id, task.id);
				this.updateTask(run, task, { status: "running" }, ctx);
				this.liveChildren.get(`${run.id}:${task.id}`)?.touchWatchdog();
				return reply;
			},
			onNotifyParent: (_taskId, message, level) => {
				this.emit("subagent:intercom", { runId: run.id, taskId: task.id, kind: "notify", level, message });
				if (!run.awaited) {
					try {
						this.pi.sendUserMessage(`[Subagent ${task.agent}] ${message}`, { deliverAs: "followUp" });
					} catch {
						/* parent mid-stream */
					}
				}
			},
			onSendMessage: (_taskId, to, text) => {
				if (to === "leader") {
					this.emit("subagent:intercom", { runId: run.id, taskId: task.id, kind: "notify", level: "info", message: text });
					if (!run.awaited) {
						try {
							this.pi.sendUserMessage(`[Subagent ${task.agent}] ${text}`, { deliverAs: "followUp" });
						} catch {
							/* parent mid-stream */
						}
					}
					return true;
				}
				// Run-scoped keys: sibling ids are run-local; cross-run task_1 can never collide.
				return this.mailboxes.send(`${run.id}:${task.id}`, `${run.id}:${to}`, text);
			},
			onPollMailbox: (taskId) => this.mailboxes.poll(`${run.id}:${taskId}`),
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

		// Inline params win; otherwise fall back to an existing agent file
		// (~/.agents, .pi/agents, user dir). Never creates files.
		const prompt = input.prompt?.trim();
		const thinking = input.thinking;
		const baseTools = input.tools ?? (input.write ? WRITE_TOOLS : READONLY_TOOLS);
		const tools = [...baseTools, ...(run.allowIntercom ? CHILD_TALK_TOOLS : [])];

		// Model + thinking resolve against the pi model registry; a bad request
		// fails the TASK with a helpful message, not the whole run.
		let model: Model<Api> | undefined;
		try {
			model = resolveChildModel(ctx, input.model);
			validateThinking(model, thinking);
		} catch (err) {
			this.updateTask(run, task, {
				status: "failed",
				error: err instanceof Error ? err.message : String(err),
				endedAt: Date.now(),
			}, ctx, onUpdate);
			return;
		}

		this.updateTask(run, task, {
			status: "starting",
			startedAt: Date.now(),
			model: input.model,
			thinking,
			tools,
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
			const subagentInstruction = run.allowIntercom
				? `You are running as a subagent. Do not call subagent/delegation tools unless the parent explicitly asks. Return a concise final answer. You MAY use ask_parent only when truly blocked on information only the parent has; notify_parent for one-way updates; send_agent_message/poll_agent_messages to coordinate with siblings. Your mailbox address and siblings: ${task.roster ?? "(none)"}. Use the exact task ids (e.g. task_2) as send_agent_message targets.`
				: "You are running as a subagent. Do not call subagent/delegation tools unless the parent explicitly asks. Return a concise final answer for the parent agent.";

			const loader = new DefaultResourceLoader({
				cwd: task.cwd,
				agentDir: getAgentDir(),
				noExtensions: true,
				appendSystemPromptOverride: (base) => [...base, [prompt?.trim(), subagentInstruction].filter(Boolean).join("\n\n")],
			});
			await loader.reload();

			const customTools: ToolDefinition[] = run.allowIntercom ? createChildTools(task.id, this.makeChildHandlers(run, task, ctx)) : [];

			const created = await createAgentSession({
				cwd: task.cwd,
				agentDir: getAgentDir(),
				resourceLoader: loader,
				sessionManager: SessionManager.create(task.cwd, undefined, { parentSession: getParentSessionFile(ctx) }),
				model,
				thinkingLevel: thinking as ThinkingLevel | undefined,
				tools,
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
				const active = event.type === "message_update" || event.type === "message_end" || event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end" || event.type === "bash_execution_update" || event.type === "agent_settled";
				if (active) {
					watchdog.touch();
					this.emit("subagent:session-event", { runId: run.id, taskId: task.id, seq: eventSeq++, event: { type: event.type } });
				}
				if (event.type === "tool_execution_start") {
					this.updateTask(run, task, { toolCalls: task.toolCalls + 1, lastActivity: `${event.toolName}${argsSuffix(event.args)}` }, ctx, onUpdate);
				} else if (event.type === "tool_execution_end") {
					this.scheduleWidget(run, ctx, onUpdate);
				} else if (event.type === "message_end") {
					const message = event.message as AssistantMessage;
					if (message?.role === "assistant") {
						updateUsageFromMessage(task, message);
						const text = getFirstText(message);
						if (text) {
							task.finalText = truncateText(text);
							task.lastActivity = activitySnippet(text);
						}
						pendingFailure = classifyFailure(message.stopReason, message.errorMessage);
					}
					this.updateRun(run, ctx, onUpdate);
				} else if (event.type === "agent_end") {
					if (event.willRetry) {
						pendingFailure = undefined; // retry in flight — don't trust stale failures
					} else {
						const failure = lastAssistantFailure(event.messages as AssistantMessage[]);
						if (failure) {
							pendingFailure = failure;
							failChildEnd?.(failureError(failure));
						}
						// NOTE: success does NOT resolve childEndPromise here — pi may run a
						// continuation leg (compaction/overflow recovery) that emits another
						// agent_end. Resolve only on agent_settled, after all legs finish.
					}
				} else if (event.type === "agent_settled") {
					childEndResolve?.();
				}
			});

			const abortChild = () => {
				void child?.abort();
				this.runControllers.get(run.id)?.abort(); // parent abort kills ALL siblings, not just this child
			};
			const runController = this.runControllers.get(run.id);
			if (signal) signal.addEventListener("abort", abortChild, { once: true });
			if (runController) runController.signal.addEventListener("abort", abortChild, { once: true });
			abortListener = () => {
				signal?.removeEventListener("abort", abortChild);
				runController?.signal.removeEventListener("abort", abortChild);
			};
			// Cancel may have landed during session creation — honor it before prompting.
			if (run.status === "aborted" || TERMINAL.includes(task.status)) {
				await child.abort();
				throw new Error("Canceled by subagent_cancel");
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
			if (task.status !== "aborted") {
				this.updateTask(run, task, { status: "completed", finalText, endedAt: Date.now() }, ctx, onUpdate);
			}
		} catch (err) {
			if (timeout) clearTimeout(timeout);
			// Cancel is authoritative: parent tool signal OR run/task already marked aborted.
			const aborted = signal?.aborted || run.status === "aborted" || task.status === "aborted";
			const subagentStatus = (err as Error & { subagentStatus?: string })?.subagentStatus;
			try {
				// Unblock a child stuck in ask_parent, then time-box the abort so a
				// wedged session can never hang this catch/finally.
				this.pendingReplies.get(key)?.resolve("(parent unreachable)");
				await Promise.race([child?.abort(), new Promise((r) => setTimeout(r, 5000))]);
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
			? [{ agent: params.agent as string, task: params.task as string, prompt: params.prompt, write: params.write, model: params.model, thinking: params.thinking, cwd: params.cwd, tools: params.tools, maxRuntimeMs: params.maxRuntimeMs }]
			: hasTasks
				? params.tasks!
				: params.chain!;
		if (inputs.length > MAX_TASKS) throw new Error(`Too many subagent tasks (${inputs.length}). Max is ${MAX_TASKS}.`);
		const ids = new Set<string>();
		for (const input of inputs) {
			if (input.id !== undefined) {
				if (ids.has(input.id)) throw new Error(`Duplicate task id: ${input.id}`);
				ids.add(input.id);
			}
		}

		const run: RunSnapshot = {
			id: newId("run"),
			mode,
			status: "queued",
			background: Boolean(params.background),
			allowIntercom: Boolean(params.allowIntercom),
			notifyPerTask: params.notifyPerTask ?? false,
			createdAt: Date.now(),
			concurrency: Math.max(1, Math.min(params.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY)),
			tasks: inputs.map((input, index) => ({
				id: input.id ?? `task_${index + 1}`,
				runId: "",
				agent: input.agent,
				task: input.task,
				cwd: input.cwd ?? ctx.cwd,
				status: "queued" as TaskStatus,
				model: input.model,
				thinking: input.thinking,
				tools: input.tools ?? (input.write ? WRITE_TOOLS : READONLY_TOOLS),
				toolCalls: 0,
				usage: emptyUsage(),
			})),
			aggregateUsage: emptyUsage(),
		};
		// Roster: each child learns its own address + sibling addresses so
		// send_agent_message/poll_agent_messages can be used reliably.
		const roster = run.tasks.map((t) => `${t.id} (${t.agent})`).join(", ");
		for (const task of run.tasks) {
			task.roster = roster;
		}
		run.tasks.forEach((t) => (t.runId = run.id));
		this.turnActivity = true;
		this.runs.set(run.id, run);
		this.settlers.set(run.id, () => {});
		this.runControllers.set(run.id, new AbortController());
		for (const task of run.tasks) this.mailboxes.open(`${run.id}:${task.id}`);
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
				const rawTask = inputs[i]!.task;
				let next = rawTask.replace(/\{previous\}/g, () => previous); // replacer fn: no $ corruption
				if (previous === "" && rawTask.includes("{previous}")) {
					next += "\n\n(Note: {previous} was empty — no prior step output existed yet.)";
				}
				const input = { ...inputs[i]!, task: next };
				task.task = input.task;
				await this.runChild(run, task, input, ctx, signal, onUpdate);
				if (run.notifyPerTask && run.background && TERMINAL.includes(task.status)) {
					this.notifyTask(run, task, task.status as "completed" | "failed" | "aborted");
				}
				if (task.status !== "completed") break;
				previous = task.finalText ?? "";
			}
		} else {
			await mapWithConcurrency(run.tasks, run.mode === "single" ? 1 : run.concurrency, async (task) => {
				const index = run.tasks.indexOf(task);
				await this.runChild(run, task, inputs[index]!, ctx, signal, onUpdate);
				if (run.notifyPerTask && run.background && TERMINAL.includes(task.status)) {
					this.notifyTask(run, task, task.status as "completed" | "failed" | "aborted");
				}
			});
		}

		const failed = run.tasks.some((t) => t.status === "failed");
		const aborted = run.tasks.some((t) => t.status === "aborted") || Boolean(signal?.aborted);
		run.status = aborted ? "aborted" : failed ? "failed" : "completed";
		run.endedAt = Date.now();
		this.flushWidget(run, ctx, onUpdate);
		// Run done: keep the widget only while another run is still live.
		const live = this.listRuns().find((r) => !TERMINAL.includes(r.status));
		if (live) {
			this.scheduleWidget(live, ctx, onUpdate);
		} else {
			this.clearWidget(ctx);
		}
		this.emit("subagent:run-completed", { runId: run.id, status: run.status, run: cloneRun(run), aggregateUsage: run.aggregateUsage });
		this.settleRun(run.id, run);
		this.runControllers.delete(run.id);
		for (const task of run.tasks) this.mailboxes.close(`${run.id}:${task.id}`);
		this.persist(ctx);
	}

	async runBlocking(params: SubagentParamsShape, signal: AbortSignal | undefined, onUpdate: ((partial: any) => void) | undefined, ctx: ExtensionContext): Promise<RunDetails> {
		const { run, inputs } = this.createRun(params, ctx);
		await this.executeTasks(run, inputs, ctx, signal, onUpdate);
		return { run: cloneRun(run) };
	}

	startInBackground(params: SubagentParamsShape, ctx: ExtensionContext): RunDetails {
		const { run, inputs } = this.createRun(params, ctx);
		void this.executeTasks(run, inputs, ctx, undefined, undefined)
			.then(() => {
				this.notifyParent(run, run.status === "completed" ? "completed" : run.status === "aborted" ? "aborted" : "failed");
			})
			.catch((err) => {
				// Never leave a background run unsettled: mark failed, settle, notify.
				run.status = "failed";
				run.endedAt = Date.now();
				for (const task of run.tasks) {
					if (!TERMINAL.includes(task.status)) {
						task.status = "failed";
						task.error = task.error || String(err instanceof Error ? err.message : err);
						task.endedAt = Date.now();
					}
				}
				this.settleRun(run.id, run);
				this.runControllers.delete(run.id);
				for (const task of run.tasks) this.mailboxes.close(`${run.id}:${task.id}`);
				this.emit("subagent:run-completed", { runId: run.id, status: "failed", run: cloneRun(run) });
				this.notifyParent(run, "failed");
				this.persist(ctx);
			});
		return { run: cloneRun(run), background: true };
	}

	cancelRun(runId: string): { aborted: number } {
		const run = this.runs.get(runId);
		if (!run) return { aborted: 0 };
		if (TERMINAL.includes(run.status)) return { aborted: 0 }; // never corrupt a finished run
		let aborted = 0;
		this.runControllers.get(runId)?.abort();
		for (const [key, child] of this.liveChildren) {
			if (key.startsWith(`${runId}:`)) {
				child.abort();
			}
		}
		for (const task of run.tasks) {
			if (TERMINAL.includes(task.status)) continue;
			task.status = "aborted";
			task.error = task.error || "Canceled by subagent_cancel"; // never overwrite a real error
			task.endedAt = Date.now();
			aborted += 1;
		}
		run.status = "aborted";
		run.endedAt = Date.now();
		this.settleRun(runId, run);
		this.runControllers.delete(runId);
		for (const task of run.tasks) this.mailboxes.close(`${run.id}:${task.id}`);
		this.emit("subagent:run-completed", { runId: run.id, status: "aborted", run: cloneRun(run) });
		return { aborted };
	}

	/** Settle-and-delete: awaiters resolve once; no leak, no closure chain. */
	private settleRun(runId: string, run: RunSnapshot): void {
		const s = this.settlers.get(runId);
		if (!s) return;
		this.settlers.delete(runId);
		s(cloneRun(run));
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
			// Settle may have run between the terminal check and wiring.
			if (TERMINAL.includes(run.status)) resolve(cloneRun(run));
		});
		if (!timeoutMs) return settled;
		return Promise.race([
			settled,
			new Promise<RunSnapshot | undefined>((resolve) => {
				const timer = setTimeout(() => resolve(this.runs.get(runId) ? cloneRun(this.runs.get(runId)!) : undefined), timeoutMs);
				settled.then(() => clearTimeout(timer));
			}),
		]);
	}
}

let eventSeq = 0;

// ── tool schemas (slim: short descriptions, no rarely-used knobs) ────────

const TaskItem = Type.Object({
	id: Type.Optional(Type.String({ description: "Optional stable task id" })),
	agent: Type.String({ minLength: 1, description: "Agent name you invent. Always define the agent inline: prompt (system prompt) + toolset (write: true for write access). Never create agent files." }),
	task: Type.String({ minLength: 1, description: "Task for this agent" }),
	prompt: Type.Optional(Type.String({ description: "System prompt defining this agent's behavior. Optional — a minimal default is used." })),
	write: Type.Optional(Type.Boolean({ description: "true = write toolset (read, bash, edit, write); default false = read-only (read, grep, find, ls)" })),
	model: Type.Optional(Type.String({ description: "Model override (provider/model-id)" })),
	thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking level override" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for this task. Default: current project." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Explicit tool allowlist (overrides the toolset)" })),
	maxRuntimeMs: Type.Optional(Type.Number({ description: "Per-task timeout (ms)" })),
});

type SubagentParamsShape = {
	agent?: string;
	task?: string;
	prompt?: string;
	write?: boolean;
	tasks?: TaskInput[];
	chain?: TaskInput[];
	model?: string;
	thinking?: string;
	cwd?: string;
	tools?: string[];
	concurrency?: number;
	maxRuntimeMs?: number;
	background?: boolean;
	allowIntercom?: boolean;
	notifyPerTask?: boolean;
};

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ minLength: 1, description: "Name you invent for this subagent (single mode)" })),
	task: Type.Optional(Type.String({ minLength: 1, description: "Task (single mode)" })),
	prompt: Type.Optional(Type.String({ description: "System prompt for this agent (single mode)" })),
	write: Type.Optional(Type.Boolean({ description: "true = write toolset; default false = read-only (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks" })),
	chain: Type.Optional(Type.Array(TaskItem, { description: "Sequential tasks; {previous} = prior output" })),
	model: Type.Optional(Type.String({ description: "Model override (single mode)" })),
	thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking level override (single mode)" })),
	cwd: Type.Optional(Type.String({ description: "Working directory (single mode). Default: current project." })),
	concurrency: Type.Optional(Type.Number({ description: `Parallel concurrency (default ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY})` })),
	maxRuntimeMs: Type.Optional(Type.Number({ description: `Per-task timeout, ms (default ${DEFAULT_RUNTIME_MS / 60000} min)` })),
	background: Type.Optional(Type.Boolean({ description: "Fire-and-forget: return immediately with a runId; you'll be notified on completion" })),
	notifyPerTask: Type.Optional(Type.Boolean({ description: "Wake you (queued follow-up turn) as each task completes, even mid-run. Default false." })),
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
			ctx.ui.notify(runs.flatMap((run) => compactLines(run).concat("")).join("\n") || "No subagent runs in this session.", "info");
		},
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!manager.turnActivity) manager.clearWidget(ctx);
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
		description: "Define and run isolated subagents (own context, own session). You invent the agent: name, optional system prompt, toolset (read-only default, write:true for edits). Modes: single, parallel (tasks), chain ({previous}). background:true fire-and-forgets with completion notice. allowIntercom:true lets children ask you questions and message each other.\n\nExamples (copy these shapes):\nSingle: subagent({ agent: \"reviewer\", prompt: \"You review code for correctness\", task: \"Review src/auth.ts\" })\nParallel: subagent({ tasks: [{ agent: \"mapper\", task: \"Map all API routes\" }, { agent: \"critic\", task: \"Review auth for vulnerabilities\" }] })\nChain: subagent({ chain: [{ agent: \"planner\", task: \"Plan the change\" }, { agent: \"doer\", write: true, task: \"Execute: {previous}\" }] })\nBackground: subagent({ agent: \"auditor\", task: \"Audit deps\", background: true })",
		promptSnippet: "Define and delegate work to specialized subagents.",
		promptGuidelines: [
			"Use subagent when independent review, testing, research, or parallel analysis improves quality.",
			"Decompose parallelizable work: if the request has 2+ independent sub-tasks (separate files, separate concerns, independent research/review), spawn N agents with a SINGLE call: subagent({ tasks: [{agent, task}, ...] }). NEVER make multiple parallel subagent calls for parallel work — one call, one run, N tasks.",
			"If independent sub-tasks are sequential (each builds on the previous one's output), use chain mode with {previous}.",
			"Define each subagent yourself: an invented name, a focused system prompt (prompt:), and a toolset — read-only (default) or write (write:true).",
			"Prefer read-only subagents unless the task explicitly needs edits.",
			"Use background:true for long-running work; you'll be notified on completion.",
			"Use allowIntercom:true only when a child may need to ask you something; keep children autonomous otherwise.",
		],
		parameters: SubagentParams,
		executionMode: "parallel", // sibling subagent calls run concurrently, not serialized
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
			// Params used, dimmed: model, thinking, toolset, per-task write count.
			const tasks = args.tasks ?? args.chain ?? [];
			const writeCount = tasks.filter((t: any) => t.write).length;
			const parts: string[] = [];
			if (args.model) parts.push(args.model);
			if (args.thinking) parts.push(args.thinking);
			if (args.write) parts.push("write");
			if (writeCount > 0) parts.push(`${writeCount} write`);
			if (args.concurrency) parts.push(`c${args.concurrency}`);
			if (args.maxRuntimeMs) parts.push(`${Math.round(args.maxRuntimeMs / 60000)}m`);
			const params = parts.length > 0 ? `\n  ${theme.fg("dim", parts.join(" · "))}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", mode)}${flags ? ` ${theme.fg("muted", `[${flags}]`)}` : ""}${params}`, 0, 0);
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
			const lines = [header];
			for (const task of run.tasks) {
				lines.push(`  ${statusIcon(task.status)} ${theme.fg("accent", task.agent)}${task.sessionId ? ` ${theme.fg("muted", task.sessionId)}` : ""}`);
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

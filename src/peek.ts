/**
 * Peek pane — quick, read-only look at what subagents are doing.
 *
 * ↑/↓ (or ←/→) move between agents, enter opens a live tail of that child's
 * session file, esc goes back / closes. Never touches run state: no abort,
 * no cancel, no writes.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/** Tail window: last 64KB of the child session file is plenty for a peek. */
const TAIL_BYTES = 64 * 1024;
const POLL_MS = 700;

export interface PeekTask {
	agent: string;
	status: string;
	sessionFile?: string;
	line: string; // pre-rendered stats line from the caller
}

function readTail(path: string): string {
	const fd = openSync(path, "r");
	try {
		const size = statSync(path).size;
		const start = Math.max(0, size - TAIL_BYTES);
		const buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, buf.length, start);
		return buf.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** One session-file line → one display line. Unparseable/irrelevant → null. */
function eventLine(raw: string): string | null {
	let entry: any;
	try {
		entry = JSON.parse(raw);
	} catch {
		return null;
	}
	const msg = entry?.message;
	if (!msg) return null;
	const parts: string[] = [];
	for (const block of msg.content ?? []) {
		if (block.type === "text" && block.text?.trim()) parts.push(block.text.trim());
		else if (block.type === "toolCall") parts.push(`→ ${block.name} ${JSON.stringify(block.arguments ?? {})}`);
		else if (block.type === "thinking" && block.thinking?.trim()) parts.push(`(thinking) ${block.thinking.trim()}`);
	}
	if (parts.length === 0) return null;
	const who = msg.role === "assistant" ? "" : msg.role === "toolResult" ? "  ← " : `${msg.role}: `;
	return `${who}${parts.join(" ").replace(/\s+/g, " ")}`;
}

function tailLines(path: string, max: number): string[] {
	let text: string;
	try {
		text = readTail(path);
	} catch {
		return ["(session file not readable yet)"];
	}
	const lines: string[] = [];
	// First line of a mid-file read is usually a fragment — drop it.
	for (const raw of text.split("\n").slice(1)) {
		const line = eventLine(raw);
		if (line) lines.push(line);
	}
	return lines.slice(-max);
}

export interface PeekPane {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
}

/**
 * Build the peek component. `getTasks` is polled live, so the pane keeps
 * updating while agents run.
 */
export function createPeekPane(getTasks: () => PeekTask[], theme: Theme, requestRender: () => void, close: () => void): PeekPane {
	let selected = 0;
	let tailing = false;
	const timer = setInterval(requestRender, POLL_MS);

	const clamp = (n: number, len: number) => (len === 0 ? 0 : Math.max(0, Math.min(len - 1, n)));

	return {
		render(width: number): string[] {
			const tasks = getTasks();
			selected = clamp(selected, tasks.length);
			if (tasks.length === 0) return [theme.fg("dim", "No subagents in this session.")];
			const task = tasks[selected]!;
			const hint = tailing ? "esc back" : "↑↓ move · enter tail · esc close";
			const head = `${theme.fg("accent", theme.bold(tailing ? task.agent : "Subagents"))} ${theme.fg("dim", `(${selected + 1}/${tasks.length}) · ${hint}`)}`;
			if (!tailing) {
				return [head, ...tasks.map((t, i) => truncateToWidth(`${i === selected ? theme.fg("accent", "❯ ") : "  "}${t.line}`, width, "…"))];
			}
			if (!task.sessionFile) return [head, theme.fg("dim", "(no session file — agent has not started yet)")];
			// ponytail: re-reads the tail each render (700ms poll). A watcher only pays off for files far bigger than a child session.
			return [head, ...tailLines(task.sessionFile, 18).map((l) => truncateToWidth(`  ${l}`, width, "…"))];
		},
		handleInput(data: string): void {
			const len = getTasks().length;
			if (matchesKey(data, Key.escape)) {
				if (tailing) tailing = false;
				else close();
			} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
				tailing = true;
			} else if (matchesKey(data, Key.left)) {
				tailing = false;
			} else if (matchesKey(data, Key.up)) {
				selected = clamp(selected - 1, len);
			} else if (matchesKey(data, Key.down)) {
				selected = clamp(selected + 1, len);
			}
			requestRender();
		},
		invalidate(): void {
			/* no cached strings */
		},
		dispose(): void {
			clearInterval(timer);
		},
	};
}

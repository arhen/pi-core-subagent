import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createPeekPane, type PeekTask } from "../src/peek.ts";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as any;

test("peek pane: navigate + tail, never mutates tasks", () => {
	const dir = mkdtempSync(join(tmpdir(), "peek-"));
	const file = join(dir, "child.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "do the thing" }] } }),
			JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }] } }),
		].join("\n"),
	);
	const tasks: PeekTask[] = [
		{ runId: "r1", taskId: "t1", agent: "rev-a", status: "running", running: true, sessionFile: file, line: "• rev-a · 3 tools" },
		{ runId: "r1", taskId: "t2", agent: "rev-b", status: "running", running: true, line: "• rev-b · 1 tools" },
	];
	const snapshot = JSON.stringify(tasks);
	let closed = false;
	const aborted: string[] = [];
	const pane = createPeekPane(() => tasks, theme, () => {}, () => (closed = true), (t) => aborted.push(t.taskId));

	expect(pane.render(80).join("\n")).toMatch(/❯ • rev-a/);
	pane.handleInput("\x1b[B"); // down
	expect(pane.render(80).join("\n")).toMatch(/❯ • rev-b/);
	pane.handleInput("\x1b[A"); // up
	pane.handleInput("\r"); // enter → tail
	const tail = pane.render(80).join("\n");
	expect(tail).toMatch(/→ read/);
	pane.handleInput("\x1b"); // esc → back to list
	expect(pane.render(80).join("\n")).toMatch(/❯ • rev-a/);
	expect(closed).toBe(false);
	pane.handleInput("\x1b"); // esc → close
	expect(closed).toBe(true);

	// abort needs confirmation: x then n does nothing, x then y fires once
	pane.handleInput("x");
	expect(pane.render(80).join("\n")).toMatch(/abort rev-a\? y \/ n/);
	pane.handleInput("n");
	expect(aborted).toEqual([]);
	pane.handleInput("x");
	pane.handleInput("y");
	expect(aborted).toEqual(["t1"]);
	expect(JSON.stringify(tasks)).toBe(snapshot); // peek must not mutate run state
	pane.dispose();
});

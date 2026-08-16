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
		{ agent: "rev-a", status: "running", sessionFile: file, line: "• rev-a · 3 tools" },
		{ agent: "rev-b", status: "running", line: "• rev-b · 1 tools" },
	];
	const snapshot = JSON.stringify(tasks);
	let closed = false;
	const pane = createPeekPane(() => tasks, theme, () => {}, () => (closed = true));

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
	expect(JSON.stringify(tasks)).toBe(snapshot); // peek must not mutate run state
	pane.dispose();
});

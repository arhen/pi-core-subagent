/**
 * Smoke tests: failure classification + mailbox routing + watchdog.
 * Pure logic only — no pi runtime needed. Run: bun test
 */
import { describe, expect, test } from "bun:test";
import { classifyFailure } from "../src/index.ts";
import { createWatchdog } from "../src/child.ts";
import { createMailbox } from "../src/mailbox.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupAgent } from "../src/agents.ts";

describe("lookupAgent", () => {
	test("finds project .agents file and parses frontmatter", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sa-test-"));
		try {
			mkdirSync(join(cwd, ".agents"), { recursive: true });
			writeFileSync(
				join(cwd, ".agents", "critic.md"),
				"---\nname: critic\ndescription: harsh reviewer\ntools: read,grep\nthinking: high\n---\nYou are harsh.\n",
			);
			const a = lookupAgent("critic", cwd);
			expect(a?.prompt).toBe("You are harsh.");
			expect(a?.tools).toEqual(["read", "grep"]);
			expect(a?.thinking).toBe("high");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	test("returns undefined for unknown agent / missing dirs", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sa-test-"));
		try {
			expect(lookupAgent("nope", cwd)).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	test("name must match frontmatter", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sa-test-"));
		try {
			mkdirSync(join(cwd, ".agents"), { recursive: true });
			writeFileSync(join(cwd, ".agents", "x.md"), "---\nname: other\n---\nbody\n");
			expect(lookupAgent("x", cwd)).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});


describe("classifyFailure", () => {
	test("stop/end/undefined → no failure (normal completion)", () => {
		expect(classifyFailure("stop")).toBeUndefined();
		expect(classifyFailure("end")).toBeUndefined();
		expect(classifyFailure(undefined)).toBeUndefined();
	});
	test("aborted → aborted status", () => {
		expect(classifyFailure("aborted")?.status).toBe("aborted");
	});
	test("any other stopReason → failed", () => {
		for (const reason of ["max_tokens", "refusal", "length", "error"]) {
			expect(classifyFailure(reason)?.status).toBe("failed");
		}
	});
});

describe("mailbox", () => {
	test("send + poll routes and drains", () => {
		const mb = createMailbox();
		mb.open("task_1");
		mb.open("task_2");
		mb.send("task_1", "task_2", "hi there");
		expect(mb.poll("task_1")).toHaveLength(0);
		const got = mb.poll("task_2");
		expect(got).toHaveLength(1);
		expect(got[0]!.text).toBe("hi there");
		expect(got[0]!.from).toBe("task_1");
		expect(mb.poll("task_2")).toHaveLength(0); // drained
	});
	test("unknown target rejected", () => {
		const mb = createMailbox();
		mb.open("task_1");
		expect(mb.send("task_1", "nope", "x")).toBe(false);
	});
	test("unknown sender rejected", () => {
		const mb = createMailbox();
		mb.open("task_1");
		expect(mb.send("ghost", "task_1", "x")).toBe(false);
	});
});

describe("watchdog", () => {
	test("dispose resolves nothing and is idempotent", async () => {
		const wd = createWatchdog(10_000, "test");
		wd.dispose();
		wd.dispose();
		expect(wd).toBeTruthy();
	});
});

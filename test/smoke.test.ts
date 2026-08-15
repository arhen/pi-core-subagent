/**
 * Smoke tests: agent discovery/catalog + mailbox routing + failure classification.
 * Pure logic only — no pi runtime needed. Run: bun test
 */
import { describe, expect, test } from "bun:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { classifyFailure } from "../src/index.ts";
import { createWatchdog } from "../src/child.ts";
import { createMailbox } from "../src/mailbox.ts";

describe("classifyFailure", () => {
	test("end → no failure", () => {
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

describe("agents", () => {
	test("agent dir exists (pi runtime present)", () => {
		expect(getAgentDir()).toBeTruthy();
	});
});

/**
 * Wave scheduling (Graph Protocol §2) + edge payload (§6).
 * Pure logic — no pi runtime needed.
 */
import { describe, expect, test } from "bun:test";
import { applyUpstream, resolveNeeds } from "../src/index.ts";

describe("resolveNeeds", () => {
	test("parallel with no needs is one wave", () => {
		expect(resolveNeeds([{ id: "a" }, { id: "b" }], "parallel")).toEqual([[], []]);
	});

	test("chain becomes needs:[previous] regardless of declared needs", () => {
		expect(resolveNeeds([{ id: "a" }, { id: "b" }, { id: "c" }], "chain")).toEqual([[], ["a"], ["b"]]);
	});

	test("default ids are task_N so needs can reference undeclared tasks", () => {
		expect(resolveNeeds([{}, { needs: ["task_1"] }], "parallel")).toEqual([[], ["task_1"]]);
	});

	test("duplicate needs collapse", () => {
		expect(resolveNeeds([{ id: "a" }, { id: "b", needs: ["a", "a"] }], "parallel")).toEqual([[], ["a"]]);
	});

	test("diamond resolves", () => {
		const edges = resolveNeeds([{ id: "a" }, { id: "b", needs: ["a"] }, { id: "c", needs: ["a"] }, { id: "d", needs: ["b", "c"] }], "parallel");
		expect(edges).toEqual([[], ["a"], ["a"], ["b", "c"]]);
	});

	test("unknown id rejected", () => {
		expect(() => resolveNeeds([{ id: "a", needs: ["ghost"] }], "parallel")).toThrow(/unknown task id: ghost/);
	});

	test("self-edge rejected", () => {
		expect(() => resolveNeeds([{ id: "a", needs: ["a"] }], "parallel")).toThrow(/cannot need itself/);
	});

	test("cycle rejected before anything spawns", () => {
		expect(() => resolveNeeds([{ id: "a", needs: ["b"] }, { id: "b", needs: ["a"] }], "parallel")).toThrow(/Cycle in subagent needs/);
	});
});

describe("applyUpstream", () => {
	test("no needs passes the task through untouched", () => {
		expect(applyUpstream("do it", [], new Map())).toBe("do it");
	});

	test("upstream output is prepended, not just ordered", () => {
		const out = applyUpstream("write tests", ["a"], new Map([["a", "the plan"]]));
		expect(out).toContain("## Output of a");
		expect(out).toContain("the plan");
		expect(out.endsWith("write tests")).toBe(true);
	});

	test("multiple upstreams each get a block", () => {
		const out = applyUpstream("merge", ["a", "b"], new Map([["a", "A"], ["b", "B"]]));
		expect(out).toContain("## Output of a");
		expect(out).toContain("## Output of b");
	});

	test("{previous} still expands for legacy chain prompts", () => {
		expect(applyUpstream("build on: {previous}", ["a"], new Map([["a", "STEP1"]]))).toContain("build on: STEP1");
	});

	test("{previous} with no upstream is emptied and flagged", () => {
		const out = applyUpstream("build on: {previous}", [], new Map());
		expect(out.split("\n")[0]).toBe("build on: "); // placeholder substituted, not left literal
		expect(out).toContain("was empty");
	});

	test("$ in upstream output is not treated as a replacement pattern", () => {
		expect(applyUpstream("use {previous}", ["a"], new Map([["a", "$& $1 cost"]]))).toContain("use $& $1 cost");
	});
});

describe("wave frontier", () => {
	/** Mirrors executeTasks: ready = every need settled. */
	function waves(tasks: { id: string; needs: string[] }[]): string[][] {
		const settled = new Set<string>();
		let remaining = [...tasks];
		const out: string[][] = [];
		while (remaining.length > 0) {
			const ready = remaining.filter((t) => t.needs.every((n) => settled.has(n)));
			if (ready.length === 0) break;
			out.push(ready.map((t) => t.id));
			for (const t of ready) settled.add(t.id);
			remaining = remaining.filter((t) => !settled.has(t.id));
		}
		return out;
	}

	test("independent tasks form a single wave", () => {
		expect(waves([{ id: "a", needs: [] }, { id: "b", needs: [] }])).toEqual([["a", "b"]]);
	});

	test("diamond runs as 3 waves with b,c parallel", () => {
		expect(
			waves([
				{ id: "a", needs: [] },
				{ id: "b", needs: ["a"] },
				{ id: "c", needs: ["a"] },
				{ id: "d", needs: ["b", "c"] },
			]),
		).toEqual([["a"], ["b", "c"], ["d"]]);
	});

	test("chain degenerates to one task per wave", () => {
		expect(waves([{ id: "a", needs: [] }, { id: "b", needs: ["a"] }, { id: "c", needs: ["b"] }])).toEqual([["a"], ["b"], ["c"]]);
	});
});

/**
 * Optional agent-file lookup — fallback for inline definitions.
 *
 * The leader defines agents inline (prompt + toolset). If a task has no inline
 * prompt, we LOOK UP a file by agent name — never create one:
 *   <cwd>/.agents/<name>.md        (nearest project dir first)
 *   <cwd>/.pi/agents/<name>.md
 *   ~/.pi/agent/agents/<name>.md   (user)
 * First match wins; explicit inline params always override file contents.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface FileAgent {
	prompt: string;
	tools?: string[];
	model?: string;
	thinking?: string;
}

function projectAgentDirs(cwd: string): string[] {
	const out: string[] = [];
	let dir = cwd;
	for (;;) {
		for (const sub of [".agents", path.join(".pi", "agents")]) {
			const candidate = path.join(dir, sub);
			try {
				if (fs.statSync(candidate).isDirectory()) out.push(candidate);
			} catch {
				/* missing dir is fine */
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return out;
}

export function lookupAgent(name: string, cwd: string): FileAgent | undefined {
	const dirs = [...projectAgentDirs(cwd), path.join(getAgentDir(), "agents")];
	for (const dir of dirs) {
		const filePath = path.join(dir, `${name}.md`);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		try {
			const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
			if (!frontmatter.name || frontmatter.name !== name) continue;
			const tools = frontmatter.tools
				?.split(",")
				.map((t) => t.trim())
				.filter(Boolean);
			return {
				prompt: body,
				tools: tools && tools.length > 0 ? tools : undefined,
				model: frontmatter.model,
				thinking: frontmatter.thinking,
			};
		} catch {
			continue;
		}
	}
	return undefined;
}

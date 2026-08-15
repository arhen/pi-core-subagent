/**
 * Agent discovery — markdown agents from user + project dirs.
 * Cached (TTL + dir mtime) so the context hook never pays an fs scan per turn.
 *
 * Format (frontmatter): name, description required; tools/model/thinking optional.
 *   tools: comma-separated pi tool names (default: read-only core tools).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

const CACHE_TTL_MS = 15_000;

function readAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;
		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			systemPrompt: body,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			thinking: frontmatter.thinking,
			source,
			filePath,
		});
	}
	return agents;
}

function findProjectAgentsDir(cwd: string): string | null {
	let dir = cwd;
	for (;;) {
		const candidate = path.join(dir, ".pi", "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			/* keep walking up */
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

let cache: { key: string; dirMtime: number; at: number; result: AgentDiscoveryResult } | undefined;

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectDir = findProjectAgentsDir(cwd);
	const key = `${userDir}:${scope}:${projectDir ?? ""}`;

	// Dir mtime catches added/removed agent files; TTL catches content edits.
	let dirMtime = 0;
	for (const dir of [userDir, projectDir]) {
		if (!dir) continue;
		try {
			dirMtime = Math.max(dirMtime, fs.statSync(dir).mtimeMs);
		} catch {
			/* missing dir is fine */
		}
	}
	if (cache && cache.key === key && cache.dirMtime === dirMtime && Date.now() - cache.at < CACHE_TTL_MS) {
		return cache.result;
	}

	const userAgents = scope === "project" ? [] : readAgentsFromDir(userDir, "user");
	const projectAgents = scope !== "user" && projectDir ? readAgentsFromDir(projectDir, "project") : [];
	const byName = new Map<string, AgentConfig>();
	for (const agent of userAgents) byName.set(agent.name, agent); // project overrides user
	for (const agent of projectAgents) byName.set(agent.name, agent);

	cache = { key, dirMtime, at: Date.now(), result: { agents: [...byName.values()], projectAgentsDir: projectDir } };
	return cache.result;
}

/** One line per agent — the whole catalog is ~50-80 tokens, injected per request. */
export function formatAgentCatalog(agents: AgentConfig[]): string {
	if (agents.length === 0) return "No subagents are configured.";
	return agents
		.map((a) => {
			const extra = [
				a.model && `model=${a.model}`,
				a.thinking && `thinking=${a.thinking}`,
				a.tools?.length && `tools=${a.tools.join(",")}`,
			]
				.filter(Boolean)
				.join(" ");
			return `- ${a.name} (${a.source})${extra ? ` ${extra}` : ""}: ${a.description}`;
		})
		.join("\n");
}

export function resolveAgent(agents: AgentConfig[], requested: string | undefined): AgentConfig | undefined {
	const raw = requested?.trim();
	if (!raw) return undefined;
	return agents.find((a) => a.name === raw) ?? agents.find((a) => a.name.toLowerCase() === raw.toLowerCase());
}

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "./utils.ts";

export const ENGINEERING_POLICY_FILE_NAME = "ENGINEERING.md";
const ENGINEERING_POLICY_START = "<!-- pi-subagents:engineering-policy:start -->";
const ENGINEERING_POLICY_END = "<!-- pi-subagents:engineering-policy:end -->";

export function engineeringPolicyPath(): string {
	return path.join(getAgentDir(), ENGINEERING_POLICY_FILE_NAME);
}

export function readEngineeringPolicy(): string {
	try {
		return fs.readFileSync(engineeringPolicyPath(), "utf8").trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

export function stripEngineeringPolicy(prompt: string): string {
	const escapedStart = ENGINEERING_POLICY_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const escapedEnd = ENGINEERING_POLICY_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return prompt
		.replace(new RegExp(`(?:\\r?\\n){0,2}${escapedStart}[\\s\\S]*?${escapedEnd}(?:\\r?\\n){0,2}`, "g"), "\n\n")
		.trim();
}

export function appendEngineeringPolicy(prompt: string, policy: string): string {
	const base = stripEngineeringPolicy(prompt);
	const body = policy.trim();
	if (!body) return base;
	const block = `${ENGINEERING_POLICY_START}\n# Global Engineering Policy\n\n${body}\n${ENGINEERING_POLICY_END}`;
	return base ? `${base}\n\n${block}` : block;
}

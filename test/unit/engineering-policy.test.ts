import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import {
	appendEngineeringPolicy,
	engineeringPolicyPath,
	readEngineeringPolicy,
	stripEngineeringPolicy,
} from "../../src/shared/engineering-policy.ts";

it("appends engineering policy idempotently and replaces stale copies", () => {
	const once = appendEngineeringPolicy("base prompt", "Own each fact once.");
	assert.match(once, /# Global Engineering Policy/);
	assert.match(once, /Own each fact once\./);

	const twice = appendEngineeringPolicy(once, "Prefer derivation over duplication.");
	assert.doesNotMatch(twice, /Own each fact once\./);
	assert.match(twice, /Prefer derivation over duplication\./);
	assert.equal(twice.match(/# Global Engineering Policy/g)?.length, 1);
	assert.equal(stripEngineeringPolicy(twice), "base prompt");
});

it("reads ENGINEERING.md from the Pi agent directory and tolerates absence", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-engineering-policy-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = dir;
		assert.equal(engineeringPolicyPath(), path.join(dir, "ENGINEERING.md"));
		assert.equal(readEngineeringPolicy(), "");
		fs.writeFileSync(path.join(dir, "ENGINEERING.md"), "\nOwnership rule.\n");
		assert.equal(readEngineeringPolicy(), "Ownership rule.");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

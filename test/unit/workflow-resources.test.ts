import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerWorkflowResource, type WorkflowResourceDefinition } from "../../src/api/workflow-resources.ts";
import {
	authorizeWorkflowResourceHost,
	consumeWorkflowResourcePermit,
} from "../../src/shared/workflow-child-permit.ts";
import { resolveWorkflowResource } from "../../src/workflows/workflow-resources.ts";
import { runWorkflowScript, WorkflowScriptError } from "../../src/workflows/scripted-workflow.ts";

describe("named workflow resources", () => {
	it("scopes registrations by session and snapshots definitions, args and issued grants", () => {
		const args = { nested: { task: "original" } };
		const expansion = { script: "return 'original';", hostCommands: [{ key: "check", command: " node check.mjs " }, { key: "other", command: "node other.mjs" }] };
		const definition: WorkflowResourceDefinition = {
			name: "acme.check", version: 2,
			resolve(input) {
				(input.nested as { task: string }).task = "changed";
				return expansion;
			},
		};
		const registration = registerWorkflowResource({ sessionId: "one", definition });
		const other = registerWorkflowResource({ sessionId: "two", definition: { ...definition, resolve: () => ({ script: "return 'two';" }) } });
		try {
			definition.version = 99;
			definition.resolve = () => ({ error: "replacement must not run" });
			assert.throws(() => registerWorkflowResource({ sessionId: "one", definition }), /already registered/);
			assert.equal(resolveWorkflowResource("acme.check", args).ok, false);
			assert.equal(resolveWorkflowResource("acme.check", args, "wrong").ok, false);
			const resolved = resolveWorkflowResource("acme.check", args, "one");
			assert.equal(resolved.ok, true);
			if (!resolved.ok) return;
			assert.equal(args.nested.task, "original");
			assert.equal(resolved.resource.provenance.version, 2);
			expansion.script = "return 'changed';";
			expansion.hostCommands[0].command = "node changed.mjs";
			registration.dispose();
			assert.equal(resolveWorkflowResource("acme.check", args, "one").ok, false);
			const replacement = registerWorkflowResource({ sessionId: "one", definition: { ...definition, resolve: () => ({ script: "return 'new';" }) } });
			try {
				registration.dispose();
				assert.equal(resolveWorkflowResource("acme.check", {}, "one").ok, true);
				assert.equal(resolveWorkflowResource("acme.check", {}, "two").ok, true);
				const consumed = consumeWorkflowResourcePermit(resolved.resource.permit, resolved.resource.script);
				assert.equal(typeof consumed, "object");
				assert.equal(resolved.resource.script, "return 'original';");
				assert.equal(authorizeWorkflowResourceHost(resolved.resource.permit, "check", "node check.mjs"), undefined);
				assert.equal(authorizeWorkflowResourceHost(resolved.resource.permit, "other", "node other.mjs"), undefined);
				assert.match(authorizeWorkflowResourceHost(resolved.resource.permit, "check", "node other.mjs")!, /not allowed/);
				assert.match(authorizeWorkflowResourceHost(resolved.resource.permit, "other", "node check.mjs")!, /not allowed/);
				assert.match(authorizeWorkflowResourceHost(resolved.resource.permit, "check", "node changed.mjs")!, /not allowed/);
				assert.match(consumeWorkflowResourcePermit(resolved.resource.permit, resolved.resource.script) as string, /already consumed/);
			} finally { replacement.dispose(); }
		} finally { registration.dispose(); other.dispose(); }
	});

	it("lets trusted validation select fixed commands while task text remains data", async () => {
		const registration = registerWorkflowResource({ sessionId: "binding", definition: {
			name: "acme.review-check", version: 1,
			resolve(args) {
				if (Object.keys(args).some((key) => key !== "task" && key !== "check") || typeof args.task !== "string" || args.check !== "quick") return { error: "Only task and check=quick are supported." };
				return { script: `return ${JSON.stringify(args.task)};`, hostCommands: [{ key: "check", command: "node check.mjs --quick" }] };
			},
		} });
		try {
			const task = `\"); await runs.host("injected", { command: "bad" }); //`;
			const resolved = resolveWorkflowResource("acme.review-check", { task, check: "quick" }, "binding");
			assert.equal(resolved.ok, true);
			if (!resolved.ok) return;
			const execution = await runWorkflowScript({
				script: resolved.resource.script,
				async launch() { throw new Error("No child expected"); },
				async status() { throw new Error("No status expected"); },
			});
			assert.equal(execution.value, task);
			for (const args of [{ task, check: "quick; bad" }, { task, check: "quick", flags: "--extra" }, { task, check: "quick", command: "bad" }, { task: new Date(), check: "quick" }, { task: "x".repeat(16385), check: "quick" }]) {
				assert.equal(resolveWorkflowResource("acme.review-check", args, "binding").ok, false);
			}
		} finally { registration.dispose(); }
	});

	it("rejects invalid registrations and protects builtin names", () => {
		const valid = { sessionId: "validation", definition: { name: "acme.check", version: 1, resolve: () => ({ script: "return true;" }) } };
		for (const input of [
			{ ...valid, sessionId: " " },
			{ ...valid, trusted: true },
			{ ...valid, definition: { ...valid.definition, name: "run-ci" } },
			{ ...valid, definition: { ...valid.definition, name: "review" } },
			{ ...valid, definition: { ...valid.definition, name: "bad name" } },
			{ ...valid, definition: { ...valid.definition, version: 0 } },
			{ ...valid, definition: { ...valid.definition, resolve: undefined } },
			{ ...valid, definition: { ...valid.definition, issuerPackage: "trusted" } },
		]) assert.throws(() => registerWorkflowResource(input as typeof valid));
	});

	it("contains throws, async results and malformed expansions without issuing permits", async () => {
		const invalid = [
			() => { throw new Error("x".repeat(5000)); },
			() => Promise.reject(new Error("async rejection")),
			() => ({ then(resolve: (value: unknown) => void) { resolve({ script: "return true;" }); } }),
			() => null,
			() => ({ script: " " }),
			() => ({ script: "return true;", authority: {} }),
			() => ({ error: 42 }),
			() => ({ script: "return true;", hostCommands: { keys: ["a"], commands: ["node a.mjs"] } }),
			() => ({ script: "return true;", hostCommands: [{ key: "a", command: "node a.mjs" }, { key: "a", command: "node b.mjs" }] }),
			() => ({ script: "return true;", hostCommands: [{ key: "../a", command: "node a.mjs" }] }),
			() => ({ script: "return true;", hostCommands: [{ key: "a", command: "node\0a" }] }),
		];
		for (const resolve of invalid) {
			const registration = registerWorkflowResource({ sessionId: "invalid", definition: { name: "acme.invalid", version: 1, resolve: resolve as WorkflowResourceDefinition["resolve"] } });
			try {
				const result = resolveWorkflowResource("acme.invalid", {}, "invalid");
				assert.equal(result.ok, false);
				assert.equal("resource" in result, false);
				if (!result.ok) assert.ok(result.error.length <= 4096);
			} finally { registration.dispose(); }
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	});

	it("shares registrations across evaluated module copies", async () => {
		const copy = await import(`../../src/workflows/workflow-resources.ts?copy=registration-test`);
		const registration = copy.registerWorkflowResource({ sessionId: "copies", definition: { name: "acme.copy", version: 1, resolve: () => ({ script: "return true;" }) } });
		try {
			assert.notEqual(copy.resolveWorkflowResource, resolveWorkflowResource);
			const resolved = resolveWorkflowResource("acme.copy", {}, "copies");
			assert.equal(resolved.ok, true);
			if (resolved.ok) assert.equal(typeof consumeWorkflowResourcePermit(resolved.resource.permit, resolved.resource.script), "object");
		} finally { registration.dispose(); }
		assert.equal(resolveWorkflowResource("acme.copy", {}, "copies").ok, false);
	});

	it("resolves and executes an extension-owned named workflow script", async () => {
		const resolved = resolveWorkflowResource("run-ci", { command: "npm test", timeoutMs: 1_000 });
		assert.equal(resolved.ok, true);
		if (!resolved.ok) return;
		assert.match(resolved.resource.script, /runs\.host\("ci"/);
		assert.deepEqual(resolved.resource.provenance, {
			kind: "workflow",
			name: "run-ci",
			version: 1,
			invocation: "named",
			expansion: "resolved",
			id: resolved.resource.provenance.id,
		});
		assert.equal(authorizeWorkflowResourceHost(resolved.resource.permit, "ci", "npm test"), "Workflow resource authority is unavailable.");
		const consumed = consumeWorkflowResourcePermit(resolved.resource.permit, resolved.resource.script);
		assert.equal(typeof consumed, "object");
		assert.equal(authorizeWorkflowResourceHost(resolved.resource.permit, "ci", "npm test"), undefined);
		const execution = await runWorkflowScript({
			script: resolved.resource.script,
			async host(key, params) {
				assert.equal(key, "ci");
				assert.equal(params.command, "npm test");
				return { key, kind: "command", ok: true, state: "passed", exitCode: 0, stdout: "ok", stderr: "", outputPath: "ci.log", durationMs: 1 };
			},
			async launch(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
			async status(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
		});
		assert.equal((execution.value as { ok?: boolean }).ok, true);
	});

	it("resolves reviewed implementation into one writer and fresh structured review", async () => {
		const resolved = resolveWorkflowResource("reviewed-implementation", {
			task: "Implement the requested fix.",
			skill: "stationer-sqlmesh-operations",
			maxReviewRounds: 2,
		});
		assert.equal(resolved.ok, true);
		if (!resolved.ok) return;
		assert.match(resolved.resource.script, /runs\.run\("implement"/);
		assert.match(resolved.resource.script, /agent: "reviewer"/);
		assert.doesNotMatch(resolved.resource.script, /gate:/);
		assert.match(resolved.resource.script, /resume: writer\.runId/);
		assert.match(resolved.resource.script, /verdict: "accepted"/);
		consumeWorkflowResourcePermit(resolved.resource.permit, resolved.resource.script);
		assert.match(authorizeWorkflowResourceHost(resolved.resource.permit, "gate-0", "npm test")!, /not allowed|unavailable/);

		const launches: Array<{ key: string; params: Record<string, unknown> }> = [];
		const stateWrites: Array<[string, unknown]> = [];
		const execution = await runWorkflowScript({
			script: resolved.resource.script,
			state: { get: () => undefined, set: (key, value) => stateWrites.push([key, value]) },
			async launch(key, params) {
				launches.push({ key, params });
				if (key === "implement") return { key, ok: true, runId: "writer-1", output: "implemented", artifactPaths: [] };
				if (key === "review-1") return { key, ok: true, runId: "reviewer-1", output: "clean", structuredOutput: { verdict: "clean", findings: [] }, artifactPaths: [] };
				throw new Error(`Unexpected child ${key}`);
			},
			async status(key) { return { key, ok: true, output: "complete", artifactPaths: [] }; },
		});
		assert.deepEqual(launches.map(({ key }) => key), ["implement", "review-1"]);
		assert.equal(launches[0]?.params.skill, "stationer-sqlmesh-operations");
		assert.equal(launches[1]?.params.agent, "reviewer");
		assert.equal(launches[1]?.params.acceptance, false);
		assert.match(String(launches[1]?.params.task), /Implement the requested fix\./);
		assert.match(String(launches[1]?.params.task), /Current writer evidence:\nimplemented/);
		assert.deepEqual(stateWrites, [["nextReadyAction", "Continue the mission after accepted implementation through its remaining delivery and verification work."]]);
		assert.deepEqual(execution.value, { verdict: "accepted", writerRunId: "writer-1", reviewerRunId: "reviewer-1", reviewRounds: 1 });
	});

	it("repairs through the original writer and requires a fresh clean review", async () => {
		const resolved = resolveWorkflowResource("reviewed-implementation", { task: "Fix", maxReviewRounds: 2 });
		assert.equal(resolved.ok, true);
		if (!resolved.ok) return;
		const launches: Array<{ key: string; params: Record<string, unknown> }> = [];
		const execution = await runWorkflowScript({
			script: resolved.resource.script,
			async launch(key, params) {
				launches.push({ key, params });
				if (key === "implement") return { key, ok: true, runId: "writer-1", output: "first", artifactPaths: [] };
				if (key === "review-1") return { key, ok: true, runId: "reviewer-1", output: "blocked", structuredOutput: { verdict: "blockers", findings: ["Fix edge case"] }, artifactPaths: [] };
				if (key === "repair-1") return { key, ok: true, runId: "writer-2", output: "fixed", artifactPaths: [] };
				if (key === "review-2") return { key, ok: true, runId: "reviewer-2", output: "clean", structuredOutput: { verdict: "clean", findings: [] }, artifactPaths: [] };
				throw new Error(`Unexpected child ${key}`);
			},
			async status(key) { return { key, ok: true, output: "complete", artifactPaths: [] }; },
		});
		assert.deepEqual(launches.map(({ key }) => key), ["implement", "review-1", "repair-1", "review-2"]);
		assert.equal(launches[2]?.params.resume, "writer-1");
		assert.match(String(launches[2]?.params.task), /Fix edge case/);
		assert.match(String(launches[2]?.params.task), /Original implementation contract:\nFix/);
		assert.match(String(launches[2]?.params.task), /non-mutating verification/);
		assert.match(String(launches[3]?.params.task), /Current writer evidence:\nfixed/);
		assert.deepEqual(execution.value, { verdict: "accepted", writerRunId: "writer-2", reviewerRunId: "reviewer-2", reviewRounds: 2 });
	});

	it("fails the stage when the reviewer run fails instead of silently repairing", async () => {
		const resolved = resolveWorkflowResource("reviewed-implementation", { task: "Fix", maxReviewRounds: 2 });
		assert.equal(resolved.ok, true);
		if (!resolved.ok) return;
		const launches: string[] = [];
		await assert.rejects(runWorkflowScript({
			script: resolved.resource.script,
			async launch(key) {
				launches.push(key);
				if (key === "implement") return { key, ok: true, runId: "writer-1", output: "implemented", artifactPaths: [] };
				if (key === "review-1") return { key, ok: false, runId: "reviewer-1", output: "review failed", error: "review failed", artifactPaths: [] };
				throw new Error(`Unexpected child ${key}`);
			},
			async status(key) { return { key, ok: true, output: "complete", artifactPaths: [] }; },
		}), /review-1.*review failed/);
		assert.deepEqual(launches, ["implement", "review-1"]);
	});

	it("bounds reviewed implementation configuration", () => {
		for (const args of [
			{},
			{ task: "Fix", skill: "" },
			{ task: "Fix", maxReviewRounds: 4 },
			{ task: "Fix", gate: "npm test" },
			{ task: "Fix", reviewer: "oracle" },
		]) assert.equal(resolveWorkflowResource("reviewed-implementation", args).ok, false);
	});

	it("qualifies fixed evidence claims with one fresh isolated verifier", async () => {
		const resolved = resolveWorkflowResource("evidence-qualification", {
			contract: "The scorer must preserve key identity and valid uncertainty.",
			claims: [
				{ id: "keys", claim: "Output keys preserve the input case identity." },
				{ id: "intervals", claim: "Bootstrap intervals represent non-degenerate uncertainty." },
			],
			skill: "research-score-qualification",
		});
		assert.equal(resolved.ok, true);
		if (!resolved.ok) return;
		const launches: Array<{ key: string; params: Record<string, unknown> }> = [];
		const hostCalls: Array<{ key: string; command: string }> = [];
		const execution = await runWorkflowScript({
			script: resolved.resource.script,
			async host(key, params) {
				hostCalls.push({ key, command: params.command });
				return { key, kind: "command", ok: true, state: "passed", exitCode: 0, stdout: "abc123\n", stderr: "", outputPath: "source-state.log", durationMs: 1 };
			},
			async launch(key, params) {
				launches.push({ key, params });
				return {
					key,
					ok: true,
					runId: "verifier-1",
					output: "qualified",
					structuredOutput: {
						findings: [
							{ id: "keys", status: "verified", evidence: ["independent shuffled-key probe passed"] },
							{ id: "intervals", status: "verified", evidence: ["collapsed-interval mutant was rejected"] },
						],
						residualRisks: [],
					},
					artifactPaths: [],
				};
			},
			async status(key) { return { key, ok: true, output: "complete", artifactPaths: [] }; },
		});
		assert.deepEqual(launches.map(({ key }) => key), ["verifier"]);
		assert.equal(hostCalls.length, 2);
		assert.deepEqual(hostCalls.map(({ key }) => key), ["source-state-before", "source-state-after"]);
		assert.ok(hostCalls.every(({ command }) => command.includes("git status --porcelain")));
		assert.equal(launches[0]?.params.agent, "verifier");
		assert.equal(launches[0]?.params.context, "fresh");
		assert.equal(launches[0]?.params.worktree, true);
		assert.equal(launches[0]?.params.acceptance, false);
		assert.equal(launches[0]?.params.skill, "research-score-qualification");
		assert.match(String(launches[0]?.params.task), /fixed qualification contract/i);
		assert.match(String(launches[0]?.params.task), /falsification probes/i);
		assert.deepEqual(execution.value, {
			verdict: "qualified",
			findings: [
				{ id: "keys", status: "verified", evidence: ["independent shuffled-key probe passed"] },
				{ id: "intervals", status: "verified", evidence: ["collapsed-interval mutant was rejected"] },
			],
			residualRisks: [],
			verifierRunId: "verifier-1",
		});
		const consumed = consumeWorkflowResourcePermit(resolved.resource.permit, resolved.resource.script);
		assert.equal(typeof consumed, "object");
		assert.equal(authorizeWorkflowResourceHost(resolved.resource.permit, "source-state-before", hostCalls[0]!.command), undefined);
		assert.equal(authorizeWorkflowResourceHost(resolved.resource.permit, "source-state-after", hostCalls[1]!.command), undefined);
		assert.match(authorizeWorkflowResourceHost(resolved.resource.permit, "ci", "npm test") ?? "", /not allowed/);
	});

	it("fails evidence qualification closed on non-verified or incomplete claim results", async () => {
		const args = {
			contract: "Fixed contract",
			claims: [{ id: "a", claim: "A" }, { id: "b", claim: "B" }],
		};
		for (const [label, structuredOutput, expected] of [
			["contradicted", { findings: [{ id: "a", status: "verified", evidence: ["a"] }, { id: "b", status: "contradicted", evidence: ["b failed"] }], residualRisks: [] }, "not-qualified"],
			["unverified", { findings: [{ id: "a", status: "verified", evidence: ["a"] }, { id: "b", status: "unverified", evidence: ["insufficient oracle"] }], residualRisks: [] }, "not-qualified"],
		] as const) {
			const resolved = resolveWorkflowResource("evidence-qualification", args);
			assert.equal(resolved.ok, true, label);
			if (!resolved.ok) continue;
			const execution = await runWorkflowScript({
				script: resolved.resource.script,
				async host(key) { return { key, kind: "command", ok: true, state: "passed", exitCode: 0, stdout: "same\n", stderr: "", outputPath: "source-state.log", durationMs: 1 }; },
				async launch(key) { return { key, ok: true, runId: "v", output: label, structuredOutput, artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "complete", artifactPaths: [] }; },
			});
			assert.equal((execution.value as { verdict?: string }).verdict, expected, label);
		}

		for (const [label, structuredOutput] of [
			["missing", { findings: [{ id: "a", status: "verified", evidence: ["a"] }], residualRisks: [] }],
			["duplicate", { findings: [{ id: "a", status: "verified", evidence: ["a"] }, { id: "a", status: "verified", evidence: ["again"] }], residualRisks: [] }],
			["extra", { findings: [{ id: "a", status: "verified", evidence: ["a"] }, { id: "x", status: "verified", evidence: ["x"] }], residualRisks: [] }],
			["empty-evidence", { findings: [{ id: "a", status: "verified", evidence: [] }, { id: "b", status: "verified", evidence: ["b"] }], residualRisks: [] }],
		] as const) {
			const resolved = resolveWorkflowResource("evidence-qualification", args);
			assert.equal(resolved.ok, true, label);
			if (!resolved.ok) continue;
			await assert.rejects(runWorkflowScript({
				script: resolved.resource.script,
				async host(key) { return { key, kind: "command", ok: true, state: "passed", exitCode: 0, stdout: "same\n", stderr: "", outputPath: "source-state.log", durationMs: 1 }; },
				async launch(key) { return { key, ok: true, runId: "v", output: label, structuredOutput, artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "complete", artifactPaths: [] }; },
			}), /Verifier/);
		}
	});

	it("rejects qualification when the original checkout changes during verification", async () => {
		const resolved = resolveWorkflowResource("evidence-qualification", {
			contract: "Fixed contract",
			claims: [{ id: "a", claim: "A" }],
		});
		assert.equal(resolved.ok, true);
		if (!resolved.ok) return;
		let hostCall = 0;
		await assert.rejects(runWorkflowScript({
			script: resolved.resource.script,
			async host(key) {
				hostCall += 1;
				return { key, kind: "command", ok: true, state: "passed", exitCode: 0, stdout: hostCall === 1 ? "before\n" : "after\n", stderr: "", outputPath: "source-state.log", durationMs: 1 };
			},
			async launch(key) {
				return { key, ok: true, runId: "v", output: "verified", structuredOutput: { findings: [{ id: "a", status: "verified", evidence: ["probe"] }], residualRisks: [] }, artifactPaths: [] };
			},
			async status(key) { return { key, ok: true, output: "complete", artifactPaths: [] }; },
		}), /Source checkout changed during evidence qualification/);
		assert.equal(hostCall, 2);
	});

	it("bounds evidence qualification arguments", () => {
		for (const args of [
			{},
			{ contract: "", claims: [{ id: "a", claim: "A" }] },
			{ contract: "C", claims: [] },
			{ contract: "C", claims: [{ id: "", claim: "A" }] },
			{ contract: "C", claims: [{ id: "a", claim: "" }] },
			{ contract: "C", claims: [{ id: "a", claim: "A" }, { id: "a", claim: "B" }] },
			{ contract: "C", claims: [{ id: "a", claim: "A", extra: true }] },
			{ contract: "C", claims: [{ id: "a", claim: "A" }], skill: "" },
			{ contract: "C", claims: [{ id: "a", claim: "A" }], extra: true },
		]) assert.equal(resolveWorkflowResource("evidence-qualification", args).ok, false);
	});

	it("does not authorize raw equivalent scripts or unconsumed/forged permits", () => {
		const forged = { __workflowResourcePermit: Symbol("forged") } as never;
		assert.equal(authorizeWorkflowResourceHost(forged, "ci", "npm test"), "Workflow resource authority is unavailable.");
		const raw = `return await runs.host("ci", { kind: "command", command: "npm test", timeoutMs: 1000 });`;
		const resolved = resolveWorkflowResource("run-ci", { command: "npm test", timeoutMs: 1_000 });
		assert.equal(resolved.ok, true);
		if (!resolved.ok) return;
		assert.equal(authorizeWorkflowResourceHost(resolved.resource.permit, "ci", "npm test"), "Workflow resource authority is unavailable.");
		assert.notEqual(raw, resolved.resource.script);
	});

	it("rejects missing metadata, mismatched scripts, and unauthorized host combinations", () => {
		const resolved = resolveWorkflowResource("run-ci", { command: "npm test" });
		assert.equal(resolved.ok, true);
		if (!resolved.ok) return;
		assert.equal(consumeWorkflowResourcePermit(resolved.resource.permit, `${resolved.resource.script}\n`), "Workflow resource permit does not match the resolved workflow script.");
		assert.equal(authorizeWorkflowResourceHost(resolved.resource.permit, "shell", "npm test"), "Workflow resource authority is unavailable.");
		const consumed = consumeWorkflowResourcePermit(resolved.resource.permit, resolved.resource.script);
		assert.equal(typeof consumed, "object");
		assert.match(authorizeWorkflowResourceHost(resolved.resource.permit, "shell", "npm test") ?? "", /not allowed/);
		assert.match(authorizeWorkflowResourceHost(resolved.resource.permit, "ci", "git status") ?? "", /not allowed/);
		assert.match(authorizeWorkflowResourceHost(resolved.resource.permit, "ci", "npm test") ?? "", /^$/);

		const review = resolveWorkflowResource("review", { task: "Review" });
		assert.equal(review.ok, true);
		if (!review.ok) return;
		const reviewConsumed = consumeWorkflowResourcePermit(review.resource.permit, review.resource.script);
		assert.equal(typeof reviewConsumed, "object");
		assert.match(authorizeWorkflowResourceHost(review.resource.permit, "ci", "npm test") ?? "", /not allowed/);
	});

	it("validates resource names and bounded arguments before creating permits", () => {
		for (const [name, args] of [
			["unknown", {}],
			["run ci", {}],
			["run-ci", { command: "rm -rf /" }],
			["run-ci", { timeoutMs: 0 }],
			["run-ci", { extra: true }],
			["review", { task: "" }],
			["review", { task: "Review", extra: true }],
			["review", { task: "x".repeat(16 * 1024 + 1) }],
		] as const) {
			const result = resolveWorkflowResource(name, args);
			assert.equal(result.ok, false, `${name}: ${JSON.stringify(args)}`);
		}
	});

	it("rejects argument validation failures even when the error message is empty", () => {
		const registration = registerWorkflowResource({ sessionId: "invalid-args", definition: {
			name: "check-args", version: 1, resolve: () => assert.fail("invalid args reached the resolver"),
		} });
		try {
			assert.deepEqual(resolveWorkflowResource("check-args", { get task() { throw new Error(""); } }, "invalid-args"), { ok: false, error: "" });
		} finally { registration.dispose(); }
	});

	it("reports unauthorized raw host execution through the workflow primitive when no host is supplied", async () => {
		await assert.rejects(
			runWorkflowScript({
				script: `return await runs.host("ci", { kind: "command", command: "npm test", timeoutMs: 1000 });`,
				async launch(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
				async status(key) { return { key, ok: true, output: "unused", artifactPaths: [] }; },
			}),
			(error: unknown) => error instanceof WorkflowScriptError && /runs\.host is unavailable/.test(error.message),
		);
	});
});

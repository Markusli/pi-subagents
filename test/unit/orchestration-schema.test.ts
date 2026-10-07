import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOrchestrationSubagentParamsSchema } from "../../src/extension/schemas.ts";

describe("orchestration subagent schema", () => {
	it("advertises only orchestration-valid actions and fields", () => {
		const schema = createOrchestrationSubagentParamsSchema() as unknown as { properties: Record<string, any> };
		const properties = schema.properties;
		const actions = properties.action.anyOf?.[0]?.enum ?? properties.action.enum;

		for (const action of ["status", "resume", "steer", "mission.show", "guide"]) assert.ok(actions.includes(action), action);
		for (const action of ["command.status", "command.yield", "command.cancel", "watchdog.configure", "schedule.create"]) assert.equal(actions.includes(action), false, action);

		for (const field of ["agent", "task", "skill", "acceptance", "output", "outputMode", "mission", "missionId", "workflow", "args"]) assert.ok(field in properties, field);
		for (const field of ["isolation", "includeProgress", "model", "fast", "share", "sessionDir", "gate", "preflight", "machine"]) assert.equal(field in properties, false, field);
		assert.deepEqual(properties.workflow.anyOf?.[0]?.enum ?? properties.workflow.enum, ["reviewed-implementation"]);
	});
});

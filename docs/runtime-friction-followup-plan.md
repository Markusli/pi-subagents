# Runtime friction follow-up plan

## Simplified architecture

Keep the existing runtime owners and remove two accidental reinterpretations:

1. **Resume uses the persisted child launch contract.** A resumed child keeps the
   exact model/provider recorded when that child was admitted. Current-session
   role ownership, capability ceilings, permissions, worktree ownership, and
   explicit resume constraints still apply, but current `modelScope` does not
   reinterpret a persisted model after launch.
2. **Result delivery owns restart reconciliation.** On startup/reload/resume, the
   existing result index/ownership/dedupe machinery immediately delivers any
   eligible undelivered terminal result and wakes the parent exactly as it does
   for a result that arrives while the session is live.
3. **Long research runs use the existing per-agent timeout field.** Give the
   `research-analyst` role a 90-minute default timeout instead of changing the
   global runtime timeout. The same role default applies to a resumed child when
   the resume call does not supply a tighter timeout/deadline. Keep task briefs
   responsible for bounded searches and query limits.

No new mission state, resume registry, reconciliation database, routing table,
or watchdog state is introduced.

## Concepts removed or narrowed

- Remove **current model-scope revalidation of a persisted resume model**. New
  launches still use current `modelScope`; resume continues a launch already
  admitted under its recorded model/tool contract.
- Remove **silent recovery result priming**. Recovery uses the same wake-bearing
  result-delivery path as normal operation instead of creating a special
  no-wake phase.
- Narrow the timeout change to one role via the existing `timeoutMs` agent
  contract; do not raise the global 30-minute default.

## Preserved invariants

- A resume cannot substitute a same-named role from another source.
- Current capability ceilings and permissions can still reduce what a revived
  child may do; the change only freezes the already-selected model identity.
- Fresh launches continue to fail closed against current strict `modelScope`.
- Result ownership and delivered-result dedupe remain authoritative; foreign or
  already-delivered results must not wake the parent.
- Recovery does not create a second programme/workflow state machine. The result
  file/index remains the terminal evidence owner.
- `research-analyst` remains bounded by task-specific search/query constraints;
  the longer timeout is not permission for unbounded discovery.

## Rejected simplifications

- **Disable `modelScope` strictness globally:** rejected; it protects fresh
  launches and is not the cause of the resume bug.
- **Add a migration alias registry for old -> new providers:** rejected; resume
  already stores the exact model contract and needs no second identity map.
- **Add a coordinator reconciliation database/state:** rejected; terminal result
  files, ownership, and delivery dedupe already own the required facts.
- **Raise all child timeouts:** rejected; recent failures were isolated to the
  research role and the per-agent timeout primitive already exists.
- **Add more runtime-update machinery:** rejected for this change. The current
  runtime already detects a package version newer than the loaded module and
  tells the operator to restart Pi; old sessions cannot safely hot-swap loaded
  extension modules.
- **Add automatic parent-model switching/failover in pi-subagents:** rejected.
  Parent model selection belongs to Pi/provider configuration, while this repo
  owns child delegation. Keep that boundary instead of creating a second parent
  model controller.

## Revised implementation plan

1. **Resume contract fix**
   - In the final single-child revival path only, do not pass the current
     `modelScope` into the resumed child's model resolution. Continue using the persisted `model` /
     `modelOrigin` / thinking values already stored in the recovery contract.
     Keep current `modelScope` on attach-chain and every other fresh launch,
     because those chain steps are new children rather than continuation of the
     persisted child.
   - Add a regression test where a child was launched under
     `b.ai/deepseek-v4.1-flash`, current strict agent scope later changes to
     `router/deepseek-v4.1-flash`, and resume still starts with the persisted
     b.ai model while a fresh launch of b.ai under the new scope is rejected.

2. **Terminal reconciliation fix**
   - On `session_start` recovery, prime eligible existing results with normal
     wake semantics instead of `triggerTurn: false`.
   - Add lifecycle/integration coverage proving one eligible predecessor result
     wakes exactly once after resume/reload, while ownership/dedupe still reject
     foreign or already-consumed results.

3. **Research role execution envelope**
   - Set `timeoutMs: 5400000` on the user `research-analyst` role.
   - In revival, when the caller did not provide a timeout/deadline, apply the
     selected role's existing `defaultTimeoutMs` to the resumed run as well.
     Do not invent a new recovery timeout field or reuse an expired source-run
     deadline.
   - Add one concise role instruction that broad filesystem/data discovery must
     remain explicitly bounded/timeboxed; longer runtime is for legitimate
     bounded scientific work, not broader search.

4. **Verification and promotion**
   - Run focused resume, result-watcher/lifecycle, model-scope, and agent parsing
     tests plus typecheck.
   - Run the full unit suite if focused tests pass.
   - Independently review the resulting diff for correctness and unnecessary
     structure before promotion.
   - Promote only the pi-subagents code change through the existing exact-SHA
     runtime process; apply the user-agent timeout as configuration, not as
     package state.

## Re-plan triggers

Return to plan simplification instead of adding local patches if review requires:

- a new persisted resume identity or provider-alias map;
- a new reconciliation state/registry beyond existing result ownership;
- weakening current capability ceilings or permissions during resume;
- a global timeout policy or new watchdog lifecycle;
- parent-model control inside pi-subagents.

## Authority and forbidden knowledge

- **Persisted child recovery contract owns:** model/provider chosen at launch,
  thinking, agent definition identity, session/worktree identity, saved launch
  capabilities.
- **Current parent runtime owns:** whether the named role is still admissible,
  current capability ceiling, permissions, and the act of authorizing resume.
- **Result delivery owns:** terminal result discovery, ownership, dedupe, and
  parent wake.
- **User role config owns:** `research-analyst` default timeout.
- **pi-subagents must not own:** parent model/provider failover policy, research
  programme status, or a second mapping between provider identities.

## Deletion target

- Delete the current-scope check from the persisted-model resume path.
- Delete the recovery-only no-wake result-priming behavior.
- Do not add replacement state for either behavior.

## Acceptance oracle

The lowest gates are executable:

- persisted-model resume succeeds after a strict scope migration without model
  substitution;
- the same now-disallowed model fails for a fresh launch;
- a resumed role with `defaultTimeoutMs` receives that timeout when the resume
  request supplies no tighter timeout/deadline;
- an undelivered owned terminal result present at recovery produces one parent
  wake and no duplicate delivery;
- existing foreign-result and dedupe tests remain green;
- research-analyst config resolves to a 90-minute default timeout.

Higher-level session replay is useful confirmation, not a replacement for these
contract tests.


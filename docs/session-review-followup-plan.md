# Session-review follow-up

## Required behavior

Recent PI sessions exposed two delegation-layer failures that belong in `pi-subagents`:

1. A completed child can carry `acceptance.status = rejected` while its native completion wake shows only the child's prose. The parent must see that rejected evidence state instead of receiving a clean-looking completion.
2. `mission.create` failed three consecutive times because the tool caller supplied the documented mission object as a JSON object string. The boundary should accept that observed tool-call representation, normalize it once, and keep the mission record itself object-only.

Preserve these invariants:

- Inferred/default acceptance rejection does **not** become a new run-failure rule. Explicit acceptance already owns fail-closed execution semantics.
- Mission continuity stays explicit through the existing `missionId`; do not add a session-global "current mission", registry, or implicit cross-run attachment.
- Native completion delivery remains the only completion path; do not add a second notification channel.
- No hot-path filesystem scan, new durable state, or background daemon is introduced.

## Ownership map

| Concern | Existing owner | Change |
|---|---|---|
| Child acceptance/evidence state | `AcceptanceLedger` already retained on child results | Project rejected state into the existing native completion wake. |
| Completion delivery/dedupe/wake | `runs/background/notify.ts` | Keep delivery mechanics unchanged; only enrich the existing message projection. |
| Mission identity and lifecycle | mission store + explicit `missionId` | Normalize one observed input representation at the tool boundary; reuse the same mission ID explicitly. |
| Provider failover evidence | `pi-router` | Out of scope. Use router-owned decision/debug evidence rather than infer failover from PI session logs. |
| Long-running shell watcher lifecycle | `@monopi/background-tasks` + operator supervision skill | Out of scope for this runtime patch. Do not build another job supervisor in `pi-subagents`. |

## Minimal implementation

### 1. Surface rejected acceptance in native completion

- Extend the completion result projection only enough to inspect an existing child's acceptance ledger.
- If a child has rejected acceptance, make that visible as an **orthogonal acceptance warning** in the native completion text using the existing acceptance failure message where available.
- Keep execution/lifecycle status unchanged (`completed` can coexist with `acceptance: rejected`). Do not map inferred acceptance rejection onto child or top-level run status.
- Keep the top-level run outcome unchanged when rejection came from inferred/default acceptance; this patch is observability, not a new acceptance policy.
- Regression-test the observed case: exit code 0 + useful reviewer prose + malformed acceptance report must wake the parent with an unmistakable rejected-acceptance warning **while the execution status remains completed**.

### 2. Normalize mission JSON-object strings at the boundary

- Let the shared `mission` tool parameter schema admit a JSON string beginning with `{` so `mission.create` can receive the representation that actually occurred. Keep the documented/default form as object/false.
- Normalize that string **only inside the `mission.create` management action**, then run the existing object validator unchanged. Ordinary mission-bearing launches continue to require an object and reject strings at runtime. Invalid JSON still fails before mission creation.
- Keep persisted mission records and mission APIs object-only; no second representation leaves the input boundary.
- Make `mission.create` tell the caller to reuse the returned `missionId` on later launches belonging to the same work. Do not infer or auto-select a mission later.
- Add focused tests for successful `mission.create` string normalization, malformed JSON, ordinary-launch string rejection, and unchanged object validation.
- Add a continuity test that reuses the returned `missionId` on a later launch and proves the same mission record is updated with no additional mission created.

## Explicit non-changes

- No automatic retries for malformed child acceptance reports.
- No conversion of inferred acceptance rejection into run failure.
- No session-level active mission state or implicit reviewer attachment.
- No background-job lease/daemon/watch registry in `pi-subagents`.
- No provider-router logging implementation here.

## External follow-ups

- **Router:** enable/use `pi-router`'s own decision/debug evidence when attributing failover. Session-log analysis must not infer a 30-second failover without router evidence.
- **Background supervision:** the current rotating-watch skill should use one-shot watchers (exit after the first actionable line or rotation) and exact PID/PGID ownership. It must not re-arm while the previous watcher is still live and must not kill generic `supervisor.sh` patterns.
- **Experiments:** local correctness probes should use a managed background task plus a terminal result artifact, not `nohup ... &` followed by sleeps and `pgrep` inference.

## Verification

1. Focused mission and completion-notification tests.
2. Existing notify/parser round-trip tests.
3. Existing mission action/lifecycle tests.
4. Typecheck.
5. Full unit suite.
6. Independent review of the final diff for hidden run-semantics changes, notification duplication, mission-state invention, and compatibility creep.

## Re-plan triggers

Re-run simplification before adding any persistent mission-selection state, a new notification path, a retry protocol for acceptance reports, or a job-supervision subsystem. Those would change ownership/lifecycle rather than fix the two observed boundary failures.

# Native swarm tools design

## Findings

The swarm already has one authoritative command boundary. A harness request is a daemon request with `command`, `verb`, `identity` and `payload` (`/root/src/malcomsonbrothers/swarm/src/harness/protocol.ts:4-14,195-217`). The current verbs are `spawn`, `handoff`, `integrate`, `check`, `flag_file`, two premise verbs, `redirect`, `retire` and `subtree` (`protocol.ts:20-31`). The command line validates files, fills the identity from the environment, emits one JSON result and returns a refusal on failure (`harness/cli.ts:1-19,96-106,165-175,278-319`). The daemon then checks the dispatch token and node-type permission (`daemon/harness-server.ts:46-124,201-249`).

Identity must remain outside model arguments. The daemon supplies nine required `SWARM_*` variables (`harness/identity.ts:25-36`), and its child environment also supplies the `swarm` shim on `PATH` (`daemon/child-env.ts:48-76`). Handoff input is flat: `status` plus six strings. Harness-owned identity, cost and token fields are refused (`handoff/validate.ts:17-33,63-108`). The daemon adds tokens, cost, tree hash, file, body reference and ledger event (`daemon/handoffs.ts:258-345`).

The current production launcher disables extensions, skills and prompt templates (`pi/rpc-client.ts:138-166`). That does not prevent native SDK custom tools. Tool arguments are validated before execution and become model-visible error results (`packages/agent/src/harness/execution/tools.ts:77-95`); a successful result can set `terminate`, which ends the loop after the current tool batch (`packages/agent/src/types.ts:362-375`). A settled pi child is already the daemon's handoff-finalisation trigger (`swarm/src/daemon/live.ts:507-525`).

## Tool set

The native layer is activated only when the complete swarm identity is present. It is injected at SDK session construction, not loaded as an extension, so `--no-extensions` remains safe. A resumed session repeats this activation from its current environment, rebuilding the tool list while retaining its old transcript. It must not infer availability from old tool calls: if a removed tool appears in the transcript, return an explicit tool error; if a new tool needs a newer daemon, disable it until a capability/version handshake succeeds. `--tools`, `--exclude-tools` and `--no-tools` remain authoritative; a normal pi process sees no swarm tools.

| Tool | Model arguments and effect |
| --- | --- |
| `swarm_handoff` | `status` enum (`done`, `partial`, `blocked`, `stopped_on_premise`) and the six current body strings. `spec_coverage` is optional for non-root nodes. Calls `handoff`; success terminates the turn. |
| `swarm_finding` | One finding per call: `file`, positive integer `line`, `severity` enum (`blocking`, `minor`), `text`, and the existing required `lens`. The daemon must add an atomic finding endpoint. `file` and `text` map to the current report's `path` and `statement` (`swarm/src/review/types.ts:13-22`). This prevents a cut-off reviewer losing all findings held in a final report. |
| `swarm_spawn` | The current brief request: `node_type`, `model_effort_config`, scope, split reason, five brief sections, and optional claim/review data. Model, effort and provider are resolved by the daemon; provider is never an argument (`swarm/src/brief/types.ts:45-116`). |
| `swarm_integrate` | Optional licensed change (`path`, `comment`, `reason`), otherwise no arguments. Maps to `integrate`. |
| `swarm_check` | `target` enum (`build`, `test`, `full`, `caps`) and optional `covered_paths`. Maps to `check`. |
| `swarm_flag_file` | `path`; maps to `flag_file`. |
| `swarm_premise` | `action` enum `clean` or `contradiction`; contradiction additionally requires `claim` and `observed` (`file:line`). Maps to the two premise verbs. |
| `swarm_redirect` | `target_node_id`, `mode` (`steer` or `abort`) and `message`. This is the planner's send-back operation. |
| `swarm_retire` | Child `node_id` and optional explanation. The daemon remains responsible for descendant closure. |
| `swarm_subtree` | No arguments; returns current rows. |
| `swarm_wait` | No daemon call. A planner explicitly waits for live or queued descendants and terminates its turn. This represents the existing rule that an idle planner ends without a handoff (`swarm/src/daemon/planner-waiting.ts:1-12`), rather than inventing a new daemon verb. |

The role map follows the daemon, not a second policy: planners get spawn, handoff, redirect, retire, subtree, premise and flag; workers, split nodes and checkpoints get handoff, integrate, check, flag and premise; reviewers get handoff, finding, flag and premise only after the finding endpoint exists. The current daemon table is the source for the first two groups (`daemon/harness-server.ts:62-110`); its reviewer set currently has no finding verb. A role-inapplicable call may still be exposed when a changed daemon is rolling out, but its refusal is returned as a normal tool error.

## Transport and safety

The first implementation uses the existing `swarm harness` CLI with a private temporary JSON file, not a second socket client. The CLI already owns argument parsing, local handoff validation, request IDs, retry timing and response-shape checks (`harness/client.ts:1-17,158-248`). A direct pi socket adapter would duplicate identity wiring, token claims, retry reservations and protocol evolution. A later shared harness package can replace the subprocess without changing tool schemas.

The tool writes only agent-owned fields. It never writes identity, token, cost, tree, model, provider, `body_ref` or daemon result fields. Refusals preserve their code and message as an error result, so the model can correct an invalid call. Successful `swarm_handoff` and `swarm_wait` set `terminate: true`; other calls do not.

Tool batches need explicit modes. Read-only queries may run in parallel. Spawn, integrate, redirect, retire, premise and finding are sequential per node. Handoff is sequential and the daemon freezes the first body; a duplicate returns `handoff_frozen` (`daemon/handoffs.ts:265-278`). Lost replies are safe because the harness client retries the same request ID and the daemon reserves its verb and payload (`daemon/harness-server.ts:256-301`).

## Provider and migration limits

Use flat object schemas, string fields, enums and arrays. Do not use unions of object shapes, references, conditionals or tuples. Provider strict conversion rejects those constructs and turns optional properties into nullable required properties (`packages/ai/src/api/constrained-sampling.ts:12-29,63-113`). Strict JSON schema is therefore `prefer`, never required; the normal pi validator remains the authority and provider adapters may send non-strict schemas (`packages/ai/src/api/openai-responses-shared.ts:389-424`). For strict-compatible providers, optional fields should be represented as required nullable fields in the final schema, with the adapter removing nulls before the CLI payload.

The prototype implements `swarm_handoff` and its CLI bridge in `packages/coding-agent/src/core/tools/swarm.ts:22-245`, and injects it in `core/sdk.ts:394-416`. The fake harness and faux provider test show identity-gated activation, an invalid call, a corrected call, one accepted handoff and no third model request (`test/swarm-handoff-tool.test.ts:69-178`). The remaining tools require the daemon additions noted above, especially atomic finding storage and a capability/version handshake for changed tool lists.

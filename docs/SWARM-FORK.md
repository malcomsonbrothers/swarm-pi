# The swarm pi fork

This repository is a fork of [pi](https://github.com/earendil-works/pi), the coding
agent. It exists to carry **one small patch** on top of the upstream tag `v0.85.1`: the
`openai-codex` provider's per-turn accounting data reaches the session record. The
untouched vanilla pi lives beside it; swarm builds against this fork when it needs the
patched behaviour, and can switch back to vanilla pi at any time.

## What the patch is

Three source files change:

- `packages/ai/src/types.ts` — the `Usage` interface gains one optional member:
  `providerExtra?: Record<string, number>`.
- `packages/ai/src/api/openai-responses-shared.ts` — in `finalizeResponse`, after pi
  rebuilds `output.usage` from the named fields it models, the patch walks
  `response.usage` and copies every remaining member whose value is a finite number
  into `providerExtra`, keeping the provider's keys verbatim. Nested objects (such as
  the `*_tokens_details` breakdowns) are not numbers, so they are skipped. Members a
  transport stashed on `providerExtra` before the terminal event survive the rebuild.
  When nothing extra survives, `providerExtra` is left undefined, so providers that
  send only the modelled fields are unaffected.
- `packages/ai/src/api/openai-codex-responses.ts` — the subscription meter reading the
  Codex backend returns with every turn is captured on both transports and flattened
  into `providerExtra` under one naming rule. The WebSocket transport sends a
  `codex.rate_limits` frame before the response events; its `rate_limits.primary` and
  `rate_limits.secondary` windows and `credits.balance` become
  `codex_primary_used_percent`, `codex_primary_window_minutes`,
  `codex_primary_reset_after_seconds`, `codex_primary_reset_at`, the same four for
  `secondary`, and `codex_credits_balance`. The SSE transport sets `x-codex-*` response
  headers; every numeric one becomes `codex_<rest>` with underscores, so
  `x-codex-primary-used-percent: 48` lands under the same key as the frame's value.
  Non-numeric values (`x-codex-active-limit`, the opaque `x-codex-turn-state`) are
  never copied. The frame is consumed, not passed on.

No existing field, behaviour or file is altered.

## Why

Swarm records two cost numbers per node today: a real cost and a normalised cost. It
wants a third, the amortised share of the ChatGPT subscription that paid for the
response. On the `openai-codex` provider, the `response.completed` event's `usage`
object may carry `codex_rollout_budget_units`, the provider's own weighted cost of that
single response. That is the honest unit to amortise on, but pi dropped it: the
Responses usage mapper rebuilds a fresh object from named fields only, on both the SSE
and the WebSocket transports, so the member never reached the per-message `usage` that
pi writes into the session JSONL file. With this patch it does.

The meter reading matters for the same reason. Swarm polls the account's usage endpoint
once a minute and must then guess which turns moved the meter, and whether anything
outside the swarm moved it. With the reading stored beside every turn, each tick of the
meter is attributed to the turn that observed it, and usage that reaches the account
from elsewhere shows up as movement between the swarm's own turns. Both transports
report whole percentage points today (probed 2026-09-15: `used_percent: 48` on the
WebSocket frame and `x-codex-primary-used-percent: 48` on the SSE headers), so the
value of the capture is attribution, not extra precision.

One caveat, stated plainly: no OpenAI endpoint publishes a weekly allowance in
`codex_rollout_budget_units`, and the meter reports a percentage, not tokens. Swarm
still has to infer the divisor for the amortisation. The patch removes the guesswork
from the numerator only, not the denominator.

## The rule

When upstream pi exposes these raw usage members and the meter reading itself, delete
this patch and go back to vanilla pi. The fork should never outlive its one reason to
exist.

## Upstream issues to watch

- <https://github.com/earendil-works/pi/issues/9481> — open; Codex turn attribution
  metadata, the most likely vehicle for Codex usage and header work.
- <https://github.com/earendil-works/pi/issues/8234> — closed; a missing provider
  response hook, fixed once reported. The precedent for asking upstream.
- <https://github.com/earendil-works/pi/issues/8245> — closed; another missing provider
  response hook, fixed once reported. Same precedent.
- <https://github.com/earendil-works/pi/issues/6959> — closed; exposing provider usage
  to extensions, refused. Do not expect a core getter for this data.

As of 2026-09-13, no upstream issue mentions `codex_rollout_budget_units` at all.

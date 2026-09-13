# The swarm pi fork

This repository is a fork of [pi](https://github.com/earendil-works/pi), the coding
agent. It exists to carry **one small patch** on top of the upstream tag `v0.85.1`.
The untouched vanilla pi lives beside it; swarm builds against this fork when it needs
the patched behaviour, and can switch back to vanilla pi at any time.

## What the patch is

Two files change:

- `packages/ai/src/types.ts` — the `Usage` interface gains one optional member:
  `providerExtra?: Record<string, number>`.
- `packages/ai/src/api/openai-responses-shared.ts` — in `finalizeResponse`, after pi
  rebuilds `output.usage` from the named fields it models, the patch walks
  `response.usage` and copies every remaining member whose value is a finite number
  into `providerExtra`, keeping the provider's keys verbatim. Nested objects (such as
  the `*_tokens_details` breakdowns) are not numbers, so they are skipped. When nothing
  extra survives, `providerExtra` is left undefined, so providers that send only the
  modelled fields are unaffected.

No existing field, behaviour or file is altered.

## Why

Swarm records two cost numbers per node today: a real cost and a normalised cost. It
wants a third, the amortised share of the ChatGPT subscription that paid for the
response. On the `openai-codex` provider, the `response.completed` event's `usage`
object carries `codex_rollout_budget_units`, the provider's own weighted cost of that
single response. That is the honest unit to amortise on, but pi dropped it: the
Responses usage mapper rebuilds a fresh object from named fields only, on both the SSE
and the WebSocket transports, so the member never reached the per-message `usage` that
pi writes into the session JSONL file. With this patch it does.

One caveat, stated plainly: no OpenAI endpoint publishes a weekly allowance in
`codex_rollout_budget_units`, so swarm still has to infer the divisor for the
amortisation. The patch removes the guesswork from the numerator only, not the
denominator.

## The rule

When upstream pi exposes these raw usage members itself, delete this patch and go back
to vanilla pi. The fork should never outlive its one reason to exist.

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

# Watchtower

## What this is

Watchtower is a production-watchdog AI agent running on Cloudflare Workers.
It watches telemetry from a simulated microservice world (with a chaos panel
for injecting faults on demand), uses statistical detection to notice when
something's wrong, and escalates ambiguous or serious incidents to an
Anthropic tool-use agent that investigates the telemetry, forms a hypothesis,
and reports a verdict.

## Try it

**https://watchtower.dylanburns.workers.dev**

_A 5-minute demo script (seed the world, inject a fault from the chaos panel,
watch detection escalate to an agent investigation, read the verdict) lands
here once the full UI ships._

## How it works

_Filled at phase 5: architecture diagram and data flow — simulator → D1 →
detector → agent → four-panel UI, with the Durable Objects that own each
stage._

## The agent

_Filled at phase 4: agent loop design — the tool layer it investigates with,
prompt caching setup, budgets/caps, and how investigation state persists and
resumes in `InvestigatorDO`._

## Decisions & tradeoffs

_Filled incrementally through phase 7: key design decisions and what got
traded off for time — e.g. single active investigation, the D1 write budget,
no hand-rolled retry logic._

## What's deliberately missing

_Filled at phase 7: scope boundaries from the break-it checklist — what was
cut on purpose vs. what's a known gap._

## Eval results

_Filled at phase 4: eval table — scenario, verdict, steps, tokens, wall time._

## Running it yourself

_Filled at phase 7: setup steps — clone, install, `wrangler secret put
ANTHROPIC_API_KEY`, seed the world, `pnpm dev`._

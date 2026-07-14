# Coding exercise: build an agent on Cloudflare Workers

## Context

Polylane connects to the tools that run your software (Cloudflare, Vercel, AWS, GitHub, Sentry), builds a live picture of your infrastructure, and uses agents to watch it, investigate problems, and explain what changed. Agents running on the edge are core to how we build.

This exercise is a slice of that: build and ship a working AI agent on Cloudflare Workers.

## The task

Build an agent that does something genuinely useful in our problem space: understanding, monitoring, or investigating software infrastructure. Deploy it on Cloudflare Workers and send us a URL we can try.

It is deliberately open ended. You pick the problem. Some directions to spark ideas (pick one, remix, or do something else entirely):

- **Log and trace investigator.** Connect it to a real telemetry source (a Cloudflare account, an OTel collector, Sentry, a demo app you instrument yourself). The agent fetches logs and traces on its own, digs through them, correlates errors with latency, and comes back with an investigation: what is broken, since when, and the likely cause. Not a viewer, an investigator.
- **Cloud dependency mapper.** Point it at a cloud account (AWS, Cloudflare and Vercel both have good APIs for this). It enumerates the resources, works out how they depend on each other, builds the map, and then goes looking for problems: misconfigurations, single points of failure, things that changed recently, resources that look abandoned.
- **Trace analyst.** Feed it a stream of distributed traces. It figures out the service topology from the spans, finds the slow paths and the error hotspots, and explains where the time and failures actually come from, span by span, not just "p99 is high."
- **Production watchdog.** It continuously pulls telemetry from a live service, maintains a memory of what normal looks like, and when something drifts it opens an investigation on its own and writes up what it found.

These examples are ambitious by design. We would rather see a bold attempt at a hard problem, with honest rough edges and a README that says what is missing, than a safe demo that works perfectly and teaches us nothing about you. Impress us.

If you need something to point the agent at, instrument a small demo app and generate traffic against it, or use your own cloud account. Producing realistic telemetry to investigate is part of the exercise, and we will notice if it is done well.

## Hard requirements

1. **It runs on Cloudflare Workers.** The free tier is enough. For the LLM you can use Workers AI (has a free allocation), or Anthropic/OpenAI/etc. with your own key. If a key is the blocker, ask us and we will provide one.
2. **It is an agent, not a prompt.** The model should run in a loop, decide what to do next, and call tools (fetch something, query state, run a check) across multiple steps. A single LLM call with a fancy prompt does not count.
3. **We can use it at a URL.** A simple chat UI is ideal, but a clean HTTP endpoint with instructions in the README is acceptable. No login screens.

## What to send us

- The URL.
- The code (GitHub repo, public or invite us).
- A short README: what it does, how it works, the decisions and tradeoffs you made, and what you would do next with more time.

## Scope and expectations

- Aim for roughly **a day of focused work**. Take up to a week of calendar time. Please do not gold plate it; we care more about your judgment on what to build and what to skip than about volume.
- **AI coding tools are allowed and encouraged.** We use them heavily. The one rule: you must understand and be able to defend every line, because the follow-up conversation is a walkthrough of your code where we will dig in and possibly extend it live.
- Rough edges are fine. A working agent with two great tools beats a broken one with ten.

## What we look at

- **Does it work.** We open the URL, we try to break it a little, we see how it behaves.
- **Agent design.** Tool selection and boundaries, how the loop is driven, how context is managed, what happens when a tool fails or the model goes sideways.
- **Judgment.** What you chose to build, what you chose to leave out, and whether the README shows you knew the difference.
- **Code quality**, proportional to a take-home. Clear structure over exhaustive polish.
- **Platform fluency** is a bonus, not a requirement: Durable Objects for state, cron triggers, Workflows, KV, streaming responses. Use them where they earn their place, not to show off.

## What we do not care about

- Pixel-perfect UI.
- Authentication, rate limiting, or billing.
- Test coverage for its own sake.
- Supporting every model provider.

## Questions

If anything is unclear, or you want to sanity-check a direction before investing time in it, email us. Asking a good scoping question is a positive signal, not a negative one.
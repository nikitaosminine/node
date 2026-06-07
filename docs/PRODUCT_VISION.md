# Node — product vision

> Internal vision document. This holds the full ambition for Node and is the north
> star for design and architecture decisions. It is deliberately broader than the
> public README, which stays grounded in what is currently demonstrable. The two
> should never contradict each other — this one just looks further ahead.

---

## The problem

Two things are broken about how retail investors manage money today.

**Incumbents have poor UX.** Traditional bank apps don't treat their interfaces as
products. The better options often swing the other way — bloated, trying to do
everything, and still missing simple features an individual investor actually wants.
There's a real gap in France (and beyond) between a clean experience and genuine
utility.

**Every tool is fragmented and has no memory.** Your portfolio lives in one app, your
budget in another, your goals in your head. Nothing connects them, and nothing
*remembers* you. These tools show you data but don't understand you. They are stateless —
each session starts from zero, with no sense of who you are, what you've done, or what
you care about.

Node exists to close both gaps: bridge great UX with AI-driven utility, and build a
system that actually knows you and gets smarter the longer you use it.

---

## What Node is

Node is a personal financial OS — an AI-native workspace that starts with investment
portfolio tracking and grows into a daily financial companion across the parts of life
where money shows up: investing, spending, habits, and goals.

The defining characteristic isn't any single feature. It's that Node maintains a
**living model of the user** and reasons from it — connecting what you own to why you
own it, to what's happening in the world, to how you behave with money over time.

---

## Domains

Node is multi-domain by design. Each domain is a distinct area of financial life, and the
agent system is built so domains can share infrastructure rather than living as isolated
features that happen to share a login.

- **Portfolio** *(live, ~30% of the product)* — holdings, performance, allocations,
  benchmarks, live prices, thesis tracking, recaps, news, prediction-market signals.
- **Expense management** *(planned)* — smarter spending visibility and understanding of
  patterns over time.
- **Habits / gamification** *(planned)* — building disciplined investing and spending
  habits. An "inverted gamification" angle (rewarding restraint and good behavior rather
  than engagement-for-its-own-sake).
- **Rules & strategies** *(planned)* — allocation targets, drift alerts, weight rules,
  and strategies the user defines and Node helps maintain.
- **Goals** *(future)* — longer-term financial objectives the system reasons toward.

The point of naming domains explicitly is that "multi-domain" only means something if the
domains are concrete. The memory layer and agent architecture must serve all of them in
the same shape.

---

## The core bet — memory and personalisation as the moat

The single most important architectural and product decision: **Node remembers.**

Most financial tools are stateless. Node is the opposite. Every interaction writes
observations about the user — their portfolio behavior, their theses, their spending
patterns, their preferences, their anxieties — that future interactions draw from. The
longer someone uses Node, the more it knows about them, and the more irreplaceable it
becomes.

This changes the retention dynamic entirely. In a typical fintech app the switching cost
is exporting a CSV. In Node, the switching cost is everything the system has learned about
you over months or years. The voice layer, the agents, the slick UI — those are
commodities or close to it. The accumulated, personal, longitudinal memory is the moat.

A concrete example of what memory unlocks: instead of repeating "Schneider outperformed
again" every week, the system knows it has been a top contributor for several weeks
running, notices when that *changes*, and tells you the new thing — the delta — rather
than re-stating what you already heard. That continuity is only possible with memory, and
it's the difference between genuine insight and sophisticated repetition.

---

## Principles (non-negotiables)

These hold true regardless of what gets built.

1. **UX and AI utility, together.** Neither at the expense of the other. The whole reason
   Node exists is that incumbents pick one and lose the other.
2. **Numbers are deterministic, never hallucinated.** Figures, percentages, charts, and
   citations are computed in code — before and after any model call. The LLM writes
   narrative and reasons about meaning; it never invents the numbers. (This is already how
   recaps and The Take work.)
3. **Memory is the foundation, not a feature.** The system is designed to accumulate and
   reason from user-specific, longitudinal context from day one.
4. **The user owns their data and their decisions.** Node informs and assists; it does not
   take irreversible financial actions on the user's behalf without explicit consent.
5. **Gets smarter over time.** Every domain agent writes to shared memory so the whole
   system compounds in understanding, not just any one feature.
6. **Modular and future-proof, without over-building.** Make decisions now that don't
   close doors later — but don't build the orchestrated future before the foundations are
   solid.

---

## Agent system

### One line summary

A persistent, multi-domain AI that maintains a living model of the user — their financial
behavior, patterns, goals, anxieties, habits — and can engage with it conversationally or
proactively surface insights across all domains simultaneously.

### High level

I want agents to live and breathe inside the users' data and real-world context, with
persistent memory.

I want a voice agent that could converse with the user about their portfolios, real-world
implications, budgets, expenses, habits, and spending patterns.

I want it to be ***alive***. This could potentially require solid RAG and orchestration. I
don't know yet if I'll have 10 agents or 2 or 3, or how exactly the whole architecture
will look. I'm still learning but I'm thinking ambitiously even if it sounds foolish at
times.

> Note: this direction is validated by where the broader market is heading — voice +
> persistent memory + agency as the future of AI personalization, and strong consumer
> appetite for AI in finance (e.g. Plaid / Harris Poll 2026: ~50% consider managing money
> without AI "almost outdated"; 44% would trust AI to make trades on their behalf).

### Potential needs

- A voice agent conversing about expenses, portfolio, and habits simultaneously needs to
  retrieve relevant context from a potentially large and diverse memory store — that's a
  RAG problem.
- "Alive over time" means the system is continuously writing observations about the user
  that future interactions draw from — that's a memory architecture problem.
- Multiple specialized agents (portfolio, expense, goals) that a conversational layer
  orchestrates — that's potentially a graph problem.

### "Architecturally solid" — what that means

Making decisions now that don't close doors later. Specifically:

- Design the memory schema to be **domain-agnostic** from day one — not portfolio-specific,
  not expense-specific. Every agent writes to the same store in the same format.
- Keep agents **modular** — each domain agent should be self-contained enough that an
  orchestration layer can call it later without refactoring it.
- Don't couple the voice/conversational layer to any specific agent — it should be able to
  query any domain's memory and call any agent.
- Pick one vector approach now even if it isn't used yet, so the decision is made.
  **Supabase has pgvector built in** — relational and vector storage in the same database.
  When ready for RAG, don't migrate; just start using a different query type on data
  already being stored.

**Don't need LangGraph, knowledge graphs, or LangChain yet.** They may earn their place
later — LangGraph specifically once a conversational layer needs to orchestrate multiple
domain agents dynamically in one interaction. The individual domain agents need to be good
first.

### Known architectural debt to address

These are the things to fix before adding more agents (in priority order):

1. **Get insights out of the JSON blob.** The Take currently stores signals inside
   `agent_runs.token_usage` as nested JSON, re-parsed at read time. This needs its own
   queryable table (e.g. `agent_signals`) — it blocks memory, repetition detection, and
   efficient querying.
2. **Build the shared, domain-agnostic memory schema.** One store both pipelines (and
   future ones) read from at the start of a run and write to at the end.
3. **Add observability.** Wire LangSmith for tracing and evals before complexity grows.
   (LangSmith is independent of LangChain — no framework adoption required.)
4. **Add a critic / delta step.** Before an insight reaches the feed, check whether it's
   genuinely different from the last one and why. Silence is better than repetition.

---

## What Node is NOT

- **Not an advisor nor a trading platform.** Node tracks and monitors. It never executes trades, moves money, or connects to brokerage execution. It informs; the user decides.
- **Not a generic AI chatbot.** The value is domain depth and personal memory, not
  open-ended chat.
- **Not another dashboard.** Dashboards show data. Node understands the user and reasons
  about it.
- **Not a bloated everything-app.** Multi-domain, but each domain earns its place and stays
  clean. UX discipline is a feature.

---

## Current state vs vision

**Live today**
- Clean UI
- Portfolio value tracking (trend line + performance)
- Benchmark overlay (with LLM-powered suggestions)
- Detailed allocation breakdown
- Live prices
- Thesis-tracking AI agent (The Take)
- Daily / weekly recaps (agentic Gemini loop + deterministic data merge)

**Next**
- Holdings-tailored news feed
- Polymarket macro-event feed to complement news
- Portfolio notifications and insights (e.g. allocation drift alerts)
- Rules & strategies (weight targets, rebalancing)

**Aspirational / the bigger vision**
- Shared persistent memory across all domains
- Expense management
- Habit-building / inverted gamification
- Voice agent that converses across portfolio, expenses, and habits
- Orchestration layer coordinating multiple domain agents

---

## Why I'm building this

Node is a personal product initiative combining product management, AI experimentation,
personal finance, and UX thinking. It started from a simple observation: incumbents in
France offer subpar UX and lack features I actually wanted — and the alternatives were
either too thin or too bloated. The market could use a better tool.

It's also how I'm learning the modern AI stack hands-on — agents, memory, RAG,
orchestration, evals — by building something real with real architectural decisions,
rather than from tutorials alone.
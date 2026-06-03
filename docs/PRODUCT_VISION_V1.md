# Agent system

## One line summary

A persistent, multi-domain AI that maintains a living model of the user — their financial behavior, patterns, goals, anxieties, habits — and can engage with it conversationally or proactively surface insights across all domains simultaneously.


## High level 

I want agents to live and breathe inside the users' data and real-world context, with persistent memory. 

I want to have a voice agent that could converse with the user about their portfolios, real world implications, bugdets, expenses, habits, spending patterns.

I want it to be ***alive***. this could potentially require solid RAG and orchestration. I don't know if i will have 10 of them or 2 or 3 or how exactly the whole architecture will look. I'm still learning but I think ambitiously even if it sounds foolish at times.


## Potential needs

- A voice agent conversing about expenses, portfolio, and habits simultaneously needs to retrieve relevant context from a potentially large and diverse memory store — that's a RAG problem
- "Alive over time" means the system is continuously writing observations about the user that future interactions draw from — that's a memory architecture problem
- Multiple specialized agents (portfolio, expense, goals) that a conversational layer orchestrates — that's potentially a graph problem

## "Architecturally solid" - what does that mean?

It means making decisions now that don't close doors later. Specifically:

- Design the memory schema to be domain-agnostic from day one — not portfolio-specific, not expense-specific. Every agent writes to the same store in the same format
- Keep agents modular — each domain agent should be self-contained enough that an orchestration layer can call it later without refactoring it
- Don't couple the voice/conversational layer to any specific agent — it should be able to query any domain's memory and call any agent
- Pick one vector DB now even if you don't use it yet — just so the decision is made. Supabase has pgvector built in, which means you already have it without adding infrastructure

- pgvector inside Supabase gives relational and vector storage in the same database. When ready for RAG, don't migrate, just start using a different query type on data already being stored.

Don't need LangGraph or knowledge graphs yet. They might earn their place in the future.
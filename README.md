<p align="center">
  <img src="./Node_assets/hexagon/node-logo-horizontal-white.svg" width="340" alt="Node logo" />
</p>

AI-native portfolio tracking app for retail investors.
Node combines portfolio and thesis tracking, AI-assisted market intelligence into a clean and modern investing workspace designed for individual investors.

## Overview

Traditional bank apps do not prioritize UX and do not treat them as products. Other options can sometimes feel overwhelming and try to do too many things at once. Node aims to bridge the gap between great UX and AI-driven utility and become a daily companinion for retail investors.

* Track and understand portfolio composition
* Maintain and revisit investment theses
* Connect macro events to portfolio impact
* Receive briefs and insights in a stories format
* Build more disciplined investing and spending habits

This project was built as a product-first exploration of how AI agents can improve personal finance for an average retail investor.

## Current Features

* Clean UI
* Portfolio value tracking: trends line and performance
* Benchmark overlay
* Detailed allocation breakdown
* Live prices
* Thesis-tracking AI agent

## Upcoming Features

* News feed tailored to the portfolio holdings
* Polymarket feed with macro events to compliment the ongoing news
* AI-driven daily/weekly market briefs
* Portfolio notifications and insights (e.g. allocation drifts)
* Smarter expense management
* Gamification for good habit building

## Product Vision

The long-term vision is to create an AI-native platform where people can track their investment portfolios, stay macro-aware and build robust habits. Namely:

* Understand not only *what* they own, but *why* they own it
* Track how macro developments affect their thesis and positions
* Reduce manual portfolio maintenance
* Develop and maintain investing strategies
* Access powerful AI tools through frictionless UI

## Why I'm building this

I am building Node as a personal product initiative combining:

* Product management
* AI experimentation
* Personal finance
* UX thinking

The project started from an observation that incubents in France offer a subpar user experience and lack some simple features. 

I saw that some apps lacked UX, some other were too bloated and didn't even have features I wanted.

I think the market could use a better tool.

This repository reflects both product exploration and hands-on execution across product design, feature definition, AI usage experimentation and implementation.

## Tech Stack

### Frontend

* Next.js 16
* React 19
* Tailwind CSS 4
* Radix UI
* Recharts
* Framer Motion

### Backend & Infrastructure

* Node.js
* Cloudflare (Workers)
* Supabase

### AI models

I'm still experimenting with different AI models. 

Shortlisted providers:
- Deepseek (Deekseek v4 flash/pro)
- Google (Gemini 3.5 Flash)
- xAI (Grok)

I chose Grok as a starting point because xAI offers competitive models at a fraction of a cost of other frontier models from OpenAI or Anthropic and I am optimising for cost/performance.


* Thesis agents
  * grok-4.20-0309-reasoning - as main agent
  * grok-4-1-fast-non-reasoning - as sub agent
* Import CSV normalization
  * grok-4-1-fast-non-reasoning
* Benchmark suggestion
  * grok-4.20-0309-reasoning

* *Planned:*
  * AI-driven briefs and recaps: gemini-3.5-flash (released May 19th, 2026) 


## Current Status

Node is currently an active work in progress.

The repository may evolve significantly as the product direction matures.

## Notes

This repository is currently public for portfolio and demonstration purposes.

As the product matures, parts of the implementation may become private or be significantly restructured.

## Screenshots *(first iteration, work in progress)*

### **Main portfolio page with sector & asset type allocation and holdings table view**

<img width="1920" height="980" alt="Screenshot 2026-05-17 164401" src="https://github.com/user-attachments/assets/0dde30ef-30c9-4d0f-9627-20147da4fa6b" />

### **Main portfolio page with geography breakdown and transactions table view**

<img width="1920" height="979" alt="Screenshot 2026-05-17 164533" src="https://github.com/user-attachments/assets/8fd8010e-e641-4a4a-92ca-77bb22f9c4df" />

### **Thesis page *(branded as The Take)***

<img width="1920" height="974" alt="Screenshot 2026-05-17 164912" src="https://github.com/user-attachments/assets/d8a8201e-2126-46a1-932f-95789e47181c" />

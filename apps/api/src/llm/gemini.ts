// ============================================================
// Gemini client — split by surface. Recap generation is a two-stage
// pipeline and these are its two Gemini surfaces:
//   invokeGeminiResearch — STAGE 1, the agentic research loop, via the
//     @google/genai SDK. Function-calling mode is AUTO: the agent picks
//     tools (stored news, Exa search, polymarket) and finishes with a
//     plain-text findings synthesis (no terminal tool — "I'm done" is a
//     natural text turn). This is where Gemini 3.x's function-calling
//     contract matters: function-call `id` round-tripping and
//     thought-signature preservation across turns, both handled in the
//     loop. The bound is closed with one mode=NONE call when needed.
//   invokeGeminiStructured — STAGE 2 (compose), single-shot raw REST.
//     Turns the findings + facts into slides with responseMimeType/
//     responseSchema. No multi-turn contract, so raw fetch stays simple
//     and structured output is guaranteed by the schema.
//
// IMPORTANT: Gemini function-calling and responseMimeType/responseSchema
// cannot be used together — which is exactly why research (tools) and
// compose (responseSchema) are separate calls.
//
// Both invoke* functions are wrapped with LangSmith `traceable` so
// they appear as child spans under the recap-generation run. Tracing
// is a no-op passthrough unless called within an active run-tree
// context (set by withRunTree in generateRecap when LANGSMITH_API_KEY
// is configured) — so the un-traced path is unchanged. processInputs
// redacts `env` so the API key never reaches LangSmith.
// ============================================================

import { traceable } from "langsmith/traceable";
import { GoogleGenAI, ThinkingLevel, FunctionCallingConfigMode } from "@google/genai";
import type { Content, Part as GenaiPart } from "@google/genai";

export interface GeminiEnv {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_API_BASE_URL?: string;
}

// Schema for generationConfig.responseSchema. Uses the API's `Type` enum
// (UPPERCASE: OBJECT/ARRAY/STRING…), confirmed against the @google/genai SDK
// (GenerationConfig.responseSchema: Schema, Schema.type: Type). The newer
// `responseJsonSchema` field accepts lowercase standard JSON Schema instead;
// we use the long-standing responseMimeType + responseSchema pairing.
// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface GeminiSchema {
  type: "OBJECT" | "ARRAY" | "STRING" | "NUMBER" | "INTEGER" | "BOOLEAN";
  description?: string;
  enum?: string[];
  items?: GeminiSchema;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  propertyOrdering?: string[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { message?: string };
}

export interface StructuredResult {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

function geminiBaseUrl(env: GeminiEnv): string {
  return (
    env.GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/$/, "");
}

export function geminiModel(env: GeminiEnv): string {
  return env.GEMINI_MODEL || "gemini-3.5-flash";
}

/**
 * Call Gemini and return guaranteed-JSON text validated against `schema`.
 * The caller parses + validates the returned text. Transient failures are
 * left to the queue's retry (single attempt here, like invokeGrok).
 */
async function invokeGeminiStructuredImpl(
  env: GeminiEnv,
  args: { system: string; user: string; schema: GeminiSchema },
): Promise<StructuredResult> {
  if (!env.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");
  const model = geminiModel(env);
  const url = `${geminiBaseUrl(env)}/models/${model}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: args.system }] },
      contents: [{ role: "user", parts: [{ text: args.user }] }],
      // No temperature/top_p/top_k: Gemini 3.x reasoning is tuned for the
      // default sampling; overriding it can degrade output quality.
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: args.schema,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini API error (${res.status}): ${body.slice(0, 400)}`);
  }

  const data = (await res.json()) as GeminiResponse;
  if (data.error?.message) throw new Error(`Gemini API error: ${data.error.message}`);

  // Gemini 3.x may include a thinking-summary part; keep only answer parts.
  const text =
    data.candidates?.[0]?.content?.parts
      ?.filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("") ?? "";
  if (!text.trim()) throw new Error("Gemini response did not include content");

  return {
    text,
    usage: {
      promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
    },
  };
}

/**
 * Traceable wrapper. Logs the prompt (NOT `env`, which holds the API key) and
 * the token usage. A no-op passthrough outside a run-tree context, so callers
 * that don't trace are unaffected.
 */
export const invokeGeminiStructured = traceable(invokeGeminiStructuredImpl, {
  name: "gemini.structured",
  run_type: "llm",
  processInputs: (inputs) => {
    const a = ((inputs as { args?: unknown[] }).args?.[1] ?? {}) as {
      system?: string;
      user?: string;
    };
    return { system: a.system, user: a.user };
  },
  processOutputs: (outputs) => {
    const r = outputs as Partial<StructuredResult>;
    // Log the model's actual text so the run is evaluatable, not just metrics.
    return { text: r.text, usage: r.usage };
  },
});

// ---------------------------------------------------------------------------
// Gemini function-calling (agentic mode)
// ---------------------------------------------------------------------------

// JSON Schema for tool parameter declarations (standard lowercase types,
// not the uppercase Type enum used by responseSchema).
export interface GeminiFunctionParam {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  description?: string;
  enum?: string[];
  items?: GeminiFunctionParam;
  properties?: Record<string, GeminiFunctionParam>;
  required?: string[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: GeminiFunctionParam;
}

export type GeminiToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface ToolCallRecord {
  tool: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  durationMs: number;
}

export interface ResearchResult {
  // The agent's final plain-text synthesis of what it found. This is the
  // grounding the compose stage writes slides from. NOT the slides themselves.
  findings: string;
  toolCalls: ToolCallRecord[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// First non-thought text on the candidate, concatenated and trimmed.
function responseText(resp: {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
}): string {
  const parts = resp.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => !p.thought)
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

/**
 * Stage 1 of recap generation: the RESEARCH agent (via @google/genai SDK).
 *
 * This is a genuine agent — function-calling mode is AUTO, so the model
 * decides which tools to call (stored news, Exa search, polymarket) and in
 * what order, then decides when it has enough. We do NOT force tool calls and
 * there is NO terminal tool: "I'm done researching" is a natural plain-text
 * turn (no functionCall), which is exactly how models like to finish. That
 * text IS the output — a synthesis the compose stage turns into slides.
 *
 * Why AUTO works here (and didn't in the old single-agent design): this prompt
 * hands the model FACTS only, never pre-fetched news snippets. With the
 * narrative genuinely missing, the model reaches for its tools instead of
 * answering from context. Separating "gather evidence" from "write slides"
 * removes the contradiction that made the old loop skip tools and stall.
 *
 * Two Gemini 3.x function-calling contract details, both handled across the
 * multi-turn tool loop:
 *   1. Every functionResponse echoes the `id` (and `name`) of the functionCall
 *      it answers, one response per call. A mismatch yields an empty STOP turn.
 *   2. Thought signatures survive across turns: we push the model's
 *      `candidate.content` back verbatim (it carries `thoughtSignature` parts).
 *
 * The loop is bounded by maxIterations. If the agent is still calling tools
 * when the bound is hit, one final mode=NONE call (no function calls allowed)
 * forces the text synthesis — so `findings` is always populated. There is no
 * error path: research is best-effort, and the compose stage still runs on
 * FACTS alone if findings come back thin.
 */
async function invokeGeminiResearchImpl(
  env: GeminiEnv,
  args: {
    system: string;
    user: string;
    tools: GeminiFunctionDeclaration[];
    handlers: Record<string, GeminiToolHandler>;
    maxIterations?: number;
    // Gemini 3.x: prefer thinkingLevel over the deprecated thinkingBudget, and
    // do NOT set temperature (reasoning is tuned for the default).
    thinkingLevel?: ThinkingLevel;
  },
): Promise<ResearchResult> {
  if (!env.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");
  const model = geminiModel(env);
  const maxIter = args.maxIterations ?? 6;
  const baseUrl = env.GEMINI_API_BASE_URL ? geminiBaseUrl(env) : undefined;
  const thinkingLevel = args.thinkingLevel ?? ThinkingLevel.LOW;

  const ai = new GoogleGenAI({
    apiKey: env.GEMINI_API_KEY,
    ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
  });

  // SDK-native function declarations. Our GeminiFunctionParam is standard
  // lowercase JSON Schema, so use `parametersJsonSchema` (not `parameters`,
  // which expects the uppercase Type enum).
  const functionDeclarations = args.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.parameters,
  }));

  const contents: Content[] = [{ role: "user", parts: [{ text: args.user }] }];
  const toolCalls: ToolCallRecord[] = [];
  const totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  const addUsage = (meta?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }) => {
    totalUsage.promptTokens += meta?.promptTokenCount ?? 0;
    totalUsage.completionTokens += meta?.candidatesTokenCount ?? 0;
    totalUsage.totalTokens += meta?.totalTokenCount ?? 0;
  };

  for (let iter = 0; iter < maxIter; iter++) {
    const response = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: args.system,
        tools: [{ functionDeclarations }],
        // AUTO: the agent chooses tools or finishes with a text synthesis.
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
        thinkingConfig: { thinkingLevel },
      },
    });
    addUsage(response.usageMetadata);

    // Push the model's turn back verbatim — preserves thoughtSignature parts
    // the SDK needs to round-trip reasoning context across turns.
    const modelContent = response.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent);

    const fnCalls = response.functionCalls ?? [];

    if (fnCalls.length === 0) {
      // Natural completion: no tool call means the agent is done researching.
      // Its text is the findings synthesis.
      return { findings: responseText(response), toolCalls, usage: totalUsage };
    }

    // Execute each tool call; build the function-response turn. Gemini 3.x
    // requires exactly one response per call, each echoing the call's id+name.
    const responseParts: GenaiPart[] = [];
    for (const call of fnCalls) {
      const name = call.name ?? "";
      const fnArgs = (call.args ?? {}) as Record<string, unknown>;
      const handler = args.handlers[name];
      if (!handler) {
        console.warn(`[gemini-research] Unknown tool called: ${name} — returning empty result`);
        responseParts.push({
          functionResponse: { id: call.id, name, response: { error: `Unknown tool: ${name}` } },
        });
        continue;
      }

      const start = Date.now();
      let output: Record<string, unknown>;
      try {
        output = await handler(fnArgs);
      } catch (err) {
        output = { error: err instanceof Error ? err.message : String(err) };
      }
      const durationMs = Date.now() - start;

      toolCalls.push({ tool: name, input: fnArgs, output, durationMs });
      responseParts.push({ functionResponse: { id: call.id, name, response: output } });
    }

    contents.push({ role: "user", parts: responseParts });
  }

  // Bound hit while still calling tools. Force a text-only synthesis (mode
  // NONE = no function calls) so findings are never empty.
  const finalResponse = await ai.models.generateContent({
    model,
    contents,
    config: {
      systemInstruction: args.system,
      tools: [{ functionDeclarations }],
      toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } },
      thinkingConfig: { thinkingLevel },
    },
  });
  addUsage(finalResponse.usageMetadata);
  return { findings: responseText(finalResponse), toolCalls, usage: totalUsage };
}

/**
 * Traceable wrapper for the research loop. run_type "chain" (it orchestrates
 * multiple LLM turns + tool calls, not a single completion). Logs the prompt
 * and declared tool names — never `env` or the handler closures. No-op
 * passthrough outside a run-tree context.
 */
export const invokeGeminiResearch = traceable(invokeGeminiResearchImpl, {
  name: "gemini.research",
  run_type: "chain",
  processInputs: (inputs) => {
    const a = ((inputs as { args?: unknown[] }).args?.[1] ?? {}) as {
      system?: string;
      user?: string;
      tools?: GeminiFunctionDeclaration[];
      maxIterations?: number;
      thinkingLevel?: ThinkingLevel;
    };
    return {
      system: a.system,
      user: a.user,
      tools: a.tools?.map((t) => t.name),
      max_iterations: a.maxIterations,
      thinking_level: a.thinkingLevel ?? ThinkingLevel.LOW,
    };
  },
  processOutputs: (outputs) => {
    const r = outputs as Partial<ResearchResult>;
    return { findings: r.findings, usage: r.usage, tool_calls: r.toolCalls?.map((t) => t.tool) };
  },
});

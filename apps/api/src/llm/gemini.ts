// ============================================================
// Gemini client — split by surface (see the recap-agent investigation):
//   invokeGeminiStructured — single-shot, raw REST. No multi-turn
//     contract to track, so raw fetch stays simple and gives tight
//     control over responseMimeType + responseSchema.
//   invokeGeminiWithTools  — agentic loop, via the @google/genai SDK.
//     This is the surface where Gemini's function-calling contract
//     churns (function-call `id` round-tripping, thought-signature
//     preservation, response-count matching). Gemini 3.5 Flash GA now
//     ENFORCES that contract: a function response missing its `id`
//     yields an empty `finishReason: STOP` turn. The old hand-rolled
//     loop treated that empty turn as "exhausted" and bailed to the
//     static fallback, which is why grounded tool calls silently
//     vanished. The SDK echoes the `id` and preserves thought
//     signatures automatically; we keep the terminal-tool capture
//     pattern on top of it.
//
// IMPORTANT: Gemini function-calling and responseMimeType/
// responseSchema cannot be used together. The agentic mode uses
// write_slides as the terminal tool to deliver structured output.
//
// Both invoke* functions are wrapped with LangSmith `traceable` so
// they appear as child spans under the recap-generation run. Tracing
// is a no-op passthrough unless called within an active run-tree
// context (set by withRunTree in generateRecap when LANGSMITH_API_KEY
// is configured) — so the un-traced path is unchanged. processInputs
// redacts `env` so the API key never reaches LangSmith.
// ============================================================

import { traceable } from "langsmith/traceable";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
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
  args: { system: string; user: string; schema: GeminiSchema; temperature?: number },
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
      generationConfig: {
        temperature: args.temperature ?? 0.3,
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
 * Traceable wrapper. Logs the prompt + temperature (NOT `env`, which holds
 * the API key) and the token usage. A no-op passthrough outside a run-tree
 * context, so callers that don't trace are unaffected.
 */
export const invokeGeminiStructured = traceable(invokeGeminiStructuredImpl, {
  name: "gemini.structured",
  run_type: "llm",
  processInputs: (inputs) => {
    const a = ((inputs as { args?: unknown[] }).args?.[1] ?? {}) as {
      system?: string;
      user?: string;
      temperature?: number;
    };
    return { system: a.system, user: a.user, temperature: a.temperature ?? 0.3 };
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

export interface AgentResult {
  // The captured output from the terminal write_slides tool call.
  output: Record<string, unknown>;
  toolCalls: ToolCallRecord[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export class MaxIterationsError extends Error {
  toolCalls: ToolCallRecord[];
  constructor(toolCalls: ToolCallRecord[]) {
    super(`Gemini agent reached max iterations without calling write_slides`);
    this.toolCalls = toolCalls;
  }
}

/**
 * Agentic Gemini call with function-calling support, via the @google/genai SDK.
 *
 * The agent iterates: call Gemini → intercept functionCall parts → execute
 * each handler → push functionResponse back → repeat until it calls
 * `write_slides` (the terminal tool) or max iterations are hit.
 *
 * Two contract details Gemini 3.x enforces, both handled here:
 *   1. Every functionResponse must echo the `id` (and `name`) of the
 *      functionCall it answers, with one response per call. We forward
 *      `call.id` on the response; a mismatch makes the model return an
 *      empty `finishReason: STOP` turn.
 *   2. Thought signatures must survive across turns. We push the model's
 *      `candidate.content` back verbatim (it carries `thoughtSignature`
 *      parts), rather than reconstructing a stripped-down model turn.
 *
 * A turn with no function call is NOT treated as terminal. The model may
 * emit a thinking/text-only turn before deciding to call a tool; we nudge
 * it ("call a tool or the terminal tool") and continue until maxIterations
 * is genuinely exhausted. Only then do we throw MaxIterationsError, on which
 * the caller falls back to invokeGeminiStructured.
 */
async function invokeGeminiWithToolsImpl(
  env: GeminiEnv,
  args: {
    system: string;
    user: string;
    tools: GeminiFunctionDeclaration[];
    handlers: Record<string, GeminiToolHandler>;
    terminalTool: string; // e.g. "write_slides" — loop exits when this is called
    maxIterations?: number;
    // Gemini 3.x: prefer thinkingLevel over the deprecated thinkingBudget, and
    // do NOT set temperature (reasoning is tuned for the default). Lower levels
    // mean fewer, faster tool calls — a good fit for this bounded recap agent.
    thinkingLevel?: ThinkingLevel;
  },
): Promise<AgentResult> {
  if (!env.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");
  const model = geminiModel(env);
  const maxIter = args.maxIterations ?? 6;
  const baseUrl = env.GEMINI_API_BASE_URL ? geminiBaseUrl(env) : undefined;

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

  for (let iter = 0; iter < maxIter; iter++) {
    const response = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: args.system,
        tools: [{ functionDeclarations }],
        thinkingConfig: { thinkingLevel: args.thinkingLevel ?? ThinkingLevel.LOW },
      },
    });

    const meta = response.usageMetadata;
    totalUsage.promptTokens += meta?.promptTokenCount ?? 0;
    totalUsage.completionTokens += meta?.candidatesTokenCount ?? 0;
    totalUsage.totalTokens += meta?.totalTokenCount ?? 0;

    // Push the model's turn back verbatim — this preserves thoughtSignature
    // parts the SDK needs to round-trip reasoning context across turns.
    const modelContent = response.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent);

    const fnCalls = response.functionCalls ?? [];

    if (fnCalls.length === 0) {
      // Thinking/text-only turn — not terminal. Nudge and keep going. If the
      // model never commits to a tool, maxIterations bounds the loop and we
      // fall through to MaxIterationsError below.
      contents.push({
        role: "user",
        parts: [{
          text:
            `You did not call a function. Call one of the available tools to gather context, ` +
            `or call "${args.terminalTool}" to finish.`,
        }],
      });
      continue;
    }

    // Execute each tool call; build the function-response turn. Gemini 3.x
    // requires exactly one response per call, each echoing the call's id+name.
    const responseParts: GenaiPart[] = [];
    for (const call of fnCalls) {
      const name = call.name ?? "";
      const fnArgs = (call.args ?? {}) as Record<string, unknown>;

      // Terminal tool: capture output and exit.
      if (name === args.terminalTool) {
        return { output: fnArgs, toolCalls, usage: totalUsage };
      }

      const handler = args.handlers[name];
      if (!handler) {
        console.warn(`[gemini-agent] Unknown tool called: ${name} — returning empty result`);
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

    // Push the tool results as a user turn for the next iteration.
    contents.push({ role: "user", parts: responseParts });
  }

  throw new MaxIterationsError(toolCalls);
}

/**
 * Traceable wrapper for the agentic loop. run_type "chain" (it orchestrates
 * multiple LLM turns + tool calls, not a single completion). Logs the prompt,
 * terminal tool, and declared tool names — never `env` or the handler
 * closures. No-op passthrough outside a run-tree context.
 */
export const invokeGeminiWithTools = traceable(invokeGeminiWithToolsImpl, {
  name: "gemini.agentic",
  run_type: "chain",
  processInputs: (inputs) => {
    const a = ((inputs as { args?: unknown[] }).args?.[1] ?? {}) as {
      system?: string;
      user?: string;
      tools?: GeminiFunctionDeclaration[];
      terminalTool?: string;
      maxIterations?: number;
      thinkingLevel?: ThinkingLevel;
    };
    return {
      system: a.system,
      user: a.user,
      terminal_tool: a.terminalTool,
      tools: a.tools?.map((t) => t.name),
      max_iterations: a.maxIterations,
      thinking_level: a.thinkingLevel ?? ThinkingLevel.LOW,
    };
  },
  processOutputs: (outputs) => {
    const r = outputs as Partial<AgentResult>;
    // Log the generated slides (the write_slides output), not just metrics.
    return { output: r.output, usage: r.usage, tool_calls: r.toolCalls?.map((t) => t.tool) };
  },
});

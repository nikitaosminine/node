// ============================================================
// Gemini client — raw REST, no SDK (house style, see invokeGrok).
//
// Two call modes:
//   invokeGeminiStructured — single-shot with JSON schema output.
//   invokeGeminiWithTools  — agentic loop: Gemini calls our tools
//     (exaSearch, DB queries, etc.) until it calls write_slides.
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
    return { usage: r.usage, text_length: r.text?.length };
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

// Gemini API wire types for the function-calling loop.
type GeminiPart =
  | { text: string; thought?: boolean }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiToolCallResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { message?: string };
}

/**
 * Agentic Gemini call with function-calling support.
 *
 * The agent iterates: call Gemini → intercept functionCall parts → execute
 * each handler → push functionResult back → repeat until it calls
 * `write_slides` (the terminal tool) or max iterations are hit.
 *
 * On MaxIterationsError the caller should fall back to invokeGeminiStructured.
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
    temperature?: number;
  },
): Promise<AgentResult> {
  if (!env.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");
  const model = geminiModel(env);
  const apiUrl = `${geminiBaseUrl(env)}/models/${model}:generateContent`;
  const maxIter = args.maxIterations ?? 6;

  const contents: GeminiContent[] = [{ role: "user", parts: [{ text: args.user }] }];
  const toolCalls: ToolCallRecord[] = [];
  let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for (let iter = 0; iter < maxIter; iter++) {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: args.system }] },
        contents,
        tools: [{ functionDeclarations: args.tools }],
        generationConfig: { temperature: args.temperature ?? 0.3 },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Gemini API error (${res.status}): ${body.slice(0, 400)}`);
    }

    const data = (await res.json()) as GeminiToolCallResponse;
    if (data.error?.message) throw new Error(`Gemini API error: ${data.error.message}`);

    const meta = data.usageMetadata;
    totalUsage.promptTokens += meta?.promptTokenCount ?? 0;
    totalUsage.completionTokens += meta?.candidatesTokenCount ?? 0;
    totalUsage.totalTokens += meta?.totalTokenCount ?? 0;

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    // Push the model's turn into the conversation.
    contents.push({ role: "model", parts: parts as GeminiPart[] });

    const fnCalls = parts.filter(
      (p): p is { functionCall: { name: string; args: Record<string, unknown> } } =>
        "functionCall" in p,
    );

    if (fnCalls.length === 0) {
      // No more tool calls but terminal tool was never called — treat as exhausted.
      throw new MaxIterationsError(toolCalls);
    }

    // Execute each tool call; build the function-response turn.
    const responseParts: GeminiPart[] = [];
    for (const { functionCall } of fnCalls) {
      const { name, args: fnArgs } = functionCall;

      // Terminal tool: capture output and exit.
      if (name === args.terminalTool) {
        return {
          output: fnArgs,
          toolCalls,
          usage: totalUsage,
        };
      }

      const handler = args.handlers[name];
      if (!handler) {
        console.warn(`[gemini-agent] Unknown tool called: ${name} — returning empty result`);
        responseParts.push({
          functionResponse: { name, response: { error: `Unknown tool: ${name}` } },
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
      responseParts.push({ functionResponse: { name, response: output } });
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
      temperature?: number;
    };
    return {
      system: a.system,
      user: a.user,
      terminal_tool: a.terminalTool,
      tools: a.tools?.map((t) => t.name),
      max_iterations: a.maxIterations,
      temperature: a.temperature ?? 0.3,
    };
  },
  processOutputs: (outputs) => {
    const r = outputs as Partial<AgentResult>;
    return { usage: r.usage, tool_calls: r.toolCalls?.map((t) => t.tool) };
  },
});

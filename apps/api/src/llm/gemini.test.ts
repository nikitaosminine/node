// Tests for the Gemini RESEARCH loop (invokeGeminiResearch) — stage 1 of recap
// generation. The recap pipeline is split into two stages:
//   1. research  → this agent gathers narrative evidence via tools (AUTO mode,
//      natural text exit, no terminal tool), returning a text synthesis.
//   2. compose   → a separate deterministic invokeGeminiStructured call turns
//      that synthesis into slides via responseSchema (no tools, can't stall).
//
// These pin the loop's contract behaviors:
//   • AUTO function-calling mode — the agent decides to use tools or finish.
//   • Natural completion: a turn with no function call ends the loop and its
//     text becomes the findings (no forcing, no terminal-tool trick).
//   • Gemini 3.x contract: every functionResponse echoes the call id+name, and
//     thoughtSignature parts survive across turns.
//   • A bounded loop that's still calling tools forces a final mode=NONE text
//     synthesis so findings are never empty.
//
// The @google/genai SDK is mocked so the loop logic runs without network or
// the Workers runtime.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGenerateContent } = vi.hoisted(() => ({ mockGenerateContent: vi.fn() }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContent: mockGenerateContent },
  })),
  ThinkingLevel: {
    THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
    MINIMAL: "MINIMAL",
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
  },
  FunctionCallingConfigMode: {
    MODE_UNSPECIFIED: "MODE_UNSPECIFIED",
    AUTO: "AUTO",
    ANY: "ANY",
    NONE: "NONE",
    VALIDATED: "VALIDATED",
  },
}));

// Import AFTER the mock is registered.
import { invokeGeminiResearch, type GeminiFunctionDeclaration } from "./gemini";

type Call = { id?: string; name: string; args?: Record<string, unknown> };

// A model turn that emits one or more function calls.
function fnCallResponse(calls: Call[]) {
  return {
    candidates: [{
      content: { role: "model", parts: calls.map((c) => ({ functionCall: c })) },
      finishReason: "STOP",
    }],
    functionCalls: calls,
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
  };
}

// A plain-text turn with no function call — the agent's "I'm done researching"
// signal. Carries a (non-thought) text part that becomes the findings, plus a
// thought part with a thoughtSignature to mirror real 3.x responses.
function textResponse(text: string) {
  return {
    candidates: [{
      content: {
        role: "model",
        parts: [
          { text: "internal reasoning", thought: true, thoughtSignature: "sig-abc" },
          { text },
        ],
      },
      finishReason: "STOP",
    }],
    functionCalls: [],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 },
  };
}

const env = { GEMINI_API_KEY: "test-key" };

const tools: GeminiFunctionDeclaration[] = [
  {
    name: "get_stored_news",
    description: "stored news",
    parameters: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"] },
  },
  {
    name: "search_news",
    description: "exa search",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    system: "research system prompt",
    user: "gather evidence",
    tools,
    handlers: {
      get_stored_news: vi.fn(async () => ({ articles: [{ title: "TotalEnergies up on oil" }] })),
      search_news: vi.fn(async () => ({ results: [{ title: "oil rally" }] })),
    },
    maxIterations: 5,
    ...overrides,
  };
}

// Walk every content turn and collect functionResponse parts.
function functionResponsesIn(contents: any[]): Array<{ id?: string; name?: string }> {
  const out: Array<{ id?: string; name?: string }> = [];
  for (const c of contents) {
    for (const p of c.parts ?? []) {
      if (p.functionResponse) out.push({ id: p.functionResponse.id, name: p.functionResponse.name });
    }
  }
  return out;
}

function configOf(callIndex: number) {
  return mockGenerateContent.mock.calls[callIndex][0].config;
}

beforeEach(() => {
  mockGenerateContent.mockReset();
});

describe("invokeGeminiResearch — agentic research loop", () => {
  it("uses AUTO function-calling mode (the agent decides to use tools or finish)", async () => {
    mockGenerateContent
      .mockResolvedValueOnce(fnCallResponse([{ id: "c1", name: "get_stored_news", args: { ticker: "TTE.PA" } }]))
      .mockResolvedValueOnce(textResponse("TotalEnergies rose on a crude rally; macro backdrop firm."));

    const result = await invokeGeminiResearch(env, baseArgs() as any);

    expect(configOf(0).toolConfig.functionCallingConfig.mode).toBe("AUTO");
    expect(configOf(0).toolConfig.functionCallingConfig.allowedFunctionNames).toBeUndefined();
    expect(result.findings).toContain("TotalEnergies rose");
    expect(result.toolCalls.map((t) => t.tool)).toEqual(["get_stored_news"]);
  });

  it("finishes naturally on a text turn — its text becomes the findings (no terminal tool)", async () => {
    mockGenerateContent
      .mockResolvedValueOnce(fnCallResponse([{ id: "c1", name: "search_news", args: { query: "oil" } }]))
      .mockResolvedValueOnce(textResponse("Crude rallied this week, lifting energy names."));

    const result = await invokeGeminiResearch(env, baseArgs() as any);

    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    expect(result.findings).toBe("Crude rallied this week, lifting energy names.");
  });

  it("round-trips the function-call id and name on the response", async () => {
    mockGenerateContent
      .mockResolvedValueOnce(fnCallResponse([{ id: "call-1", name: "get_stored_news", args: { ticker: "TTE.PA" } }]))
      .mockResolvedValueOnce(textResponse("done"));

    const args = baseArgs();
    await invokeGeminiResearch(env, args as any);

    expect(args.handlers.get_stored_news).toHaveBeenCalledWith({ ticker: "TTE.PA" });
    const secondCallContents = mockGenerateContent.mock.calls[1][0].contents;
    expect(functionResponsesIn(secondCallContents)).toContainEqual({ id: "call-1", name: "get_stored_news" });
  });

  it("preserves the model's thoughtSignature parts across turns", async () => {
    mockGenerateContent
      .mockResolvedValueOnce(fnCallResponse([{ id: "c1", name: "get_stored_news", args: { ticker: "TTE.PA" } }]))
      .mockResolvedValueOnce(textResponse("done"));

    await invokeGeminiResearch(env, baseArgs() as any);

    // Turn 1's model content (with the functionCall) is pushed back verbatim;
    // assert the loop forwards model turns rather than reconstructing them.
    const secondCallContents = mockGenerateContent.mock.calls[1][0].contents as any[];
    const hasModelTurn = secondCallContents.some(
      (c) => c.role === "model" && (c.parts ?? []).some((p: any) => p.functionCall),
    );
    expect(hasModelTurn).toBe(true);
  });

  it("sends no temperature and a thinkingLevel (Gemini 3.x best practice)", async () => {
    mockGenerateContent.mockResolvedValueOnce(textResponse("done"));

    await invokeGeminiResearch(env, baseArgs() as any);

    const config = configOf(0);
    expect(config.temperature).toBeUndefined();
    expect(config.thinkingConfig?.thinkingLevel).toBe("LOW");
  });

  it("forces a final mode=NONE text synthesis when the iteration bound is hit mid-research", async () => {
    // 3 tool-calling turns exhaust maxIterations=3; the agent never volunteers
    // a text turn. The loop then makes one extra mode=NONE call to force the
    // synthesis so findings are never empty.
    mockGenerateContent
      .mockResolvedValueOnce(fnCallResponse([{ id: "a", name: "get_stored_news", args: { ticker: "TTE.PA" } }]))
      .mockResolvedValueOnce(fnCallResponse([{ id: "b", name: "get_stored_news", args: { ticker: "TTE.PA" } }]))
      .mockResolvedValueOnce(fnCallResponse([{ id: "c", name: "get_stored_news", args: { ticker: "TTE.PA" } }]))
      .mockResolvedValueOnce(textResponse("Forced synthesis after running out of research turns."));

    const result = await invokeGeminiResearch(env, baseArgs({ maxIterations: 3 }) as any);

    // 3 loop iterations + 1 forced synthesis call = 4 total.
    expect(mockGenerateContent).toHaveBeenCalledTimes(4);
    // The 4th call forbids function calls (mode NONE).
    expect(configOf(3).toolConfig.functionCallingConfig.mode).toBe("NONE");
    expect(result.findings).toBe("Forced synthesis after running out of research turns.");
  });

  it("accumulates token usage across all turns", async () => {
    mockGenerateContent
      .mockResolvedValueOnce(fnCallResponse([{ id: "c1", name: "get_stored_news", args: { ticker: "TTE.PA" } }]))
      .mockResolvedValueOnce(textResponse("done"));

    const result = await invokeGeminiResearch(env, baseArgs() as any);

    // fnCall turn (10/20/30) + text turn (5/5/10).
    expect(result.usage).toEqual({ promptTokens: 15, completionTokens: 25, totalTokens: 40 });
  });
});

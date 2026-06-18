// Regression tests for the agentic Gemini loop (invokeGeminiWithTools).
//
// These pin the two contract behaviors that broke when gemini-3.5-flash went
// GA and started enforcing Gemini 3.x function-calling rules:
//
//   1. A turn with no function call (thinking/text-only, or an empty
//      `finishReason: STOP` turn caused by a malformed prior response) must
//      NOT end the loop. The old hand-rolled loop threw MaxIterationsError on
//      the first such turn and fell back to the ungrounded static path. The
//      fix nudges and continues.
//   2. Every functionResponse sent back must echo the `id` (and `name`) of the
//      functionCall it answers. A missing id is exactly what made 3.5 Flash
//      return the empty STOP turn in the first place.
//
// The @google/genai SDK is mocked so the loop logic is exercised without
// network or the Workers runtime.

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
}));

// Import AFTER the mock is registered.
import { invokeGeminiWithTools, MaxIterationsError, type GeminiFunctionDeclaration } from "./gemini";

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

// A thinking/text-only turn with no function call — the shape that used to
// kill the loop. Includes a thoughtSignature to mirror real 3.x responses.
function emptyThinkingResponse() {
  return {
    candidates: [{
      content: {
        role: "model",
        parts: [{ text: "Let me consider the portfolio...", thought: true, thoughtSignature: "sig-abc" }],
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
    name: "write_slides",
    description: "terminal",
    parameters: { type: "object", properties: { slides: { type: "array", items: { type: "object" } } }, required: ["slides"] },
  },
];

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    system: "system prompt",
    user: "write the recap",
    tools,
    handlers: {
      get_stored_news: vi.fn(async () => ({ articles: [{ title: "TotalEnergies up on oil" }] })),
    },
    terminalTool: "write_slides",
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

beforeEach(() => {
  mockGenerateContent.mockReset();
});

describe("invokeGeminiWithTools — Gemini 3.x function-calling contract", () => {
  it("round-trips the function-call id and name on the response", async () => {
    mockGenerateContent
      .mockResolvedValueOnce(fnCallResponse([{ id: "call-1", name: "get_stored_news", args: { ticker: "TTE.PA" } }]))
      .mockResolvedValueOnce(fnCallResponse([{ id: "call-2", name: "write_slides", args: { slides: [{ kind: "performance", headline: "h", body: ["b"] }] } }]));

    const args = baseArgs();
    const result = await invokeGeminiWithTools(env, args as any);

    // Terminal output captured.
    expect(result.output.slides).toBeDefined();
    expect(result.toolCalls.map((t) => t.tool)).toEqual(["get_stored_news"]);
    expect(args.handlers.get_stored_news).toHaveBeenCalledWith({ ticker: "TTE.PA" });

    // The second model call must carry a functionResponse echoing id=call-1.
    const secondCallContents = mockGenerateContent.mock.calls[1][0].contents;
    const responses = functionResponsesIn(secondCallContents);
    expect(responses).toContainEqual({ id: "call-1", name: "get_stored_news" });
  });

  it("does NOT abort on a thinking/text-only turn — it nudges and continues", async () => {
    // Turn 1: empty thinking turn (the old failure trigger). Turn 2: write_slides.
    mockGenerateContent
      .mockResolvedValueOnce(emptyThinkingResponse())
      .mockResolvedValueOnce(fnCallResponse([{ id: "call-9", name: "write_slides", args: { slides: [{ kind: "performance", headline: "h", body: ["b"] }] } }]));

    const result = await invokeGeminiWithTools(env, baseArgs() as any);

    // Loop survived the empty turn and completed.
    expect(result.output.slides).toBeDefined();
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);

    // A nudge user turn was injected before the second call.
    const secondCallContents = mockGenerateContent.mock.calls[1][0].contents as any[];
    const nudged = secondCallContents.some(
      (c) => c.role === "user" && (c.parts ?? []).some((p: any) => typeof p.text === "string" && p.text.includes("write_slides")),
    );
    expect(nudged).toBe(true);
  });

  it("preserves the model's thoughtSignature parts across turns", async () => {
    mockGenerateContent
      .mockResolvedValueOnce(emptyThinkingResponse())
      .mockResolvedValueOnce(fnCallResponse([{ id: "call-9", name: "write_slides", args: { slides: [] } }]));

    await invokeGeminiWithTools(env, baseArgs() as any);

    const secondCallContents = mockGenerateContent.mock.calls[1][0].contents as any[];
    const hasSignature = secondCallContents.some(
      (c) => c.role === "model" && (c.parts ?? []).some((p: any) => p.thoughtSignature === "sig-abc"),
    );
    expect(hasSignature).toBe(true);
  });

  it("sends no temperature and a thinkingLevel (Gemini 3.x best practice)", async () => {
    mockGenerateContent.mockResolvedValueOnce(
      fnCallResponse([{ id: "call-2", name: "write_slides", args: { slides: [] } }]),
    );

    await invokeGeminiWithTools(env, baseArgs() as any);

    const config = mockGenerateContent.mock.calls[0][0].config;
    expect(config.temperature).toBeUndefined();
    expect(config.thinkingConfig?.thinkingLevel).toBe("LOW");
  });

  it("still throws MaxIterationsError when the model never commits to a tool", async () => {
    // Every turn is an empty thinking turn → genuine exhaustion.
    mockGenerateContent.mockResolvedValue(emptyThinkingResponse());

    await expect(invokeGeminiWithTools(env, baseArgs({ maxIterations: 3 }) as any)).rejects.toBeInstanceOf(
      MaxIterationsError,
    );
    // Bounded by maxIterations — not an infinite loop.
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
  });
});

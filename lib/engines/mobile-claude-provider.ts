// ============================================================
// KPMG TrustLens — Claude vision provider for the mobile audit
// Uses the official Anthropic SDK. Screenshots are sent as base64
// image blocks; the prompt asks for a single JSON object back.
// ============================================================

import Anthropic from "@anthropic-ai/sdk";

export const CLAUDE_MOBILE_MODEL =
  process.env.MOBILE_AUDIT_CLAUDE_MODEL || "claude-opus-5-5";

type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export async function callClaudeVision(
  system: string,
  prompt: string,
  images: { base64: string; mimeType: string }[],
): Promise<string> {
  const client = new Anthropic({ maxRetries: 0, timeout: 180000 });
  const response = await client.messages.create({
    model: CLAUDE_MOBILE_MODEL,
    max_tokens: 16000,
    // Thinking is always on for this model; effort sets its depth
    output_config: { effort: "high" },
    system,
    messages: [
      {
        role: "user",
        content: [
          ...images.map((img) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: img.mimeType as ImageMediaType,
              data: img.base64,
            },
          })),
          { type: "text" as const, text: prompt },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to analyse this screen");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude response was cut off (max_tokens)");
  }
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

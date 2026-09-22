/**
 * Hermes Memory — LLM channel.
 *
 * V2 (native): uses `ctx.generate.text()` — no sessions, no tools, no history.
 * No internal sessions, no idle loops, no cleanup needed.
 */

export type InternalCompletion = {
  text: string;
  error?: string;
};

type GenerateFn = (input: { prompt: string; model?: { providerID: string; id: string } }) => Promise<{ text: string }>;

/**
 * V2 completion via ctx.generate.text().
 * `generate` is `ctx.generate.text` bound (or any compatible function).
 */
export async function completeWithGenerate(
  generate: GenerateFn,
  systemPrompt: string,
  userPrompt: string,
  model?: { providerID: string; id: string },
): Promise<InternalCompletion> {
  try {
    const combined = `${systemPrompt}\n\n${userPrompt}`;
    const result = await generate({ prompt: combined, model });
    const text = typeof result?.text === "string" ? result.text.trim() : "";
    if (!text) return { text: "", error: "empty model output" };
    return { text };
  } catch (err) {
    return { text: "", error: String(err) };
  }
}

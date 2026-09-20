/**
 * Hermes Memory — LLM channel.
 *
 * V2 (native): uses `ctx.generate.text()` — no sessions, no tools, no history.
 * No internal sessions, no idle loops, no cleanup needed.
 *
 * V1 (legacy, kept for backwards compat): drives the LLM through a throwaway
 * internal session, title-tagged so background learning can skip it.
 */

export const INTERNAL_SESSION_TITLE = "[hm-internal]";

/** IDs of internal sessions created by this process (V1 path only). */
const internalSessionIDs = new Set<string>();

export function isInternalSessionId(sessionID: string | undefined | null): boolean {
  return typeof sessionID === "string" && internalSessionIDs.has(sessionID);
}

export function isInternalSession(title: string | undefined | null): boolean {
  return typeof title === "string" && title.startsWith(INTERNAL_SESSION_TITLE);
}

export type InternalCompletion = {
  text: string;
  error?: string;
};

type GenerateFn = (input: {
  prompt: string;
  model?: { providerID: string; id: string };
}) => Promise<{ text: string }>;

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

/** Minimal V1 client shape (only what the legacy path touches). */
type V1ClientLike = {
  session: {
    create: (input: unknown) => Promise<{ data?: { id?: string } }>;
    prompt: (input: unknown) => Promise<{ data?: { parts?: Array<{ type?: string; text?: unknown }> } }>;
    delete: (input: unknown) => Promise<unknown>;
  };
};

/**
 * V1 completion via a fresh internal session (legacy).
 * Kept so the `server()` export keeps working on OpenCode 1.x.
 */
export async function completeWithInternalSession(
  client: V1ClientLike,
  directory: string,
  systemPrompt: string,
  userPrompt: string,
  model?: { providerID: string; modelID: string },
): Promise<InternalCompletion> {
  let sessionID: string | undefined;
  try {
    const created = await client.session.create({
      query: { directory },
      body: { title: INTERNAL_SESSION_TITLE },
    } as unknown);
    sessionID = created.data?.id;
    if (!sessionID) return { text: "", error: "Failed to create internal session" };
    internalSessionIDs.add(sessionID);

    const resp = await client.session.prompt({
      path: { id: sessionID },
      body: {
        model,
        parts: [
          { type: "text", text: systemPrompt },
          { type: "text", text: userPrompt },
        ],
      },
    } as unknown);
    const parts = resp.data?.parts ?? [];
    const text = parts
      .filter((p) => p.type === "text" && typeof (p as { text?: unknown }).text === "string")
      .map((p) => (p as { text: string }).text)
      .join("\n");
    return { text: text.trim() };
  } catch (err) {
    return { text: "", error: String(err) };
  } finally {
    if (sessionID) {
      internalSessionIDs.delete(sessionID);
      try {
        await client.session.delete({ path: { id: sessionID } } as unknown);
      } catch (err) {
        console.error(`[hermes-memory] internal session delete failed: ${sessionID}`, err);
      }
    }
  }
}

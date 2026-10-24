/** Telegram answers 400 "message is not modified" when an edit would not change anything. That is not a failure. */
export function isNotModified(error: unknown): boolean {
  const description = (error as { description?: unknown } | null)?.description;
  return String(typeof description === "string" ? description : error).includes("message is not modified");
}

interface CallbackLike {
  callbackQuery?: unknown;
  answerCallbackQuery(other?: { text?: string }): Promise<unknown>;
}

/** Always answer a tapped button, even when the action failed, so the button's spinner stops. */
export async function answerFailure(ctx: CallbackLike): Promise<void> {
  if (!ctx.callbackQuery) return;
  await ctx.answerCallbackQuery({ text: "Something went wrong. Please try again." }).catch(() => undefined);
}

/** Runs a message edit; an edit that changes nothing is not an error. */
export async function editQuietly(edit: () => Promise<unknown>): Promise<void> {
  try {
    await edit();
  } catch (error) {
    if (!isNotModified(error)) throw error;
  }
}

/** What happened to one file of a Telegram album. */
export type AlbumOutcome = "saved" | "duplicate" | "trashed" | "empty" | "failed";

export interface AlbumTally {
  saved: number;
  duplicate: number;
  trashed: number;
  empty: number;
  failed: number;
}

/** The one message that tells the user how the whole album went. Failures are always spelled out. */
export function albumSummary(tally: AlbumTally): string {
  const parts: string[] = [];
  if (tally.saved) parts.push(`${tally.saved} saved`);
  if (tally.duplicate) parts.push(`${tally.duplicate} already in your Cloud Drive`);
  if (tally.trashed) parts.push(`${tally.trashed} already in your Trash`);
  if (tally.empty) parts.push(`${tally.empty} without a file I can save`);
  if (tally.failed) parts.push(`${tally.failed} failed`);
  const text = `${tally.failed ? "⚠️" : "✅"} Album: ${parts.join(", ")}.`;
  return tally.failed ? `${text}\nSend the failed files again - nothing else was lost.` : text;
}

interface AlbumRun {
  status: Promise<number | null>;
  tally: AlbumTally;
  edits: Promise<void>;
  lastSeen: number;
}

/**
 * Albums arrive as separate messages. All of them share one status message that always shows the running
 * result of every file, so a failure on any file is reported and "saved" is never claimed for the others.
 */
export class AlbumReports {
  #runs = new Map<string, AlbumRun>();

  constructor(private ttlMs = 120_000, private clock: () => number = Date.now) {}

  /** Joins the album `key` (the first caller opens the status message) and returns a recorder for one file. */
  join(
    key: string,
    open: () => Promise<number | null>,
    edit: (statusId: number, text: string) => Promise<unknown>,
  ) {
    const now = this.clock();
    for (const [other, run] of this.#runs) if (now - run.lastSeen > this.ttlMs) this.#runs.delete(other);
    let run = this.#runs.get(key);
    if (!run) {
      run = {
        status: open().catch((error) => {
          console.warn("Unable to open the album status message", String(error));
          return null;
        }),
        tally: { saved: 0, duplicate: 0, trashed: 0, empty: 0, failed: 0 },
        edits: Promise.resolve(),
        lastSeen: now,
      };
      this.#runs.set(key, run);
    }
    run.lastSeen = now;
    const current = run;
    return {
      /** Records the outcome and resolves once the status message shows it. Edits run one after another. */
      record(outcome: AlbumOutcome): Promise<void> {
        current.tally[outcome]++;
        current.edits = current.edits.then(async () => {
          const statusId = await current.status;
          if (statusId === null) return;
          try {
            await edit(statusId, albumSummary(current.tally));
          } catch (error) {
            console.warn("Unable to update the album status message", String(error));
          }
        });
        return current.edits;
      },
    };
  }
}

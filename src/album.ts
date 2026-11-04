import { logWarn } from "./redact.ts";

/** What happened to one file of a Telegram album. */
export type AlbumOutcome = "saved" | "duplicate" | "trashed" | "empty" | "failed";

export interface AlbumTally {
  saved: number;
  duplicate: number;
  trashed: number;
  empty: number;
  failed: number;
  /** Files that were still being saved when the "taking longer than usual" notice went out. */
  slow?: number;
}

/** The one message that tells the user how the whole album went. Failures are always spelled out. */
export function albumSummary(tally: AlbumTally): string {
  const slow = tally.slow ?? 0;
  const parts: string[] = [];
  if (tally.saved) parts.push(`${tally.saved} saved`);
  if (tally.duplicate) parts.push(`${tally.duplicate} already in your Cloud Drive`);
  if (tally.trashed) parts.push(`${tally.trashed} already in your Trash`);
  if (tally.empty) parts.push(`${tally.empty} without a file I can save`);
  if (tally.failed) parts.push(`${tally.failed} failed`);
  if (slow) parts.push(`${slow} still saving`);
  let text = `${tally.failed ? "⚠️" : slow ? "⏳" : "✅"} Album: ${parts.join(", ")}.`;
  if (tally.failed) text += "\nSend the failed files again - nothing else was lost.";
  if (slow) {
    text += "\nIf this doesn't update within a minute, send those files again - nothing will be duplicated.";
  }
  return text;
}

/**
 * Counters kept in the database, so every server instance that receives a file of the same album shares one
 * status message and one tally. Optional: without it each instance counts on its own.
 */
export interface SharedAlbum {
  /** True for the first caller to claim the album; that caller opens the status message. */
  claim(key: string): Promise<boolean>;
  setStatus(key: string, statusId: number): Promise<void>;
  getStatus(key: string): Promise<number | null>;
  /** Adds one file's outcome (or one "slow" file) and returns every counter. */
  record(key: string, outcome: AlbumOutcome | "slow", wasSlow: boolean): Promise<AlbumTally>;
  read(key: string): Promise<AlbumTally>;
}

export interface AlbumOptions {
  shared?: SharedAlbum;
  /** How long a later instance waits for the first one to publish the status message. */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface AlbumRun {
  /** The status message (null when none could be opened) and whether the tally is shared through the database. */
  start: Promise<{ statusId: number | null; shared: boolean }>;
  /** What this instance has counted itself; the whole story only when the tally is not shared. */
  tally: AlbumTally;
  edits: Promise<void>;
  lastSeen: number;
  /** The text this instance last put on the status message (an identical edit would only make Telegram complain). */
  shown: string | null;
}

/**
 * Albums arrive as separate messages. All of them share one status message that always shows the running
 * result of every file, so a failure on any file is reported and "saved" is never claimed for the others.
 * With a `shared` store this holds even when the files of one album reach different server instances.
 */
export class AlbumReports {
  #runs = new Map<string, AlbumRun>();
  #warnedAboutStore = false;
  #options: Required<Omit<AlbumOptions, "shared">> & Pick<AlbumOptions, "shared">;

  constructor(private ttlMs = 120_000, private clock: () => number = Date.now, options: AlbumOptions = {}) {
    this.#options = {
      shared: options.shared,
      waitMs: options.waitMs ?? 8_000,
      pollMs: options.pollMs ?? 250,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
  }

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
        start: this.#start(key, open),
        tally: { saved: 0, duplicate: 0, trashed: 0, empty: 0, failed: 0, slow: 0 },
        edits: Promise.resolve(),
        lastSeen: now,
        shown: null,
      };
      this.#runs.set(key, run);
    }
    run.lastSeen = now;
    const current = run;
    const apply = (outcome: AlbumOutcome | "slow", wasSlow: boolean): Promise<void> => {
      if (outcome === "slow") current.tally.slow = (current.tally.slow ?? 0) + 1;
      else {
        current.tally[outcome]++;
        if (wasSlow) current.tally.slow = Math.max(0, (current.tally.slow ?? 0) - 1);
      }
      current.edits = current.edits.then(() => this.#show(key, current, edit, outcome, wasSlow));
      return current.edits;
    };
    return {
      /** Records the outcome and resolves once the status message shows it. Edits run one after another. */
      record(outcome: AlbumOutcome, wasSlow = false): Promise<void> {
        return apply(outcome, wasSlow);
      },
      /** Notes that this file is taking longer than usual; a later `record(outcome, true)` settles it. */
      delayed(): Promise<void> {
        return apply("slow", false);
      },
    };
  }

  async #start(
    key: string,
    open: () => Promise<number | null>,
  ): Promise<{ statusId: number | null; shared: boolean }> {
    const openQuietly = () =>
      open().catch((error) => {
        logWarn("Unable to open the album status message", error);
        return null;
      });
    const store = this.#options.shared;
    if (store) {
      try {
        if (await store.claim(key)) {
          const statusId = await openQuietly();
          if (statusId !== null) {
            await store.setStatus(key, statusId).catch((error) =>
              logWarn("Unable to share the album status", error)
            );
          }
          return { statusId, shared: true };
        }
        const waited = await this.#waitForStatus(store, key);
        if (waited !== null) return { statusId: waited, shared: true };
        logWarn("The first album message never published its status message; opening one here");
      } catch (error) {
        if (!this.#warnedAboutStore) {
          this.#warnedAboutStore = true;
          logWarn("Shared album tracking is unavailable; each server counts its own files", error);
        }
      }
    }
    return { statusId: await openQuietly(), shared: false };
  }

  async #waitForStatus(store: SharedAlbum, key: string): Promise<number | null> {
    for (let waited = 0; waited <= this.#options.waitMs; waited += this.#options.pollMs) {
      const statusId = await store.getStatus(key);
      if (statusId !== null) return statusId;
      await this.#options.sleep(this.#options.pollMs);
    }
    return null;
  }

  /**
   * Puts the current result on the status message. With a shared tally, other instances may be editing the same
   * message at the same time, so after each edit the counters are read again and the message is corrected until
   * it matches them: the last instance to finish always leaves the complete result on screen.
   */
  async #show(
    key: string,
    run: AlbumRun,
    edit: (statusId: number, text: string) => Promise<unknown>,
    outcome: AlbumOutcome | "slow",
    wasSlow: boolean,
  ): Promise<void> {
    const { statusId, shared } = await run.start;
    if (statusId === null) return;
    const store = shared ? this.#options.shared : undefined;
    let tally = run.tally;
    if (store) {
      try {
        tally = await store.record(key, outcome, wasSlow);
      } catch (error) {
        logWarn("Unable to update the shared album counters", error);
        await this.#paint(run, statusId, run.tally, edit); // fall back to this instance's own count
        return;
      }
    }
    for (let round = 0; round < 4; round++) {
      if (!await this.#paint(run, statusId, tally, edit) || !store) return;
      let latest: AlbumTally;
      try {
        latest = await store.read(key);
      } catch {
        return;
      }
      if (albumSummary(latest) === run.shown) return;
      tally = latest;
    }
  }

  /** Edits the status message to show `tally`. False when the edit failed. */
  async #paint(
    run: AlbumRun,
    statusId: number,
    tally: AlbumTally,
    edit: (statusId: number, text: string) => Promise<unknown>,
  ): Promise<boolean> {
    const text = albumSummary(tally);
    if (text === run.shown) return true;
    try {
      await edit(statusId, text);
      run.shown = text;
      return true;
    } catch (error) {
      logWarn("Unable to update the album status message", error);
      return false;
    }
  }
}

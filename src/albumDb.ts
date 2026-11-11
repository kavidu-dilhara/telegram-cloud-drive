import type { AlbumOutcome, AlbumTally, SharedAlbum } from "./album.ts";
import { db } from "./db.ts";

interface CounterRow {
  n_saved: number;
  n_duplicate: number;
  n_trashed: number;
  n_empty: number;
  n_failed: number;
  n_slow: number;
}

const COUNTERS = "n_saved, n_duplicate, n_trashed, n_empty, n_failed, n_slow";

const toTally = (row: CounterRow): AlbumTally => ({
  saved: row.n_saved,
  duplicate: row.n_duplicate,
  trashed: row.n_trashed,
  empty: row.n_empty,
  failed: row.n_failed,
  slow: row.n_slow,
});

/** True when the optional `album_reports` table or its functions have not been created in this database. */
export const albumTableMissing = (error: { code?: string } | null): boolean =>
  error?.code === "PGRST205" || error?.code === "42P01" || error?.code === "PGRST202" ||
  error?.code === "42883";

/**
 * Album counters in Supabase. Every method throws on a database error; the album tracker then falls back to
 * counting on one server only, so albums keep working even before the album tables from `supabase/schema.sql` exist.
 */
export const databaseAlbums: SharedAlbum = {
  async claim(key) {
    const { data, error } = await db.rpc("claim_album", { p_key: key });
    if (error) throw error;
    return data === true;
  },

  async setStatus(key, statusId) {
    const { error } = await db.from("album_reports").update({ status_message_id: statusId }).eq("key", key);
    if (error) throw error;
  },

  async getStatus(key) {
    const { data, error } = await db.from("album_reports").select("status_message_id").eq("key", key)
      .maybeSingle();
    if (error) throw error;
    return data?.status_message_id ?? null;
  },

  async record(key: string, outcome: AlbumOutcome | "slow", wasSlow: boolean) {
    const { data, error } = await db.rpc("record_album", {
      p_key: key,
      p_outcome: outcome,
      p_was_slow: wasSlow,
    });
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as CounterRow | undefined;
    if (!row) throw new Error("The album counters came back empty");
    return toTally(row);
  },

  async read(key) {
    const { data, error } = await db.from("album_reports").select(COUNTERS).eq("key", key).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("The album counters were not found");
    return toTally(data as CounterRow);
  },
};

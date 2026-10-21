import assert from "node:assert/strict";
import { AlbumReports, albumSummary } from "./album.ts";

const zero = { saved: 0, duplicate: 0, trashed: 0, empty: 0, failed: 0 };

Deno.test("albumSummary: failures are always spelled out", () => {
  assert.equal(albumSummary({ ...zero, saved: 3 }), "✅ Album: 3 saved.");
  assert.equal(
    albumSummary({ ...zero, saved: 2, failed: 1 }),
    "⚠️ Album: 2 saved, 1 failed.\nSend the failed files again - nothing else was lost.",
  );
  assert.equal(
    albumSummary({ ...zero, saved: 1, duplicate: 1, trashed: 1 }),
    "✅ Album: 1 saved, 1 already in your Cloud Drive, 1 already in your Trash.",
  );
  assert.equal(albumSummary({ ...zero, failed: 3 }).startsWith("⚠️ Album: 3 failed."), true);
});

Deno.test("AlbumReports: one status message for the whole album, final text shows every file", async () => {
  const reports = new AlbumReports();
  let opened = 0;
  const edits: string[] = [];
  const open = () => (opened++, Promise.resolve(77));
  const edit = (id: number, text: string) => (assert.equal(id, 77), edits.push(text), Promise.resolve());

  const a = reports.join("chat:album", open, edit);
  const b = reports.join("chat:album", open, edit);
  const c = reports.join("chat:album", open, edit);
  assert.equal(opened, 1);

  // files finish in any order; one of them fails
  await Promise.all([b.record("failed"), a.record("saved"), c.record("saved")]);
  assert.equal(
    edits.at(-1),
    "⚠️ Album: 2 saved, 1 failed.\nSend the failed files again - nothing else was lost.",
  );
  assert.equal(edits.length, 3); // edits run one after another, never overlapping
});

Deno.test("AlbumReports: the first file's success is not reported as the whole album", async () => {
  const reports = new AlbumReports();
  const edits: string[] = [];
  const edit = (_id: number, text: string) => (edits.push(text), Promise.resolve());
  const first = reports.join("k", () => Promise.resolve(1), edit);
  const second = reports.join("k", () => Promise.resolve(1), edit);
  await first.record("saved");
  assert.equal(edits.at(-1), "✅ Album: 1 saved."); // so far
  await second.record("failed");
  assert.match(edits.at(-1)!, /1 saved, 1 failed/); // the later failure is reported, not swallowed
});

Deno.test("AlbumReports: separate albums and expired albums do not mix", async () => {
  let now = 0;
  const reports = new AlbumReports(1000, () => now);
  const edits: string[] = [];
  const edit = (_id: number, text: string) => (edits.push(text), Promise.resolve());
  let opened = 0;
  const open = () => (opened++, Promise.resolve(opened));
  await reports.join("one", open, edit).record("saved");
  await reports.join("two", open, edit).record("failed");
  assert.equal(opened, 2);
  now = 5000; // album "one" expired
  await reports.join("one", open, edit).record("saved");
  assert.equal(opened, 3);
  assert.equal(edits.at(-1), "✅ Album: 1 saved.");
});

Deno.test("AlbumReports: a status message that cannot be opened or edited never throws", async () => {
  const reports = new AlbumReports();
  await reports.join("x", () => Promise.reject(new Error("telegram down")), () => Promise.resolve()).record(
    "saved",
  );
  await reports.join("y", () => Promise.resolve(5), () => Promise.reject(new Error("message not modified")))
    .record("saved");
});

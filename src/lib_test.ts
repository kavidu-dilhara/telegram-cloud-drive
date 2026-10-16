import assert from "node:assert/strict";
import {
  chunk,
  descendants,
  escapeLike,
  extensionOf,
  folderPath,
  formatSize,
  isUuid,
  parseIds,
  renameKeepingExtension,
  safeEqualText,
  sha256Hex,
  singleLine,
} from "./lib.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

Deno.test("isUuid / parseIds validate and de-duplicate", () => {
  assert.ok(isUuid(id(1)));
  assert.equal(isUuid("nope"), false);
  assert.equal(isUuid(5), false);
  assert.deepEqual(parseIds([id(1), id(1), id(2)]), [id(1), id(2)]);
  assert.equal(parseIds([]), null);
  assert.equal(parseIds(["x"]), null);
  assert.equal(parseIds("nope"), null);
  assert.equal(parseIds(Array.from({ length: 201 }, (_, i) => id(i + 1))), null);
});

Deno.test("escapeLike makes % _ and backslash literal", () => {
  assert.equal(escapeLike("50%_off\\"), "50\\%\\_off\\\\");
});

Deno.test("chunk splits evenly", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
});

Deno.test("descendants never includes unrelated folders and handles chains", () => {
  const rows = [
    { id: "a", parent_id: null },
    { id: "b", parent_id: "a" },
    { id: "c", parent_id: "b" },
    { id: "x", parent_id: null },
  ];
  assert.deepEqual([...descendants("a", rows)].sort(), ["a", "b", "c"]);
  assert.deepEqual([...descendants("x", rows)], ["x"]);
});

Deno.test("folderPath builds readable paths and survives cycles", () => {
  const folders = [
    { id: "a", parent_id: null, name: "Projects" },
    { id: "b", parent_id: "a", name: "2026" },
    { id: "c", parent_id: "d", name: "Loop1" },
    { id: "d", parent_id: "c", name: "Loop2" },
  ];
  assert.equal(folderPath("b", folders), "/Projects/2026");
  assert.equal(folderPath(null, folders), "/");
  assert.equal(folderPath("missing", folders), "/");
  assert.ok(folderPath("c", folders).startsWith("/"));
});

Deno.test("extensionOf", () => {
  assert.equal(extensionOf("report.PDF"), "pdf");
  assert.equal(extensionOf("archive.tar.gz"), "gz");
  assert.equal(extensionOf("noext"), null);
  assert.equal(extensionOf(".hidden"), null);
  assert.equal(extensionOf("trailing."), null);
});

Deno.test("rename changes only the name and always keeps the extension", () => {
  assert.equal(renameKeepingExtension("report.pdf", "Summary"), "Summary.pdf");
  assert.equal(renameKeepingExtension("report.pdf", "Summary.pdf"), "Summary.pdf");
  assert.equal(renameKeepingExtension("report.PDF", "Summary.pdf"), "Summary.PDF");
  assert.equal(renameKeepingExtension("report.pdf", "Summary.exe"), "Summary.exe.pdf");
  assert.equal(renameKeepingExtension("voice_12", "note"), "note");
  assert.equal(renameKeepingExtension("a.txt", "  a/b\\c  "), "a b c.txt");
  assert.equal(renameKeepingExtension("a.txt", "   "), null);
  assert.equal(renameKeepingExtension("a.txt", ".txt"), null);
  assert.equal(renameKeepingExtension("a.txt", "x".repeat(300)), null);
});

Deno.test("formatSize and singleLine", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(1536), "2 KB");
  assert.equal(formatSize(5 * 1048576), "5.00 MB");
  assert.equal(formatSize(3 * 1073741824), "3.00 GB");
  assert.equal(formatSize(NaN), "0 B");
  assert.equal(singleLine("a\nb\r\nc"), "a b c");
  assert.equal(singleLine(5), "");
  assert.equal(singleLine("x".repeat(500), 10).length, 10);
});

Deno.test("sha256Hex and safeEqualText", async () => {
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.ok(safeEqualText("same", "same"));
  assert.equal(safeEqualText("same", "diff"), false);
  assert.equal(safeEqualText("short", "longer-text"), false);
});

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
  resolveClientIp,
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

Deno.test("resolveClientIp: forwarding headers are ignored unless a trusted header is configured", () => {
  const headers = new Headers({ "CF-Connecting-IP": "6.6.6.6", "X-Forwarded-For": "7.7.7.7, 8.8.8.8" });
  assert.equal(resolveClientIp(headers, "10.0.0.5"), "10.0.0.5");
  assert.equal(resolveClientIp(headers, undefined), "unknown");
});

Deno.test("resolveClientIp: cf-connecting-ip is used only when configured and valid", () => {
  const options = { header: "cf-connecting-ip" as const };
  assert.equal(
    resolveClientIp(new Headers({ "CF-Connecting-IP": "203.0.113.7" }), "10.0.0.5", options),
    "203.0.113.7",
  );
  assert.equal(
    resolveClientIp(new Headers({ "CF-Connecting-IP": "not-an-ip" }), "10.0.0.5", options),
    "10.0.0.5",
  );
  assert.equal(resolveClientIp(new Headers(), "10.0.0.5", options), "10.0.0.5");
});

Deno.test("resolveClientIp: x-forwarded-for is read from the right, not the forgeable left", () => {
  const options = { header: "x-forwarded-for" as const };
  const forged = new Headers({ "X-Forwarded-For": "1.2.3.4, 198.51.100.20" });
  assert.equal(resolveClientIp(forged, "10.0.0.5", options), "198.51.100.20");
  assert.equal(resolveClientIp(forged, "10.0.0.5", { ...options, hops: 2 }), "1.2.3.4");
  assert.equal(resolveClientIp(forged, "10.0.0.5", { ...options, hops: 3 }), "10.0.0.5");
  assert.equal(
    resolveClientIp(new Headers({ "X-Forwarded-For": "2001:db8::1" }), "10.0.0.5", options),
    "2001:db8::1",
  );
  assert.equal(resolveClientIp(new Headers({ "X-Forwarded-For": "junk" }), "10.0.0.5", options), "10.0.0.5");
});

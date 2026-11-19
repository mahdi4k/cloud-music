// Uploads the MP3s from public/songs ONTO the website (Workers KV).
// After this, songs live on the website: "npm run deploy" NEVER removes them,
// even when the folder is empty. The folder is only an "add these songs" queue;
// removing music is done on the website (Manage -> trash icon).
//
// Runs automatically before every deploy (see package.json), or alone: npm run import
// Folder name = group. Example: public/songs/Rock/song.mp3 -> group "Rock"
//
// Idempotent: files that were already imported are skipped, so you can keep the
// folder as long as you like. Delete a song on the website first if you want to
// import a changed file with the same name again.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SONGS_DIR = "public/songs";
const MAX_FILE_BYTES = 25 * 1024 * 1024; // KV value limit: 25 MiB
const DEFAULT_GROUP = "Other";
const WRANGLER_JS = join("node_modules", "wrangler", "bin", "wrangler.js");
// Wrangler v4 talks to LOCAL storage by default. The real website needs --remote.
// (--local is used only for testing together with `wrangler dev`.)
const KV_SCOPE = process.argv.includes("--local") ? ["--local"] : ["--remote"];

if (!existsSync(WRANGLER_JS)) {
  console.error("Wrangler is not installed. Run 'npm install' first.");
  process.exit(1);
}

function wrangler(kvArgs, { allowMissing = false } = {}) {
  const result = spawnSync(
    process.execPath,
    [WRANGLER_JS, "kv", ...kvArgs, "--binding", "SONGS", ...KV_SCOPE],
    { encoding: "utf8" },
  );
  const output = (result.stdout || "") + (result.stderr || "");
  if (result.status !== 0) {
    if (allowMissing && /value not found/i.test(output)) return null;
    if (/CLOUDFLARE_API_TOKEN|not authenticated|login|OAuth/i.test(output)) {
      console.error("Could not reach your Cloudflare account. Run 'npx wrangler login' and try again.");
    } else {
      console.error("Wrangler command failed: wrangler kv " + kvArgs.join(" "));
      console.error(output.trim());
    }
    process.exit(1);
  }
  if (allowMissing && /value not found/i.test(output)) return null;
  return result.stdout.trim();
}

function listMp3Paths(folder) {
  const paths = [];
  let entries;
  try { entries = readdirSync(join(SONGS_DIR, folder), { withFileTypes: true }); }
  catch { return paths; }
  for (const entry of entries) {
    const relativePath = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...listMp3Paths(relativePath));
    else if (entry.name.toLowerCase().endsWith(".mp3")) paths.push(relativePath);
  }
  return paths;
}

const indexRaw = wrangler(["key", "get", "index"], { allowMissing: true });
const index = indexRaw ? JSON.parse(indexRaw) : [];
const importedFiles = new Set(index.filter((song) => song.file).map((song) => song.file));

const paths = listMp3Paths("");
const tooBig = paths.filter((p) => statSync(join(SONGS_DIR, p)).size > MAX_FILE_BYTES);
if (tooBig.length > 0) {
  console.error("These files are bigger than 25 MiB and cannot be uploaded:");
  console.error(tooBig.join("\n"));
  process.exit(1);
}

const fresh = paths.filter((p) => !importedFiles.has(p));
if (fresh.length === 0) {
  console.log(`Nothing new to import (${paths.length} file(s) in ${SONGS_DIR}, all already on the website).`);
  process.exit(0);
}

console.log(`Importing ${fresh.length} song(s) to the website...`);
let done = 0;
for (const relativePath of fresh) {
  const parts = relativePath.split("/");
  const fileName = parts[parts.length - 1];
  const song = {
    id: randomUUID(),
    title: fileName.replace(/\.mp3$/i, ""),
    group: parts.length > 1 ? parts[0] : DEFAULT_GROUP,
    size: statSync(join(SONGS_DIR, relativePath)).size,
    url: "", // filled below
    file: relativePath,
  };
  song.url = "/api/songs/" + song.id;

  wrangler(["key", "put", "song:" + song.id, "--path", join(SONGS_DIR, relativePath)]);
  index.push(song);
  // Write the index after every song, so an interrupted import can simply be run again.
  const tmp = join(tmpdir(), "my-music-index-" + song.id + ".json");
  writeFileSync(tmp, JSON.stringify(index));
  wrangler(["key", "put", "index", "--path", tmp]);
  rmSync(tmp, { force: true });

  done++;
  console.log(`  [${done}/${fresh.length}] ${song.title} -> group "${song.group}"`);
}

console.log(`Done. ${done} song(s) now live on the website.`);
console.log("Deploying with an empty public/songs folder will NOT remove them.");
console.log("You can delete the files from public/songs now (or keep them; already imported files are skipped).");

// Reads public/songs and writes public/songs.json
// Folder name = group. Example: public/songs/Rock/song.mp3 -> group "Rock"
// Songs that were already imported to the website (Workers KV) are skipped,
// so they do not show up twice. Everything else works as before.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SONGS_DIR = "public/songs";
const MAX_FILE_BYTES = 25 * 1024 * 1024; // Cloudflare static file limit: 25 MiB
const DEFAULT_GROUP = "Other";
const WRANGLER_JS = join("node_modules", "wrangler", "bin", "wrangler.js");
const KV_SCOPE = process.argv.includes("--local") ? ["--local"] : ["--remote"];

mkdirSync(SONGS_DIR, { recursive: true });

// Which files are already on the website? (import-songs.mjs marks them with "file")
function importedFilesOnWebsite() {
  if (!existsSync(WRANGLER_JS)) return new Set();
  const result = spawnSync(
    process.execPath,
    [WRANGLER_JS, "kv", "key", "get", "index", "--binding", "SONGS", ...KV_SCOPE],
    { encoding: "utf8" },
  );
  const output = (result.stdout || "") + (result.stderr || "");
  if (result.status !== 0 && !/value not found/i.test(output)) {
    console.warn("Warning: could not read the song list from the website (" + output.trim().split("\n")[0] + ").");
    console.warn("Songs already on the website may be listed twice this time.");
    return new Set();
  }
  if (/value not found/i.test(output)) return new Set();
  try {
    const index = JSON.parse(result.stdout.trim());
    return new Set(index.filter((song) => song.file).map((song) => song.file));
  } catch {
    return new Set();
  }
}

function listMp3Paths(folder) {
  const paths = [];
  for (const entry of readdirSync(`${SONGS_DIR}/${folder}`, { withFileTypes: true })) {
    const relativePath = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...listMp3Paths(relativePath));
    else if (entry.name.toLowerCase().endsWith(".mp3")) paths.push(relativePath);
  }
  return paths;
}

function toSong(relativePath) {
  const parts = relativePath.split("/");
  const fileName = parts[parts.length - 1];
  return {
    title: fileName.replace(/\.mp3$/i, ""),
    group: parts.length > 1 ? parts[0] : DEFAULT_GROUP,
    url: "/songs/" + parts.map(encodeURIComponent).join("/"),
  };
}

function compareSongs(a, b) {
  return a.group.localeCompare(b.group) || a.title.localeCompare(b.title);
}

const imported = importedFilesOnWebsite();
const paths = listMp3Paths("").filter((p) => !imported.has(p));
const tooBig = paths.filter((p) => statSync(`${SONGS_DIR}/${p}`).size > MAX_FILE_BYTES);
if (tooBig.length > 0) {
  console.error("These files are bigger than 25 MiB and cannot be uploaded:");
  console.error(tooBig.join("\n"));
  process.exit(1);
}

const songs = paths.map(toSong).sort(compareSongs);
writeFileSync("public/songs.json", JSON.stringify(songs, null, 2));
const skipped = imported.size ? ` (${imported.size} already on the website, skipped)` : "";
console.log(`Playlist ready: ${songs.length} song(s) from the folder${skipped}`);

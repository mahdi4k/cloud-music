// API for the music player. Songs live in Workers KV, so deploys never remove them.
//   GET    /api/songs            -> list of songs (public)
//   GET    /api/songs/:id        -> the MP3 file, with Range support (public)
//   GET    /api/login            -> checks the admin password
//   POST   /api/songs            -> add a song (admin)  ?title=...&group=...  body = MP3 file
//   PATCH  /api/songs/:id        -> move a song to another group (admin)  ?group=...
//   DELETE /api/songs/:id        -> delete a song (admin)
//   GET    /api/groups           -> list of groups with their image URL (public)
//   PATCH  /api/groups           -> rename a group, moves songs + image (admin)  ?from=...&to=...
//   GET    /api/group-image/:id  -> a group image file (public)
//   PUT    /api/group-image       -> set a group image (admin)  ?group=...  body = SVG/PNG/JPG file
//   DELETE /api/group-image       -> remove a group image (admin)  ?group=...

const MAX_SONG_BYTES = 25 * 1024 * 1024; // KV value limit: 25 MiB
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // group images: 2 MiB is plenty
const SONG_PREFIX = "song:";
const GROUP_IMG_PREFIX = "groupimg:";
const INDEX_KEY = "index";
const GROUP_IMG_INDEX_KEY = "groupImages";
const IMAGE_TYPES = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Returns an error Response if the request is not from the admin, otherwise null.
function checkAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return json({ error: "ADMIN_PASSWORD is not set yet (see README.txt)" }, 500);
  const given = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  return safeEqual(given, env.ADMIN_PASSWORD) ? null : json({ error: "Wrong password" }, 401);
}

function cleanText(value, maxLength) {
  return (value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

async function readIndex(env) {
  return (await env.SONGS.get(INDEX_KEY, "json")) || [];
}

function writeIndex(env, songs) {
  return env.SONGS.put(INDEX_KEY, JSON.stringify(songs));
}

async function readGroupImages(env) {
  return (await env.SONGS.get(GROUP_IMG_INDEX_KEY, "json")) || {};
}

function writeGroupImages(env, images) {
  return env.SONGS.put(GROUP_IMG_INDEX_KEY, JSON.stringify(images));
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText, endText] = match;
  let start;
  let end;
  if (startText === "") {
    const length = Number(endText);
    if (!length) return "invalid";
    start = Math.max(size - length, 0);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

async function streamSong(request, env, id) {
  const data = await env.SONGS.get(SONG_PREFIX + id, "arrayBuffer");
  if (!data) return json({ error: "Song not found" }, 404);

  const size = data.byteLength;
  const headers = new Headers({
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
  });

  const range = parseRange(request.headers.get("Range"), size);
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range === null) {
    headers.set("Content-Length", String(size));
    return new Response(data, { status: 200, headers });
  }
  const part = data.slice(range.start, range.end + 1);
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  headers.set("Content-Length", String(part.byteLength));
  return new Response(part, { status: 206, headers });
}

async function addSong(request, env, url) {
  const denied = checkAdmin(request, env);
  if (denied) return denied;

  const title = cleanText(url.searchParams.get("title"), 150);
  const group = cleanText(url.searchParams.get("group"), 60) || "Other";
  if (!title) return json({ error: "Missing song title" }, 400);
  if (Number(request.headers.get("Content-Length")) > MAX_SONG_BYTES) {
    return json({ error: "File is bigger than 25 MiB" }, 413);
  }

  const data = await request.arrayBuffer();
  if (data.byteLength === 0) return json({ error: "The file is empty" }, 400);
  if (data.byteLength > MAX_SONG_BYTES) return json({ error: "File is bigger than 25 MiB" }, 413);

  const id = crypto.randomUUID();
  await env.SONGS.put(SONG_PREFIX + id, data);
  const song = { id, title, group, size: data.byteLength, url: `/api/songs/${id}` };
  const songs = await readIndex(env);
  songs.push(song);
  await writeIndex(env, songs);
  return json(song, 201);
}

// Move a song to another group. Only the small index entry changes; the MP3 stays where it is.
async function moveSong(request, env, url, id) {
  const denied = checkAdmin(request, env);
  if (denied) return denied;

  const group = cleanText(url.searchParams.get("group"), 60);
  if (!group) return json({ error: "Missing group name" }, 400);

  const songs = await readIndex(env);
  const song = songs.find((song) => song.id === id);
  if (!song) return json({ error: "Song not found" }, 404);
  if (song.group === group) return json(song);

  song.group = group;
  await writeIndex(env, songs);
  return json(song);
}

async function deleteSong(request, env, id) {
  const denied = checkAdmin(request, env);
  if (denied) return denied;
  await env.SONGS.delete(SONG_PREFIX + id);
  const songs = await readIndex(env);
  await writeIndex(env, songs.filter((song) => song.id !== id));
  return json({ ok: true });
}

// Rename a group: every song in "from" moves to "to", and the group image follows.
async function renameGroup(request, env, url) {
  const denied = checkAdmin(request, env);
  if (denied) return denied;

  const from = cleanText(url.searchParams.get("from"), 60);
  const to = cleanText(url.searchParams.get("to"), 60);
  if (!from || !to) return json({ error: "Missing group name" }, 400);
  if (from === to) return json({ ok: true, renamed: 0 });

  const songs = await readIndex(env);
  let renamed = 0;
  for (const song of songs) {
    if (song.group === from) {
      song.group = to;
      renamed++;
    }
  }
  if (renamed) await writeIndex(env, songs);

  const images = await readGroupImages(env);
  if (images[from]) {
    images[to] = images[from];
    delete images[from];
    await writeGroupImages(env, images);
  }
  return json({ ok: true, renamed });
}

// List every group with its image URL, so the page can show covers.
async function listGroups(env) {
  const songs = await readIndex(env);
  const images = await readGroupImages(env);
  const names = [...new Set(songs.map((song) => song.group))];
  // Keep images for groups that no longer songs belong to? No: they stay in KV until replaced,
  // but the list only shows groups that exist.
  return json(names.map((name) => ({ name, image: images[name] ? `/api/group-image/${images[name].id}` : null })));
}

async function getGroupImage(env, id) {
  const images = await readGroupImages(env);
  const entry = Object.values(images).find((image) => image.id === id);
  if (!entry) return json({ error: "Image not found" }, 404);
  const data = await env.SONGS.get(GROUP_IMG_PREFIX + id, "arrayBuffer");
  if (!data) return json({ error: "Image not found" }, 404);
  return new Response(data, {
    headers: {
      "Content-Type": entry.type,
      "Cache-Control": "public, max-age=604800",
    },
  });
}

async function setGroupImage(request, env, url) {
  const denied = checkAdmin(request, env);
  if (denied) return denied;

  const group = cleanText(url.searchParams.get("group"), 60);
  if (!group) return json({ error: "Missing group name" }, 400);

  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES[type]) {
    return json({ error: "Please pick an SVG, PNG, JPG, WebP or GIF image" }, 415);
  }
  const data = await request.arrayBuffer();
  if (data.byteLength === 0) return json({ error: "The file is empty" }, 400);
  if (data.byteLength > MAX_IMAGE_BYTES) return json({ error: "Image is bigger than 2 MiB" }, 413);

  const images = await readGroupImages(env);
  const old = images[group];
  if (old) await env.SONGS.delete(GROUP_IMG_PREFIX + old.id); // replace: remove the old file

  const id = crypto.randomUUID();
  await env.SONGS.put(GROUP_IMG_PREFIX + id, data);
  images[group] = { id, type };
  await writeGroupImages(env, images);
  return json({ group, image: `/api/group-image/${id}` }, 201);
}

async function removeGroupImage(request, env, url) {
  const denied = checkAdmin(request, env);
  if (denied) return denied;

  const group = cleanText(url.searchParams.get("group"), 60);
  const images = await readGroupImages(env);
  const old = images[group];
  if (old) {
    await env.SONGS.delete(GROUP_IMG_PREFIX + old.id);
    delete images[group];
    await writeGroupImages(env, images);
  }
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname === "/api/songs" && method === "GET") return json(await readIndex(env));
    if (pathname === "/api/songs" && method === "POST") return addSong(request, env, url);
    if (pathname === "/api/login" && method === "GET") {
      return checkAdmin(request, env) || json({ ok: true });
    }
    if (pathname === "/api/groups" && method === "GET") return listGroups(env);
    if (pathname === "/api/groups" && method === "PATCH") return renameGroup(request, env, url);
    if (pathname === "/api/group-image" && method === "PUT") return setGroupImage(request, env, url);
    if (pathname === "/api/group-image" && method === "DELETE") return removeGroupImage(request, env, url);

    const imageMatch = /^\/api\/group-image\/([\w-]+)$/.exec(pathname);
    if (imageMatch && method === "GET") return getGroupImage(env, imageMatch[1]);

    const match = /^\/api\/songs\/([\w-]+)$/.exec(pathname);
    if (match && (method === "GET" || method === "HEAD")) return streamSong(request, env, match[1]);
    if (match && method === "DELETE") return deleteSong(request, env, match[1]);
    if (match && method === "PATCH") return moveSong(request, env, url, match[1]);

    return json({ error: "Not found" }, 404);
  },
};

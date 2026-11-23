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
const SMALL_RANGE_BYTES = 512 * 1024;    // buffer small chunks (<= 512 KiB) for exact Content-Length
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

// Read only [start, end] from a ReadableStream into a compact Uint8Array, then cancel upstream.
async function readStreamRange(source, start, end) {
  const length = end - start + 1;
  const out = new Uint8Array(length);
  const reader = source.getReader();
  let pos = 0;
  let written = 0;
  try {
    while (written < length) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;
      const chunkStart = pos;
      const chunkEnd = pos + value.byteLength;
      pos = chunkEnd;
      if (chunkEnd <= start) continue;
      const sliceFrom = Math.max(0, start - chunkStart);
      const sliceTo = Math.min(value.byteLength, end + 1 - chunkStart);
      if (sliceTo > sliceFrom) {
        out.set(value.subarray(sliceFrom, sliceTo), written);
        written += sliceTo - sliceFrom;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return written === length ? out : out.subarray(0, written);
}

// Stream [start, end] with constant memory (used for large ranges > 512 KiB).
function sliceStream(source, start, end) {
  const reader = source.getReader();
  let pos = 0;
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (!value || !value.byteLength) continue;
        const chunkStart = pos;
        const chunkEnd = pos + value.byteLength;
        pos = chunkEnd;
        if (chunkEnd <= start) continue;

        const sliceFrom = Math.max(0, start - chunkStart);
        const sliceTo = Math.min(value.byteLength, end + 1 - chunkStart);
        if (sliceTo > sliceFrom) {
          controller.enqueue(value.subarray(sliceFrom, sliceTo));
        }
        if (chunkEnd > end) {
          reader.cancel().catch(() => {});
          controller.close();
          return;
        }
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    },
  });
}

async function streamSong(request, env, id) {
  const { value: stream, metadata } = await env.SONGS.getWithMetadata(SONG_PREFIX + id, {
    type: "stream",
    cacheTtl: 3600,
  });
  if (!stream) return json({ error: "Song not found" }, 404);

  let size = metadata && typeof metadata.size === "number" ? metadata.size : null;
  if (size === null) {
    const songs = await readIndex(env);
    const entry = songs.find((s) => s.id === id);
    if (entry && typeof entry.size === "number") size = entry.size;
  }

  const headers = new Headers({
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    "ETag": `"${id}"`,
    "Cache-Control": "public, max-age=86400, immutable",
  });

  // Fallback only if an old song somehow has no recorded size anywhere.
  if (size === null) {
    const data = await new Response(stream).arrayBuffer();
    size = data.byteLength;
    const range = parseRange(request.headers.get("Range"), size);
    if (range === "invalid") {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    if (range === null) {
      headers.set("Content-Length", String(size));
      return new Response(request.method === "HEAD" ? null : data, { status: 200, headers });
    }
    const len = range.end - range.start + 1;
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("Content-Length", String(len));
    const body = request.method === "HEAD" ? null : new Uint8Array(data, range.start, len);
    return new Response(body, { status: 206, headers });
  }

  const range = parseRange(request.headers.get("Range"), size);
  if (range === "invalid") {
    stream.cancel().catch(() => {});
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  if (request.method === "HEAD") {
    stream.cancel().catch(() => {});
    if (range === null) {
      headers.set("Content-Length", String(size));
      return new Response(null, { status: 200, headers });
    }
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(null, { status: 206, headers });
  }

  if (range === null) {
    headers.set("Content-Length", String(size));
    return new Response(stream, { status: 200, headers });
  }

  const length = range.end - range.start + 1;

  // Full-file range (e.g. "bytes=0-"): stream directly with zero copying.
  if (range.start === 0 && range.end === size - 1) {
    headers.set("Content-Range", `bytes 0-${size - 1}/${size}`);
    headers.set("Content-Length", String(size));
    return new Response(stream, { status: 206, headers });
  }

  // Small range (e.g. 60 KB chunks or Safari 0-1 probe): read exact slice with minimal RAM.
  if (length <= SMALL_RANGE_BYTES) {
    const part = await readStreamRange(stream, range.start, range.end);
    if (!part.byteLength) {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    const actualEnd = range.start + part.byteLength - 1;
    headers.set("Content-Range", `bytes ${range.start}-${actualEnd}/${size}`);
    headers.set("Content-Length", String(part.byteLength));
    return new Response(part, { status: 206, headers });
  }

  // Large partial range (e.g. seeking mid-song): stream with constant memory.
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  headers.set("Content-Length", String(length));
  return new Response(sliceStream(stream, range.start, range.end), { status: 206, headers });
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
  await env.SONGS.put(SONG_PREFIX + id, data, { metadata: { size: data.byteLength } });
  const song = { id, title, group, size: data.byteLength, url: `/api/songs/${id}` };
  const songs = await readIndex(env);
  songs.push(song);
  await writeIndex(env, songs);
  return json(song, 201);
}

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

async function listGroups(env) {
  const songs = await readIndex(env);
  const images = await readGroupImages(env);
  const names = [...new Set(songs.map((song) => song.group))];
  return json(names.map((name) => ({ name, image: images[name] ? `/api/group-image/${images[name].id}` : null })));
}

async function getGroupImage(env, id) {
  const images = await readGroupImages(env);
  const entry = Object.values(images).find((image) => image.id === id);
  if (!entry) return json({ error: "Image not found" }, 404);
  const data = await env.SONGS.get(GROUP_IMG_PREFIX + id, { type: "arrayBuffer", cacheTtl: 3600 });
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
  if (old) await env.SONGS.delete(GROUP_IMG_PREFIX + old.id);

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
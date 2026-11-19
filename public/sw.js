// Service worker: makes the app open without internet and plays downloaded songs offline.
const SHELL = "shell-v6";   // the page, the song list, icons. Change the number to force an update.
const SONGS = "songs";      // downloaded songs live here. This cache is never deleted automatically.
const SHELL_FILES = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== SHELL && name !== SONGS) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

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

// A downloaded song is served from the device (with Range support, so seeking works).
// A song that is not downloaded goes to the internet as normal.
async function songResponse(request, url) {
  const cache = await caches.open(SONGS);
  const saved = await cache.match(url.pathname);
  if (!saved) return fetch(request);

  const data = await saved.arrayBuffer();
  const size = data.byteLength;
  const headers = new Headers({ "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes" });
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

// Page, song list, icons: use the internet when possible, otherwise the saved copy.
async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request);
    if (response.status === 200) cache.put(request, response.clone());
    return response;
  } catch {
    const saved = await cache.match(request, { ignoreSearch: true });
    if (saved) return saved;
    return request.mode === "navigate" ? cache.match("/") : Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (/^\/api\/songs\/[\w-]+$/.test(url.pathname)) {
    event.respondWith(songResponse(request, url));
    return;
  }
  if (url.pathname === "/api/login") return;
  event.respondWith(networkFirst(request));
});

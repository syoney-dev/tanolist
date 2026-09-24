const CACHE_NAME = "tanolist-cache-v11";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  // cache: "reload" でブラウザの HTTP キャッシュを通さず、必ず最新版を取得する
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: "reload" }))))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function putInCache(request, response) {
  if (response && response.ok) {
    const clone = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const origin = new URL(request.url).origin;

  // アプリ本体・単語リスト・GitHub API(リスト一覧):
  // オンラインなら常に最新版、オフラインのときだけキャッシュを使う
  if (origin === self.location.origin || origin === "https://api.github.com") {
    event.respondWith(
      fetch(request, { cache: "no-cache" })
        .then((response) => putInCache(request, response))
        .catch(() => caches.match(request, { ignoreSearch: true }))
    );
  }
});

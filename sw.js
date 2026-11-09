// public/sw.js
// Service Worker — PWA 缓存 + 后台保活 + 推送通知
const CACHE_VERSION = 'v5-20261010_051033Z';
const CACHE_NAME = `wechat-ai-os-${CACHE_VERSION}`;

// ─── 保活状态 ───
let keepAliveTimerId = null;
let lastClientPing = Date.now();

const buildBaseAssetUrls = () => {
  try {
    const scope = String(self.registration?.scope || '').trim();
    if (!scope) return ['/'];
    const u = new URL(scope);
    const basePath = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
    return [basePath, `${basePath}index.html`, `${basePath}manifest.json`];
  } catch {
    return ['/'];
  }
};

// ─── SW 保活：定期自我唤醒 ───
function startKeepAlive() {
  if (keepAliveTimerId !== null) return;
  keepAliveTimerId = setInterval(() => {
    // 检查是否有存活客户端
    self.clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length === 0) {
        // 没有活动的页面，但 SW 仍可存活
        // 这里可以做一些后台清理或预取
      }
      // 保活：SW 只要有这个定时器，就不会被浏览器休眠
    }).catch(() => {});
  }, 20000); // 每 20 秒唤醒一次
}

// 监听来自页面的保活消息
self.addEventListener('message', async (event) => {
  const { type, payload, taskId } = event.data || {};

  // ─── 保活相关 ───
  if (type === 'KEEPALIVE_PING') {
    lastClientPing = Date.now();
    event.source?.postMessage({
      type: 'KEEPALIVE_PONG',
      ts: Date.now(),
      swUptime: Math.floor((Date.now() - (self.__swStart || Date.now())) / 1000)
    });
    return;
  }

  if (type === 'KEEPALIVE_START') {
    startKeepAlive();
    event.source?.postMessage({ type: 'KEEPALIVE_STARTED' });
    return;
  }

  if (type === 'KEEPALIVE_STOP') {
    if (keepAliveTimerId !== null) {
      clearInterval(keepAliveTimerId);
      keepAliveTimerId = null;
    }
    event.source?.postMessage({ type: 'KEEPALIVE_STOPPED' });
    return;
  }

  if (type === 'KEEPALIVE_STATUS') {
    const clients = await self.clients.matchAll();
    event.source?.postMessage({
      type: 'KEEPALIVE_STATUS',
      alive: keepAliveTimerId !== null,
      clientCount: clients.length,
      lastPing: lastClientPing,
      uptime: Math.floor((Date.now() - (self.__swStart || Date.now())) / 1000)
    });
    return;
  }

  // ─── SKIP_WAITING ───
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // ─── AI 后台请求 ───
  if (type === 'AI_REQUEST_START') {
    const activeTasks = new Map();
    activeTasks.set(taskId, payload);
    
    try {
      const response = await fetch(payload.url, payload.options);
      const result = await response.json();
      activeTasks.delete(taskId);
      
      const clients = await self.clients.matchAll();
      clients.forEach(client => {
        client.postMessage({
          type: 'AI_REQUEST_COMPLETE',
          taskId,
          result
        });
      });
    } catch (error) {
      activeTasks.delete(taskId);
      const clients = await self.clients.matchAll();
      clients.forEach(client => {
        client.postMessage({
          type: 'AI_REQUEST_ERROR',
          taskId,
          error: error.message
        });
      });
    }
  }
});

// ─── Install ───
self.addEventListener('install', (event) => {
  const ASSETS_TO_CACHE = buildBaseAssetUrls();
  self.__swStart = Date.now();
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => caches.delete(cacheName))
      );
    }).then(() => {
      return caches.open(CACHE_NAME);
    }).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE.map(url => new Request(url, { cache: 'reload' })));
    })
  );
  self.skipWaiting();
});

// ─── Activate ───
self.addEventListener('activate', (event) => {
  self.__swStart = Date.now();
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // 激活后自动启动保活
      startKeepAlive();
    })
  );
  self.clients.claim();
});

// ─── Fetch ───
// iOS PWA：冷启动不走网络直连，改用 Cache First + 后台更新，避免进入 PWA 白屏加载慢（安卓保持原策略）
const IS_IOS_SW = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(String(navigator.userAgent || ''));

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);

  // 只缓存同源资源，跨域资源交给浏览器默认缓存
  if (requestUrl.origin !== self.location.origin) return;

  // 更新日志要拿实时内容，不能被缓存命中（否则新版本上线后仍显示上一版更新说明）
  if (requestUrl.pathname.endsWith('changelog.json')) return;

  if (IS_IOS_SW) {
    const isIndex = requestUrl.pathname.endsWith('index.html');
    if (isIndex) {
      // iOS 的 index.html 必须 Network First：构建后 index.html 内引用的是带 hash 的
      // 新 chunk（版本目录也随构建改变）。若像下面静态资源那样 Cache First，冷启动会
      // 命中缓存的旧 index.html，而旧 hash chunk 已被本版本 install 清空缓存且线上目录
      // 已覆盖删除 -> 资源 404 -> iOS 长时间白屏/加载失败（安卓 Network First 无此问题）。
      // index.html 本身只有几 KB，走网络基本无感，真正的大体积静态资源仍走 Cache First。
      event.respondWith(
        fetch(event.request, { cache: 'no-store', mode: 'same-origin' })
          .then((networkResponse) => {
            if (networkResponse && networkResponse.ok) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, networkResponse.clone());
              });
            }
            return networkResponse;
          })
          .catch(() => caches.match(event.request))
      );
      return;
    }
    // iOS 静态资源：Cache First + 后台更新（先返回缓存立即渲染，再静默更新缓存）
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const network = fetch(event.request, {})
          .then((networkResponse) => {
            if (networkResponse && networkResponse.ok) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, networkResponse.clone());
              });
            }
            return networkResponse;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // index.html 始终使用 Network First（非 iOS）
  if (requestUrl.pathname.endsWith('index.html')) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store', mode: 'same-origin' })
        .then((networkResponse) => {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, networkResponse.clone());
          });
          return networkResponse;
        })
        .catch(() => {
          return caches.match(event.request);
        })
    );
    return;
  }

  // 其他资源
  event.respondWith(
    fetch(event.request)
      .catch(() => {
        return caches.match(event.request);
      })
  );
});

// ─── Push Event ───
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch { data = { title: '新消息', body: '' }; }

  const options = {
    body: data.body || '你有新的消息',
    icon: data.icon || 'icons/icon-192.png',
    badge: data.badge || 'icons/icon-192.png',
    vibrate: [200, 100, 200],
    tag: 'bg-push',
    requireInteraction: true
  };

  // 页面可见时由页面直接展示消息（App 内弹窗），后台/关闭时才弹系统通知，避免重复弹窗
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      const pageVisible = clientList.some(c => c.visibilityState === 'visible');
      if (pageVisible) return;
      return self.registration.showNotification(data.title || 'WeChat AI OS', options);
    })
  );
});

// ─── Notification Click ───
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      if (clients.length > 0) {
        clients[0].focus();
        clients[0].postMessage({ type: 'notificationclick', url: '/' });
      } else {
        self.clients.openWindow('/');
      }
    })
  );
});

// BUILD_STAMP: 20261010_051033Z @ 2026-10-10T05:10:33.596Z

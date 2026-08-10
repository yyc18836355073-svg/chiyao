const CACHE_NAME = 'hp-pwa-v1.2.0';
const DIAG_URL = 'https://hp-push-worker.hp-push.workers.dev/api/diag';

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[SW] 预加载跳过:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim()).then(() => reportDiag('activated'))
  );
  self.clients.claim();
});

// ===== Web Push 通知处理 =====

async function reportDiag(evt) {
  try {
    let permission = 'unknown';
    try { permission = Notification.permission; } catch (e) {}
    await fetch(DIAG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        evt,
        swTs: Date.now(),
        swVersion: CACHE_NAME,
        permission,
        ua: navigator.userAgent,
      }),
    });
  } catch (e) {}
}

self.addEventListener('push', (event) => {
  reportDiag('push-received');
  let data = { title: 'HP服药打卡', body: '该吃药了！', tag: 'hp-reminder' };
  try {
    if (event.data) {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
    }
  } catch (e) {
    // 非 JSON 载荷，使用默认文案
  }

  const options = {
    body: data.body,
    icon: './pwa-192x192.png',
    badge: './pwa-192x192.png',
    tag: data.tag || 'hp-reminder',
    requireInteraction: true,
    data: { url: './' }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
      .then(() => reportDiag('shown'))
      .catch((e) => reportDiag('show-error:' + e.message))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, networkResponse);
            });
          }
        }).catch(() => {});
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      }).catch(() => {
        if (event.request.headers.get('accept').includes('text/html')) {
          return caches.match('./index.html');
        }
      });
    })
  );
});


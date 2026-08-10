// Web Push 订阅与提醒上报工具
const WORKER_BASE = 'https://hp-push-worker.hp-push.workers.dev';

const CLIENT_ID_KEY = 'hp_push_client_id';

function getClientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

async function api(path, options) {
  try {
    const resp = await fetch(WORKER_BASE + path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    });
    return await resp.json();
  } catch (e) {
    console.warn('[push] 上报失败:', e);
    return { ok: false, error: String(e) };
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms)),
  ]);
}

async function fetchWithRetry(url, { retries = 2, ms = 8000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url);
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function ensureServiceWorker() {
  // 确保 SW 注册成功并处于激活状态，避免 serviceWorker.ready 永不 resolve
  if (!navigator.serviceWorker.controller) {
    try {
      const reg = await withTimeout(navigator.serviceWorker.register('/chiyao/sw.js'), 8000, 'SW注册');
      if (reg.waiting || reg.installing) {
        await withTimeout(new Promise((resolve) => {
          const onState = () => {
            if (reg.active && navigator.serviceWorker.controller) resolve();
          };
          reg.addEventListener('updatefound', () => {
            const w = reg.installing;
            if (w) w.addEventListener('statechange', onState);
          });
          navigator.serviceWorker.addEventListener('controllerchange', onState);
          setTimeout(resolve, 6000);
        }), 8000, 'SW激活');
      }
    } catch (e) {
      // 注册失败或超时：继续走 ready，可能已存在已注册的 SW
      console.warn('[push] SW 注册异常:', e);
    }
  }
  return withTimeout(navigator.serviceWorker.ready, 8000, 'SW ready');
}

// 请求推送权限 + 订阅 + 上报
export async function enablePush() {
  const steps = [];
  const step = (name, ok) => steps.push(`${name}:${ok ? 'OK' : 'FAIL'}`);
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return { ok: false, error: '浏览器不支持推送', steps };
    }
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    step('standalone', standalone);

    if (Notification.permission === 'denied') {
      return { ok: false, error: '通知权限已被拒绝，请在 设置-通知 中开启', steps };
    }

    let perm = Notification.permission;
    if (perm !== 'granted') {
      perm = await Notification.requestPermission();
    }
    step('permission', perm === 'granted');
    if (perm !== 'granted') return { ok: false, error: '未授予通知权限', steps };

    const reg = await ensureServiceWorker();
    step('sw', !!reg.active);

    const keyResp = await withTimeout(fetchWithRetry(WORKER_BASE + '/api/public-key', { retries: 2, ms: 8000 }), 26000, '获取公钥');
    const { publicKey } = await keyResp.json();
    step('publicKey', !!publicKey);
    if (!publicKey) return { ok: false, error: '获取推送公钥失败', steps };

    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await withTimeout(
        reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }),
        10000,
        '订阅'
      );
    }
    step('subscribe', !!subscription);

    const res = await api('/api/subscribe', {
      method: 'POST',
      body: JSON.stringify({ clientId: getClientId(), subscription: subscription.toJSON() }),
    });
    step('upload', !!res.ok);
    return { ok: res.ok, clientId: getClientId(), steps, error: res.ok ? undefined : (res.error || '上报失败') };
  } catch (e) {
    console.error('[push] enablePush 失败:', e);
    return { ok: false, error: String(e.message || e), steps };
  }
}

// 上报倒计时提醒计划（到达 at 时推送）
export async function scheduleReminder({ at, title, body }) {
  return api('/api/reminder', {
    method: 'POST',
    body: JSON.stringify({ clientId: getClientId(), at, title, body }),
  });
}

// 取消该设备所有待办提醒（打卡完成/重置时）
export async function cancelReminders() {
  return api('/api/reminder?clientId=' + encodeURIComponent(getClientId()), { method: 'DELETE' });
}

// 保存每日定时提醒（早/晚时间，HH:mm 格式，可随时修改）
export async function saveDailySchedule({ morning, evening }) {
  return api('/api/daily', {
    method: 'POST',
    body: JSON.stringify({
      clientId: getClientId(),
      morning: morning || null,
      evening: evening || null,
      tzOffset: -new Date().getTimezoneOffset(),
    }),
  });
}

// 取消每日定时提醒
export async function cancelDailySchedule() {
  return api('/api/daily?clientId=' + encodeURIComponent(getClientId()), { method: 'DELETE' });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

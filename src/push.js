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

// 请求推送权限 + 订阅 + 上报
export async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, error: '浏览器不支持推送' };
  }
  if (Notification.permission === 'denied') {
    return { ok: false, error: '通知权限已被拒绝，请在浏览器设置中开启' };
  }

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, error: '未授予通知权限' };

  const reg = await navigator.serviceWorker.ready;

  const keyResp = await fetch(WORKER_BASE + '/api/public-key');
  const { publicKey } = await keyResp.json();
  if (!publicKey) return { ok: false, error: '获取推送公钥失败' };

  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const res = await api('/api/subscribe', {
    method: 'POST',
    body: JSON.stringify({ clientId: getClientId(), subscription: subscription.toJSON() }),
  });
  return { ok: res.ok, clientId: getClientId() };
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

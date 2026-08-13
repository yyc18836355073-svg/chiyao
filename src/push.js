// Web Push 订阅与提醒上报工具（双模式）
// 浏览器环境：走 Cloudflare Worker Web Push；Capacitor App 环境：走 iOS 本地通知（离线）
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

const WORKER_BASE = 'https://hp-push-worker.hp-push.workers.dev';

const CLIENT_ID_KEY = 'hp_push_client_id';
const API_KEY_STORAGE = 'hp_push_api_key';

// App 内本地通知 id 分段（避免冲突）
const NOTIF_IDS = {
  REMINDER_BASE: 10000, // 循环提醒 10000-10011（最多 12 条）
  DAILY_MORNING: 20001,
  DAILY_EVENING: 20002,
  IMMEDIATE: 30001,
};

export const isNativeApp = () => !!Capacitor.isNativePlatform();

// 设备级随机密钥：首次生成后存本地，作为访问 Worker 设备端 API 的身份凭证，
// 不再在客户端代码中放置任何固定密钥
function getApiKey() {
  let key = localStorage.getItem(API_KEY_STORAGE);
  if (!key) {
    const arr = new Uint8Array(24);
    crypto.getRandomValues(arr);
    key = Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(API_KEY_STORAGE, key);
  }
  return key;
}

// 设备 ID：强随机，不可猜测（攻击者无法冒充他人 clientId 操作其提醒）
function getClientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    const arr = new Uint8Array(24);
    crypto.getRandomValues(arr);
    id = Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

async function api(path, options) {
  try {
    let resp = await withTimeout(fetchWithRetry(WORKER_BASE + path, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': getApiKey(), ...(options?.headers || {}) },
    }), 15000, '请求');
    // 设备密钥未被云端登记（如老版本升级后）：自动重新订阅一次并重试
    if (resp.status === 401 && !isNativeApp()) {
      const resubscribed = await tryResubscribe();
      if (resubscribed) {
        resp = await withTimeout(fetchWithRetry(WORKER_BASE + path, {
          ...options,
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': getApiKey(), ...(options?.headers || {}) },
        }), 15000, '请求');
      }
    }
    return await resp.json();
  } catch (e) {
    console.warn('[push] 上报失败:', e);
    return { ok: false, error: String(e) };
  }
}

// 用现有订阅重新向云端登记设备密钥（订阅存在时无需再次申请权限）
let resubscribing = false;
async function tryResubscribe() {
  if (resubscribing) return false;
  resubscribing = true;
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    const reg = await ensureServiceWorker();
    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) return false;
    const res = await api('/api/subscribe', {
      method: 'POST',
      body: JSON.stringify({ clientId: getClientId(), apiKey: getApiKey(), subscription: subscription.toJSON() }),
    });
    return !!res.ok;
  } catch (e) {
    console.warn('[push] 自动重订阅失败:', e);
    return false;
  } finally {
    resubscribing = false;
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms)),
  ]);
}

async function fetchWithRetry(url, init, { retries = 2, ms = 8000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, init);
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

  // ===== App 模式：请求 iOS 本地通知权限 =====
  if (isNativeApp()) {
    try {
      let status = await LocalNotifications.checkPermissions();
      if (status.display !== 'granted') {
        status = await LocalNotifications.requestPermissions();
      }
      step('permission', status.display === 'granted');
      return { ok: status.display === 'granted', steps, error: status.display === 'granted' ? undefined : '未授予通知权限，请在 设置-通知 中开启' };
    } catch (e) {
      console.error('[push] App 权限请求失败:', e);
      return { ok: false, error: String(e.message || e), steps };
    }
  }

  // ===== 浏览器模式：Web Push =====
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

    const keyResp = await withTimeout(fetchWithRetry(WORKER_BASE + '/api/public-key'), 26000, '获取公钥');
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
      body: JSON.stringify({ clientId: getClientId(), apiKey: getApiKey(), subscription: subscription.toJSON() }),
    });
    step('upload', !!res.ok);
    return { ok: res.ok, clientId: getClientId(), steps, error: res.ok ? undefined : (res.error || '上报失败') };
  } catch (e) {
    console.error('[push] enablePush 失败:', e);
    return { ok: false, error: String(e.message || e), steps };
  }
}

// 上报倒计时提醒计划（到达 at 时推送；repeatMinutes>0 则每 repeatMinutes 分钟循环提醒，
// 直到打卡完成取消或超过默认 2 小时时限）
export async function scheduleReminder({ at, title, body, repeatMinutes }) {
  // ===== App 模式：注册 12 条一次性本地通知（10 分钟 × 12 = 2 小时）=====
  if (isNativeApp()) {
    try {
      const interval = Math.max(0, Math.floor(repeatMinutes || 0)) * 60 * 1000;
      const notifications = [];
      for (let i = 0; i < 12; i++) {
        const fireAt = new Date(at + i * interval);
        if (i > 0 && fireAt.getTime() <= Date.now()) break;
        notifications.push({
          id: NOTIF_IDS.REMINDER_BASE + i,
          title,
          body,
          extra: { kind: 'hp-reminder' },
          schedule: { at: fireAt },
        });
      }
      // 先取消旧的循环提醒，避免 id 冲突
      await LocalNotifications.cancel({
        notifications: Array.from({ length: 12 }, (_, i) => ({ id: NOTIF_IDS.REMINDER_BASE + i })),
      });
      if (notifications.length > 0) {
        await LocalNotifications.schedule({ notifications });
      }
      return { ok: true };
    } catch (e) {
      console.error('[push] App 循环提醒注册失败:', e);
      return { ok: false, error: String(e.message || e) };
    }
  }

  // ===== 浏览器模式：上报云端 =====
  return api('/api/reminder', {
    method: 'POST',
    body: JSON.stringify({
      clientId: getClientId(),
      at,
      title,
      body,
      repeatMinutes: repeatMinutes || 0,
    }),
  });
}

// 取消该设备所有待办提醒（打卡完成/重置时）
export async function cancelReminders() {
  // ===== App 模式：取消全部循环提醒 =====
  if (isNativeApp()) {
    try {
      await LocalNotifications.cancel({
        notifications: Array.from({ length: 12 }, (_, i) => ({ id: NOTIF_IDS.REMINDER_BASE + i })),
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }
  // ===== 浏览器模式：取消云端 =====
  return api('/api/reminder?clientId=' + encodeURIComponent(getClientId()), { method: 'DELETE' });
}

// 保存每日定时提醒（早/晚时间，HH:mm 格式，可随时修改）
export async function saveDailySchedule({ morning, evening }) {
  // ===== App 模式：本地每日重复通知 =====
  if (isNativeApp()) {
    try {
      const scheduleOn = (time, id) => {
        if (!time) return null;
        const [hour, minute] = time.split(':').map(Number);
        return { id, title: 'HP服药打卡', body: '该吃早餐药了！饭前30分钟：PPI抑酸剂+铋剂。', extra: { kind: 'hp-daily' }, schedule: { on: { hour, minute }, repeats: true } };
      };
      const morningNotif = scheduleOn(morning, NOTIF_IDS.DAILY_MORNING);
      const eveningNotif = scheduleOn(evening, NOTIF_IDS.DAILY_EVENING);
      const toCancel = [];
      if (!morningNotif) toCancel.push({ id: NOTIF_IDS.DAILY_MORNING });
      if (!eveningNotif) toCancel.push({ id: NOTIF_IDS.DAILY_EVENING });
      if (toCancel.length > 0) await LocalNotifications.cancel({ notifications: toCancel });
      const notifications = [morningNotif, eveningNotif].filter(Boolean);
      if (notifications.length > 0) await LocalNotifications.schedule({ notifications });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }
  // ===== 浏览器模式：云端 =====
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
  // ===== App 模式 =====
  if (isNativeApp()) {
    try {
      await LocalNotifications.cancel({ notifications: [{ id: NOTIF_IDS.DAILY_MORNING }, { id: NOTIF_IDS.DAILY_EVENING }] });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }
  // ===== 浏览器模式 =====
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

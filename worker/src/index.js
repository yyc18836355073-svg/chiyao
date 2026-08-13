// HP 四联打卡 PWA 推送服务 Worker
// 功能：接收订阅/提醒计划，每分钟 cron 检查到期提醒并 Web Push 推送

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Token',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // 除公钥/健康检查外，所有接口需要 X-Api-Token 鉴权
    const PUBLIC_PATHS = ['/api/public-key', '/api/health'];
    if (!PUBLIC_PATHS.includes(url.pathname)) {
      const token = request.headers.get('x-api-token');
      if (!env.API_TOKEN || token !== env.API_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: '未授权' }), { status: 401, headers: cors });
      }
    }

    try {
      // 返回 VAPID 公钥（前端订阅时需要）
      if (url.pathname === '/api/public-key' && request.method === 'GET') {
        return new Response(JSON.stringify({ publicKey: env.VAPID_PUBLIC_KEY }), {
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }

      // 前端上报订阅信息
      if (url.pathname === '/api/subscribe' && request.method === 'POST') {
        const body = await request.json();
        const subscription = body.subscription;
        const clientId = body.clientId || 'default';
        if (!subscription || !subscription.endpoint) {
          return new Response(JSON.stringify({ ok: false, error: '无效订阅' }), { status: 400, headers: cors });
        }

        // 写回前重读最新快照，避免并发覆盖
        const latest = await getSubscriptions(env);
        // 同 clientId 只保留最新一条 endpoint（同设备重复订阅会被替换），
        // 避免同一设备多个推送地址同时收到通知导致连弹
        const rest2 = latest.filter((s) => s.clientId !== clientId);
        rest2.push({ clientId, subscription, updatedAt: Date.now() });
        await env.PUSH_KV.put('subscriptions', JSON.stringify(rest2));
        return new Response(JSON.stringify({ ok: true }), { headers: cors });
      }

      // 前端启动倒计时时上报提醒计划
      if (url.pathname === '/api/reminder' && request.method === 'POST') {
        const body = await request.json();
        const { clientId, at, title, body: text } = body;
        if (!clientId || !at) {
          return new Response(JSON.stringify({ ok: false, error: '缺少参数' }), { status: 400, headers: cors });
        }
        // 写回前重读最新快照，避免并发覆盖
        const latestR = await getReminders(env);
        const repeatMinutes = Math.max(0, Math.floor(Number(body.repeatMinutes) || 0));
        const atNum = Number(at);
        // 幂等：同一设备只保留最新一条待办提醒，避免重试/重复上报导致到点连弹
        const rest = latestR.filter((r) => r.clientId !== clientId);
        rest.push({
          id: `${clientId}-${at}-${Date.now()}`,
          clientId,
          at: atNum,
          title: title || 'HP服药打卡',
          body: text || '该吃药了！',
          // 循环提醒：每 repeatMinutes 分钟重推一次，直到 repeatUntil（默认 2 小时后）或打卡完成取消
          repeatMinutes,
          repeatUntil: Number(body.repeatUntil) || atNum + 2 * 3600 * 1000,
        });
        await env.PUSH_KV.put('reminders', JSON.stringify(rest));
        return new Response(JSON.stringify({ ok: true, count: rest.length }), { headers: cors });
      }

      // 取消该设备的提醒（打卡完成时）
      if (url.pathname === '/api/reminder' && request.method === 'DELETE') {
        const clientId = url.searchParams.get('clientId');
        if (!clientId) return new Response(JSON.stringify({ ok: false }), { status: 400, headers: cors });
        const reminders = await getReminders(env);
        const rest = reminders.filter((r) => r.clientId !== clientId);
        await env.PUSH_KV.put('reminders', JSON.stringify(rest));
        return new Response(JSON.stringify({ ok: true, removed: reminders.length - rest.length }), { headers: cors });
      }

      // 健康检查
      // 保存/更新每日定时提醒（早/晚饭时间，可随时修改）
      if (url.pathname === '/api/daily' && request.method === 'POST') {
        const body = await request.json();
        const { clientId, morning, evening, tzOffset } = body;
        if (!clientId) {
          return new Response(JSON.stringify({ ok: false, error: '缺少参数' }), { status: 400, headers: cors });
        }
        const clean = (t) => (typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) ? t : null;
        const settings = await getDailySettings(env);
        const rest = settings.filter((s) => s.clientId !== clientId);
        rest.push({
          clientId,
          morning: clean(morning),
          evening: clean(evening),
          tzOffset: Number.isFinite(Number(tzOffset)) ? Number(tzOffset) : -new Date().getTimezoneOffset(),
          updatedAt: Date.now(),
        });
        await env.PUSH_KV.put('dailySettings', JSON.stringify(rest));
        return new Response(JSON.stringify({ ok: true, count: rest.length }), { headers: cors });
      }

      // 取消该设备的每日定时提醒
      if (url.pathname === '/api/daily' && request.method === 'DELETE') {
        const clientId = url.searchParams.get('clientId');
        const settings = await getDailySettings(env);
        const rest = settings.filter((s) => s.clientId !== clientId);
        await env.PUSH_KV.put('dailySettings', JSON.stringify(rest));
        return new Response(JSON.stringify({ ok: true }), { headers: cors });
      }

      if (url.pathname === '/api/health') {
        return new Response(JSON.stringify({ ok: true, reminders: (await getReminders(env)).length, subs: (await getSubscriptions(env)).length }), {
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }

      // 接收 SW 推送事件诊断日志（设备端上报）
      if (url.pathname === '/api/diag' && request.method === 'POST') {
        const body = await request.json();
        const key = 'diag:' + Date.now();
        await env.PUSH_KV.put(key, JSON.stringify({ ...body, serverTs: Date.now() }));
        return new Response(JSON.stringify({ ok: true }), { headers: cors });
      }

      // 读取诊断日志
      if (url.pathname === '/api/diag' && request.method === 'GET') {
        const list = await env.PUSH_KV.list({ prefix: 'diag:', limit: 50 });
        const logs = [];
        for (const k of list.keys) {
          logs.push(JSON.parse((await env.PUSH_KV.get(k.name)) || '{}'));
        }
        logs.sort((a, b) => (a.serverTs || 0) - (b.serverTs || 0));
        return new Response(JSON.stringify({ ok: true, logs }), {
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }

      // 手动测试推送（诊断用）
      if (url.pathname === '/api/test-push' && request.method === 'POST') {
        const body = await request.json();
        const subs = await getSubscriptions(env);
        const targets = body.clientId
          ? subs.filter((s) => s.clientId === body.clientId)
          : subs;
        if (targets.length === 0) {
          return new Response(JSON.stringify({ ok: false, error: '无订阅' }), { headers: cors });
        }
        const results = [];
        for (const t of targets) {
          try {
            const payload = JSON.stringify({ title: '测试推送', body: '如果收到说明推送链路正常', tag: 'hp-reminder' });
            const detail = await sendPush(env, t.subscription, payload);
            results.push({ endpoint: t.subscription.endpoint.slice(0, 60), success: detail.ok, status: detail.status, headers: detail.headers });
          } catch (e) {
            results.push({ endpoint: t.subscription.endpoint.slice(0, 60), success: false, error: e.message });
          }
        }
        return new Response(JSON.stringify({ ok: true, results }), {
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }

      return new Response('Not Found', { status: 404, headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
    }
  },

  // 每分钟定时检查到期提醒
  async scheduled(event, env, ctx) {
    const now = Date.now();

    // 每日清理一次 7 天前的诊断日志
    const cleanKey = 'diagClean:' + new Date().toISOString().slice(0, 10);
    if (!(await env.PUSH_KV.get(cleanKey))) {
      const expireMs = 7 * 24 * 3600 * 1000;
      let cursor;
      do {
        const page = await env.PUSH_KV.list({ prefix: 'diag:', cursor, limit: 1000 });
        for (const k of page.keys) {
          const ts = Number(k.name.split(':')[1]);
          if (ts && now - ts > expireMs) await env.PUSH_KV.delete(k.name);
        }
        cursor = page.cursor;
      } while (cursor);
      await env.PUSH_KV.put(cleanKey, String(now));
      console.log(`[scheduled] 已清理过期诊断日志`);
    }

    const subs = await getSubscriptions(env);
    let pushed = 0;
    let failed = 0;

    // ===== 每日定时提醒（早/晚固定时间）=====
    const dailySettings = await getDailySettings(env);
    for (const s of dailySettings) {
      const tzOffset = Number(s.tzOffset) || 480;
      const localMs = now + tzOffset * 60000;
      const d = new Date(localMs);
      const localDate = d.toISOString().slice(0, 10);

      for (const period of ['morning', 'evening']) {
        const time = s[period];
        if (!time) continue;
        const [th, tm] = time.split(':').map(Number);
        const targetSec = th * 3600 + tm * 60;
        const nowSec = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
        // cron 触发可能有延迟，目标时间后的 2 分钟窗口内都算（当日防重）
        const diff = nowSec - targetSec;
        if (diff < 0 || diff > 120) continue;

        const pushedKey = `dailyPushed:${s.clientId}:${localDate}:${period}`;
        if (await env.PUSH_KV.get(pushedKey)) continue;

        const targets = subs.filter((t) => t.clientId === s.clientId);
        let ok = false;
        for (const t of targets) {
          try {
            const payload = JSON.stringify({
              title: period === 'morning' ? '🌅 该吃早餐药了！' : '🌙 该吃晚餐药了！',
              body: period === 'morning'
                ? '饭前30分钟：PPI抑酸剂+铋剂。请开启30分钟倒计时，饭后记得服抗生素。'
                : '饭前30分钟：PPI抑酸剂+铋剂。请开启30分钟倒计时，饭后记得服抗生素。',
              tag: `hp-daily-${period}`,
            });
            const result = await sendPush(env, t.subscription, payload);
            if (result) ok = true;
          } catch (e) {
            failed++;
            console.error(`每日提醒推送失败 ${t.subscription.endpoint}:`, e.message);
            if (String(e.message).includes('410')) {
              const rest = subs.filter((x) => x.endpoint !== t.subscription.endpoint);
              await env.PUSH_KV.put('subscriptions', JSON.stringify(rest));
            }
          }
        }
        if (ok) {
          await env.PUSH_KV.put(pushedKey, String(now));
          pushed++;
          console.log(`[scheduled] 每日提醒 ${s.clientId} ${period}@${time} 推送成功`);
        }
      }
    }

    // ===== 到期提醒（一次性 / 循环）=====
    const reminders = await getReminders(env);
    const due = reminders.filter((r) => r.at <= now);

    if (due.length > 0) {
      // id -> { remove: true } 或 { lastPushedAt: ts }
      const outcome = new Map();

      for (const reminder of due) {
        const repeatInterval = (Number(reminder.repeatMinutes) || 0) * 60 * 1000;
        const repeatUntil = Number(reminder.repeatUntil) || 0;

        // 循环提醒超过时限（如 2 小时）→ 移除，不再推送（无论是否推成功过，避免僵尸任务驻留）
        if (repeatUntil && now > repeatUntil) {
          outcome.set(reminder.id, { remove: true });
          console.log(`[scheduled] 循环提醒 ${reminder.id} 超过时限，停止`);
          continue;
        }
        // 循环提醒未到下次推送时间
        if (reminder.lastPushedAt && repeatInterval > 0 && now - reminder.lastPushedAt < repeatInterval) {
          continue;
        }

        const targets = subs.filter((s) => s.clientId === reminder.clientId || reminder.clientId === 'all');
        console.log(`[scheduled] 处理 ${reminder.id}: due=${due.length} subs=${subs.length} targets=${targets.length} repeat=${reminder.repeatMinutes || 0}min`);

        let ok = false;
        for (const t of targets) {
          try {
            const payload = JSON.stringify({ title: reminder.title, body: reminder.body, tag: 'hp-reminder' });
            const result = await sendPush(env, t.subscription, payload);
            if (result) ok = true;
          } catch (e) {
            failed++;
            console.error(`推送失败 ${t.subscription.endpoint}:`, e.message);
            // 410 Gone = 订阅失效，删除
            if (String(e.message).includes('410')) {
              const rest = subs.filter((s) => s.endpoint !== t.subscription.endpoint);
              await env.PUSH_KV.put('subscriptions', JSON.stringify(rest));
            }
          }
        }
        if (ok) {
          if (repeatInterval > 0) {
            // 循环提醒：保留，记录上次推送时间
            outcome.set(reminder.id, { lastPushedAt: now });
          } else {
            outcome.set(reminder.id, { remove: true });
          }
        }
      }

      // 写回前重新读取最新快照，避免覆盖处理期间并发新增的提醒
      const latest = await getReminders(env);
      const rest = latest
        .filter((r) => !(outcome.get(r.id) && outcome.get(r.id).remove))
        .map((r) => {
          const o = outcome.get(r.id);
          if (o && o.lastPushedAt) return { ...r, lastPushedAt: o.lastPushedAt };
          return r;
        });
      await env.PUSH_KV.put('reminders', JSON.stringify(rest));
      const removed = latest.length - rest.length;
      const repeatCount = [...outcome.values()].filter((o) => o.lastPushedAt).length;
      console.log(`[scheduled] 到期 ${due.length} 条，推送成功 ${repeatCount}，失败 ${failed}，移除 ${removed}，剩余 ${rest.length} 条`);
    }
  },
};

async function getSubscriptions(env) {
  const raw = await env.PUSH_KV.get('subscriptions');
  return raw ? JSON.parse(raw) : [];
}

async function getReminders(env) {
  const raw = await env.PUSH_KV.get('reminders');
  return raw ? JSON.parse(raw) : [];
}

async function getDailySettings(env) {
  const raw = await env.PUSH_KV.get('dailySettings');
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// ===== Web Push 加密实现（RFC 8291 / aes128gcm） =====

async function sendPush(env, subscription, payload) {
  const endpoint = new URL(subscription.endpoint);
  const authSecret = base64UrlToBuffer(subscription.keys.auth);
  const clientPublicKey = base64UrlToBuffer(subscription.keys.p256dh);

  const { salt, localKeyPair, localPublicKey, key, nonce } = await encryptSetup(
    clientPublicKey,
    authSecret
  );

  const body = await buildEncryptedBody(salt, localPublicKey, key, nonce, payload);
  const jwt = await signJwt(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY, endpoint.origin, env.PUSH_SUBJECT);

  const resp = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      'Urgency': 'high',
      'Topic': 'hp-quad-therapy',
      'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
    body,
  });

  if (resp.status >= 400) {
    let detail = '';
    try { detail = await resp.text(); } catch (e) {}
    const err = new Error(`推送返回 ${resp.status}: ${detail}`);
    if (resp.status === 410 || resp.status === 404) err.message = '410';
    throw err;
  }
  const headers = {};
  for (const [k, v] of resp.headers) headers[k] = v;
  return { ok: resp.ok, status: resp.status, headers };
}

async function encryptSetup(clientPublicKey, authSecret) {
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const localKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const localPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', localKeyPair.publicKey));

  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: await importClientKey(clientPublicKey) },
    localKeyPair.privateKey,
    256
  );

  // IKM = HKDF(salt=auth_secret, IKM=ecdh_secret, info="WebPush: info" || ua_public || as_public, 32)
  // 与 http_ece / iOS 兼容实现完全一致
  const info = concat(utf8('WebPush: info'), new Uint8Array([0]), clientPublicKey, localPublicKey);
  const ikm = await hkdf(new Uint8Array(shared), info, 32, authSecret);

  // key = HKDF-Expand(Extract(salt), "Content-Encoding: aes128gcm\0", 16)
  const key = await hkdf(ikm, utf8('Content-Encoding: aes128gcm\0'), 16, salt);
  // nonce = HKDF-Expand(Extract(salt), "Content-Encoding: nonce\0", 12)
  const nonce = await hkdf(ikm, utf8('Content-Encoding: nonce\0'), 12, salt);

  return { salt, localKeyPair, localPublicKey, key, nonce };
}

async function buildEncryptedBody(salt, localPublicKey, key, nonce, payload) {
  // 最后一块填充 0x02（仅 padding，无分隔）
  const plaintext = concat(utf8(payload), new Uint8Array([2]));

  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']),
    plaintext
  ));

  // aes128gcm header: salt(16) | rs(4 BE=4096) | idlen(1=65) | localPublicKey(65)
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  header[16] = 0;
  header[17] = 0;
  header[18] = 16; // rs = 4096
  header[19] = 0;
  header[20] = 65;
  header.set(localPublicKey, 21);

  return concat(header, encrypted);
}

async function importClientKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

async function hkdf(secret, info, length = 32, salt = new Uint8Array(32)) {
  const keyMaterial = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info,
    },
    keyMaterial,
    length * 8
  );
  return new Uint8Array(bits);
}

async function signJwt(privateKeyB64, publicKeyB64, audience, subject) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + 12 * 3600,
    sub: subject,
  };

  const enc = (o) => base64UrlEncode(utf8(JSON.stringify(o)));
  const unsignedToken = `${enc(header)}.${enc(payload)}`;

  // 用 JWK 导入（避免手写 PKCS8 DER 出错）
  const pubRaw = base64UrlToBuffer(publicKeyB64); // 65 字节: 04 || X || Y
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: base64UrlEncode(pubRaw.slice(1, 33)),
    y: base64UrlEncode(pubRaw.slice(33, 65)),
    d: base64UrlEncode(base64UrlToBuffer(privateKeyB64)),
  };

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    utf8(unsignedToken)
  );
  const sig = derToRfc7515(new Uint8Array(signature));

  return `${unsignedToken}.${base64UrlEncode(sig)}`;
}

// ECDSA 签名转 RFC 7515 (r || s 各 32 字节)
// 兼容两种输出格式：DER (30...) 或 raw (r||s)
function derToRfc7515(sig) {
  // raw 格式（64字节 r||s）直接返回
  if (sig.length === 64 && sig[0] !== 0x30) {
    return sig;
  }
  // DER 格式解析
  const rLen = sig[3];
  const rStart = 4;
  let r = trimLeadingZeros(sig.slice(rStart, rStart + rLen));
  const sLen = sig[rStart + rLen + 1];
  const sStart = rStart + rLen + 2;
  let s = trimLeadingZeros(sig.slice(sStart, sStart + sLen));
  if (r.length < 32) r = padLeft(r, 32);
  if (s.length < 32) s = padLeft(s, 32);
  return concat(r, s);
}

function trimLeadingZeros(arr) {
  let i = 0;
  while (i < arr.length - 1 && arr[i] === 0) i++;
  return arr.slice(i);
}

function padLeft(arr, len) {
  const out = new Uint8Array(len);
  out.set(arr, len - arr.length);
  return out;
}

function base64UrlToBuffer(b64) {
  const b = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4 === 0 ? '' : '='.repeat(4 - (b.length % 4));
  const bin = atob(b + pad);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function base64UrlEncode(arr) {
  let bin = '';
  for (const byte of arr) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function utf8(str) {
  return new TextEncoder().encode(str);
}

function concat(...arrays) {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

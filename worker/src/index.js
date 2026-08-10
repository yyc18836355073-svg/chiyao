// HP 四联打卡 PWA 推送服务 Worker
// 功能：接收订阅/提醒计划，每分钟 cron 检查到期提醒并 Web Push 推送

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
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

        const subs = await getSubscriptions(env);
        const others = subs.filter((s) => s.clientId !== clientId && s.endpoint !== subscription.endpoint);
        const clientSubs = subs.filter((s) => s.clientId === clientId);
        // 同一设备最多保留 3 个旧订阅，避免重复
        const keepClientSubs = clientSubs
          .concat([{ clientId, subscription, updatedAt: Date.now() }])
          .slice(-3);
        const merged = others.concat(keepClientSubs);
        await env.PUSH_KV.put('subscriptions', JSON.stringify(merged));
        return new Response(JSON.stringify({ ok: true }), { headers: cors });
      }

      // 前端启动倒计时时上报提醒计划
      if (url.pathname === '/api/reminder' && request.method === 'POST') {
        const body = await request.json();
        const { clientId, at, title, body: text } = body;
        if (!clientId || !at) {
          return new Response(JSON.stringify({ ok: false, error: '缺少参数' }), { status: 400, headers: cors });
        }
        const reminders = await getReminders(env);
        reminders.push({
          id: `${clientId}-${at}-${Date.now()}`,
          clientId,
          at: Number(at),
          title: title || 'HP服药打卡',
          body: text || '该吃药了！',
        });
        await env.PUSH_KV.put('reminders', JSON.stringify(reminders));
        return new Response(JSON.stringify({ ok: true, count: reminders.length }), { headers: cors });
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
            const r = await sendPush(env, t.subscription, payload);
            results.push({ endpoint: t.subscription.endpoint.slice(0, 60), success: r });
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
    const reminders = await getReminders(env);
    const due = reminders.filter((r) => r.at <= now);

    if (due.length === 0) return;

    const subs = await getSubscriptions(env);
    let pushed = 0;
    let failed = 0;
    // 仅成功推送的提醒才会被移除
    const successIds = new Set();

    for (const reminder of due) {
      const targets = subs.filter((s) => s.clientId === reminder.clientId || reminder.clientId === 'all');
      console.log(`[scheduled] 处理 ${reminder.id}: due=${due.length} subs=${subs.length} targets=${targets.length}`);
      // 若该设备在 5 分钟前才刚提醒过，跳过（防重复）
      const lastKey = `lastpush:${reminder.clientId}`;
      const lastTs = Number((await env.PUSH_KV.get(lastKey)) || 0);
      if (now - lastTs < 5 * 60 * 1000) continue;

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
        successIds.add(reminder.id);
        await env.PUSH_KV.put(lastKey, String(now));
      }
    }

    // 写回前重新读取最新快照，避免覆盖处理期间并发新增的提醒
    const latest = await getReminders(env);
    const rest = latest.filter((r) => !successIds.has(r.id));
    await env.PUSH_KV.put('reminders', JSON.stringify(rest));
    console.log(`[scheduled] 到期 ${due.length} 条，推送成功 ${successIds.size}，失败 ${failed}，剩余 ${rest.length} 条`);
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
      'TTL': '300',
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
  return resp.ok;
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

  // HKDF: PRK = HMAC(auth_info, ecdh_secret)
  const authInfo = concat(utf8('Content-Encoding: auth'), new Uint8Array([0]), authSecret);
  const prk = await hkdf(new Uint8Array(shared), authInfo);

  // IKM = HKDF(PRK, info = "WebPush: info" || ua_public || as_public, 32)
  const info = concat(utf8('WebPush: info'), new Uint8Array([0]), clientPublicKey, localPublicKey);
  const ikm = await hkdf(prk, info, 32);

  // key = HKDF(IKM, salt, "Content-Encoding: aes128gcm\0", 16)
  const key = await hkdf(ikm, concat(utf8('Content-Encoding: aes128gcm'), new Uint8Array([0]), salt), 16);
  // nonce = HKDF(IKM, salt, "Content-Encoding: nonce\0", 12)
  const nonce = await hkdf(ikm, concat(utf8('Content-Encoding: nonce'), new Uint8Array([0]), salt), 12);

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

async function hkdf(secret, info, length = 32) {
  const keyMaterial = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
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

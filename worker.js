export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    });

    // ── 短網址：建立（取代原本的 v.gd）──
    if (path === '/' || path === '') {
      const target = url.searchParams.get('url');
      if (!target) return new Response('missing url', { status: 400, headers: corsHeaders });
      if (!target.startsWith('http')) return new Response('invalid url', { status: 400, headers: corsHeaders });

      try {
        // 字元集去掉容易看錯的 0/O/1/l/I
        const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code, exists;
        let attempts = 0;
        do {
          code = '';
          const len = attempts < 10 ? 6 : 7;
          for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
          exists = await env.DB.get(`short:${code}`);
          attempts++;
        } while (exists && attempts < 20);

        const record = {
          url: target,
          created: Date.now(),
          clicks: 0,
        };
        await env.DB.put(`short:${code}`, JSON.stringify(record));

        const shortUrl = `${url.origin}/s/${code}`;
        return new Response(shortUrl, { headers: { ...corsHeaders, 'Content-Type': 'text/plain' } });
      } catch (e) {
        return new Response('error: ' + e.message, { status: 500, headers: corsHeaders });
      }
    }

    // ── 短網址：重定向 ──
    if (path.startsWith('/s/')) {
      const code = path.slice(3);
      if (!code) return new Response('missing code', { status: 400, headers: corsHeaders });

      const raw = await env.DB.get(`short:${code}`);
      if (!raw) {
        return new Response(`<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="UTF-8"><title>連結已失效</title>
<style>body{font-family:-apple-system,sans-serif;background:#EFEEEA;color:#0A0A0A;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}.box{max-width:400px}h1{font-size:28px;margin:0 0 12px}p{color:#666;line-height:1.6}</style>
</head><body><div class="box"><h1>連結找不到</h1><p>這個短網址不存在或已被移除。<br>請聯絡管理員確認。</p></div></body></html>`, {
          status: 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      const record = JSON.parse(raw);
      record.clicks = (record.clicks || 0) + 1;
      record.lastClicked = Date.now();
      // 等 KV 寫完才回傳，雖然多幾十毫秒但保證資料正確
      await env.DB.put(`short:${code}`, JSON.stringify(record));

      return Response.redirect(record.url, 302);
    }

    // ── 短網址：查點擊統計 ──
    if (path.startsWith('/api/stats/')) {
      const code = path.slice('/api/stats/'.length);
      const raw = await env.DB.get(`short:${code}`);
      if (!raw) return new Response('not found', { status: 404, headers: corsHeaders });
      return new Response(raw, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── KV: 讀取 ──
    if (path === '/db/get') {
      const key = url.searchParams.get('key') || 'lock_db';
      const val = await env.DB.get(key);
      return new Response(val || 'null', {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── KV: 儲存 ──
    if (path === '/db/set' && request.method === 'POST') {
      const key = url.searchParams.get('key') || 'lock_db';
      const body = await request.text();
      await env.DB.put(key, body);
      return json({ ok: true });
    }

    // ── TTLock Token ──
    if (path === '/ttlock/token') {
      const tokenData = await getTtlockToken(env);
      return json(tokenData);
    }

    // ── TTLock 列出所有門鎖（含註冊日期）──
    if (path === '/ttlock/locks') {
      const tokenData = await getTtlockToken(env);
      if (!tokenData.access_token) return json({ error: 'token failed', detail: tokenData }, 502);

      const api = new URL('https://euapi.ttlock.com/v3/lock/list');
      api.searchParams.set('clientId', env.TTLOCK_CLIENT_ID);
      api.searchParams.set('accessToken', tokenData.access_token);
      api.searchParams.set('pageNo', '1');
      api.searchParams.set('pageSize', '200');
      api.searchParams.set('date', String(Date.now()));

      const resp = await fetch(api, { method: 'GET' });
      const data = await resp.json();
      const list = (data.list || []).map(l => ({
        lockId: l.lockId,
        name: l.lockAlias || l.lockName,
        date: l.date,                       // 註冊/初始化時間 (毫秒)
        dateStr: new Date(l.date).toISOString(),
      })).sort((a, b) => b.date - a.date);  // 新 → 舊

      return json({ total: data.total, count: list.length, list });
    }

    // ── TTLock 產生臨時密碼（支援預約時間）──
    if (path === '/ttlock/passcode') {
      const reqBody = await request.json();
      const { lockId, name, cleanDate, cleanTime } = reqBody;

      const tokenData = await getTtlockToken(env);
      if (!tokenData.access_token) return json({ error: 'token failed', detail: tokenData }, 502);
      const accessToken = tokenData.access_token;

      // 計算有效期（依預約日期）
      const now = Date.now();
      let startDate, endDate;

      if (cleanDate) {
        const targetDay = new Date(cleanDate);
        // startDate: 預約日 00:00，不能早於現在
        const dayStart = new Date(targetDay);
        dayStart.setHours(0, 0, 0, 0);
        startDate = Math.max(now, dayStart.getTime());
        // endDate: 預約日隔天中午（確保至少30分鐘）
        const dayEnd = new Date(targetDay);
        dayEnd.setDate(dayEnd.getDate() + 1);
        dayEnd.setHours(12, 0, 0, 0);
        endDate = dayEnd.getTime();
      } else {
        startDate = now;
        const end = new Date();
        end.setDate(end.getDate() + 1);
        end.setHours(12, 0, 0, 0);
        endDate = end.getTime();
      }

      const pwBody = new URLSearchParams({
        clientId:           env.TTLOCK_CLIENT_ID,
        accessToken:        accessToken,
        lockId:             String(lockId),
        keyboardPwdVersion: '4',
        keyboardPwdType:    '3',
        keyboardPwdName:    name || '清潔臨時密碼',
        startDate:          String(startDate),
        endDate:            String(endDate),
        date:               String(now),
      });

      const pwResp = await fetch('https://euapi.ttlock.com/v3/keyboardPwd/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: pwBody.toString(),
      });
      const pwText = await pwResp.text();
      return new Response(pwText, {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── LINE 房客自助取門鎖密碼 webhook ──
    if (path === '/line/webhook' && request.method === 'POST') {
      const bodyText = await request.text();
      const sig = request.headers.get('x-line-signature');
      const ok = await verifyLineSignature(env.LINE_CHANNEL_SECRET, bodyText, sig);
      if (!ok) return new Response('bad signature', { status: 401, headers: corsHeaders });

      let payload;
      try { payload = JSON.parse(bodyText); } catch { return json({ ok: true }); }

      for (const event of (payload.events || [])) {
        const userId = event.source && event.source.userId;
        if (event.type === 'follow' && event.replyToken) {
          await lineReply(env, event.replyToken, '歡迎！輸入「密碼」即可取得今日門鎖密碼 🔐');
          continue;
        }
        if (event.type === 'message' && event.message && event.message.type === 'text' && event.replyToken) {
          const text = (event.message.text || '').trim();
          const reply = isPasscodeRequest(text)
            ? await handleTenantPasscode(env, userId)
            : '輸入「密碼」即可取得今日門鎖密碼 🔐';
          await lineReply(env, event.replyToken, reply);
        }
      }
      return json({ ok: true });
    }

    return new Response('not found', { status: 404, headers: corsHeaders });
  }
};

// ── 取得 TTLock access token（憑證全走環境變數）──
async function getTtlockToken(env) {
  const body = new URLSearchParams({
    clientId:     env.TTLOCK_CLIENT_ID,
    clientSecret: env.TTLOCK_CLIENT_SECRET,
    username:     env.TTLOCK_USERNAME,
    password:     md5(env.TTLOCK_PASSWORD),
    grant_type:   'password',
  });
  const resp = await fetch('https://euapi.ttlock.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return resp.json();
}

// ══════════════════════════════════════════════════════════════
//  LINE 房客自助取密碼
// ══════════════════════════════════════════════════════════════

// 是否為「索取密碼」的訊息
function isPasscodeRequest(text) {
  return /密碼|密码|門鎖|门锁|開門|开门|開鎖|开锁|password|passcode/i.test(text);
}

// 驗證 LINE webhook 簽章（HMAC-SHA256 + channel secret，Base64）
async function verifyLineSignature(secret, body, signature) {
  if (!secret || !signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return b64 === signature;
}

// 用 Reply API 回覆房客
async function lineReply(env, replyToken, text) {
  try {
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
    });
  } catch (e) { /* 回覆失敗不影響主流程 */ }
}

// 台北時區日期字串 YYYY-MM-DD
function taipeiDateStr(ms = Date.now()) {
  const d = new Date(ms + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
}

// 今日密碼有效區間：現在 → 台北當日 23:59:59
function taipeiTodayWindow() {
  const now = Date.now();
  const d = new Date(now + 8 * 3600 * 1000);
  const endUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59) - 8 * 3600 * 1000;
  return { startDate: now, endDate: endUtc };
}

// 產生一組 TTLock 限時鍵盤密碼
async function genTtlockPasscode(env, accessToken, lockId, startDate, endDate, name) {
  const pwBody = new URLSearchParams({
    clientId:           env.TTLOCK_CLIENT_ID,
    accessToken,
    lockId:             String(lockId),
    keyboardPwdVersion: '4',
    keyboardPwdType:    '3',
    keyboardPwdName:    name,
    startDate:          String(startDate),
    endDate:            String(endDate),
    date:               String(Date.now()),
  });
  const resp = await fetch('https://euapi.ttlock.com/v3/keyboardPwd/get', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: pwBody.toString(),
  });
  return resp.json();
}

// 組回覆訊息
function renderTenantReply(passcodes, n, charged, dateStr) {
  const lines = passcodes.length > 1
    ? passcodes.map((p, i) => `門鎖 ${i + 1}：${p.pw}`).join('\n')
    : `門鎖密碼：${passcodes[0].pw}`;
  let msg = `🔐 ${lines}\n有效至今日 23:59（${dateStr}）`;
  if (charged) {
    msg += `\n⚠️ 本次為本年度第 ${n} 次索取，收取作業費 50 元，已記入您的帳款。`;
  } else {
    msg += `\n（本年度第 ${n} 次，免費）`;
  }
  return msg;
}

// 核心：房客索取密碼
async function handleTenantPasscode(env, userId) {
  if (!userId) return '無法辨識您的身分，請稍後再試。';

  // 綁定設定（後台手動維護）：tenants_db = { "<userId>": { name, room, lockIds:[] } }
  const cfgRaw = await env.DB.get('tenants_db');
  const cfg = cfgRaw ? JSON.parse(cfgRaw) : {};
  const t = cfg[userId];
  if (!t || !Array.isArray(t.lockIds) || t.lockIds.length === 0) {
    return '您尚未開通門鎖密碼服務，請聯絡房東。';
  }

  const today = taipeiDateStr();
  const year = Number(today.slice(0, 4));
  const usageKey = `tenant_usage:${userId}`;
  const uRaw = await env.DB.get(usageKey);
  let u = uRaw ? JSON.parse(uRaw) : { year, issuedThisYear: 0, today: null, charges: [] };

  // 當天重複索取 → 回傳同一組密碼（不計次、不收費）
  if (u.today && u.today.date === today && Array.isArray(u.today.passcodes) && u.today.passcodes.length) {
    return renderTenantReply(u.today.passcodes, u.today.n, u.today.charged, today);
  }

  // 每年重置免費額度
  if (u.year !== year) { u.year = year; u.issuedThisYear = 0; }

  const n = u.issuedThisYear + 1;
  const charged = n >= 4;   // 前 3 次免費，第 4 次起收費

  const tokenData = await getTtlockToken(env);
  if (!tokenData.access_token) return '系統暫時無法連線門鎖服務，請稍後再試。';

  const { startDate, endDate } = taipeiTodayWindow();
  const passcodes = [];
  for (let i = 0; i < t.lockIds.length; i++) {
    const lockId = t.lockIds[i];
    const name = `房客密碼-${today}` + (t.lockIds.length > 1 ? `-${i + 1}` : '');
    const pw = await genTtlockPasscode(env, tokenData.access_token, lockId, startDate, endDate, name);
    if (!pw || !pw.keyboardPwd) {
      return '產生密碼失敗，請稍後再試或聯絡房東。';
    }
    passcodes.push({ lockId, pw: pw.keyboardPwd + '#', keyboardPwdId: pw.keyboardPwdId });
  }

  // 產生成功才記次 / 記帳
  u.issuedThisYear = n;
  u.today = { date: today, passcodes, n, charged };
  if (charged) {
    u.charges = u.charges || [];
    u.charges.push({ date: today, amount: 50, paid: false });
  }
  await env.DB.put(usageKey, JSON.stringify(u));

  return renderTenantReply(passcodes, n, charged, today);
}

// ── 標準 MD5 ──
function md5(input) {
  function safeAdd(x, y) {
    const lsw = (x & 0xffff) + (y & 0xffff);
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }
  function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
  function cmn(q, a, b, x, s, t) { return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  function ff(a,b,c,d,x,s,t){ return cmn((b&c)|((~b)&d),a,b,x,s,t); }
  function gg(a,b,c,d,x,s,t){ return cmn((b&d)|(c&(~d)),a,b,x,s,t); }
  function hh(a,b,c,d,x,s,t){ return cmn(b^c^d,a,b,x,s,t); }
  function ii(a,b,c,d,x,s,t){ return cmn(c^(b|(~d)),a,b,x,s,t); }
  const str = unescape(encodeURIComponent(input));
  const n = str.length;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  const k = Math.ceil((n + 9) / 64) * 64;
  const tail = new Uint8Array(k);
  for (let i = 0; i < n; i++) tail[i] = str.charCodeAt(i);
  tail[n] = 0x80;
  const dv = new DataView(tail.buffer);
  dv.setUint32(k - 8, n * 8, true);
  dv.setUint32(k - 4, 0, true);
  for (let i = 0; i < k; i += 64) {
    const M = [];
    for (let j = 0; j < 16; j++) M[j] = dv.getInt32(i + j * 4, true);
    let [a,b,c,d] = state;
    a=ff(a,b,c,d,M[0],7,-680876936);   d=ff(d,a,b,c,M[1],12,-389564586);  c=ff(c,d,a,b,M[2],17,606105819);    b=ff(b,c,d,a,M[3],22,-1044525330);
    a=ff(a,b,c,d,M[4],7,-176418897);   d=ff(d,a,b,c,M[5],12,1200080426);   c=ff(c,d,a,b,M[6],17,-1473231341);  b=ff(b,c,d,a,M[7],22,-45705983);
    a=ff(a,b,c,d,M[8],7,1770035416);   d=ff(d,a,b,c,M[9],12,-1958414417);  c=ff(c,d,a,b,M[10],17,-42063);      b=ff(b,c,d,a,M[11],22,-1990404162);
    a=ff(a,b,c,d,M[12],7,1804603682);  d=ff(d,a,b,c,M[13],12,-40341101);   c=ff(c,d,a,b,M[14],17,-1502002290); b=ff(b,c,d,a,M[15],22,1236535329);
    a=gg(a,b,c,d,M[1],5,-165796510);   d=gg(d,a,b,c,M[6],9,-1069501632);   c=gg(c,d,a,b,M[11],14,643717713);   b=gg(b,c,d,a,M[0],20,-373897302);
    a=gg(a,b,c,d,M[5],5,-701558691);   d=gg(d,a,b,c,M[10],9,38016083);     c=gg(c,d,a,b,M[15],14,-660478335);  b=gg(b,c,d,a,M[4],20,-405537848);
    a=gg(a,b,c,d,M[9],5,568446438);    d=gg(d,a,b,c,M[14],9,-1019803690);  c=gg(c,d,a,b,M[3],14,-187363961);   b=gg(b,c,d,a,M[8],20,1163531501);
    a=gg(a,b,c,d,M[13],5,-1444681467); d=gg(d,a,b,c,M[2],9,-51403784);     c=gg(c,d,a,b,M[7],14,1735328473);   b=gg(b,c,d,a,M[12],20,-1926607734);
    a=hh(a,b,c,d,M[5],4,-378558);      d=hh(d,a,b,c,M[8],11,-2022574463);  c=hh(c,d,a,b,M[11],16,1839030562);  b=hh(b,c,d,a,M[14],23,-35309556);
    a=hh(a,b,c,d,M[1],4,-1530992060);  d=hh(d,a,b,c,M[4],11,1272893353);   c=hh(c,d,a,b,M[7],16,-155497632);   b=hh(b,c,d,a,M[10],23,-1094730640);
    a=hh(a,b,c,d,M[13],4,681279174);   d=hh(d,a,b,c,M[0],11,-358537222);   c=hh(c,d,a,b,M[3],16,-722521979);   b=hh(b,c,d,a,M[6],23,76029189);
    a=hh(a,b,c,d,M[9],4,-640364487);   d=hh(d,a,b,c,M[12],11,-421815835);  c=hh(c,d,a,b,M[15],16,530742520);   b=hh(b,c,d,a,M[2],23,-995338651);
    a=ii(a,b,c,d,M[0],6,-198630844);   d=ii(d,a,b,c,M[7],10,1126891415);   c=ii(c,d,a,b,M[14],15,-1416354905); b=ii(b,c,d,a,M[5],21,-57434055);
    a=ii(a,b,c,d,M[12],6,1700485571);  d=ii(d,a,b,c,M[3],10,-1894986606);  c=ii(c,d,a,b,M[10],15,-1051523);    b=ii(b,c,d,a,M[1],21,-2054922799);
    a=ii(a,b,c,d,M[8],6,1873313359);   d=ii(d,a,b,c,M[15],10,-30611744);   c=ii(c,d,a,b,M[6],15,-1560198380);  b=ii(b,c,d,a,M[13],21,1309151649);
    a=ii(a,b,c,d,M[4],6,-145523070);   d=ii(d,a,b,c,M[11],10,-1120210379); c=ii(c,d,a,b,M[2],15,718787259);    b=ii(b,c,d,a,M[9],21,-343485551);
    state[0]=safeAdd(a,state[0]); state[1]=safeAdd(b,state[1]);
    state[2]=safeAdd(c,state[2]); state[3]=safeAdd(d,state[3]);
  }
  return state.map(n => {
    const v = n < 0 ? n + 4294967296 : n;
    return ('00000000' + v.toString(16)).slice(-8).replace(/^(..)(..)(..)(..)$/, '$4$3$2$1');
  }).join('');
}

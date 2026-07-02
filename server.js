const express = require('express');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

function getConfig() {
  return {
    adminPassword: process.env.ADMIN_PASSWORD || 'admin1234',
    staffPassword: process.env.STAFF_PASSWORD || 'staff1234',
    geminiApiKey:  process.env.GEMINI_API_KEY  || '',
    supabaseUrl:   process.env.SUPABASE_URL    || '',
    supabaseKey:   process.env.SUPABASE_KEY    || '',
  };
}

function supabaseRequest(method, path, body, config) {
  return new Promise((resolve, reject) => {
    const url = new URL(config.supabaseUrl);
    const data = body ? JSON.stringify(body) : null;
    console.log(`Supabase ${method} ${path}`, data ? data.slice(0, 100) : '');
    const options = {
      hostname: url.hostname,
      path: `/rest/v1/${path}`,
      method,
      headers: {
        'apikey': config.supabaseKey,
        'Authorization': `Bearer ${config.supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=representation' : ''
      }
    };
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        console.log(`Supabase response ${res.statusCode}:`, d.slice(0, 200));
        try { resolve({ status: res.statusCode, data: d ? JSON.parse(d) : [] }); }
        catch(e) { resolve({ status: res.statusCode, data: [] }); }
      });
    });
    req.on('error', e => { console.error('Supabase error:', e.message); reject(e); });
    if (data) req.write(data);
    req.end();
  });
}

// ── セッション管理 ────────────────────────────
const sessions = {};
function createSession(role, company) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { role, company: company || null, createdAt: Date.now() };
  return token;
}
function getSession(req) {
  const token = req.headers['x-session-token'];
  if (!token || !sessions[token]) return null;
  const s = sessions[token];
  if (Date.now() - s.createdAt > 12 * 60 * 60 * 1000) { delete sessions[token]; return null; }
  return s;
}
function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'ログインが必要です' });
  req.session = s; next();
}
function requireAdmin(req, res, next) {
  const s = getSession(req);
  if (!s || s.role !== 'admin') return res.status(403).json({ error: '管理者権限が必要です' });
  req.session = s; next();
}

// ── 認証API ──────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { password } = req.body;
  const config = getConfig();

  // 管理者チェック
  if (password === config.adminPassword) {
    return res.json({ ok: true, role: 'admin', company: null, token: createSession('admin', null) });
  }
  // 職員チェック
  if (password === config.staffPassword) {
    return res.json({ ok: true, role: 'staff', company: null, token: createSession('staff', null) });
  }
  // 企業パスワードチェック
  try {
    const r = await supabaseRequest('GET', `garlic_companies?password=eq.${encodeURIComponent(password)}&select=name,password`, null, config);
    if (r.data && r.data.length > 0) {
      const company = r.data[0].name;
      return res.json({ ok: true, role: 'company', company, token: createSession('company', company) });
    }
  } catch(e) {}

  res.status(401).json({ error: 'パスワードが違います' });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) delete sessions[token];
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: '未ログイン' });
  res.json({ role: s.role, company: s.company });
});

// ── データAPI ─────────────────────────────────
app.get('/api/data', requireAuth, async (req, res) => {
  const config = getConfig();
  const session = req.session;
  try {
    const companiesRes = await supabaseRequest('GET', 'garlic_companies?select=name,password&order=id.asc', null, config);
    const companies = (companiesRes.data || []).map(c => ({ name: c.name, hasPassword: !!c.password }));

    let entriesPath = 'garlic_entries?select=*&order=id.desc';
    if (session.role === 'company') {
      entriesPath = `garlic_entries?select=*&company=eq.${encodeURIComponent(session.company)}&order=id.desc`;
    }
    const entriesRes = await supabaseRequest('GET', entriesPath, null, config);

    res.json({
      companies: companies.map(c => c.name),
      companiesDetail: companies,
      entries: entriesRes.data || [],
      session: { role: session.role, company: session.company }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/entry', requireAuth, async (req, res) => {
  const { company, type, count, date, staff } = req.body;
  if (!company || !type || !count || !date) return res.status(400).json({ error: '入力不足です' });
  // 企業ユーザーは自社のみ
  if (req.session.role === 'company' && req.session.company !== company) {
    return res.status(403).json({ error: '他社データは入力できません' });
  }
  const config = getConfig();
  const now = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  try {
    await supabaseRequest('POST', 'garlic_entries', {
      id: Date.now(), company, type,
      count: parseInt(count), date,
      staff: staff || '不明', created_at: now
    }, config);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/entry/:id', requireAuth, async (req, res) => {
  const config = getConfig();
  // 企業ユーザーは自社データのみ削除可
  if (req.session.role === 'company') {
    const check = await supabaseRequest('GET', `garlic_entries?id=eq.${req.params.id}&select=company`, null, config);
    if (!check.data || !check.data[0] || check.data[0].company !== req.session.company) {
      return res.status(403).json({ error: '他社データは削除できません' });
    }
  }
  try {
    await supabaseRequest('DELETE', `garlic_entries?id=eq.${req.params.id}`, null, config);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/company', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '企業名が必要です' });
  const config = getConfig();
  try {
    const r = await supabaseRequest('POST', 'garlic_companies', { name }, config);
    if (r.status === 409) return res.status(409).json({ error: 'すでに存在します' });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/company/:name', requireAdmin, async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const config = getConfig();
  try {
    await supabaseRequest('DELETE', `garlic_companies?name=eq.${encodeURIComponent(name)}`, null, config);
    await supabaseRequest('DELETE', `garlic_entries?company=eq.${encodeURIComponent(name)}`, null, config);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// 企業パスワード設定（管理者のみ）
app.post('/api/company/:name/password', requireAdmin, async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { password } = req.body;
  const config = getConfig();
  try {
    await supabaseRequest('PATCH', `garlic_companies?name=eq.${encodeURIComponent(name)}`,
      { password: password || null }, config);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Gemini API中継 ────────────────────────────
app.post('/api/gemini', requireAdmin, async (req, res) => {
  const config = getConfig();
  if (!config.geminiApiKey) return res.status(400).json({ error: 'Gemini APIキーが設定されていません' });
  try {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: req.body.prompt }] }],
      generationConfig: { maxOutputTokens: 3000, temperature: 0.7 }
    });
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const proxyReq = https.request(options, proxyRes => {
      let data = '';
      proxyRes.on('data', c => data += c);
      proxyRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
          res.json({ ok: true, text });
        } catch(e) { res.status(500).json({ error: 'レスポンス解析エラー' }); }
      });
    });
    proxyReq.on('error', e => res.status(500).json({ error: e.message }));
    proxyReq.write(body);
    proxyReq.end();
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🧄 にんにく在庫管理サーバー 起動中');
  console.log('  ポート: ' + PORT + '\n');
});

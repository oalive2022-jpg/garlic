const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

app.use(express.json());

// ── 設定読み込み ──────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const defaults = {
      adminPassword: 'admin1234',
      staffPassword: 'staff1234'
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

// ── セッション管理（メモリ）─────────────────────
const sessions = {};
function createSession(role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { role, createdAt: Date.now() };
  return token;
}
function getSession(req) {
  const token = req.headers['x-session-token'];
  if (!token || !sessions[token]) return null;
  const s = sessions[token];
  // 12時間で失効
  if (Date.now() - s.createdAt > 12 * 60 * 60 * 1000) {
    delete sessions[token];
    return null;
  }
  return s;
}

// ── 認証ミドルウェア ─────────────────────────
function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'ログインが必要です' });
  req.role = s.role;
  next();
}
function requireAdmin(req, res, next) {
  const s = getSession(req);
  if (!s || s.role !== 'admin') return res.status(403).json({ error: '管理者権限が必要です' });
  req.role = s.role;
  next();
}

// ── 静的ファイル（login.htmlのみ認証不要）────────
// login.htmlは直接配信、他はAPIで認証
app.use(express.static(path.join(__dirname, 'public')));

// ── 認証API ──────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const config = loadConfig();
  if (password === config.adminPassword) {
    const token = createSession('admin');
    return res.json({ ok: true, role: 'admin', token });
  }
  if (password === config.staffPassword) {
    const token = createSession('staff');
    return res.json({ ok: true, role: 'staff', token });
  }
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
  res.json({ role: s.role });
});

// ── データAPI（全員ログイン必須）────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const init = { companies: [], entries: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/data', requireAuth, (req, res) => {
  res.json(loadData());
});

app.post('/api/entry', requireAuth, (req, res) => {
  const { company, type, count, date, staff } = req.body;
  if (!company || !type || !count || !date) return res.status(400).json({ error: '入力不足です' });
  const data = loadData();
  if (!data.companies.includes(company)) return res.status(404).json({ error: '企業が見つかりません' });
  const now = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  data.entries.unshift({
    id: Date.now(), company, type,
    count: parseInt(count), date,
    staff: staff || '不明', createdAt: now
  });
  saveData(data);
  res.json({ ok: true });
});

app.delete('/api/entry/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const data = loadData();
  data.entries = data.entries.filter(e => e.id !== id);
  saveData(data);
  res.json({ ok: true });
});

// ── 企業管理（管理者のみ）────────────────────
app.post('/api/company', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '企業名が必要です' });
  const data = loadData();
  if (data.companies.includes(name)) return res.status(409).json({ error: 'すでに存在します' });
  data.companies.push(name);
  saveData(data);
  res.json({ ok: true });
});

app.delete('/api/company/:name', requireAdmin, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const data = loadData();
  data.companies = data.companies.filter(c => c !== name);
  data.entries = data.entries.filter(e => e.company !== name);
  saveData(data);
  res.json({ ok: true });
});

// ── パスワード変更（管理者のみ）──────────────
app.post('/api/config/password', requireAdmin, (req, res) => {
  const { adminPassword, staffPassword } = req.body;
  const config = loadConfig();
  if (adminPassword) config.adminPassword = adminPassword;
  if (staffPassword) config.staffPassword = staffPassword;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  res.json({ ok: true });
});

// ── Claude API中継（管理者のみ）──────────────
app.post('/api/claude', requireAdmin, async (req, res) => {
  const config = loadConfig();
  const apiKey = config.anthropicApiKey;
  if (!apiKey) {
    return res.status(400).json({ error: 'APIキーが設定されていません。config.jsonに anthropicApiKey を追加してください。' });
  }

  try {
    const https = require('https');
    const body = JSON.stringify(req.body);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const proxyReq = https.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        res.status(proxyRes.statusCode).json(JSON.parse(data));
      });
    });
    proxyReq.on('error', (e) => res.status(500).json({ error: e.message }));
    proxyReq.write(body);
    proxyReq.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Gemini API中継（管理者のみ）─────────────
app.post('/api/gemini', requireAdmin, async (req, res) => {
  const config = loadConfig();
  const apiKey = config.geminiApiKey;
  if (!apiKey) {
    return res.status(400).json({ error: 'Gemini APIキーが設定されていません。config.jsonに geminiApiKey を追加してください。' });
  }

  try {
    const https = require('https');
    const body = JSON.stringify({
      contents: [{ parts: [{ text: req.body.prompt }] }],
      generationConfig: { maxOutputTokens: 3000, temperature: 0.7 }
    });
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const proxyReq = https.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // レスポンス全体をログ出力（デバッグ用）
          console.log('Gemini response:', JSON.stringify(parsed).slice(0, 500));
          const text =
            parsed.candidates?.[0]?.content?.parts?.[0]?.text ||
            parsed.candidates?.[0]?.output ||
            parsed.text || '';
          if (!text) {
            console.log('Full Gemini response:', JSON.stringify(parsed));
          }
          res.json({ ok: true, text });
        } catch(e) {
          res.status(500).json({ error: 'レスポンスの解析に失敗しました: ' + e.message });
        }
      });
    });
    proxyReq.on('error', (e) => res.status(500).json({ error: e.message }));
    proxyReq.write(body);
    proxyReq.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 起動 ────────────────────────────────────
function getLanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets))
    for (const net of nets[name])
      if (net.family === 'IPv4' && !net.internal) return net.address;
  return 'localhost';
}

app.listen(PORT, '0.0.0.0', () => {
  const ip = getLanIP();
  console.log('');
  console.log('🧄 にんにく在庫管理サーバー 起動中');
  console.log('');
  console.log('  ログイン画面(PC): http://localhost:' + PORT + '/login.html');
  console.log('  ログイン画面(LAN): http://' + ip + ':' + PORT + '/login.html');
  console.log('');
  console.log('  ※ ngrokを使えばインターネットからもアクセス可能');
  console.log('  Ctrl+C で停止');
  console.log('');
});

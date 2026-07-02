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
    importApiKey:  process.env.IMPORT_API_KEY  || '',
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
function requireImportKey(req, res, next) {
  const config = getConfig();
  const key = req.headers['x-api-key'];
  if (!config.importApiKey) return res.status(500).json({ error: 'IMPORT_API_KEYが未設定です' });
  if (!key || key !== config.importApiKey) return res.status(401).json({ error: 'APIキーが不正です' });
  next();
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

// ── 作業マスタ（皮むき／醤油酢漬け等、固定の作業種類）───────
app.get('/api/task-master', requireAuth, async (req, res) => {
  const config = getConfig();
  try {
    const r = await supabaseRequest('GET', 'garlic_task_master?select=*&order=sort_order.asc', null, config);
    res.json({ tasks: r.data || [] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/task-master', requireAdmin, async (req, res) => {
  const { task_name, linked_type, sort_order } = req.body;
  if (!task_name || !VALID_TYPES.includes(linked_type)) {
    return res.status(400).json({ error: '作業名と紐づけ種別(clean/damaged/shipped/planting)が必要です' });
  }
  const config = getConfig();
  try {
    const r = await supabaseRequest('POST', 'garlic_task_master', {
      id: Date.now(), task_name, linked_type,
      sort_order: sort_order || 0, created_at: new Date().toISOString()
    }, config);
    if (r.status === 409) return res.status(409).json({ error: '既に同じ作業名があります' });
    if (r.status < 200 || r.status >= 300) {
      console.error('task-master insert failed:', r.status, JSON.stringify(r.data));
      return res.status(500).json({ error: 'Supabaseへの登録に失敗しました', detail: r.data });
    }
    res.json({ ok: true, inserted: r.data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/task-master/:id', requireAdmin, async (req, res) => {
  const config = getConfig();
  try {
    await supabaseRequest('DELETE', `garlic_task_master?id=eq.${req.params.id}`, null, config);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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

// ── 申し送り：予測スケジュールAPI ──────────────
// company を省略した場合は「全社合計」の予測として扱う
app.get('/api/predictions', requireAuth, async (req, res) => {
  const config = getConfig();
  const { start, end, company } = req.query;
  try {
    let path = 'garlic_predictions?select=*&order=date.asc';
    if (start && end) path += `&date=gte.${start}&date=lte.${end}`;
    if (company) path += `&company=eq.${encodeURIComponent(company)}`;
    const r = await supabaseRequest('GET', path, null, config);
    res.json({ predictions: r.data || [] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// 予測値を登録・上書き保存（同じ日付+種別+作業+企業があれば更新。companyを省略/nullなら全社合計扱い）
app.post('/api/prediction', requireAdmin, async (req, res) => {
  const { date, type, predicted_count, note, company, task } = req.body;
  if (!date || !type || predicted_count === undefined || predicted_count === '') {
    return res.status(400).json({ error: '入力不足です' });
  }
  const config = getConfig();
  try {
    let findPath = `garlic_predictions?date=eq.${date}&type=eq.${type}&select=id`;
    findPath += company ? `&company=eq.${encodeURIComponent(company)}` : `&company=is.null`;
    findPath += task ? `&task=eq.${encodeURIComponent(task)}` : `&task=is.null`;
    const existing = await supabaseRequest('GET', findPath, null, config);
    let writeRes;
    if (existing.data && existing.data.length > 0) {
      writeRes = await supabaseRequest('PATCH', `garlic_predictions?id=eq.${existing.data[0].id}`,
        { predicted_count: parseInt(predicted_count), note: note || null }, config);
    } else {
      writeRes = await supabaseRequest('POST', 'garlic_predictions', {
        id: Date.now() + Math.floor(Math.random() * 1000),
        date, type, predicted_count: parseInt(predicted_count),
        note: note || null, company: company || null, task: task || null,
        created_at: new Date().toISOString()
      }, config);
    }
    if (writeRes.status < 200 || writeRes.status >= 300) {
      console.error('prediction write failed:', writeRes.status, JSON.stringify(writeRes.data));
      return res.status(500).json({ error: 'Supabaseへの登録に失敗しました', detail: writeRes.data });
    }
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/prediction/:id', requireAdmin, async (req, res) => {
  const config = getConfig();
  try {
    await supabaseRequest('DELETE', `garlic_predictions?id=eq.${req.params.id}`, null, config);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 申し送り：実測値の日付×種別（×企業）集計API ─────
// company指定なし → 全社合計＋企業別内訳の両方を返す
// company指定あり → その企業だけに絞った合計を返す
app.get('/api/actuals', requireAuth, async (req, res) => {
  const config = getConfig();
  const { start, end, company } = req.query;
  if (!start || !end) return res.status(400).json({ error: '期間指定が必要です(start, end)' });
  try {
    let path = `garlic_entries?select=date,type,count,company&date=gte.${start}&date=lte.${end}`;
    if (company) path += `&company=eq.${encodeURIComponent(company)}`;
    const r = await supabaseRequest('GET', path, null, config);

    const totals = {};       // date||type -> 合計（company指定時はその企業のみ）
    const byCompany = {};    // date||type||company -> 合計
    (r.data || []).forEach(e => {
      const key = `${e.date}||${e.type}`;
      totals[key] = (totals[key] || 0) + (e.count || 0);
      const ckey = `${e.date}||${e.type}||${e.company}`;
      byCompany[ckey] = (byCompany[ckey] || 0) + (e.count || 0);
    });
    res.json({ totals, byCompany });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 申し送り：Custom GPT(チャッピー)からの自動取り込みAPI ──────
// x-api-key ヘッダーで認証。ChatGPTのCustom GPT Actionsから直接叩かれる想定。
const VALID_TYPES = ['clean', 'damaged', 'shipped', 'planting'];

app.post('/api/prediction-import', requireImportKey, async (req, res) => {
  const { predictions } = req.body;
  if (!Array.isArray(predictions) || predictions.length === 0) {
    return res.status(400).json({ error: 'predictions配列が必要です' });
  }
  const config = getConfig();
  const results = [];
  try {
    for (const p of predictions) {
      const { date, type, predicted_count, note, company, task } = p;
      if (!date || !VALID_TYPES.includes(type) || predicted_count === undefined || predicted_count === '') {
        results.push({ date, type, task: task || null, company: company || null, ok: false, error: '入力不足または種別が不正です' });
        continue;
      }
      let findPath = `garlic_predictions?date=eq.${date}&type=eq.${type}&select=id`;
      findPath += company ? `&company=eq.${encodeURIComponent(company)}` : `&company=is.null`;
      findPath += task ? `&task=eq.${encodeURIComponent(task)}` : `&task=is.null`;
      const existing = await supabaseRequest('GET', findPath, null, config);
      let writeRes;
      if (existing.data && existing.data.length > 0) {
        writeRes = await supabaseRequest('PATCH', `garlic_predictions?id=eq.${existing.data[0].id}`,
          { predicted_count: parseInt(predicted_count), note: note || null }, config);
      } else {
        writeRes = await supabaseRequest('POST', 'garlic_predictions', {
          id: Date.now() + Math.floor(Math.random() * 1000),
          date, type, predicted_count: parseInt(predicted_count),
          note: note || null, company: company || null, task: task || null,
          created_at: new Date().toISOString()
        }, config);
      }
      if (writeRes.status < 200 || writeRes.status >= 300) {
        console.error('prediction-import write failed:', writeRes.status, JSON.stringify(writeRes.data));
        results.push({ date, type, task: task || null, company: company || null, ok: false, error: `Supabaseエラー(${writeRes.status})` });
        continue;
      }
      results.push({ date, type, task: task || null, company: company || null, ok: true });
    }
    const failed = results.filter(r => !r.ok);
    res.json({
      ok: failed.length === 0,
      imported: results.filter(r => r.ok).length,
      failed,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Custom GPTが「今どの週の実測がどこまで埋まっているか」「どんな作業種類があるか」を確認するための参照API
// company を指定すればその企業だけ、省略すれば全社合計＋企業一覧を返す
app.get('/api/actuals-for-gpt', requireImportKey, async (req, res) => {
  const config = getConfig();
  const { start, end, company } = req.query;
  if (!start || !end) return res.status(400).json({ error: '期間指定が必要です(start, end)' });
  try {
    let entriesPath = `garlic_entries?select=date,type,count,company&date=gte.${start}&date=lte.${end}`;
    if (company) entriesPath += `&company=eq.${encodeURIComponent(company)}`;
    const r = await supabaseRequest('GET', entriesPath, null, config);

    const totals = {};
    const byCompany = {};
    (r.data || []).forEach(e => {
      const key = `${e.date}||${e.type}`;
      totals[key] = (totals[key] || 0) + (e.count || 0);
      const ckey = `${e.date}||${e.type}||${e.company}`;
      byCompany[ckey] = (byCompany[ckey] || 0) + (e.count || 0);
    });

    let predPath = `garlic_predictions?select=*&date=gte.${start}&date=lte.${end}`;
    if (company) predPath += `&company=eq.${encodeURIComponent(company)}`;
    const predRes = await supabaseRequest('GET', predPath, null, config);

    const companiesRes = await supabaseRequest('GET', 'garlic_companies?select=name&order=id.asc', null, config);
    const taskMasterRes = await supabaseRequest('GET', 'garlic_task_master?select=*&order=sort_order.asc', null, config);

    res.json({
      companies: (companiesRes.data || []).map(c => c.name),
      task_master: taskMasterRes.data || [],
      actual_totals: totals,
      actual_by_company: byCompany,
      previous_predictions: predRes.data || []
    });
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

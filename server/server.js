#!/usr/bin/env node
/*
 * ============================================================================
 *  Week1 最小接收 / 存储 / 查询服务（零依赖，只用 Node 内置模块）
 *
 *  职责边界（课堂上要讲清楚的一层）：
 *     板端  = 采样 + 打时间戳 + 上报      （数据来源）
 *     服务端 = 接收 + 落盘 + 提供查询      （唯一可信记录，source of truth）
 *     浏览器 = 只读展示，不做任何计算改写   （视图）
 *
 *  存储：data/records.ndjson  —— 一行一条 JSON，append-only，永不覆盖
 *        这是"VPS 原始记录"的证据文件，可以直接 cat 出来核对
 *
 *  启动：
 *      DEVICE_TOKEN=xxx PORT=8080 node server.js
 *  网页：
 *      http://<host>:8080/
 * ============================================================================
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// ------------------------------ 配置 ------------------------------
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'dev-token-please-change';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const WEB_DIR = process.env.WEB_DIR || path.join(__dirname, '..', 'web');
const MAX_MEMORY = parseInt(process.env.MAX_MEMORY || '50000', 10);
const BODY_LIMIT = 64 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
const RECORDS_FILE = path.join(DATA_DIR, 'records.ndjson');

// ------------------------------ 内存索引 ------------------------------
/** @type {object[]} 最近 MAX_MEMORY 条记录，按时间升序 */
let records = [];
let ingestTotal = 0;
let rejectTotal = 0;
const startedAt = Date.now();

function loadExisting() {
  if (!fs.existsSync(RECORDS_FILE)) return;
  const text = fs.readFileSync(RECORDS_FILE, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch (_) {
      /* 损坏行直接跳过，不影响服务启动 */
    }
  }
  if (records.length > MAX_MEMORY) records = records.slice(-MAX_MEMORY);
  ingestTotal = records.length;
}

function appendRecord(rec) {
  records.push(rec);
  if (records.length > MAX_MEMORY) records = records.slice(-MAX_MEMORY);
  fs.appendFile(RECORDS_FILE, JSON.stringify(rec) + '\n', (err) => {
    if (err) console.error('[STORE] 写盘失败:', err.message);
  });
}

// ------------------------------ 工具 ------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(WEB_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(WEB_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function byDevice(id, limit) {
  const list = id ? records.filter((r) => r.device_id === id) : records;
  return limit ? list.slice(-limit) : list;
}

// ------------------------------ 路由 ------------------------------
async function handleIngest(req, res) {
  if (req.headers['x-device-token'] !== DEVICE_TOKEN) {
    rejectTotal++;
    console.warn('[INGEST] 401 token 不匹配');
    return sendJson(res, 401, { ok: false, error: 'bad token' });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    rejectTotal++;
    return sendJson(res, 413, { ok: false, error: e.message });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    rejectTotal++;
    return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
  }

  // 最小校验：这四个字段缺一个就不收
  if (!payload.device_id || payload.metric === undefined ||
      payload.value === undefined || payload.unit === undefined) {
    rejectTotal++;
    return sendJson(res, 422, {
      ok: false,
      error: 'missing required field: device_id / metric / value / unit',
    });
  }

  const value = Number(payload.value);
  if (!Number.isFinite(value)) {
    rejectTotal++;
    return sendJson(res, 422, { ok: false, error: 'value is not a finite number' });
  }

  // 服务端自己盖章：这是"VPS 原始记录"的时间基准
  const nowMs = Date.now();
  const rec = Object.assign({}, payload, {
    value,
    seq: Number(payload.seq) || null,
    ts_device: Number(payload.ts_device) || 0,
    uptime_ms: Number(payload.uptime_ms) || 0,
    server_ts_ms: nowMs,
    server_iso: new Date(nowMs).toISOString(),
    src_ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', ''),
  });

  appendRecord(rec);
  console.log('[INGEST] %s  %s=%s %s  seq=%s  ts_device=%s',
    rec.device_id, rec.metric, rec.value, rec.unit, rec.seq, rec.ts_device || 'N/A');

  return sendJson(res, 201, {
    ok: true,
    accepted_seq: rec.seq,
    server_ts_ms: rec.server_ts_ms,
    stored: ingestTotal,
  });
}

function handleApi(req, res, u) {
  const p = u.pathname;

  if (p === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      records_in_memory: records.length,
      ingest_total: ingestTotal,
      reject_total: rejectTotal,
      devices: [...new Set(records.map((r) => r.device_id))],
      records_file: RECORDS_FILE,
      server_iso: new Date().toISOString(),
    });
  }

  if (p === '/api/devices') {
    const map = new Map();
    for (const r of records) {
      const cur = map.get(r.device_id);
      if (!cur) {
        map.set(r.device_id, {
          device_id: r.device_id,
          metric: r.metric,
          unit: r.unit,
          count: 1,
          last_server_ts_ms: r.server_ts_ms,
          mac: r.mac || null,
          fw: r.fw || null,
        });
      } else {
        cur.count++;
        cur.metric = r.metric;
        cur.unit = r.unit;
        cur.last_server_ts_ms = r.server_ts_ms;
        cur.mac = r.mac || cur.mac;
        cur.fw = r.fw || cur.fw;
      }
    }
    return sendJson(res, 200, { ok: true, now_ms: Date.now(), devices: [...map.values()] });
  }

  if (p === '/api/latest') {
    const dev = u.searchParams.get('device');
    const list = byDevice(dev, 0);
    const rec = list.length ? list[list.length - 1] : null;
    return sendJson(res, 200, {
      ok: true,
      now_ms: Date.now(),
      has_data: !!rec,
      age_ms: rec ? Date.now() - rec.server_ts_ms : null,
      record: rec,
    });
  }

  if (p === '/api/history') {
    const dev = u.searchParams.get('device');
    const limit = Math.min(parseInt(u.searchParams.get('limit') || '120', 10) || 120, 2000);
    const list = byDevice(dev, limit);
    return sendJson(res, 200, { ok: true, now_ms: Date.now(), count: list.length, records: list });
  }

  if (p === '/api/export.csv') {
    const dev = u.searchParams.get('device');
    const list = byDevice(dev, 0);
    const cols = ['server_iso', 'server_ts_ms', 'device_id', 'seq', 'metric', 'value', 'unit',
      'ts_device', 'uptime_ms', 'rssi', 'mac', 'fw', 'src_ip'];
    const lines = [cols.join(',')];
    for (const r of list) {
      lines.push(cols.map((c) => {
        const v = r[c] === undefined || r[c] === null ? '' : String(r[c]);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(','));
    }
    const body = lines.join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="records.csv"',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(body);
  }

  return sendJson(res, 404, { ok: false, error: 'unknown api: ' + p });
}

// ------------------------------ 启动 ------------------------------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Device-Token',
    });
    return res.end();
  }

  if (req.method === 'POST' && u.pathname === '/api/ingest') {
    return handleIngest(req, res).catch((e) => {
      console.error('[INGEST] 异常:', e);
      sendJson(res, 500, { ok: false, error: 'internal error' });
    });
  }

  if (req.method === 'GET' && u.pathname.startsWith('/api/')) {
    return handleApi(req, res, u);
  }

  if (req.method === 'GET') return serveStatic(req, res, u.pathname);

  res.writeHead(405, { 'Content-Type': 'text/plain' }).end('405 method not allowed');
});

loadExisting();

server.listen(PORT, HOST, () => {
  console.log('==================================================');
  console.log(' Week1 传感数据服务已启动');
  console.log('  监听地址   : http://' + HOST + ':' + PORT);
  console.log('  网页       : http://<本机IP>:' + PORT + '/');
  console.log('  上报接口   : POST /api/ingest   (需 X-Device-Token)');
  console.log('  查询接口   : GET  /api/latest | /api/history | /api/devices | /api/health');
  console.log('  导出 CSV   : GET  /api/export.csv?device=<id>');
  console.log('  原始记录   : ' + RECORDS_FILE);
  console.log('  已载入记录 : ' + records.length);
  console.log('  token      : ' + (DEVICE_TOKEN === 'dev-token-please-change'
    ? '⚠ 正在用默认 token，上线前务必改掉！' : '已自定义'));
  console.log('==================================================');
});

process.on('SIGINT', () => { console.log('\n[EXIT] 收到 Ctrl+C，退出'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n[EXIT] 收到终止信号，退出'); process.exit(0); });

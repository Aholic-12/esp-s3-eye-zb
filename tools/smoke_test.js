#!/usr/bin/env node
/*
 * ============================================================================
 *  【冒烟测试】一条命令验证服务端全链路
 *
 *  覆盖：
 *    1. GET  /api/health         服务活着
 *    2. POST /api/ingest         正常接收一条 IMU 记录 → 201
 *    3. POST /api/ingest         错误 token 必须被拒 → 401
 *    4. POST /api/ingest         缺字段必须被拒 → 422
 *    5. GET  /api/latest         能读到刚才那条，且值/单位一致
 *    6. GET  /api/history        能读到历史，条数对得上
 *    7. GET  /api/devices        设备出现在列表里
 *    8. GET  /api/export.csv     能导出 CSV
 *    9. GET  /                    页面能打开
 *
 *  用法：
 *    node smoke_test.js
 *    node smoke_test.js --url http://1.2.3.4:8080 --token mytoken
 *
 *  退出码 0 = 全通过，1 = 有失败（方便写进 CI / 课前检查脚本）
 * ============================================================================
 */

'use strict';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const BASE = (arg('url', process.env.SERVER_URL || 'http://127.0.0.1:8080')).replace(/\/$/, '');
const TOKEN = arg('token', process.env.DEVICE_TOKEN || 'dev-token-please-change');
const TEST_DEVICE = arg('device', 'smoke-test-device');

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}

function section(t) { console.log('\n' + t); }

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers['X-Device-Token'] = token === undefined ? TOKEN : token;
  const res = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch (_) { /* 可能不是 json */ }
  return { status: res.status, json };
}

function goodRecord(seq, value) {
  return {
    device_id: TEST_DEVICE,
    seq,
    metric: 'accel_mag',
    value,
    unit: 'g',
    axes: {
      accel: { x: 0.011, y: -0.022, z: 0.999, unit: 'g' },
      gyro: { x: 1.2, y: -0.4, z: 0.7, unit: 'dps' },
    },
    sensor: 'SMOKE-TEST',
    has_gyro: true,
    ts_device: Math.floor(Date.now() / 1000),
    uptime_ms: 12345,
    rssi: -57,
    mac: 'DE:AD:BE:EF:00:01',
    fw: 'smoke',
    sampling: true,
  };
}

async function main() {
  console.log('==================================================');
  console.log(' Week1 服务端冒烟测试');
  console.log(' 目标: ' + BASE);
  console.log(' 设备: ' + TEST_DEVICE);
  console.log('==================================================');

  // 1. health
  section('[1] 服务探活 GET /api/health');
  try {
    const r = await fetch(BASE + '/api/health');
    const j = await r.json();
    check('HTTP 200', r.status === 200, 'got ' + r.status);
    check('ok=true', j.ok === true);
    check('返回记录总数', typeof j.ingest_total === 'number', JSON.stringify(j).slice(0, 120));
    console.log('     uptime=' + j.uptime_s + 's  内存记录=' + j.records_in_memory + '  落盘=' + j.records_file);
  } catch (e) {
    check('服务可达', false, e.message);
    console.log('\n服务端没起来。先执行：  cd server && node server.js');
    process.exit(1);
  }

  // 2-4. ingest
  section('[2] 正常上报 POST /api/ingest');
  const V1 = 1.0032, V2 = 0.9987, V3 = 1.7410;
  const r1 = await post('/api/ingest', goodRecord(9001, V1));
  check('HTTP 201', r1.status === 201, 'got ' + r1.status);
  check('ok=true 且回执含 server_ts_ms', !!(r1.json && r1.json.ok && r1.json.server_ts_ms));
  await new Promise((r) => setTimeout(r, 30));
  const r2 = await post('/api/ingest', goodRecord(9002, V2));
  check('第二条也通过', r2.status === 201, 'got ' + r2.status);
  await new Promise((r) => setTimeout(r, 30));
  const r3 = await post('/api/ingest', goodRecord(9003, V3));
  check('第三条也通过', r3.status === 201, 'got ' + r3.status);

  section('[3] 鉴权与校验');
  const bad = await post('/api/ingest', goodRecord(9004, 1.0), 'wrong-token-xxx');
  check('错误 token → 401', bad.status === 401, 'got ' + bad.status);
  const missing = await post('/api/ingest', { device_id: TEST_DEVICE, seq: 9005 });
  check('缺 metric/value/unit → 422', missing.status === 422, 'got ' + missing.status);
  const badVal = await post('/api/ingest', Object.assign(goodRecord(9006, 1), { value: 'abc' }));
  check('value 非数字 → 422', badVal.status === 422, 'got ' + badVal.status);

  // 5. latest
  section('[4] 最新值 GET /api/latest');
  const latest = await fetch(BASE + '/api/latest?device=' + encodeURIComponent(TEST_DEVICE)).then((r) => r.json());
  check('has_data=true', latest.has_data === true);
  check('value 与我们发的一致', latest.record && Math.abs(latest.record.value - V3) < 1e-9,
    'got ' + (latest.record && latest.record.value) + ' want ' + V3);
  check('unit=g', latest.record && latest.record.unit === 'g');
  check('陀螺仪字段被完整保存', !!(latest.record && latest.record.axes && latest.record.axes.gyro));
  check('服务端盖了自己的时间戳', !!(latest.record && latest.record.server_iso));
  check('记录了来源 IP', !!(latest.record && latest.record.src_ip));
  console.log('     最新记录: seq=' + latest.record.seq + '  value=' + latest.record.value +
    ' ' + latest.record.unit + '  age=' + latest.age_ms + 'ms');

  // 6. history
  section('[5] 历史 GET /api/history');
  const hist = await fetch(BASE + '/api/history?device=' + encodeURIComponent(TEST_DEVICE) + '&limit=10').then((r) => r.json());
  check('至少 3 条', hist.count >= 3, 'got ' + hist.count);
  const seqs = (hist.records || []).map((x) => x.seq);
  check('包含 9001/9002/9003', [9001, 9002, 9003].every((s) => seqs.indexOf(s) >= 0), 'seqs=' + seqs.join(','));
  check('按时间升序（最后一条最新）', (hist.records || []).length < 2 ||
    hist.records[hist.records.length - 1].server_ts_ms >= hist.records[0].server_ts_ms);

  // 7. devices
  section('[6] 设备列表 GET /api/devices');
  const devs = await fetch(BASE + '/api/devices').then((r) => r.json());
  const mine = (devs.devices || []).find((d) => d.device_id === TEST_DEVICE);
  check('测试设备出现在列表', !!mine);
  if (mine) {
    check('计数 ≥ 3', mine.count >= 3, 'got ' + mine.count);
    check('带上了 metric/unit', mine.metric === 'accel_mag' && mine.unit === 'g');
    console.log('     设备: ' + mine.device_id + '  ' + mine.count + ' 条  metric=' + mine.metric);
  }

  // 8. csv
  section('[7] 导出 GET /api/export.csv');
  const csvRes = await fetch(BASE + '/api/export.csv?device=' + encodeURIComponent(TEST_DEVICE));
  const csv = await csvRes.text();
  const lines = csv.trim().split('\n');
  check('HTTP 200', csvRes.status === 200);
  check('表头含 server_iso/device_id/value', lines[0].indexOf('server_iso') >= 0 &&
    lines[0].indexOf('device_id') >= 0 && lines[0].indexOf('value') >= 0, lines[0]);
  check('数据行 ≥ 3', lines.length - 1 >= 3, 'got ' + (lines.length - 1));

  // 9. 静态页
  section('[8] 网页 GET /');
  const page = await fetch(BASE + '/');
  const html = await page.text();
  check('HTTP 200', page.status === 200, 'got ' + page.status);
  check('是 HTML', (page.headers.get('content-type') || '').indexOf('text/html') >= 0);
  check('页面里引用了 /api/latest', html.indexOf('/api/latest') >= 0);

  // 汇总
  console.log('\n==================================================');
  console.log(' 结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) {
    console.log(' 失败清单：');
    failures.forEach((f) => console.log('   - ' + f));
  } else {
    console.log(' 全链路 OK。接下来把板子 config.h 里的 SERVER_INGEST_URL 指向这台服务。');
  }
  console.log('==================================================');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n[FATAL] ' + e.message);
  process.exit(1);
});

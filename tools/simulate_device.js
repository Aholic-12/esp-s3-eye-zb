#!/usr/bin/env node
/*
 * ============================================================================
 *  【模拟设备】—— 只用于在拿到板子之前把服务端和网页跑通
 *
 *  ⚠⚠  重要：这不是真实传感数据，绝对不可以作为作业的"真实观测"证据。  ⚠⚠
 *      当堂验证必须用板子上的真实 IMU（QMA7981 / MPU6050 ...）。
 *      模拟脚本的每条记录都会把 fw 标成 "SIMULATOR"，页面上一眼能认出来。
 *
 *  用法：
 *    node simulate_device.js                        # 默认 http://127.0.0.1:8080
 *    node simulate_device.js --url http://1.2.3.4:8080 --token mytoken
 *    node simulate_device.js --device g01-s3eye --interval 1000 --count 30
 * ============================================================================
 */

'use strict';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const URL_BASE = arg('url', process.env.SERVER_URL || 'http://127.0.0.1:8080');
const TOKEN = arg('token', process.env.DEVICE_TOKEN || 'dev-token-please-change');
const DEVICE_ID = arg('device', 'sim-01');
const INTERVAL = parseInt(arg('interval', '1000'), 10);
const COUNT = parseInt(arg('count', '0'), 10);   // 0 = 一直发

const ENDPOINT = URL_BASE.replace(/\/$/, '') + '/api/ingest';

let seq = 0;
let moving = false;
let moveUntil = 0;

function noise(amp) { return (Math.random() * 2 - 1) * amp; }

function buildRecord() {
  const now = Date.now();
  if (now > moveUntil) {
    moving = Math.random() < 0.12;                 // 12% 概率进入"晃动"状态
    moveUntil = now + (moving ? 900 : 2500);
  }

  // 静止：z ≈ 1g；晃动：三轴乱跳，合矢量偏离 1
  const ax = moving ? noise(0.9) : noise(0.012);
  const ay = moving ? noise(0.9) : noise(0.012);
  const az = moving ? 1.0 + noise(0.9) : 1.0 + noise(0.012);
  const mag = Math.sqrt(ax * ax + ay * ay + az * az);

  // 陀螺仪：静止 ≈0 dps，晃动时几十~几百 dps
  const gx = moving ? noise(120) : noise(1.2);
  const gy = moving ? noise(120) : noise(1.2);
  const gz = moving ? noise(120) : noise(1.2);

  seq++;
  return {
    device_id: DEVICE_ID,
    seq,
    metric: 'accel_mag',
    value: Number(mag.toFixed(4)),
    unit: 'g',
    axes: {
      accel: { x: +ax.toFixed(4), y: +ay.toFixed(4), z: +az.toFixed(4), unit: 'g' },
      gyro: { x: +gx.toFixed(3), y: +gy.toFixed(3), z: +gz.toFixed(3), unit: 'dps' },
    },
    sensor: 'SIMULATOR',
    has_gyro: true,
    ts_device: Math.floor(now / 1000),
    uptime_ms: Date.now() % 100000000,
    rssi: -50 - Math.round(Math.random() * 20),
    mac: 'AA:BB:CC:DD:EE:FF',
    fw: 'SIMULATOR-do-not-use-as-evidence',
    sampling: true,
  };
}

async function post(rec) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Token': TOKEN },
    body: JSON.stringify(rec),
  });
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 160) };
}

async function main() {
  console.log('==================================================');
  console.log(' ⚠  模拟设备启动 —— 数据是假的，仅供联调，不可作为作业证据');
  console.log('  上报地址 : ' + ENDPOINT);
  console.log('  设备 ID  : ' + DEVICE_ID);
  console.log('  周期     : ' + INTERVAL + 'ms' + (COUNT ? '，共 ' + COUNT + ' 条' : '，持续发送'));
  console.log('  停止     : Ctrl+C');
  console.log('==================================================');

  // 先探活
  try {
    const h = await fetch(URL_BASE.replace(/\/$/, '') + '/api/health').then((r) => r.json());
    console.log('[PRE ] 服务端在线，已有记录 ' + h.records_in_memory + ' 条');
  } catch (e) {
    console.error('[PRE ] 连不上服务端：' + e.message);
    console.error('       先启动服务：cd server && node server.js');
    process.exit(1);
  }

  let ok = 0, fail = 0;
  const loop = async () => {
    const rec = buildRecord();
    try {
      const r = await post(rec);
      if (r.status === 200 || r.status === 201) {
        ok++;
        console.log(`[SIM ] #${rec.seq} accel=${rec.value} g  gyro=(${rec.axes.gyro.x},${rec.axes.gyro.y},${rec.axes.gyro.z}) dps  -> ${r.status}  (ok=${ok} fail=${fail})`);
      } else {
        fail++;
        console.error(`[SIM ] #${rec.seq} 被拒绝 ${r.status} ${r.text}`);
      }
    } catch (e) {
      fail++;
      console.error('[SIM ] 网络错误: ' + e.message);
    }
    if (COUNT && rec.seq >= COUNT) {
      console.log('--------------------------------------------------');
      console.log(` 模拟结束：成功 ${ok} 条，失败 ${fail} 条`);
      console.log(' 打开 http://<host>:8080/ 查看页面');
      console.log(' 别忘记：作业证据必须来自真实板子！');
      process.exit(fail > 0 ? 1 : 0);
    }
  };

  await loop();
  setInterval(loop, INTERVAL);
}

main();

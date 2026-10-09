#!/usr/bin/env node
/*
 * ============================================================================
 *  【页面自检】不启动浏览器，静态校验 web/index.html
 *
 *  检查项：
 *    1. inline script 语法是否合法
 *    2. 脚本里 $('xxx') 引用的每个 DOM id 是否真的存在（最常见的低级 bug）
 *    3. id 是否重复
 *    4. div 标签是否配对
 *    5. 是否确实引用了需要的接口
 *
 *  改完页面先跑这个，比开浏览器快得多：
 *      node tools/page_check.js
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'web', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');

let bad = 0;
const ok = (t) => console.log('  ✅ ' + t);
const no = (t) => { bad++; console.log('  ❌ ' + t); };

console.log('检查 ' + FILE + '\n');

// 1) 语法
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { no('没找到 inline <script>'); process.exit(1); }
const js = m[1];
try { new Function(js); ok('JS 语法合法（' + js.split('\n').length + ' 行）'); }
catch (e) { no('JS 语法错误: ' + e.message); }

// 2) id 引用
const used = [...new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((x) => x[1]))];
const defined = [...html.matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]);
const missing = used.filter((id) => !defined.includes(id));
if (missing.length) no('脚本引用了不存在的 id: ' + missing.join(', '));
else ok('全部 ' + used.length + ' 个 DOM id 都存在');

// 3) 重复 id
const dup = [...new Set(defined.filter((v, i) => defined.indexOf(v) !== i))];
if (dup.length) no('重复 id: ' + dup.join(', '));
else ok('无重复 id（共 ' + defined.length + ' 个）');

// 4) 标签配对
const o = (html.match(/<div\b/g) || []).length;
const c = (html.match(/<\/div>/g) || []).length;
if (o !== c) no('div 未配对: ' + o + ' 开 / ' + c + ' 闭');
else ok('div 配对正常（' + o + ' 组）');

// 5) 接口引用
const need = ['/api/devices', '/api/latest', '/api/history', '/api/export.csv', '/api/health'];
const miss = need.filter((p) => html.indexOf(p) < 0);
if (miss.length) no('页面没引用: ' + miss.join(', '));
else ok('页面引用了全部 ' + need.length + ' 个接口');

console.log('\n' + (bad ? '发现 ' + bad + ' 个问题' : '页面自检全部通过'));
process.exit(bad ? 1 : 0);

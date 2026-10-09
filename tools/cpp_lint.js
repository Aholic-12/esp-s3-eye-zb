/*
 * tools/cpp_lint.js —— 无编译器环境下的轻量 C++ 结构自检
 * 作用：不依赖 PlatformIO / g++，检查固件源码的括号与引号是否配平、
 *      每个 switch case 是否有出口，避免"显然编译不过"的低级错误。
 * 用法：node tools/cpp_lint.js [路径，默认 firmware/src/main.cpp]
 */
const fs = require('fs');
const path = require('path');

const file = process.argv[2] ||
  path.join(__dirname, '..', 'firmware', 'src', 'main.cpp');

if (!fs.existsSync(file)) {
  console.error('❌ 找不到文件: ' + file);
  process.exit(1);
}
const src = fs.readFileSync(file, 'utf8');

let i = 0, inStr = null, inLine = false, inBlock = false, esc = false, line = 1;
const stack = [], errs = [];
const close = { '(': ')', '{': '}', '[': ']' };

while (i < src.length) {
  const c = src[i], n = src[i + 1];
  if (c === '\n') { line++; inLine = false; }
  if (inLine) { i++; continue; }
  if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i += 2; continue; } i++; continue; }
  if (inStr) {
    if (esc) { esc = false; i++; continue; }
    if (c === '\\') { esc = true; i++; continue; }
    if (c === inStr) inStr = null;
    i++; continue;
  }
  if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
  if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
  if (c === '"' || c === "'") { inStr = c; i++; continue; }
  if ('({['.includes(c)) stack.push([c, line]);
  if (')}]'.includes(c)) {
    const t = stack.pop();
    if (!t) errs.push(`line ${line}: 多余的 ${c}`);
    else if (close[t[0]] !== c) errs.push(`line ${line}: ${c} 与 line ${t[1]} 的 ${t[0]} 不匹配`);
  }
  i++;
}
stack.forEach(t => errs.push(`line ${t[1]}: 未闭合的 ${t[0]}`));

// switch case 统计（每个 case 到下一个 case/default 之间应出现 break 或 return）
const caseRe = /case\s+([A-Za-z_][A-Za-z_0-9]*)\s*:/g;
let m, cases = 0, noBreak = [];
while ((m = caseRe.exec(src))) {
  cases++;
  const rest = src.slice(m.index + m[0].length);
  const next = rest.search(/\n\s*(case\s+[A-Za-z_][A-Za-z_0-9]*\s*:|default\s*:)/);
  const seg = next >= 0 ? rest.slice(0, next) : rest.slice(0, 400);
  // 空段 = 堆叠的 case 标签（如 case A: case B: {...}），是有意为之，不算缺 break
  if (seg.trim() === '') continue;
  if (!/\b(break|return)\b/.test(seg) && !/\bswitch\b/.test(seg)) {
    noBreak.push(`${m[1]} (line ${src.slice(0, m.index).split('\n').length})`);
  }
}

console.log('文件  : ' + file);
console.log('行数  : ' + src.split('\n').length);
console.log(errs.length ? '❌ 括号/引号问题:\n  ' + errs.join('\n  ') : '✅ 括号/引号全部配平');
console.log('case  : 共 ' + cases + ' 个');
if (noBreak.length) console.log('⚠️  疑似缺少 break/return 的 case: ' + noBreak.join(', '));
else console.log('✅ 每个 case 都有 break/return');
process.exit(errs.length ? 1 : 0);

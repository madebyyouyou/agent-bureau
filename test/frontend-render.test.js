// 前端渲染纯函数测试：mdHtml（气泡 markdown）与 clientChrome（老账本噪音兜底）
// app.js 是浏览器 IIFE 不能 require——按锚点从源码切出这几段纯函数执行。
// 锚点变了测试会大声失败（而不是静默漏测），重构时同步改这里。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'plugin', 'public', 'app.js'), 'utf8');

function slice(startMark, endMark, endOffset) {
  const a = src.indexOf(startMark);
  assert.notEqual(a, -1, '找不到源码锚点：' + startMark);
  const b = src.indexOf(endMark, a);
  assert.notEqual(b, -1, '找不到源码结尾锚点：' + endMark);
  return src.slice(a, b + endOffset);
}

const escLine = slice('const esc = ', ';\n', 1);
const chromeBlock = slice('function clientChrome(t) {', '\n  }', 4);
const mdBlock = slice('const CJK = ', "return out.join('');", 0) + src.slice(src.indexOf("return out.join('');"), src.indexOf('\n  }', src.indexOf("return out.join('');")) + 4);

const { esc, clientChrome, mdHtml } = new Function(
  escLine + '\n' + chromeBlock + '\n' + mdBlock + '\nreturn { esc, clientChrome, mdHtml };'
)();

test('clientChrome：只吞纯符号，带文字的消息绝不吞', () => {
  assert.equal(clientChrome('────────\n⠋ ⠙ ⣿\n> '), true, '纯框线/转轮=噪音');
  assert.equal(clientChrome('▀▄█▌▐■□▓▒░'), true, '色块=噪音');
  assert.equal(clientChrome(''), true, '空串=噪音');
  assert.equal(clientChrome('我查了 keyboard shortcuts 的实现'), false, '含 shortcuts 的正文不能吞（v0.5.9 修的隐患）');
  assert.equal(clientChrome('effort 一词出现也不吞'), false);
  assert.equal(clientChrome('────\n正文\n────'), false, '混合内容保留');
});

test('mdHtml：markdown 极简渲染', async t => {
  await t.test('并段：单换行并回同段，CJK 相邻不加空格、中英边界加空格', () => {
    assert.equal(mdHtml('这句被终端\n硬切成两行'), '<p>这句被终端硬切成两行</p>');
    assert.equal(mdHtml('ShopsScene\n是旧版'), '<p>ShopsScene 是旧版</p>');
    assert.equal(mdHtml('第一段\n\n第二段'), '<p>第一段</p><p>第二段</p>');
  });
  await t.test('宽松有序列表：空行分隔的编号项并成一张表，编号不重头', () => {
    assert.equal(mdHtml('1. 甲\n\n2. 乙'), '<ol><li>甲</li><li>乙</li></ol>');
    assert.equal(mdHtml('3. 从三开始'), '<ol start="3"><li>从三开始</li></ol>');
    assert.equal(mdHtml('1. 项目一\n   缩进续行并回本项'), '<ol><li>项目一缩进续行并回本项</li></ol>');
  });
  await t.test('列表类型切换与无序列表', () => {
    assert.equal(mdHtml('- 圆点一\n- 圆点二'), '<ul><li>圆点一</li><li>圆点二</li></ul>');
    assert.equal(mdHtml('1. 数字\n\n- 圆点'), '<ol><li>数字</li></ol><ul><li>圆点</li></ul>');
  });
  await t.test('粗体 / 行内代码 / 标题', () => {
    assert.equal(mdHtml('**重点** 与 `code` 同段'), '<p><b>重点</b> 与 <code>code</code> 同段</p>');
    assert.equal(mdHtml('## 小标题\n正文'), '<p class="mdh">小标题</p><p>正文</p>');
  });
  await t.test('围栏代码原样保留（不并段、转义）', () => {
    assert.equal(mdHtml('```js\nconst a = 1;\nif (a < 2) {}\n```'), '<pre>const a = 1;\nif (a &lt; 2) {}</pre>');
  });
  await t.test('HTML 一律转义，信封残片当文字显示', () => {
    assert.equal(mdHtml('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    assert.match(mdHtml('残留 <pass /> 标记'), /&lt;pass \/&gt;/);
  });
});

test('esc：与服务端约定的三件套转义', () => {
  assert.equal(esc('<a> & "b"'), '&lt;a&gt; &amp; "b"');
});

test('index.html：app.js 引用不许挂查询串（上游静态服务器带 ? 必 404，页面会瘫在"正在连接"）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'plugin', 'public', 'index.html'), 'utf8');
  assert.match(html, /<script src="app\.js"><\/script>/);
  assert.ok(!/app\.js\?/.test(html), 'app.js 不能带查询串');
});

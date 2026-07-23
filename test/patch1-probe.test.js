const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { patch1Probe } = require('../app/scripts/patch-clideck.js');
const vendor = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'clideck', 'handlers.js'), 'utf8');
const probeBlock = src => src.match(/function getInstalledVersion\(bin\) \{[\s\S]*?\n\}/)?.[0] || '';

test('Windows 版本探测不使用 shell:true + args', () => {
  const out = patch1Probe(vendor);

  assert.notEqual(out, undefined, 'getInstalledVersion 锚点漂移');
  assert.notEqual(out, null);
  assert.match(out, /kfq-win-probe@v2/);
  assert.match(out, /execSync\(`\$\{bin\} \$\{flag\}`/);
  assert.doesNotMatch(probeBlock(out), /shell:\s*process\.platform === 'win32'/);
});

test('旧版 shell:true 探测补丁会升级，升级后保持幂等', () => {
  const old = vendor.replace(
    /{ encoding: 'utf8', stdio: \['ignore', 'pipe', 'pipe'\] }/g,
    "/*kfq-win-probe*/{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' }",
  );
  const upgraded = patch1Probe(old);

  assert.match(upgraded, /kfq-win-probe@v2/);
  assert.doesNotMatch(probeBlock(upgraded), /shell:\s*process\.platform === 'win32'/);
  assert.equal(patch1Probe(upgraded), null);
});

test('上游函数结构漂移时拒绝模糊覆盖', () => {
  const changed = vendor.replace(
    probeBlock(vendor),
    "function getInstalledVersion(bin) {\n  return bin ? 'changed' : '';\n}",
  );

  assert.equal(patch1Probe(changed), undefined);
});

test('补丁后的探测函数可在当前 Windows 环境读取 npm.cmd 版本', () => {
  const block = probeBlock(patch1Probe(vendor));
  const getInstalledVersion = new Function(
    'execFileSync',
    'parseVersion',
    'require',
    `${block}; return getInstalledVersion;`,
  )(
    require('node:child_process').execFileSync,
    text => String(text).match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || '',
    require,
  );

  assert.match(getInstalledVersion('npm'), /^\d+\.\d+\.\d+$/);
});

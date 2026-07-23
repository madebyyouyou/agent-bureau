const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('启动脚本从自身位置解析仓库根目录', () => {
  const script = fs.readFileSync(path.join(root, 'app', 'scripts', 'start.ps1'), 'utf8');

  assert.doesNotMatch(script, /\$repo\s*=\s*["'][A-Za-z]:\\/);
  assert.match(script, /\$PSScriptRoot/);
  assert.match(script, /Resolve-Path/);
});

test('插件清单使用公开作者身份和可移植默认值', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app', 'plugin', 'clideck-plugin.json'), 'utf8'));
  const backupDir = manifest.settings.find(item => item.key === 'backupDir');

  assert.equal(manifest.author, 'YouYou');
  assert.ok(backupDir, '缺少 backupDir 设置');
  assert.equal(backupDir.default, '');
});

test('服务端不会在未配置时写入固定盘符的备份目录', () => {
  const server = fs.readFileSync(path.join(root, 'app', 'plugin', 'index.js'), 'utf8');

  assert.doesNotMatch(server, /[A-Za-z]:\\\\开发部群备份/);
  assert.match(server, /\? '' : String\(v\)\.trim\(\)/);
});

test('package-lock 与 package.json 的根包声明一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const rootPackage = lock.packages[''];

  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(rootPackage.name, pkg.name);
  assert.equal(rootPackage.version, pkg.version);
  assert.deepEqual(rootPackage.dependencies || {}, pkg.dependencies || {});
});

test('公开安装说明固定到补丁回归所验证的 CliDeck 版本', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const auditSummary = fs.readFileSync(path.join(root, 'docs', 'technical-audit-summary.md'), 'utf8');

  assert.match(readme, /npm install -g clideck@1\.31\.24/);
  assert.doesNotMatch(readme, /版本守卫|升级自动补/);
  assert.doesNotMatch(auditSummary, /版本守卫|版本探测/);
});

test('源码与锚点测试固定使用 LF，避免 Windows 检出破坏补丁匹配', () => {
  const attrs = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
  const critical = [
    path.join(root, 'app', 'plugin', 'kfq-spawn.js'),
    path.join(root, 'app', 'scripts', 'patch-clideck.js'),
    path.join(root, 'test', 'patch7-spawn.test.js'),
  ];

  assert.match(attrs, /^\* text=auto eol=lf$/m);
  for (const file of critical) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\r\n/, `${path.relative(root, file)} 不是 LF`);
  }
});

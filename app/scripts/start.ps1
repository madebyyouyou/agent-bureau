# 开发部群 启动器：补丁 → 同步插件 → 挂代理 → 启动/复用工作台 → 打开群聊界面
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dst = "$env:USERPROFILE\.clideck\plugins\kaifabuqun"
robocopy "$repo\app\plugin" $dst /MIR /NFL /NDL /NJH /NJS | Out-Null

# 修 CliDeck 的 Windows 版本探测（幂等；clideck 升级后自动再补）——否则 Codex/Claude 遥测会被误报关闭
node "$repo\app\scripts\patch-clideck.js"

# 部分命令行工具只读取代理环境变量；这里按 Windows 系统代理设置转发。
# 系统代理变更后需重启本服务，新的 CLI 进程才会继承更新后的环境变量。
try {
  $inet = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
  if ($inet.ProxyEnable -eq 1 -and $inet.ProxyServer) {
    $ps = $inet.ProxyServer
    if ($ps -match 'https?=([^;]+)') { $ps = $Matches[1] }   # 兼容 "http=...;https=..." 写法
    $proxyUrl = $ps; if ($ps -notmatch '^\w+://') { $proxyUrl = "http://$ps" }
    $env:HTTP_PROXY = $proxyUrl; $env:HTTPS_PROXY = $proxyUrl
    $env:NO_PROXY = 'localhost,127.0.0.1,::1'
    Write-Host "已按系统代理给各 AI 工位挂上代理：$proxyUrl"
  } else {
    Write-Host "未检测到 Windows 系统代理；如所用 CLI 的上游服务需要代理，请先配置代理再重启本服务。"
  }
} catch {}

$url = "http://127.0.0.1:4000/plugins/kaifabuqun/index.html"
$lockPath = "$env:USERPROFILE\.clideck\server.lock"
$running = $false
if (Test-Path $lockPath) {
  # "在运行"以端口真能连上为准——进程号会被 Windows 回收复用，服务器窗口异常关闭留下的残锁
  # 仅检查可能被复用的进程号会误判，因此还需验证锁文件记录的端口确实可连接。
  try {
    $lock = Get-Content $lockPath -Raw | ConvertFrom-Json
    $port = 4000; if ($lock.port) { $port = [int]$lock.port }
    $c = New-Object Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $port); if ($c.Connected) { $running = $true; $url = $lock.url.TrimEnd('/') + "/plugins/kaifabuqun/index.html" } } catch {}
    $c.Close()
  } catch {}
  if (-not $running) {
    Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
    Write-Host "上次窗口没走正常关闭，留了个残锁——已清掉，正常启动。"
  }
}

if ($running) {
  Write-Host "工作台已在运行，直接打开群聊界面。"
  Write-Host "（注意：如果刚更新过插件代码，要先关掉旧的服务器窗口，再重新运行 app\scripts\start.ps1）"
  Start-Process $url
} else {
  Write-Host "正在启动开发部群工作台……几秒后自动打开浏览器。"
  Write-Host "这个窗口是服务器本体，使用期间请勿关闭；结束使用时直接关闭窗口即可。"
  # 轮询到服务器真正就绪（端口可连）再开浏览器，最多等 3 分钟——防止敲门太早吃闭门羹
  $null = Start-Job -ScriptBlock { param($u)
    for ($i = 0; $i -lt 90; $i++) {
      Start-Sleep -Seconds 2
      try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 4000); if ($c.Connected) { $c.Close(); Start-Process $u; return } } catch {}
    }
  } -ArgumentList $url
  # 用管道喂空输入：CliDeck 检测到非交互式就会跳过"Update now? [Y/n]"自更新询问，
  # 否则那个提问会卡住启动（服务器迟迟不监听，浏览器打开就是拒绝连接）。
  '' | clideck
}

$ErrorActionPreference = 'Stop'

$root = Join-Path $env:LOCALAPPDATA 'SubX'
if (Test-Path $root) { throw "SubX is already installed at $root. Use a clean test account." }

$setup = @(Get-ChildItem out/make -Recurse -Filter '*Setup.exe' -File)
if ($setup.Count -ne 1) { throw "Expected one Setup.exe, found $($setup.Count)" }

try {
    $install = Start-Process -FilePath $setup[0].FullName -ArgumentList '--silent' -PassThru -Wait
    if ($install.ExitCode -ne 0) { throw "Setup exited with $($install.ExitCode)" }

    # Squirrel Setup 会先退出，再由 Update.exe 完成落盘；等待可执行文件出现。
    $app = $null
    for ($attempt = 0; $attempt -lt 60 -and !$app; $attempt++) {
        $candidate = Get-ChildItem $root -Recurse -Filter 'SubX.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($candidate) { $app = $candidate.FullName } else { Start-Sleep -Milliseconds 500 }
    }
    if (!$app) {
        Get-ChildItem $root -Force -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_.FullName }
        throw "SubX executable missing under $root"
    }
    foreach ($tool in @('ffmpeg.exe', 'ffprobe.exe')) {
        $bundled = Get-ChildItem $root -Recurse -Filter $tool -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if (!$bundled) { throw "Bundled $tool missing under $root" }
    }

    $profile = Join-Path $env:TEMP ("subx-installed-" + [guid]::NewGuid().ToString('N'))
    # CI 会话里安装目录的启动器可能立即返回 0；启动检查只作为提示，不阻塞安装器验收。
    Get-Process SubX -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 500
    try {
        $process = Start-Process -FilePath $app -ArgumentList "--user-data-dir=$profile" -PassThru
        Start-Sleep -Seconds 6
        if ($process.HasExited) { Write-Warning "Installed SubX exited immediately with code $($process.ExitCode)" }
        else { Stop-Process -Id $process.Id -Force }
    } catch {
        Write-Warning "Installed SubX launch check failed: $_"
    }
    Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue

    # 验证随包 FFmpeg 能独立完成 H.264 编码。
    $ffmpeg = Get-ChildItem $root -Recurse -Filter 'ffmpeg.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$ffmpeg) { throw 'Bundled ffmpeg.exe missing' }
    $encoded = Join-Path $env:TEMP ("subx-ffmpeg-" + [guid]::NewGuid().ToString('N') + '.mp4')
    & $ffmpeg.FullName -hide_banner -loglevel error -f lavfi -i 'color=c=blue:s=320x240:d=1' -c:v libx264 -y $encoded
    if ($LASTEXITCODE -ne 0 -or !(Test-Path $encoded -PathType Leaf)) { throw 'Bundled FFmpeg failed to encode H.264' }
    Remove-Item $encoded -Force

    $association = Get-ItemProperty 'HKCU:\Software\Classes\.subx' -ErrorAction Stop
    if ($association.'(default)' -ne 'SubX.Project') { throw "Unexpected .subx association: $($association.'(default)')" }
    $openCommand = (Get-ItemProperty 'HKCU:\Software\Classes\SubX.Project\shell\open\command' -ErrorAction Stop).'(default)'
    if ($openCommand -notmatch 'SubX\.exe') { throw "Unexpected .subx open command: $openCommand" }
} finally {
    $updater = Join-Path $root 'Update.exe'
    if (Test-Path $updater -PathType Leaf) {
        $uninstall = Start-Process -FilePath $updater -ArgumentList '--uninstall --silent' -PassThru -Wait
        if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with $($uninstall.ExitCode)" }
        if ($app -and (Test-Path $app)) { throw 'SubX executable remains after uninstall' }
        if (Test-Path 'HKCU:\Software\Classes\.subx') { throw '.subx association remains after uninstall' }
    }
}

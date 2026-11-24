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

    node scripts/desktop-smoke/installed-lite.mjs $app
    if ($LASTEXITCODE -ne 0) { throw "Installed SubX smoke test failed" }

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

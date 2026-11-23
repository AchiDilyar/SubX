$ErrorActionPreference = 'Stop'

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$root = Join-Path $env:LOCALAPPDATA 'SubX'
if (Test-Path $root) { throw "SubX is already installed at $root. Use a clean test account." }

$setup = @(Get-ChildItem out/make -Recurse -Filter '*Setup.exe' -File)
if ($setup.Count -ne 1) { throw "Expected one Setup.exe, found $($setup.Count)" }

try {
    $install = Start-Process -FilePath $setup[0].FullName -ArgumentList '--silent' -PassThru -Wait
    if ($install.ExitCode -ne 0) { throw "Setup exited with $($install.ExitCode)" }

    $app = Join-Path $root "app-$version/SubX.exe"
    if (!(Test-Path $app -PathType Leaf)) { throw "SubX executable missing at $app" }
    foreach ($tool in @('ffmpeg.exe', 'ffprobe.exe')) {
        $bundled = Join-Path $root "app-$version/resources/$tool"
        if (!(Test-Path $bundled -PathType Leaf)) { throw "Bundled $tool missing at $bundled" }
    }

    $association = Get-ItemProperty 'HKCU:\Software\Classes\.subx' -ErrorAction Stop
    if ($association.'(default)' -ne 'SubX.Project') { throw "Unexpected .subx association: $($association.'(default)')" }
    $openCommand = (Get-ItemProperty 'HKCU:\Software\Classes\SubX.Project\shell\open\command' -ErrorAction Stop).'(default)'
    if ($openCommand -notmatch 'SubX\.exe') { throw "Unexpected .subx open command: $openCommand" }

    node scripts/desktop-smoke/installed.mjs $app
    if ($LASTEXITCODE -ne 0) { throw "Installed SubX smoke test failed" }
} finally {
    $updater = Join-Path $root 'Update.exe'
    if (Test-Path $updater -PathType Leaf) {
        $uninstall = Start-Process -FilePath $updater -ArgumentList '--uninstall --silent' -PassThru -Wait
        if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with $($uninstall.ExitCode)" }
        if (Test-Path (Join-Path $root "app-$version/SubX.exe")) { throw 'SubX executable remains after uninstall' }
        if (Test-Path 'HKCU:\Software\Classes\.subx') { throw '.subx association remains after uninstall' }
    }
}

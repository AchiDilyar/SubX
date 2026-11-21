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

    node scripts/desktop-smoke/installed.mjs $app
    if ($LASTEXITCODE -ne 0) { throw "Installed SubX smoke test failed" }
} finally {
    $updater = Join-Path $root 'Update.exe'
    if (Test-Path $updater -PathType Leaf) {
        $uninstall = Start-Process -FilePath $updater -ArgumentList '--uninstall --silent' -PassThru -Wait
        if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with $($uninstall.ExitCode)" }
        if (Test-Path (Join-Path $root "app-$version/SubX.exe")) { throw 'SubX executable remains after uninstall' }
    }
}

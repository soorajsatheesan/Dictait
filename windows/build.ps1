$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
$version = (Get-Content desktop/package.json -Raw | ConvertFrom-Json).version
python -m pip install -r windows/requirements.txt "pyinstaller>=6.16,<7"
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed" }
python -m PyInstaller --noconfirm --clean --onedir --windowed --name Dictait `
    --paths $repo --distpath dist/windows --workpath dist/windows-work --specpath dist `
    --collect-all faster_whisper --collect-all ctranslate2 --collect-all tokenizers `
    --collect-all onnxruntime --collect-all sounddevice --collect-all _sounddevice_data `
    --copy-metadata faster-whisper windows/app.py
if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed" }
Copy-Item LICENSE dist/windows/Dictait/LICENSE.txt
Copy-Item windows/README.md dist/windows/Dictait/README.txt
$smoke = Start-Process -FilePath "$repo/dist/windows/Dictait/Dictait.exe" -ArgumentList "--self-test" -Wait -PassThru
if ($smoke.ExitCode -ne 0) { throw "Packaged app failed its import smoke check" }
New-Item -ItemType Directory -Force dist/release | Out-Null
Compress-Archive -Path dist/windows/Dictait -DestinationPath "dist/release/Dictait-$version-windows-x64.zip" -Force

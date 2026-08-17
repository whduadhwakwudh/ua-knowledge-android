$ErrorActionPreference = 'Stop'

# JAVA_HOME and ANDROID_HOME are machine-local paths — they differ per
# developer machine and CI runner. Adjust both (and the sealed SDK path in
# android/local.properties below) before running on a new machine.
$env:JAVA_HOME = 'D:\Java\jdk-21.0.12+8'
$env:ANDROID_HOME = 'D:\Android\Sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

Set-Location $PSScriptRoot

# Use npm ci (not npm install) for the fresh install so repeat builds get a
# deterministic dependency tree from package-lock.json instead of drifting.
if (-not (Test-Path 'node_modules')) {
    npm ci
}

npm run build:web
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npx cap sync android
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

'sdk.dir=D:\\Android\\Sdk' | Set-Content -Path 'android\local.properties' -Encoding ASCII
& '.\android\gradlew.bat' -p android assembleDebug
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$source = 'android\app\build\outputs\apk\debug\app-debug.apk'
$dist = 'dist'
$target = Join-Path $dist 'UA-debug.apk'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Copy-Item $source $target -Force
Write-Host "APK: $(Resolve-Path $target)"

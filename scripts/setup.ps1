<#
  Downloads the media binaries and models the plugin needs.

  Nothing here is committed to the repository: ffmpeg alone is ~100 MB per
  executable and the speech model is ~514 MB, both beyond GitHub's per-file
  limit. Run this once after cloning, then restart DSH.

  usage:
    pwsh -File scripts/setup.ps1                 # everything, official hosts
    pwsh -File scripts/setup.ps1 -Mirror         # route GitHub through a proxy
    pwsh -File scripts/setup.ps1 -SkipModels     # binaries only
#>
param(
  [switch]$Mirror,
  [switch]$SkipModels,
  [string]$FfmpegUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  [string]$WhisperUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
  [string]$SherpaUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.0/sherpa-onnx-v2.0.0-win-x64-shared-MD-MinSizeRel-no-tts.tar.bz2',
  [string]$SegmentationUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
  [string]$EmbeddingUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
  [string]$WhisperModelUrl = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root 'tools\win32-x64'
$models = Join-Path $root 'models'
$work = Join-Path $root '.downloads'
New-Item -ItemType Directory -Force -Path $tools, $models, $work | Out-Null

function Resolve-Url([string]$url) {
  if ($Mirror -and $url -match '^https://github\.com/') { return 'https://gh-proxy.com/' + $url }
  return $url
}

function Get-Archive([string]$url, [string]$out, [int]$minMb) {
  if ((Test-Path $out) -and ((Get-Item $out).Length / 1MB) -ge $minMb) {
    Write-Host "  cached  $(Split-Path $out -Leaf)"
    return
  }
  $target = Resolve-Url $url
  Write-Host "  fetch   $target"
  Invoke-WebRequest -Uri $target -OutFile $out -UseBasicParsing -TimeoutSec 3600
  if (((Get-Item $out).Length / 1MB) -lt $minMb) { throw "$out is smaller than expected" }
}

# 1. ffmpeg + ffprobe (smaller "essentials" build: ~100 MB each instead of 161 MB)
Write-Host 'ffmpeg'
$ffZip = Join-Path $work 'ffmpeg-essentials.zip'
Get-Archive $FfmpegUrl $ffZip 60
Expand-Archive -Path $ffZip -DestinationPath (Join-Path $work 'ffmpeg') -Force
foreach ($name in @('ffmpeg.exe', 'ffprobe.exe')) {
  $found = Get-ChildItem (Join-Path $work 'ffmpeg') -Recurse -Filter $name | Select-Object -First 1
  Copy-Item $found.FullName (Join-Path $tools $name) -Force
}

# 2. whisper.cpp CLI (recognition)
Write-Host 'whisper.cpp'
$wZip = Join-Path $work 'whisper.zip'
Get-Archive $WhisperUrl $wZip 6
Expand-Archive -Path $wZip -DestinationPath (Join-Path $work 'whisper') -Force
foreach ($name in @('whisper-cli.exe', 'main.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll', 'SDL2.dll')) {
  $found = Get-ChildItem (Join-Path $work 'whisper') -Recurse -Filter $name | Select-Object -First 1
  if ($found) { Copy-Item $found.FullName (Join-Path $tools $name) -Force }
}
Get-ChildItem (Join-Path $work 'whisper') -Recurse -Filter 'ggml-cpu-*.dll' |
  ForEach-Object { Copy-Item $_.FullName $tools -Force }

# 3. sherpa-onnx (speaker diarization)
Write-Host 'sherpa-onnx'
$sTar = Join-Path $work 'sherpa.tar.bz2'
Get-Archive $SherpaUrl $sTar 10
$sDir = Join-Path $work 'sherpa'
New-Item -ItemType Directory -Force -Path $sDir | Out-Null
tar -xjf $sTar -C $sDir
foreach ($name in @('sherpa-onnx-offline-speaker-diarization.exe', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'sherpa-onnx-c-api.dll', 'sherpa-onnx-cxx-api.dll')) {
  $found = Get-ChildItem $sDir -Recurse -Filter $name | Select-Object -First 1
  if ($found) { Copy-Item $found.FullName (Join-Path $tools $name) -Force }
}

if (-not $SkipModels) {
  # 4. speech model (multilingual, 99 languages)
  Write-Host 'speech model (~514 MB)'
  $modelPath = Join-Path $models 'ggml-medium-q5_0.bin'
  if (-not ((Test-Path $modelPath) -and ((Get-Item $modelPath).Length / 1MB) -ge 400)) {
    Invoke-WebRequest -Uri $WhisperModelUrl -OutFile $modelPath -UseBasicParsing -TimeoutSec 3600
  } else { Write-Host '  cached  ggml-medium-q5_0.bin' }

  # 5. diarization models
  Write-Host 'diarization models'
  $segTar = Join-Path $work 'segmentation.tar.bz2'
  Get-Archive $SegmentationUrl $segTar 3
  $segDir = Join-Path $work 'segmentation'
  New-Item -ItemType Directory -Force -Path $segDir | Out-Null
  tar -xjf $segTar -C $segDir
  $segModel = Get-ChildItem $segDir -Recurse -Filter 'model.onnx' | Select-Object -First 1
  Copy-Item $segModel.FullName (Join-Path $models 'segmentation.onnx') -Force

  $emb = Join-Path $models '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'
  if (-not ((Test-Path $emb) -and ((Get-Item $emb).Length / 1MB) -ge 20)) {
    Invoke-WebRequest -Uri (Resolve-Url $EmbeddingUrl) -OutFile $emb -UseBasicParsing -TimeoutSec 1800
  } else { Write-Host '  cached  3dspeaker campplus' }
}

Write-Host ''
Write-Host 'done. Restart DSH so the plugin picks up the binaries, then open'
Write-Host 'Settings -> Video Reader and use "Capture a preview" to confirm.'

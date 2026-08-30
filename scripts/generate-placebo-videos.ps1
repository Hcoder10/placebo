param(
  [string]$ManifestPath = (Join-Path $PSScriptRoot '..\console\assets\seedance-prompts.json')
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($env:OPENROUTER_API_KEY)) {
  throw 'Set OPENROUTER_API_KEY in the current process before running this script.'
}

$resolvedManifest = (Resolve-Path -LiteralPath $ManifestPath).Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifest = Get-Content -LiteralPath $resolvedManifest -Raw | ConvertFrom-Json
$apiRoot = 'https://openrouter.ai/api/v1/videos'
$headers = @{
  Authorization = "Bearer $($env:OPENROUTER_API_KEY)"
  'Content-Type' = 'application/json'
  'HTTP-Referer' = 'http://localhost:3333'
  'X-Title' = 'Placebo Causal Console'
}

function Resolve-RepoPath([string]$relativePath) {
  return [System.IO.Path]::GetFullPath((Join-Path $repoRoot $relativePath))
}

function New-FrameImage([string]$relativePath, [string]$frameType) {
  $absolutePath = Resolve-RepoPath $relativePath
  $extension = [System.IO.Path]::GetExtension($absolutePath).TrimStart('.').ToLowerInvariant()
  $mime = if ($extension -eq 'jpg' -or $extension -eq 'jpeg') { 'image/jpeg' } else { 'image/png' }
  $encoded = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($absolutePath))
  return @{
    type = 'image_url'
    image_url = @{ url = "data:$mime;base64,$encoded" }
    frame_type = $frameType
  }
}

$jobs = @()

foreach ($clip in $manifest.clips) {
  $outputPath = Resolve-RepoPath $clip.output
  $outputDirectory = Split-Path -Parent $outputPath
  New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

  $frames = @((New-FrameImage $clip.firstFrame 'first_frame'))
  if ($clip.lastFrame) {
    $frames += New-FrameImage $clip.lastFrame 'last_frame'
  }

  $body = @{
    model = $manifest.model
    prompt = $clip.prompt
    duration = [int]$manifest.duration
    resolution = $manifest.resolution
    aspect_ratio = $manifest.aspectRatio
    generate_audio = $false
    frame_images = $frames
  } | ConvertTo-Json -Depth 8 -Compress

  $response = Invoke-RestMethod -Method Post -Uri $apiRoot -Headers $headers -Body $body
  $videoId = if ($response.id) { $response.id } else { $response.generation_id }
  if (-not $videoId) {
    throw "Seedance did not return a video id for $($clip.name)."
  }

  $pollingUrl = if ($response.polling_url) { $response.polling_url } else { "$apiRoot/$videoId" }
  $jobs += [pscustomobject]@{
    Name = $clip.name
    Id = $videoId
    PollingUrl = $pollingUrl
    OutputPath = $outputPath
    Status = if ($response.status) { $response.status } else { 'queued' }
    Downloaded = $false
  }
  Write-Host "Submitted $($clip.name) [$videoId]"
}

$startedAt = Get-Date
$timeout = [TimeSpan]::FromMinutes(30)

while (($jobs | Where-Object { -not $_.Downloaded -and $_.Status -notin @('failed', 'cancelled', 'expired') }).Count -gt 0) {
  if (((Get-Date) - $startedAt) -gt $timeout) {
    throw 'Timed out waiting for Seedance video jobs.'
  }

  foreach ($job in $jobs) {
    if ($job.Downloaded -or $job.Status -in @('failed', 'cancelled', 'expired')) {
      continue
    }

    $result = Invoke-RestMethod -Method Get -Uri $job.PollingUrl -Headers $headers
    $newStatus = if ($result.status) { $result.status } else { $job.Status }
    if ($newStatus -ne $job.Status) {
      $job.Status = $newStatus
      Write-Host "$($job.Name): $newStatus"
    }

    if ($newStatus -eq 'completed') {
      Invoke-WebRequest -Method Get -Uri "$apiRoot/$($job.Id)/content" -Headers $headers -OutFile $job.OutputPath
      $job.Downloaded = $true
      Write-Host "Saved $($job.Name) -> $($job.OutputPath)"
    }
  }

  if (($jobs | Where-Object { -not $_.Downloaded -and $_.Status -notin @('failed', 'cancelled', 'expired') }).Count -gt 0) {
    Start-Sleep -Seconds 8
  }
}

$failures = @($jobs | Where-Object { $_.Status -in @('failed', 'cancelled', 'expired') })
if ($failures.Count -gt 0) {
  $names = ($failures | ForEach-Object { "$($_.Name) [$($_.Status)]" }) -join ', '
  throw "Seedance jobs did not complete: $names"
}

Write-Host "Completed $($jobs.Count) Seedance clips."

# Build (if needed) and run FinAlly. Pass -Build to force a rebuild.
param([switch]$Build)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$Image = "finally"
$Container = "finally"
$Url = "http://localhost:8000"

docker image inspect $Image *> $null
if ($Build -or $LASTEXITCODE -ne 0) {
    docker build -t $Image .
    if ($LASTEXITCODE -ne 0) { throw "docker build failed" }
}

docker rm -f $Container *> $null
$envArgs = @()
if (Test-Path ".env") { $envArgs = @("--env-file", ".env") }
docker run -d --name $Container -p 8000:8000 -v finally-data:/app/db @envArgs $Image | Out-Null
if ($LASTEXITCODE -ne 0) { throw "docker run failed" }

Write-Host "FinAlly is running at $Url"
Start-Process $Url

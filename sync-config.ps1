# CloudBox — sync runtime config from .env (single source of truth).
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\sync-config.ps1
# Reads:  .env  (SUPABASE_URL, SUPABASE_ANON_KEY)
# Writes: js/supabase-config.js  (gitignored — never committed to git)
#
# The static frontend cannot read .env at runtime (no build step), so this
# script copies the keys into the gitignored runtime config the app loads.
# Run it once after creating/editing .env, and again before `npx serve .`.

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $root ".env"
$outFile = Join-Path $root "js\supabase-config.js"

if (-not (Test-Path -LiteralPath $envFile)) {
  Write-Error ".env not found. Copy .env.example to .env and fill in your keys first."
  exit 1
}

$map = @{}
Get-Content -LiteralPath $envFile | ForEach-Object {
  if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
    $map[$matches[1].Trim()] = $matches[2].Trim()
  }
}

$url = $map["SUPABASE_URL"]
$key = $map["SUPABASE_ANON_KEY"]

if (-not $url -or $url -match "YOUR-PROJECT" -or -not $url.StartsWith("https://")) {
  Write-Error "SUPABASE_URL missing or still a placeholder in .env."
  exit 1
}
if (-not $key -or $key -match "YOUR-ANON") {
  Write-Error "SUPABASE_ANON_KEY missing or still a placeholder in .env."
  exit 1
}

# Minimal JS-string escaping for the two values.
$urlEsc = $url -replace '\\', '\\' -replace '"', '\"'
$keyEsc = $key -replace '\\', '\\' -replace '"', '\"'

$js = "window.CLOUDBOX_CONFIG = {`n  SUPABASE_URL: `"$urlEsc`",`n  SUPABASE_ANON_KEY: `"$keyEsc`"`n};`n"
Set-Content -LiteralPath $outFile -Value $js -NoNewline -Encoding UTF8

Write-Output "OK: js/supabase-config.js regenerated from .env (gitignored, safe from git)."

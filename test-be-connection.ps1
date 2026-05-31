# Smoke test BE konektivity z gateway hostu
# =========================================
#
# Použití:
#   $env:BE_BASE_URL = "https://tvuj-server.cloud"
#   $env:BE_API_KEY  = "7c41..."
#   .\test-be-connection.ps1
#
# Vyzkouší tři auth metody (Bearer, X-API-Key, query param) na /api/admin/users,
# vypíše, která prošla. Tu pak nastav jako BE_AUTH_MODE v gateway env.

param(
    [string]$BaseUrl = $env:BE_BASE_URL,
    [string]$ApiKey  = $env:BE_API_KEY
)

if (-not $BaseUrl) { Write-Error "Set BE_BASE_URL env var or pass -BaseUrl"; exit 1 }
if (-not $ApiKey)  { Write-Error "Set BE_API_KEY env var or pass -ApiKey";  exit 1 }

$endpoint = "$BaseUrl/api/admin/users?page=1&limit=1"
Write-Host "Target: $endpoint" -ForegroundColor Cyan
Write-Host "Token:  $($ApiKey.Substring(0,8))..." -ForegroundColor DarkGray
Write-Host ""

function Test-Auth {
    param([string]$Name, [hashtable]$Headers, [string]$Url)
    Write-Host "[$Name] " -NoNewline
    try {
        $response = Invoke-WebRequest -Uri $Url -Headers $Headers -UseBasicParsing -ErrorAction Stop
        $body = $response.Content | ConvertFrom-Json
        Write-Host "OK ($($response.StatusCode))" -ForegroundColor Green
        Write-Host "  -> response: data=$($body.data.Count) items, meta.total=$($body.meta.total)" -ForegroundColor DarkGray
        return $true
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        $msg = $_.Exception.Message
        if ($code) {
            Write-Host "FAIL ($code)" -ForegroundColor Red
            try {
                $errBody = $_.ErrorDetails.Message | ConvertFrom-Json -ErrorAction SilentlyContinue
                if ($errBody) { Write-Host "  -> $($errBody.error)" -ForegroundColor DarkRed }
            } catch {}
        } else {
            Write-Host "FAIL (network: $msg)" -ForegroundColor Red
        }
        return $false
    }
}

$results = @{}
$results.bearer  = Test-Auth "Bearer       " @{ "Authorization" = "Bearer $ApiKey" }       $endpoint
$results.xapikey = Test-Auth "X-API-Key    " @{ "X-API-Key"     = $ApiKey }                $endpoint
$results.query   = Test-Auth "?apiKey=...  " @{}                                            "$endpoint&apiKey=$ApiKey"

Write-Host ""
Write-Host "=== Výsledky ===" -ForegroundColor Cyan
$winner = $null
foreach ($mode in @('bearer','xapikey','query')) {
    if ($results[$mode]) {
        if (-not $winner) { $winner = $mode }
        Write-Host "  $mode -> ANO" -ForegroundColor Green
    } else {
        Write-Host "  $mode -> ne" -ForegroundColor DarkGray
    }
}

if ($winner) {
    Write-Host ""
    Write-Host "Nastav v gateway:" -ForegroundColor Yellow
    Write-Host "  BE_AUTH_MODE=$winner" -ForegroundColor Yellow
    Write-Host "  BE_API_KEY=$($ApiKey.Substring(0,8))..." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Pokud žádná z těchto cest nefunguje, zeptej se BE týmu na přesný header." -ForegroundColor DarkYellow
} else {
    Write-Host ""
    Write-Host "Žádná auth metoda nefungovala. Možné příčiny:" -ForegroundColor Red
    Write-Host "  1) BE_BASE_URL je špatně (HTTPS? port? trailing slash?)" -ForegroundColor DarkRed
    Write-Host "  2) Klíč je expirovaný/zneplatněný" -ForegroundColor DarkRed
    Write-Host "  3) BE používá jiný header (X-Auth-Token? custom?) - zeptej se BE týmu" -ForegroundColor DarkRed
    Write-Host "  4) Síťová bariéra (firewall, VPN)" -ForegroundColor DarkRed
    exit 1
}

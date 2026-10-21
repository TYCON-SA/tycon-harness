#
# install-clocki-hooks.ps1 — Windows PowerShell
#
# Instala los hooks de clocki en %USERPROFILE%\.claude\settings.json sin pisar hooks existentes.
# Idempotente.
#
# Uso (desde PowerShell):
#   pwsh $HOME\.claude\agent-skills\skills\clocki\scripts\install-clocki-hooks.ps1
#
# macOS/Linux users: usar install-clocki-hooks.sh (bash).

$ErrorActionPreference = "Stop"

$ClockiDir = Join-Path $HOME ".claude\agent-skills\skills\clocki\scripts"
$StateDir = Join-Path $HOME ".claude\clocki"
$Settings = Join-Path $HOME ".claude\settings.json"

Write-Host "→ Instalador de hooks clocki (Windows)" -ForegroundColor Cyan
Write-Host ""

# 1. Dependencias
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "✗ ERROR: 'node' no está en PATH. Instalá Node.js (>= 16)." -ForegroundColor Red
    exit 1
}

# 2. Verificar scripts presentes
$requiredFiles = @("lib.js", "sweep.js", "on-prompt.js", "touch-activity.js", "clocki-enforce.js")
foreach ($f in $requiredFiles) {
    $fullPath = Join-Path $ClockiDir $f
    if (-not (Test-Path $fullPath)) {
        Write-Host "✗ ERROR: falta $fullPath. ¿Está clonado el repo AgentSkills?" -ForegroundColor Red
        exit 1
    }
}

# 3. Crear state dir con defaults
if (-not (Test-Path $StateDir)) {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
}

$activePath = Join-Path $StateDir "active.json"
$cachePath = Join-Path $StateDir "project-cache.json"
$settingsLocalPath = Join-Path $StateDir "settings.json"

if (-not (Test-Path $activePath)) { "{}" | Set-Content -Path $activePath -Encoding UTF8 }
if (-not (Test-Path $cachePath)) { "{}" | Set-Content -Path $cachePath -Encoding UTF8 }
if (-not (Test-Path $settingsLocalPath)) {
    # Nota: NO sembrar intentKeywords/stopKeywords vacios. readSettings() (lib.js) usa
    # la lista narrow/precision-first de DEFAULT_SETTINGS cuando el field falta o esta vacio.
    # Sembrar `[]` aca degradaria a una lista ANCHA y dispararia falsos positivos sobre
    # charla/meta-discusion. El dev puede agregar estos campos para OVERRIDE.
    @"
{
  "idleTimeoutMinutes": 15,
  "defaultWorkspaceId": null
}
"@ | Set-Content -Path $settingsLocalPath -Encoding UTF8
}
Write-Host "✓ State dir listo: $StateDir"

# 4. Verificar settings.json
if (-not (Test-Path $Settings)) {
    "{}" | Set-Content -Path $Settings -Encoding UTF8
}

# 5. Patchear settings.json con los hooks
# Resolver paths absolutos con forward-slash para evitar escaping issues en JSON
$sweepJs = (Join-Path $ClockiDir "sweep.js").Replace('\', '/')
$promptJs = (Join-Path $ClockiDir "on-prompt.js").Replace('\', '/')
$touchJs = (Join-Path $ClockiDir "touch-activity.js").Replace('\', '/')
$enforceJs = (Join-Path $ClockiDir "clocki-enforce.js").Replace('\', '/')

$sweepCmd = "node `"$sweepJs`""
$promptCmd = "node `"$promptJs`""
$touchCmd = "node `"$touchJs`""
$enforceCmd = "node `"$enforceJs`""

# Leer settings actual
$raw = Get-Content -Raw -Path $Settings -Encoding UTF8
if (-not $raw -or $raw.Trim().Length -eq 0) { $raw = "{}" }
$s = $raw | ConvertFrom-Json -AsHashtable

if (-not $s.ContainsKey("hooks")) { $s["hooks"] = @{} }
$hooks = $s["hooks"]

function Test-ClockiHook($hookList, $cmd) {
    if ($null -eq $hookList) { return $false }
    foreach ($entry in $hookList) {
        if ($null -eq $entry.hooks) { continue }
        foreach ($h in $entry.hooks) {
            $c = $h.command
            if ($c -and ($c.Trim() -eq $cmd.Trim() -or $c.Contains("clocki"))) {
                return $true
            }
        }
    }
    return $false
}

function Test-ClockiHookByScript($hookList, $scriptBasename) {
    # Verifica si ya hay una entry cuyo command menciona ese script basename.
    # Más estricto que Test-ClockiHook (que match "clocki" demasiado amplio).
    if ($null -eq $hookList) { return $false }
    foreach ($entry in $hookList) {
        if ($null -eq $entry.hooks) { continue }
        foreach ($h in $entry.hooks) {
            $c = $h.command
            if ($c -and $c.Contains($scriptBasename)) {
                return $true
            }
        }
    }
    return $false
}

function Add-ClockiHook($eventName, $cmd, $isAsync, $matcher, $scriptBasename) {
    if (-not $hooks.ContainsKey($eventName)) {
        $hooks[$eventName] = @()
    }
    $arr = @($hooks[$eventName])
    # Idempotencia por basename del script (más estable que match amplio "clocki")
    if (Test-ClockiHookByScript $arr $scriptBasename) { return $false }

    $hookObj = @{ type = "command"; command = $cmd }
    if ($isAsync) { $hookObj["async"] = $true }
    $entry = @{ hooks = @($hookObj) }
    if ($matcher) { $entry["matcher"] = $matcher }
    $arr += $entry
    $hooks[$eventName] = $arr
    return $true
}

$added = @()
if (Add-ClockiHook "SessionStart" $sweepCmd $false $null "sweep.js") { $added += "SessionStart → sweep.js" }
if (Add-ClockiHook "UserPromptSubmit" $promptCmd $false $null "on-prompt.js") { $added += "UserPromptSubmit → on-prompt.js" }
if (Add-ClockiHook "PostToolUse" $touchCmd $true $null "touch-activity.js") { $added += "PostToolUse → touch-activity.js (async, todos los tools)" }
# enforce DEBE ser sync (`$false`): emite system-reminder en stdout, y async hooks
# tienen stdout discarded — el reminder nunca llega al contexto del modelo.
if (Add-ClockiHook "PostToolUse" $enforceCmd $false "Edit|Write" "clocki-enforce.js") { $added += "PostToolUse(Edit|Write) → clocki-enforce.js (sync, forza timer activo)" }

$s["hooks"] = $hooks
$json = $s | ConvertTo-Json -Depth 20
$json | Set-Content -Path $Settings -Encoding UTF8

if ($added.Count -gt 0) {
    Write-Host "✓ Hooks agregados:" -ForegroundColor Green
    foreach ($a in $added) { Write-Host "  • $a" }
} else {
    Write-Host "✓ Hooks ya estaban instalados (idempotente, no se duplicó nada)." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "✓ Hooks clocki instalados en $Settings" -ForegroundColor Green
Write-Host ""
Write-Host "Próximo paso:"
Write-Host "  1. Verificá que Clockify MCP esté instalado: claude mcp list | findstr clockify"
Write-Host "     (Si no está, corré: pwsh `$HOME\.claude\tycon-harness\scripts\install-clockify-mcp.ps1)"
Write-Host "  2. Reiniciá tu sesión de Claude Code."
Write-Host "  3. Probá: en cualquier proyecto, decile a Claude 'fixeemos el bug X'. Debería proponerte abrir timer."
Write-Host ""

# install-clockify-mcp.ps1 — Windows PowerShell
#
# Instala el MCP server de Clockify (aslamanver/mcp_clockify) en Claude Code
# a nivel user-scope (todos los proyectos de la máquina lo usan).
#
# Uso (desde PowerShell, NO desde cmd):
#   pwsh ~\.claude\tycon-harness\scripts\setup\install-clockify-mcp.ps1
#
# Si tu execution policy lo bloquea, correlo así (solo afecta este proceso):
#   pwsh -ExecutionPolicy Bypass -File ~\.claude\tycon-harness\scripts\setup\install-clockify-mcp.ps1
#
# macOS / Linux users: usar install-clockify-mcp.sh.
#
# Idempotente: si ya está instalado, lo remueve y reinstala con la key nueva.
# La API key NO se commitea a ningún repo — vive solo en %USERPROFILE%\.claude.json local.

$ErrorActionPreference = "Stop"

# PowerShell 7 es un requisito (story 8.17, W3W4): lanzado con Windows PowerShell 5.1, lo dice en una línea y sale 1 antes
# de pedir la llave, escribir o lanzar nada. Mismo criterio y misma variable de prueba que install-tycon-hooks.ps1 (sólo
# simula una versión más vieja; el texto, sin tildes: ver allá).
$TyconPsMajor = $PSVersionTable.PSVersion.Major
if ($env:TYCON_PS_MAJOR_FOR_TEST -match '^\d+$' -and [int]$env:TYCON_PS_MAJOR_FOR_TEST -lt $TyconPsMajor) {
    $TyconPsMajor = [int]$env:TYCON_PS_MAJOR_FOR_TEST
}
if ($TyconPsMajor -lt 7) {
    if ($TyconPsMajor -ne $PSVersionTable.PSVersion.Major) {
        Write-Output ("tycon: la variable TYCON_PS_MAJOR_FOR_TEST=$($env:TYCON_PS_MAJOR_FOR_TEST) esta puesta y simula un PowerShell viejo: " +
            "el servidor de Clockify NO quedo instalado. Es una variable de prueba: sacala del entorno y volve a correrlo.")
        exit 1
    }
    Write-Output ("tycon: FALTA PowerShell 7 (pwsh): el servidor de Clockify NO quedo instalado. " +
        "Este guion no corre con Windows PowerShell $TyconPsMajor. Pasos: 1) winget install Microsoft.PowerShell  " +
        "2) cerrar y volver a abrir la terminal  3) pwsh -NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`"")
    exit 1
}

$ServerName = "clockify"
$Package = "mcp_clockify@latest"

Write-Host "-> Instalador de Clockify MCP server (user-scope)"
Write-Host ""

# 1. Verificar dependencias
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Error "El CLI 'claude' no esta en PATH. Instala Claude Code primero."
    exit 1
}

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    Write-Error "'npx' no esta en PATH. Instala Node.js (>= 16)."
    exit 1
}

# 2. Pedir API key (SecureString para que no quede en el buffer ni en pantalla)
Write-Host "Necesito tu Clockify API key personal."
Write-Host "  Sacala de: Clockify -> Profile Settings (esquina sup. der.) -> API -> Generate"
Write-Host ""

$SecureKey = Read-Host -AsSecureString "API key"
$Bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureKey)
try {
    $ApiKey = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
}
finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr)
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    Write-Error "La API key esta vacia. Cancelando."
    exit 1
}

Write-Host ""

# 3. Si ya existe el server, removerlo (idempotencia)
$ExistingList = (claude mcp list 2>$null) -join "`n"
if ($ExistingList -match "(?m)^${ServerName}:") {
    Write-Host "-> '$ServerName' ya estaba instalado; lo remuevo para reinstalar limpio."
    claude mcp remove --scope user $ServerName 2>$null | Out-Null
}

# 4. Instalar
# NOTA: --env=KEY=VALUE (con `=`) es obligatorio. -e es variadic y se traga
# el nombre del server si se usa con espacio.
Write-Host "-> Instalando '$ServerName' (user-scope)..."
& claude mcp add `
    --scope user `
    --env="CLOCKIFY_API_KEY=$ApiKey" `
    $ServerName `
    -- npx -y $Package

if ($LASTEXITCODE -ne 0) {
    Write-Error "El comando 'claude mcp add' fallo con exit code $LASTEXITCODE."
    exit 1
}

# 5. Verificar conexión
Write-Host ""
Write-Host "-> Verificando conexion..."
Start-Sleep -Seconds 1

$VerifyOutput = (claude mcp list 2>&1) -join "`n"
if ($VerifyOutput -match "(?m)^${ServerName}:.*Connected") {
    Write-Host "OK: '$ServerName' instalado y conectado correctamente."
    Write-Host ""
    Write-Host "Proximo paso: reinicia tu sesion de Claude Code para ver los tools nuevos."
    Write-Host "Tools disponibles: list workspaces/projects/tasks, time entries, summary reports."
}
else {
    Write-Warning "'$ServerName' instalado pero no aparece como Connected."
    Write-Warning "Corre 'claude mcp list' manualmente y revisa si hay errores."
    exit 1
}

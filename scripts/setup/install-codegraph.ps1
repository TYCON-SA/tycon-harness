# install-codegraph.ps1 — Windows PowerShell
#
# Instala CodeGraph (@colbymchenry/codegraph) y lo registra como MCP server
# en Claude Code para uno o varios proyectos.
#
# CodeGraph indexa el codebase (tree-sitter -> SQLite local) y expone un grafo
# de simbolos / call graph / dependencias via MCP. Reduce tokens y tool calls
# de los agentes vs. escanear archivos con grep.
#
# Uso (desde PowerShell, NO desde cmd):
#   pwsh install-codegraph.ps1                       # setup del directorio actual
#   pwsh install-codegraph.ps1 C:\ruta\al\repo       # setup de un repo especifico
#   pwsh install-codegraph.ps1 -Container C:\ruta    # contenedor con subproyectos
#   pwsh install-codegraph.ps1 -Repo C:\ruta         # forzar modo repo-suelto
#   pwsh install-codegraph.ps1 -NoAuto               # NO instalar el hook automatico
#
# Si tu execution policy lo bloquea:
#   pwsh -ExecutionPolicy Bypass -File install-codegraph.ps1   (PowerShell 7: con Windows PowerShell 5.1 sale 1 y lo dice)
#
# Ademas instala un hook SessionStart (codegraph-session-hook.ps1) que, de aca
# en adelante, auto-configura CodeGraph en cualquier OTRO repo que abras —
# corres este script UNA vez por maquina y listo. -NoAuto saltea ese hook.
#
# Por defecto autodetecta repo-suelto vs contenedor. Idempotente.
# El indice (.codegraph\) y la config MCP son machine-local: NO se commitean.
# macOS / Linux: usar install-codegraph.sh.

param(
    [Parameter(Position = 0)] [string] $Target = "",
    [switch] $Container,
    [switch] $Repo,
    [switch] $NoAuto,
    # el CLI y el hook, sin indexar ni registrar ninguna carpeta (lo usa el instalador del arnés)
    [switch] $ToolOnly
)

$ErrorActionPreference = "Stop"

# PowerShell 7 es un requisito (story 8.17, W3W4): lanzado con Windows PowerShell 5.1, lo dice en una línea y sale 1 antes
# de escribir o lanzar nada. Mismo criterio y misma variable de prueba que install-tycon-hooks.ps1 (sólo simula una
# versión más vieja; el texto, sin tildes: ver allá).
$TyconPsMajor = $PSVersionTable.PSVersion.Major
if ($env:TYCON_PS_MAJOR_FOR_TEST -match '^\d+$' -and [int]$env:TYCON_PS_MAJOR_FOR_TEST -lt $TyconPsMajor) {
    $TyconPsMajor = [int]$env:TYCON_PS_MAJOR_FOR_TEST
}
if ($TyconPsMajor -lt 7) {
    if ($TyconPsMajor -ne $PSVersionTable.PSVersion.Major) {
        Write-Output ("tycon: la variable TYCON_PS_MAJOR_FOR_TEST=$($env:TYCON_PS_MAJOR_FOR_TEST) esta puesta y simula un PowerShell viejo: " +
            "CodeGraph NO quedo instalado. Es una variable de prueba: sacala del entorno y volve a correrlo.")
        exit 1
    }
    Write-Output ("tycon: FALTA PowerShell 7 (pwsh): CodeGraph NO quedo instalado. " +
        "Este guion no corre con Windows PowerShell $TyconPsMajor. Pasos: 1) winget install Microsoft.PowerShell  " +
        "2) cerrar y volver a abrir la terminal  3) pwsh -NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`"")
    exit 1
}

$ScriptDir = $PSScriptRoot

# Version del paquete npm. "latest" o un numero fijo (ej. "0.7.9") para pinear.
$CodegraphVersion = "latest"
$Pkg = "@colbymchenry/codegraph@$CodegraphVersion"

if ([string]::IsNullOrWhiteSpace($Target)) { $Target = (Get-Location).Path }
if (-not (Test-Path -LiteralPath $Target -PathType Container)) {
    Write-Error "No existe el directorio: $Target"; exit 1
}
$Target = (Resolve-Path -LiteralPath $Target).Path

$Mode = "auto"
if ($Container) { $Mode = "container" }
if ($Repo)      { $Mode = "repo" }
if ($Container -and $Repo) { Write-Error "No uses -Container y -Repo a la vez."; exit 1 }

Write-Host "-> Instalador de CodeGraph MCP"
Write-Host "   target: $Target"
Write-Host ""

# ---- 1. dependencias ----
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js no esta en PATH (se requiere >= 18)."; exit 1
}
$NodeMajor = [int]((node -p "process.versions.node.split('.')[0]"))
if ($NodeMajor -lt 18) { Write-Error "Node $NodeMajor detectado; se requiere >= 18."; exit 1 }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm no esta en PATH."; exit 1
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Error "El CLI 'claude' no esta en PATH. Instala Claude Code primero."; exit 1
}

# ---- 2. instalar el CLI codegraph (global) ----
Write-Host "-> Instalando $Pkg (global)..."
npm install -g $Pkg 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "Fallo 'npm install -g $Pkg'. Revisa permisos / 'npm config get prefix'."
    exit 1
}
$CodegraphCmd = Get-Command codegraph -ErrorAction SilentlyContinue
if (-not $CodegraphCmd) { Write-Error "codegraph no quedo en PATH tras la instalacion."; exit 1 }
$CodegraphBin = $CodegraphCmd.Source
Write-Host "   codegraph $(codegraph --version 2>$null) -> $CodegraphBin"
Write-Host ""

# ---- helpers ----
function Test-Project {
    param([string] $Dir)
    if (Test-Path -LiteralPath (Join-Path $Dir ".git"))           { return $true }
    if (Test-Path -LiteralPath (Join-Path $Dir "package.json"))   { return $true }
    if (Test-Path -LiteralPath (Join-Path $Dir "go.mod"))         { return $true }
    if (Test-Path -LiteralPath (Join-Path $Dir "Cargo.toml"))     { return $true }
    if (Test-Path -LiteralPath (Join-Path $Dir "pom.xml"))        { return $true }
    if (Test-Path -LiteralPath (Join-Path $Dir "pyproject.toml")) { return $true }
    if (Get-ChildItem -LiteralPath $Dir -Filter "*.sln" -ErrorAction SilentlyContinue)    { return $true }
    if (Get-ChildItem -LiteralPath $Dir -Filter "*.csproj" -ErrorAction SilentlyContinue) { return $true }
    return $false
}

# ---- 3. resolver modo + lista de repos ----
$Repos = @()
$RegDir = "(el repo que abras: el hook arma su indice)"
if (-not $ToolOnly) {
if ($Mode -eq "auto") {
    if (Test-Project $Target) { $Mode = "repo" } else { $Mode = "container" }
    Write-Host "   modo autodetectado: $Mode"
}

$Repos = @()
if ($Mode -eq "repo") {
    if (-not (Test-Project $Target)) { Write-Host "   ! $Target no parece un proyecto; sigo igual (forzado)." }
    $Repos = @($Target)
}
else {
    foreach ($d in (Get-ChildItem -LiteralPath $Target -Directory)) {
        if ($d.Name -eq "node_modules" -or $d.Name.StartsWith(".")) { continue }
        if (Test-Project $d.FullName) { $Repos += $d.FullName }
    }
    if ($Repos.Count -eq 0) { Write-Error "No se encontraron subproyectos en $Target."; exit 1 }
    Write-Host "   subproyectos detectados: $(($Repos | ForEach-Object { Split-Path $_ -Leaf }) -join ' ')"
}
Write-Host ""

# ---- 4. indexar cada repo + gitignore ----
foreach ($repoPath in $Repos) {
    $name = Split-Path $repoPath -Leaf
    Push-Location -LiteralPath $repoPath
    try {
        if (Test-Path -LiteralPath (Join-Path $repoPath ".codegraph")) {
            Write-Host "-> [$name] re-indexando (.codegraph\ ya existe)..."
            codegraph index 2>$null | Out-Null
        }
        else {
            Write-Host "-> [$name] init + index inicial..."
            codegraph init -i 2>$null | Out-Null
        }
        if ($LASTEXITCODE -ne 0) { Write-Error "Fallo el index/init de $name."; exit 1 }
    }
    finally { Pop-Location }

    $gi = Join-Path $repoPath ".gitignore"
    if (Test-Path -LiteralPath $gi) {
        $giLines = Get-Content -LiteralPath $gi
        if ($giLines -notcontains ".codegraph/") {
            Add-Content -LiteralPath $gi -Value ""
            Add-Content -LiteralPath $gi -Value "# CodeGraph: indice local (SQLite), machine-specific y regenerable"
            Add-Content -LiteralPath $gi -Value ".codegraph/"
            Write-Host "   + .codegraph/ agregado a $name\.gitignore"
        }
    }
    $claudeMd = Join-Path $repoPath "CLAUDE.md"
    if ((Test-Path -LiteralPath $claudeMd) -and
        -not (Select-String -LiteralPath $claudeMd -Pattern "CodeGraph" -Quiet)) {
        Write-Host "   ! $name\CLAUDE.md NO tiene la seccion CodeGraph. Sin ella los agentes"
        Write-Host "     no usan codegraph por defecto. Copia el bloque de la guia codegraph-mcp.md."
    }
}
Write-Host ""

# ---- 5. registrar MCP server(s) en Claude Code ----
# 'claude mcp add' usa scope 'local' por defecto (per-proyecto, machine-only,
# guardado en ~/.claude.json). NO se pasa --scope: algunos builds del CLI lo
# rechazan, y 'local' ya es lo que queremos.
# Se usa 'serve --path' (forma larga): el '-p' corto colisiona con el flag
# global '-p/--print' del CLI 'claude' y rompe el parseo del subcomando.
Write-Host "-> Registrando MCP server(s) en Claude Code (scope local = solo esta maquina)..."
if ($Mode -eq "repo") {
    $repoPath = $Repos[0]
    Push-Location -LiteralPath $repoPath
    try {
        claude mcp remove codegraph 2>$null | Out-Null
        & claude mcp add codegraph -- $CodegraphBin serve --mcp --path $repoPath | Out-Null
    }
    finally { Pop-Location }
    Write-Host "   + 'codegraph' -> $repoPath"
    $RegDir = $repoPath
}
else {
    Push-Location -LiteralPath $Target
    try {
        foreach ($repoPath in $Repos) {
            $name = (Split-Path $repoPath -Leaf).ToLower()
            $sname = "codegraph-$name"
            claude mcp remove $sname 2>$null | Out-Null
            & claude mcp add $sname -- $CodegraphBin serve --mcp --path $repoPath | Out-Null
            Write-Host "   + '$sname' -> $repoPath"
        }
    }
    finally { Pop-Location }
    $RegDir = $Target
}

# Marca de "seteado por esta tooling" -> el hook SessionStart sale por fast path.
foreach ($repoPath in $Repos) {
    $cg = Join-Path $repoPath ".codegraph"
    if (Test-Path -LiteralPath $cg) {
        New-Item -ItemType File -Path (Join-Path $cg ".tycon-setup-done") -Force | Out-Null
    }
}
Write-Host ""
}   # -ToolOnly: sin repos que indexar ni registrar

# ---- 6. instalar el hook SessionStart (auto-setup de futuros repos) ----
if (-not $NoAuto) {
    $HookScript = Join-Path (Join-Path (Split-Path -Parent $ScriptDir) 'hooks') "codegraph-session-hook.ps1"
    $Settings = Join-Path $HOME ".claude\settings.json"
    if (-not (Test-Path -LiteralPath $HookScript)) {
        Write-Warning "No encuentro scripts\hooks\codegraph-session-hook.ps1; omito el hook."
    }
    else {
        $claudeDir = Join-Path $HOME ".claude"
        if (-not (Test-Path -LiteralPath $claudeDir)) { New-Item -ItemType Directory -Path $claudeDir | Out-Null }
        if (Test-Path -LiteralPath $Settings) { Copy-Item -LiteralPath $Settings -Destination "$Settings.bak-codegraph" -Force }

        $HookCmd = "pwsh -NoProfile -File `"$HookScript`""
        try {
            if (Test-Path -LiteralPath $Settings) {
                $data = Get-Content -LiteralPath $Settings -Raw | ConvertFrom-Json -AsHashtable
            }
            else { $data = @{} }
            if ($null -eq $data) { $data = @{} }
            if (-not $data.ContainsKey("hooks"))               { $data["hooks"] = @{} }
            if (-not $data["hooks"].ContainsKey("SessionStart")) { $data["hooks"]["SessionStart"] = @() }

            $already = $false
            foreach ($group in $data["hooks"]["SessionStart"]) {
                if ($group -is [hashtable] -and $group.ContainsKey("hooks")) {
                    foreach ($h in $group["hooks"]) {
                        if ("$($h["command"])" -match "codegraph-session-hook") { $already = $true }
                    }
                }
            }
            if ($already) {
                Write-Host "-> Hook SessionStart ya estaba instalado (ok)"
            }
            else {
                $data["hooks"]["SessionStart"] += @{
                    hooks = @( @{ type = "command"; command = $HookCmd; async = $true } )
                }
                ($data | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath $Settings -Encoding UTF8
                Write-Host "-> Hook SessionStart instalado en $Settings"
            }
        }
        catch {
            Write-Warning "No pude editar $Settings ($_). Agregalo a mano — ver guia codegraph-mcp.md."
        }
    }
    Write-Host ""
}

Write-Host "OK: CodeGraph instalado."
Write-Host ""
Write-Host "Proximos pasos:"
Write-Host "  1. Reinicia Claude Code abriendolo en: $RegDir"
Write-Host "  2. Cuando pida aprobar el/los MCP server(s) 'codegraph*', aprobalos."
Write-Host "  3. Verifica con el comando /mcp dentro de Claude Code (deben figurar 'connected')."
if (-not $NoAuto) {
    Write-Host ""
    Write-Host "Modo automatico ACTIVO: de aca en adelante, cualquier OTRO repo que abras"
    Write-Host "en Claude Code se auto-configura solo (indexa + registra) via el hook."
    Write-Host "No hace falta volver a correr este script — salvo para contenedores"
    Write-Host "(-Container), que el hook no maneja."
}
else {
    Write-Host ""
    Write-Host "Modo manual (-NoAuto): solo se configuro el target. Para otros repos,"
    Write-Host "volve a correr este script apuntando a cada uno."
}

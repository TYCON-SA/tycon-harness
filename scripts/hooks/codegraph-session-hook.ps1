# codegraph-session-hook.ps1 — hook SessionStart de Claude Code (Windows).
#
# Auto-configura CodeGraph para el repo donde se abre la sesion: si es un
# proyecto y todavia no esta seteado, lo indexa y registra el MCP server.
# En sesiones siguientes (repo ya seteado) sale al instante.
#
# Lo instala install-codegraph.ps1 con "async": true — corre en background y
# NO bloquea el arranque de la sesion. NO editar ni invocar a mano.
#
# Diseno defensivo: nunca falla ruidosamente, siempre exit 0.

$ErrorActionPreference = "SilentlyContinue"

$Cwd = (Get-Location).Path

# No tocar paths dentro de node_modules / .git
if ($Cwd -match "[\\/]node_modules[\\/]" -or $Cwd -match "[\\/]\.git[\\/]") { exit 0 }

# Nunca tratar la carpeta personal ni la raiz de un disco como proyecto: una sesion abierta sin carpeta arranca ahi, y
# con un package.json suelto indexaria todo (el mismo cuidado que tiene el gancho de Mac y Linux).
$CwdFull = [System.IO.Path]::GetFullPath($Cwd).TrimEnd('\', '/')
$HomeFull = if ($HOME) { [System.IO.Path]::GetFullPath($HOME).TrimEnd('\', '/') } else { $null }
if (($HomeFull -and $CwdFull -ieq $HomeFull) -or ($CwdFull -eq [System.IO.Path]::GetPathRoot($Cwd).TrimEnd('\', '/'))) { exit 0 }

# El binario de codegraph es imprescindible (indexa). El CLI claude no: sólo registra el servidor del lado Claude. Una
# máquina sólo con Codex tiene codegraph sin claude, y sin indexar su servidor respondería vacío (como el gancho de Mac).
if (-not (Get-Command codegraph -ErrorAction SilentlyContinue)) { exit 0 }

# Es un proyecto?
$IsProject = $false
foreach ($m in @(".git", "package.json", "go.mod", "Cargo.toml", "pom.xml", "pyproject.toml")) {
    if (Test-Path -LiteralPath (Join-Path $Cwd $m)) { $IsProject = $true }
}
if (Get-ChildItem -LiteralPath $Cwd -Filter "*.sln" -ErrorAction SilentlyContinue)    { $IsProject = $true }
if (Get-ChildItem -LiteralPath $Cwd -Filter "*.csproj" -ErrorAction SilentlyContinue) { $IsProject = $true }
if (-not $IsProject) { exit 0 }

# Ya seteado? -> fast path
$Marker = Join-Path $Cwd ".codegraph\.tycon-setup-done"
if (Test-Path -LiteralPath $Marker) { exit 0 }

# --- primera vez en este repo: setup completo ---
if (-not (Test-Path -LiteralPath (Join-Path $Cwd ".codegraph"))) {
    codegraph init -i $Cwd 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { exit 0 }
}

# El índice es de esta máquina: va al exclude local de git, nunca al .gitignore del equipo (un cambio ahí se termina
# subiendo). La ruta la da git, así vale también en un worktree. Fuera de un repo no se anota nada.
$Ex = (& git -C $Cwd rev-parse --git-path info/exclude 2>$null)
if ($LASTEXITCODE -eq 0 -and $Ex) {
    if (-not [System.IO.Path]::IsPathRooted($Ex)) { $Ex = Join-Path $Cwd $Ex }
    $ExDir = Split-Path -Parent $Ex
    if (-not (Test-Path -LiteralPath $ExDir)) { New-Item -ItemType Directory -Path $ExDir -Force | Out-Null }
    $ExLines = if (Test-Path -LiteralPath $Ex) { Get-Content -LiteralPath $Ex } else { @() }
    if ($ExLines -notcontains ".codegraph/") { Add-Content -LiteralPath $Ex -Value ".codegraph/" }
}

# Registrar el MCP server del lado Claude (forma larga --path por la colision de -p), sólo si claude está. La marca de
# completado se escribe sólo con el trabajo hecho: con claude, si el registro salió bien (si falló, la próxima sesión
# lo reintenta, sin volver a indexar); sin claude, el índice es todo lo que hay que hacer.
$Done = $true
if (Get-Command claude -ErrorAction SilentlyContinue) {
    $Bin = (Get-Command codegraph).Source
    Push-Location -LiteralPath $Cwd
    try {
        claude mcp remove codegraph 2>$null | Out-Null
        & claude mcp add codegraph -- $Bin serve --mcp --path $Cwd 2>$null | Out-Null
        $Done = ($LASTEXITCODE -eq 0)
    }
    finally { Pop-Location }
}
if ($Done -and (Test-Path -LiteralPath (Join-Path $Cwd ".codegraph"))) {
    New-Item -ItemType File -Path $Marker -Force | Out-Null
}

exit 0

# ensure-sqlite3.ps1 — deja el comando `sqlite3` disponible en esta máquina (Windows).
#
# ── POR QUÉ ─────────────────────────────────────────────────────────────────────────────────
# Dos de los cuatro chequeos de salud de la memoria persistente (memoria partida en varios
# nombres, y memoria que nunca se exportó) leen la base de engram por dentro, porque el dato que
# necesitan —desde QUÉ CARPETA se guardó cada recuerdo— engram no lo expone por ningún comando.
# Para leerla hace falta el comando `sqlite3`.
#
# 🔴 Windows es EL caso que motivó este script. Tener engram no alcanza: engram lleva su propio
# SQLite compilado adentro (`modernc.org/sqlite`), así que funciona perfecto sin dejar ningún
# comando en el PATH. Y acá engram se instala con `go install`, que menos todavía lo arrastra.
# En macOS `sqlite3` viene con el sistema y esto casi nunca hace falta; en Windows NO viene.
#
# Se instala SOLO, sin preguntar, por el mismo criterio que el arnés ya aplica al actualizar
# engram (`check-engram-version.ps1`): es una dependencia del arnés, no una decisión del dev.
# Si no se puede, avisa con el comando exacto — nunca falla en silencio, que es justamente el
# modo de falla que estos chequeos existen para cazar.
#
# Idempotente · fail-open (nunca rompe el arranque) · throttle de 7 días.
#
# Opt-outs: `TYCON_NO_SQLITE_CHECK=1` · `TYCON_SQLITE_AUTO_INSTALL=0`.
# Override del binario: `TYCON_SQLITE_BIN`.

$ErrorActionPreference = 'SilentlyContinue'

if ($env:TYCON_NO_SQLITE_CHECK -eq '1') { exit 0 }

# PowerShell 7 es un requisito (story 8.17, W3W4): lanzado con Windows PowerShell 5.1, lo dice en una línea y sale 1 antes
# de escribir su sello o lanzar nada. Mismo criterio y misma variable de prueba que install-tycon-hooks.ps1 (sólo simula
# una versión más vieja; el texto, sin tildes: ver allá).
$TyconPsMajor = $PSVersionTable.PSVersion.Major
if ($env:TYCON_PS_MAJOR_FOR_TEST -match '^\d+$' -and [int]$env:TYCON_PS_MAJOR_FOR_TEST -lt $TyconPsMajor) {
    $TyconPsMajor = [int]$env:TYCON_PS_MAJOR_FOR_TEST
}
if ($TyconPsMajor -lt 7) {
    if ($TyconPsMajor -ne $PSVersionTable.PSVersion.Major) {
        Write-Output ("tycon: la variable TYCON_PS_MAJOR_FOR_TEST=$($env:TYCON_PS_MAJOR_FOR_TEST) esta puesta y simula un PowerShell viejo: " +
            "NO revise ni instale sqlite3. Es una variable de prueba: sacala del entorno y volve a correrlo.")
        exit 1
    }
    Write-Output ("tycon: FALTA PowerShell 7 (pwsh): NO revise ni instale sqlite3 (lo usan dos chequeos de la memoria). " +
        "Este guion no corre con Windows PowerShell $TyconPsMajor. Instalar: winget install Microsoft.PowerShell")
    exit 1
}

$sqliteBin = if ($env:TYCON_SQLITE_BIN) { $env:TYCON_SQLITE_BIN } else { 'sqlite3' }

function Test-Sqlite {
    param([string]$Bin)
    try { & $Bin -version 2>$null | Out-Null; return ($LASTEXITCODE -eq 0) } catch { return $false }
}

if (Test-Sqlite $sqliteBin) { exit 0 }

$stampDir = Join-Path $env:USERPROFILE '.claude\.tycon-pipeline'
$stamp = Join-Path $stampDir 'sqlite3-install-last-try'
$ahora = [int][double]::Parse((Get-Date -UFormat %s))
if (Test-Path $stamp) {
    $ultimo = 0
    # Un stamp ilegible cuenta como vencido: mejor reintentar de más que quedarse mudo por una
    # fecha rota.
    [int]::TryParse((Get-Content $stamp -Raw).Trim(), [ref]$ultimo) | Out-Null
    if (($ahora - $ultimo) -lt (7 * 24 * 60 * 60)) { exit 0 }
}

function Avisar-Manual {
    param([string]$Cmd)
    Write-Host "WARN tycon: falta el comando 'sqlite3' y no se pudo instalar solo." -ForegroundColor Yellow
    Write-Host "     Sin el, 2 de los 4 chequeos de salud de la memoria de engram no pueden correr"
    Write-Host "     (memoria partida en varios nombres - memoria que nunca se exporto)."
    Write-Host "     Instalalo a mano:  $Cmd"
    Write-Host "     Silenciar: TYCON_NO_SQLITE_CHECK=1"
    New-Item -ItemType Directory -Path $stampDir -Force | Out-Null
    Set-Content -Path $stamp -Value "$ahora" -NoNewline
    exit 0
}

# ── cómo instalarlo ──────────────────────────────────────────────────────────────────────────
$tieneWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
$tieneScoop  = $null -ne (Get-Command scoop  -ErrorAction SilentlyContinue)

if ($tieneWinget)      { $cmdTxt = 'winget install --id SQLite.SQLite -e --source winget' }
elseif ($tieneScoop)   { $cmdTxt = 'scoop install sqlite' }
else                   { Avisar-Manual 'instala SQLite desde https://sqlite.org/download.html (tools) y agregalo al PATH' }

if ($env:TYCON_SQLITE_AUTO_INSTALL -eq '0') { Avisar-Manual $cmdTxt }

# 🔴 CANDADO entre procesos (2026-08-25, revisión adversarial). Dos sesiones que arrancan juntas
# pasaban las dos la guarda de arriba y lanzaban DOS instalaciones en paralelo. Se toma el candado
# con creación exclusiva del archivo, que es atómica; si otro lo tiene, este proceso se va callado.
$lockPath = Join-Path $stampDir 'sqlite3-install.lock'
New-Item -ItemType Directory -Path $stampDir -Force | Out-Null
$lock = $null
try { $lock = [System.IO.File]::Open($lockPath, 'CreateNew', 'Write', 'None') }
catch { exit 0 }   # ya hay otra sesión instalando: no se duplica y no se avisa dos veces

try {
    # 🔴 El sello se escribe ANTES de instalar, no después. Si la instalación cuelga o el proceso
    # muere, el throttle ya está puesto y no se reintenta en cada arranque.
    Set-Content -Path $stamp -Value "$ahora" -NoNewline

    Write-Host "-> tycon: falta 'sqlite3' (engram trae el suyo compilado adentro, pero no deja el comando)."
    Write-Host "   Instalando con: $cmdTxt"

    # 🔴 `--silent --disable-interactivity` además de los agreements: aceptar los acuerdos NO
    # equivale a modo no interactivo, y un instalador que abre un prompt cuelga el arranque de la
    # sesión. Y TIMEOUT duro: si tarda más de 5 minutos, se corta y se avisa — un hook de
    # SessionStart no puede quedarse esperando indefinidamente.
    if ($tieneWinget) {
        $proc = Start-Process -FilePath 'winget' -PassThru -NoNewWindow -ArgumentList @(
            'install','--id','SQLite.SQLite','-e','--source','winget',
            '--accept-package-agreements','--accept-source-agreements',
            '--silent','--disable-interactivity')
    } else {
        $proc = Start-Process -FilePath 'scoop' -PassThru -NoNewWindow -ArgumentList @('install','sqlite')
    }
    if (-not $proc.WaitForExit(300000)) {
        try { $proc.Kill() } catch { }
        Write-Host "   La instalacion tardo demasiado y se corto." -ForegroundColor Yellow
        Avisar-Manual $cmdTxt
    }
} finally {
    if ($lock) { $lock.Close() }
    Remove-Item $lockPath -ErrorAction SilentlyContinue
}

# winget deja el binario en el PATH de la MÁQUINA, que este proceso todavía no ve: se refresca acá
# para poder VERIFICAR que la instalación funcionó.
#
# 🔴 Pero esto NO alcanza para el proceso padre (2026-08-25, revisión adversarial): este script
# corre en un PowerShell hijo, y un hijo no puede modificar el entorno de quien lo lanzó. O sea que
# la sesión de Claude/Codex que está arrancando AHORA sigue sin ver `sqlite3`, aunque acá diga que
# se instaló bien. Por eso el mensaje de éxito avisa de reabrir: prometer que ya funciona sería
# exactamente el tipo de verde falso que estos chequeos existen para cazar.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

if (Test-Sqlite $sqliteBin) {
    Write-Host "   OK sqlite3 instalado." -ForegroundColor Green
    Write-Host "   Reabri esta terminal/sesion para que la vea: un proceso hijo no puede cambiar el PATH del padre," -ForegroundColor Yellow
    Write-Host "   asi que la sesion actual todavia no lo encuentra." -ForegroundColor Yellow
    Remove-Item $stamp -ErrorAction SilentlyContinue
    exit 0
}

Avisar-Manual $cmdTxt

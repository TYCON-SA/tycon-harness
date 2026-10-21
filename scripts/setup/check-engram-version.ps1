# check-engram-version.ps1 — contraparte Windows de check-engram-version.sh
#
# Mantiene a todo el equipo en la MISMA versión de engram: la anotada en `engram-version`.
# Ver el header de la versión .sh para el porqué (las memorias se comparten por git; si
# una máquina escribe otro formato, el resto no las lee y NO da error).
#
# Actualiza sola a la versión del equipo con `go install ...@vX.Y.Z`, que es el método
# que usa el equipo en Windows (onboarding/new-dev-harness-setup.md paso 5a) y el que
# recomienda el README oficial de engram: los binarios prebuilt no están firmados y
# Windows Defender los marca como falso positivo, así que se compila local.
#
# ✅ VENTAJA SOBRE MAC: `go install ...@v1.12.0` instala la versión EXACTA. El
# `brew upgrade --cask` de Mac instala la ÚLTIMA del cask, así que si el equipo eligiera
# a propósito una versión anterior a la última, en Mac no se le puede acertar y en
# Windows sí. Windows quedó con el camino más preciso de los dos.
#
# Precondiciones — si falla cualquiera, cae al aviso manual:
#   - `TYCON_ENGRAM_AUTO_UPGRADE` != 0 (default: ON)
#   - `go` en el PATH (es prerequisito del onboarding en Windows, paso 0)
#   - engram vive en el bin de Go (o sea, se instaló así). Si está en otro lado, se
#     instaló de otra forma y pisarlo con go install dejaría dos binarios distintos.
#
# NUNCA hace downgrade: si tu versión es más nueva que la del equipo, sólo avisa.
#
# Fail-open total. Opt-outs: TYCON_NO_ENGRAM_VERSION_CHECK=1 (todo) ·
#                            TYCON_ENGRAM_AUTO_UPGRADE=0 (deja el aviso, saca el update).
#
# Uso:
#   .\check-engram-version.ps1         # respeta el throttle
#   .\check-engram-version.ps1 -Check  # fuerza ambos avisos

param([switch]$Check)

$ErrorActionPreference = 'Continue'

if ($env:TYCON_NO_ENGRAM_VERSION_CHECK -eq '1') { exit 0 }

# PowerShell 7 es un requisito: lanzado suelto con Windows PowerShell 5.1, lo dice en una línea y sale 1
# antes de lanzar nada. El instalador ya frena antes de llegar acá; esto cubre a quien lo corre a mano. Mismo criterio y
# misma variable de prueba que install-tycon-hooks.ps1 (sólo simula una versión más vieja; el texto, sin tildes: ver allá).
$TyconPsMajor = $PSVersionTable.PSVersion.Major
if ($env:TYCON_PS_MAJOR_FOR_TEST -match '^\d+$' -and [int]$env:TYCON_PS_MAJOR_FOR_TEST -lt $TyconPsMajor) {
    $TyconPsMajor = [int]$env:TYCON_PS_MAJOR_FOR_TEST
}
if ($TyconPsMajor -lt 7) {
    if ($TyconPsMajor -ne $PSVersionTable.PSVersion.Major) {
        Write-Output ("tycon: la variable TYCON_PS_MAJOR_FOR_TEST=$($env:TYCON_PS_MAJOR_FOR_TEST) esta puesta y simula un PowerShell viejo: " +
            "NO revise la version de engram. Es una variable de prueba: sacala del entorno y volve a correrlo.")
        exit 1
    }
    Write-Output ("tycon: FALTA PowerShell 7 (pwsh): NO revise la version de engram contra la del equipo. " +
        "Este guion no corre con Windows PowerShell $TyconPsMajor. Instalar: winget install Microsoft.PowerShell")
    exit 1
}

function Get-Semver([string]$text) {
    if ($text -match '(\d+)\.(\d+)\.(\d+)') {
        return [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $Matches[3])
    }
    return $null
}

try {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $pinFile = Join-Path (Split-Path -Parent (Split-Path -Parent $scriptDir)) 'engram-version'

    if (-not (Test-Path $pinFile)) { exit 0 }
    if (-not (Get-Command engram -ErrorAction SilentlyContinue)) { exit 0 }

    $pin = $null
    foreach ($line in (Get-Content $pinFile)) {
        $clean = ($line -split '#', 2)[0].Trim()
        if ($clean) { $pin = Get-Semver $clean; break }
    }
    if (-not $pin) { exit 0 }

    # stdout = "engram X.Y.Z"; stderr = "Update available: A -> B"
    $localRaw = (& engram version 2>$null | Out-String)
    $upstreamRaw = (& engram version 2>&1 | Out-String)

    $local = Get-Semver $localRaw
    if (-not $local) { exit 0 }

    $goPkg = 'github.com/Gentleman-Programming/engram/cmd/engram'
    $cmd = "go install $goPkg@v$pin"
    $needsUpgrade = $false

    # --- A · DRIFT ---
    if ($local -ne $pin) {
        if ($local -lt $pin) {
            $needsUpgrade = $true
            Write-Host "⚠ tycon: engram $local — el equipo usa la $pin (con una versión distinta podés no ver memorias que escribió el resto)."
        } else {
            Write-Host "⚠ tycon: tenés engram $local, más nueva que la del equipo ($pin). Las memorias que guardes pueden no verse en las máquinas del resto."
            Write-Host "   Si la $local anda bien, poné ese número en el archivo ``engram-version`` del arnés y commiteá: el resto se actualiza solo."
        }
    }

    # --- A2 · ALINEACIÓN AUTOMÁTICA (sólo si estás ATRASADO; nunca downgrade) ---
    if ($needsUpgrade) {
        $failedStamp = Join-Path $HOME '.claude\.tycon-engram-upgrade-failed'
        $goBin = $null
        try { $goBin = (& go env GOPATH 2>$null | Out-String).Trim() } catch { }
        $engramPath = (Get-Command engram -ErrorAction SilentlyContinue).Source

        # Anti-loop: si ya se intentó alinear a ESTA misma versión y quedó en otra, no
        # se reintenta en cada arranque. Un intento que "anda" pero deja otra versión
        # reintentaría para siempre, compilando en cada sesión y sin llegar nunca.
        $alreadyFailed = $false
        if (Test-Path $failedStamp) {
            $alreadyFailed = ((Get-Content $failedStamp -Raw).Trim() -eq $pin.ToString())
        }

        $canAuto = ($env:TYCON_ENGRAM_AUTO_UPGRADE -ne '0') -and
                   (-not $alreadyFailed) -and
                   $goBin -and $engramPath -and
                   ($engramPath -like (Join-Path $goBin 'bin\engram*'))

        if (-not $canAuto) {
            Write-Host "   Actualizá cuando puedas: $cmd"
            if (-not $goBin) { Write-Host "   (necesitás Go — ver onboarding/new-dev-harness-setup.md paso 0)" }
        } else {
            Write-Host "   Actualizando sola a la $pin (compila, puede tardar un poco)…"
            $ok = $false
            try {
                & go install "$goPkg@v$pin" 2>$null
                $ok = ($LASTEXITCODE -eq 0)
            } catch { $ok = $false }

            $new = Get-Semver ((& engram version 2>$null | Out-String))

            if ($ok -and $new -eq $pin) {
                Remove-Item $failedStamp -ErrorAction SilentlyContinue
                Write-Host "   ✓ Listo: engram $new"
            } else {
                try {
                    $dir = Split-Path -Parent $failedStamp
                    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
                    Set-Content -Path $failedStamp -Value $pin.ToString() -NoNewline
                } catch { }
                if (-not $ok) {
                    Write-Host "   ⚠ No se pudo actualizar sola. Probá a mano: $cmd"
                } else {
                    Write-Host "   ⚠ Quedó en la $(if ($new) { $new } else { 'desconocida' }), no en la $pin."
                }
                Write-Host "   No lo reintento solo hasta que la versión del equipo cambie."
            }
        }
    }

    # --- B · UPSTREAM (throttled 7 días) ---
    if ($upstreamRaw -notmatch 'Update available:\s*\S+\s*->\s*(\d+\.\d+\.\d+)') { exit 0 }
    $upstream = Get-Semver $Matches[1]
    if (-not $upstream -or $upstream -le $pin) { exit 0 }

    $stamp = Join-Path $HOME '.claude\.tycon-engram-upstream-notice'
    if (-not $Check) {
        if (Test-Path $stamp) {
            $age = (Get-Date) - (Get-Item $stamp).LastWriteTime
            if ($age.TotalDays -lt 7) { exit 0 }
        }
    }

    Write-Host "ℹ tycon: salió engram $upstream. El equipo sigue en la $pin, nadie la probó todavía."
    Write-Host "   Si la probás unos días y la memoria sigue andando, poné ese número en el archivo ``engram-version`` del arnés: el resto se actualiza solo."

    if (-not $Check) {
        try {
            $dir = Split-Path -Parent $stamp
            if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            Set-Content -Path $stamp -Value $upstream.ToString() -NoNewline
        } catch { }
    }
} catch {
    # Fail-open: nunca romper el arranque de una sesión por un chequeo informativo.
    exit 0
}

exit 0

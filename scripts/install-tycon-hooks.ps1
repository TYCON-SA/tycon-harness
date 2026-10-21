# install-tycon-hooks.ps1 — instala/sincroniza el set canónico de hooks TYCON
# en `~\.claude\settings.json` del dev (Windows; la carpeta de usuario sale de Get-TyconHome, más abajo).
#
# Equivalente PowerShell del install-tycon-hooks.sh (macOS/Linux). Misma lógica:
#   - Idempotente (corre N veces sin duplicar entries).
#   - Silencioso si todo OK; 1 línea por hook agregado si hubo cambio.
#   - Backup automático settings.json.bak.<timestamp> ANTES del primer cambio — salvo lanzado por harness.js
#     (TYCON_HARNESS_SNAPSHOT_DIR puesta): ahí la copia ya la tomó el mecanismo.
#   - Opt-out via env var: $env:TYCON_NO_AUTOINSTALL='1' → exit 0 silencioso.
#   - Atomic write (tmp + Move-Item).
#   - Match semántico de matchers ("Edit|Write" === "Write|Edit").
#
# Hooks que instala (set canónico TYCON, con dispatcher):
#
#   UserPromptSubmit:
#     - clocki/scripts/on-prompt.js
#     - tycon-pipeline/scripts/on-prompt.js
#
#   PostToolUse:
#     - clocki/scripts/touch-activity.js          (sin matcher — cualquier tool, async)
#     - tycon-pipeline/scripts/hook-post-edit.js  (Edit|Write — dispatcher: clocki-enforce + on-edit)
#
#   PreToolUse:
#     - tycon-pipeline/scripts/hook-pre-edit.js   (Edit|Write — dispatcher: DoD frontmatter gate + collision)
#     - tycon-pipeline/scripts/on-pre-commit.js   (Bash|PowerShell — DoD gate Capa 1)
#
# hook-pre/post-edit corren los handlers individuales in-process (1 spawn node/evento).
# La migración remueve los 4 scripts sueltos (SUPERSEDED). ⚠️ Este .ps1 está sin probar en
# Windows — correr una vez antes de confiar.
#
# Uso:
#   pwsh ./install-tycon-hooks.ps1                       # corre el install
#   $env:TYCON_NO_AUTOINSTALL='1'; pwsh ./install-tycon-hooks.ps1  # skip
#   pwsh ./install-tycon-hooks.ps1 -Check                # solo reporta qué falta
#   pwsh ./install-tycon-hooks.ps1 -Link <ruta>          # re-apunta el lugar del arnés (~/.claude/tycon-harness) a otro clon
#   pwsh ./install-tycon-hooks.ps1 -ReportJson <archivo> # además, la lista de piezas que deja;
#                                                        # con `pwsh -File` también anda la forma del .sh: --report-json

# -Enlace es el nombre viejo de -Link (en castellano): sigue andando por el alias de PowerShell hasta el
# retiro, y su uso se anota (más abajo, con la biblioteca ya cargada).
# Sin parámetros por posición: con `& script --report-json x` desde PowerShell, la opción caería callada en
# -Link; así falla con su nombre. `pwsh -File script --report-json x` (como lo lanza harness.js) la toma por el alias.
[CmdletBinding(PositionalBinding = $false)]
param(
    [switch]$Check,
    [Alias('Enlace')][string]$Link,
    [Alias('report-json')][string]$ReportJson,
    [Alias('plan-json')][string]$PlanJson
)

$ErrorActionPreference = 'Stop'
# 🔴 Lo que node escribe por su salida es UTF-8; PowerShell lo decodifica con [Console]::OutputEncoding, que sin consola
# (lanzado por harness.js, por un hook) es la página de códigos OEM de la máquina. Una ruta con acento («usuario de
# práctica») volvería con otros bytes, `Test-Path` no la encontraría y el instalador saldría 1 diciendo que la carpeta de skills
# «no trae tycon-pipeline». Se fija UTF-8 para lo que entra y lo que sale de los programas nativos (lab.js PWSH_UTF8).
# Si no se puede, se sigue.
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

# ============================================================
# Opt-out
# ============================================================
if ($env:TYCON_NO_AUTOINSTALL -eq '1') {
    exit 0
}
# el plan es una mirada: sin -Check escribiría la máquina mientras dice que sólo la describe (espejo
# del .sh)
if ($PlanJson -and -not $Check) {
    [Console]::Error.WriteLine('install-tycon-hooks.ps1: -PlanJson va con -Check (el plan se arma sin escribir nada)')
    exit 2
}

# ============================================================
# PowerShell 7 es un requisito, y si falta se DICE
# ============================================================
# Windows PowerShell 5.1 ni siquiera puede LEER este archivo sin la marca de codificación (UTF-8 sin marca: lo
# decodifica como Windows-1252 y una raya o una flecha dentro de un texto le cierra las comillas), y la línea de arranque
# vieja envuelve todo en `try { … } catch {}`: la máquina quedaría con 0 controles y sin una sola línea de aviso. Dos
# arreglos, juntos:
#   · el archivo lleva la marca de codificación (BOM) para que 5.1 lo lea — la comprueba ps1-readable.test.js;
#   · esta guarda corre antes de escribir nada: UNA línea por la salida estándar con el comando para instalarlo, y
#     salida 1, la misma que «falta node». El texto va sin tildes a propósito: 5.1 escribe la consola en la página de
#     códigos de la máquina y una tilde puede llegar rota.
# A quién le llega (comprobado en un Windows PowerShell 5.1): a quien corre el instalador a mano,
# y a `harness.js doctor`, que marca el requisito en rojo. Por la línea de arranque vieja NO se puede contar con que
# llegue: en Windows, Claude Code lanza los hooks por Git Bash y esa línea ahí no llega ni a correr; lanzada por cmd sí
# imprime esta línea, pero sale 1, y lo que escribe un hook que no sale 0 no entra a la sesión.
# No se intenta que el instalador ande con 5.1: lo que sigue usa cosas de PowerShell 7.
# TYCON_PS_MAJOR_FOR_TEST sólo puede simular una versión MÁS VIEJA que la real (para probar esta guarda con pwsh):
# nunca la saltea.
$TyconPsMajor = $PSVersionTable.PSVersion.Major
if ($env:TYCON_PS_MAJOR_FOR_TEST -match '^\d+$' -and [int]$env:TYCON_PS_MAJOR_FOR_TEST -lt $TyconPsMajor) {
    $TyconPsMajor = [int]$env:TYCON_PS_MAJOR_FOR_TEST
}
if ($TyconPsMajor -lt 7) {
    $TyconSelf = $MyInvocation.MyCommand.Path
    if ($TyconPsMajor -ne $PSVersionTable.PSVersion.Major) {
        # la version es la SIMULADA por la variable de prueba: decirlo, o una maquina sana con la variable olvidada
        # recibiria para siempre un mensaje falso que la manda a instalar lo que ya tiene
        Write-Output ("tycon: la variable TYCON_PS_MAJOR_FOR_TEST=$($env:TYCON_PS_MAJOR_FOR_TEST) esta puesta y simula un PowerShell viejo: " +
            "el instalador NO instalo nada. Es una variable de prueba: sacala del entorno y volve a correrlo.")
        exit 1
    }
    Write-Output ("tycon: FALTA PowerShell 7 (pwsh): los controles del equipo NO quedaron instalados. " +
        "Este instalador no corre con Windows PowerShell $TyconPsMajor. " +
        "Pasos: 1) winget install Microsoft.PowerShell  2) cerrar y volver a abrir la terminal y VS Code  " +
        "3) pwsh -NoProfile -ExecutionPolicy Bypass -File `"$TyconSelf`"")
    exit 1
}

# ============================================================
# La carpeta de usuario: UNA función, la misma en los tres .ps1 que la buscan
# ============================================================
# Los guiones de Node que este archivo llama usan os.homedir(). Con HOME distinta de USERPROFILE (Git Bash la pone así en
# Windows), usar $env:USERPROFILE para settings.json y $HOME para el CLAUDE.md repartiría la instalación en dos
# carpetas. La función es copia exacta en sync-claude-md-blocks.ps1 y harness/bootstrap-fallback.ps1 (lo controla
# installer-ps1.test.sh, sección x): el respaldo vive fuera del árbol y no puede cargar una biblioteca.
# Lo mismo que os.homedir() de Node: en Windows USERPROFILE si esta puesta y, si no, la carpeta del perfil; en Linux y
# Mac HOME y, si no, la del perfil. -Platform es para las pruebas.
function Get-TyconHome([string]$Platform = [Environment]::OSVersion.Platform) {
    if ($Platform -eq 'Win32NT') { $h = $env:USERPROFILE } else { $h = $env:HOME }
    if (-not $h) { $h = [Environment]::GetFolderPath('UserProfile') }
    return $h
}

# ============================================================
# Requisitos (espejo del .sh)
# ============================================================
# Sin `node` los bloques guardados por `Get-Command node` se saltearían callados (el enlace, las integraciones, los
# terceros) y quedaría una instalación a medias que nadie anunciaría. Acá, ANTES de escribir nada: UNA línea que nombra lo
# que falta y remite a los requisitos de la portada, y salida 1. Mira presencia, no versión (el piso lo comprueba
# harness.js). El .sh chequea además `python3` porque lo ejecuta; este archivo no lo usa (es PowerShell y node), y en
# Windows Python suele estar como `python` o `py`: exigir `python3` acá frenaría máquinas que andan. Quien instala
# por `harness.js install` ya pasa por su chequeo de requisitos, que sí lo pide.
# ⚠️ Escrito por lectura, sin máquina Windows (misma deuda declarada que el resto del .ps1).
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    [Console]::Error.WriteLine('✗ tycon: falta node en el PATH — el instalador lo necesita y no escribió nada (ver los requisitos de la portada)')
    exit 1
}

# ============================================================
# Con qué Node corren las llamadas de este instalador (espejo del .sh)
# ============================================================
# El arnés baja su propio Node a <casa>/node/current (scripts/setup/harness/harness-node.js; la casa es TYCON_HOME o
# ~/.tycon — copia de la regla de tycon-home.js#harnessNode, declarada en scripts/tests/fixtures/harness-node-copies.json).
# Si está, las llamadas `& node` de ESTE guion van con él: `node` pasa a ser una función de este guion (en PowerShell una
# función le gana a un programa del PATH). No cambia el PATH ni llega a lo que el guion lance. Sin él, el `node` del PATH.
function Get-HarnessNode {
    if ($env:TYCON_HARNESS_NODE -eq '0') { return $null }
    $casa = if ($env:TYCON_HOME) { $env:TYCON_HOME } else { Join-Path (Get-TyconHome) '.tycon' }
    # una TYCON_HOME relativa se resolvería contra la carpeta actual (un binario puesto en el repo): el Node del PATH
    if (-not [System.IO.Path]::IsPathRooted($casa)) { return $null }
    $cur = Join-Path (Join-Path $casa 'node') 'current'
    foreach ($bin in @((Join-Path $cur 'node.exe'), (Join-Path (Join-Path $cur 'bin') 'node'))) {
        if (Test-Path -LiteralPath $bin -PathType Leaf) { return $bin }
    }
    return $null
}
$script:HarnessNode = Get-HarnessNode
if ($script:HarnessNode) { function node { & $script:HarnessNode @args } }
# `Start-Process` busca el programa en el PATH y no ve la función: lo que se lanza de fondo nombra el binario
$script:NodeProgram = if ($script:HarnessNode) { $script:HarnessNode } else { 'node' }

# ============================================================
# El candado — el MISMO que toma harness.js
# ============================================================
# Corrido suelto (sin TYCON_HARNESS_LOCK_HELD=1), este instalador toma el candado del mecanismo de instalación
# (scripts/setup/harness/lock.js: ~/.claude/.tycon-pipeline/harness/harness.lock). Sin candado, dos
# corridas a la vez (dos sesiones que arrancan juntas, o una a mano mientras harness.js actualiza) leerían y escribirían
# settings.json al mismo tiempo, y la última pisaría a la primera. El segundo que llega se va diciendo «otra sesión está
# instalando», sin escribir nada (salida 0, como el .sh: el que corre hace el mismo trabajo). Lanzado por harness.js no
# se toma: lo tiene el padre. Con -Check tampoco: no escribe. Toda salida de acá en adelante pasa por Exit-Installer,
# que lo suelta.
$LockJs = Join-Path (Join-Path (Join-Path $PSScriptRoot 'setup') 'harness') 'lock.js'
$TyconLockTaken = $false
function Exit-Installer([int]$Code) {
    if ($script:TyconLockTaken) {
        $eapL = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { & node -e 'require(process.argv[1]).release(require("os").homedir())' $script:LockJs 2>$null } catch { } finally { $ErrorActionPreference = $eapL }
        $script:TyconLockTaken = $false
    }
    exit $Code
}
# El texto de un error para UNA línea propia: el de más adentro, sin el «Exception calling "X" with "2"
# argument(s):» con que PowerShell envuelve el de un método de .NET.
function Get-ErrText($ErrorRecord) {
    $e = $ErrorRecord.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    return ("$($e.Message)" -replace '\s+', ' ').Trim()
}

# ── La tanda de Node ─────────────────────────────────────────────────────────────────────────────────
# Este aplicador corre en cada arranque y lanzaría unos 16 procesos sueltos de Node; PowerShell gasta ~50-100 ms en lanzar cada
# uno. scripts/setup/applier-batch.js corre varios pasos en UN proceso y devuelve de cada uno su código y lo que
# escribió, cada trozo con su canal (`o` la salida, `e` la de error) y en orden. Cada llamada de más abajo usa ese
# resultado si la tanda lo trajo; si no (sin la tanda, o una tanda que no dejó su resultado), hace su llamada suelta de
# siempre. La tanda no saca ningún respaldo. Invoke-NodeBatch devuelve @{ <id> = @{ Rc; Chunks } } o $null.
$BatchJs = Join-Path (Join-Path $PSScriptRoot 'setup') 'applier-batch.js'
function Invoke-NodeBatch([object[]]$Steps) {
    if (-not $Steps -or -not $Steps.Count -or -not (Test-Path $script:BatchJs)) { return $null }
    $plan = $null; $out = $null
    $eapB = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $plan = [IO.Path]::GetTempFileName()
        $out = "$plan.out.json"
        [IO.File]::WriteAllText($plan, (ConvertTo-Json -InputObject @{ steps = $Steps } -Depth 6 -Compress), (New-Object System.Text.UTF8Encoding($false)))
        $errB = "$plan.err.txt"
        & node $script:BatchJs --plan $plan --out $out 2>$errB | Out-Null
        $batchRc = $LASTEXITCODE
        # la causa, si la tanda dijo algo (su primera línea): va en el aviso de más abajo
        $whyB = ''
        try { $whyB = "$(@(Get-Content -LiteralPath $errB -Encoding UTF8 -ErrorAction Stop) | Where-Object { $_ } | Select-Object -First 1)".Trim() } catch { }
        # sin resultado no corrió ningún paso (el plan estaba mal, o no pudo empezar a anotar): las sueltas, en silencio
        if (-not (Test-Path -LiteralPath $out)) { return $null }
        # con resultado, lo anotado ya corrió y se usa; lo que falta corre suelto. Si la tanda se cortó, se dice: un paso
        # que corrió sin quedar anotado se repite suelto, y su aviso puede no salir (lo que ya hizo no lo vuelve a hacer)
        $doc = $null
        try { $doc = [IO.File]::ReadAllText($out) | ConvertFrom-Json } catch { $doc = $null }
        $res = @{}
        if ($doc -and $doc.steps) {
            foreach ($p in @($doc.steps.PSObject.Properties)) {
                $res[$p.Name] = @{ Rc = [int]$p.Value.rc; Chunks = @($p.Value.chunks | ForEach-Object { [string]$_ }) }
            }
        }
        if ($batchRc -ne 0 -or -not $doc -or $doc.complete -ne $true) {
            Write-Host "⚠ tycon: la tanda de Node se cortó antes de terminar (salió $batchRc$(if ($whyB) { ": $whyB" })): lo que no dejó anotado corre suelto, y un paso que ya había corrido puede no repetir su aviso"
        }
        if (-not $res.Count) { return $null }
        return $res
    } catch { return $null }
    finally {
        $ErrorActionPreference = $eapB
        foreach ($f in @($plan, $out, $errB)) { if ($f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue } }
    }
}
# lo que un paso escribió por un canal (`o` u `e`), junto
function Get-ChunkText($Chunks, [string]$Kind) {
    return (-join @($Chunks | Where-Object { $_ -and $_.Substring(0, 1) -eq $Kind } | ForEach-Object { $_.Substring(1) }))
}
# un texto en renglones, como PowerShell parte la salida de un programa: sin el renglón vacío del salto final, y sin `\r`
function Split-NativeLines([string]$Text) {
    if (-not $Text) { return @() }
    $lines = $Text -split "`n"
    if ($lines[-1] -eq '') { $lines = $lines[0..($lines.Count - 2)] }
    return @($lines | ForEach-Object { $_.TrimEnd("`r") })
}
# los dos canales en renglones, en el orden en que se escribieron (lo que da `2>&1` en una llamada suelta)
function Get-MergedLines($Chunks) {
    $buf = @{ o = ''; e = '' }
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($c in @($Chunks)) {
        if (-not $c) { continue }
        $k = $c.Substring(0, 1)
        $buf[$k] += $c.Substring(1)
        while (($i = $buf[$k].IndexOf("`n")) -ge 0) { $lines.Add($buf[$k].Substring(0, $i).TrimEnd("`r")); $buf[$k] = $buf[$k].Substring($i + 1) }
    }
    foreach ($k in @('o', 'e')) { if ($buf[$k]) { $lines.Add($buf[$k].TrimEnd("`r")) } }
    return $lines.ToArray()
}
# lo que un paso escribió, otra vez por su canal y en su orden: donde saldría lo que escribe su llamada suelta
function Write-NodeChunks($Chunks) {
    foreach ($c in @($Chunks)) {
        if (-not $c) { continue }
        if ($c.Substring(0, 1) -eq 'o') { [Console]::Out.Write($c.Substring(1)) } else { [Console]::Error.Write($c.Substring(1)) }
    }
    [Console]::Out.Flush(); [Console]::Error.Flush()
}
# ── fin de la tanda de Node (las pruebas que corren un bloque suelto de este archivo copian hasta acá) ──────────────
# Sin lock.js (una copia parcial del árbol) sigue sin candado, y lo DICE en una línea, como cuando lock.js no contesta.
if (-not $Check -and $env:TYCON_HARNESS_LOCK_HELD -ne '1' -and -not (Test-Path $LockJs)) {
    Write-Host "⚠ tycon: falta $LockJs — sigo sin candado (otra corrida a la vez podría pisar settings.json)"
}
if (-not $Check -and $env:TYCON_HARNESS_LOCK_HELD -ne '1' -and (Test-Path $LockJs)) {
    $lockOut = ''
    $eapL = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    # a nombre de ESTE proceso ($PID), no del node que lo toma y termina enseguida: con un dueño muerto el candado se
    # pisa en el acto
    try { $lockOut = (& node -e 'process.stdout.write(JSON.stringify(require(process.argv[1]).acquire(require("os").homedir(), { ownerPid: Number(process.argv[2]) })))' $LockJs $PID 2>$null | Out-String) } catch { } finally { $ErrorActionPreference = $eapL }
    $lock = $null
    try { $lock = $lockOut | ConvertFrom-Json } catch { $lock = $null }
    if ($null -eq $lock) {
        Write-Host "⚠ tycon: no pude tomar el candado de instalación ($LockJs) — sigo sin candado"
    } elseif (-not $lock.ok) {
        Write-Host "tycon: otra sesión está instalando ($($lock.reason)) — no escribo nada; esa corrida hace el mismo trabajo"
        exit 0
    } else {
        $TyconLockTaken = $true
    }
}

# ============================================================
# El registro de lo instalado (espejo del .sh)
# ============================================================
# Con -ReportJson <archivo>, cada pieza del arnés que queda en la máquina al terminar (la que escribió esta corrida Y la que
# ya estaba) se anota `kind<TAB>where<TAB>id` en un temporal; Write-PieceReport arma el arreglo JSON `[{kind, where, id}]`
# sin duplicados y lo escribe atómico — también en la salida temprana de «sin cambios en settings.json», que no llega al
# sync de CLAUDE.md ni a Codex (lo que Windows hace). sync-claude-md-blocks.ps1 anota sus bloques y el espejo por
# TYCON_REPORT_PIECES. La lista declarada (con qué hace Windows): scripts/tests/fixtures/harness-managed-pieces.json.
# Con -Check no se escribe nada; sin la opción, ni el temporal existe.
$PiecesTmp = $null
if ($ReportJson -and -not $Check) {
    try { $PiecesTmp = [IO.Path]::GetTempFileName() } catch { $PiecesTmp = $null }
}
if ($PiecesTmp) { $env:TYCON_REPORT_PIECES = $PiecesTmp } else { Remove-Item Env:TYCON_REPORT_PIECES -ErrorAction SilentlyContinue }
function Record-Piece([string]$Kind, [string]$Where, [string]$Id) {
    if (-not $script:PiecesTmp) { return }
    try { [IO.File]::AppendAllText($script:PiecesTmp, "$Kind`t$([IO.Path]::GetFullPath($Where))`t$Id`n") } catch { }
}

# ============================================================
# El plan para un programa (espejo del .sh)
# ============================================================
# Con -Check -PlanJson <archivo>, cada pieza que esta corrida escribiría, sacaría o dejaría como está se anota
# `kind<TAB>where<TAB>id<TAB>action` (add · update · remove · keep) en un temporal; canonical-path.js anota los enlaces por
# TYCON_PLAN_PIECES. Write-PlanJson arma `[{kind, where, id, action}]` sin repetidos y lo escribe atómico; una pieza que
# no se pudo anotar deja el plan sin escribir (sale 1). Lo lee `harness.js install`. Con -Check no se escribe nada más.
$PlanTmp = $null
$PlanIncomplete = $false
if ($PlanJson) {
    try { $PlanTmp = [IO.Path]::GetTempFileName() } catch { [Console]::Error.WriteLine("install-tycon-hooks.ps1: sin un temporal para el plan ($($_.Exception.Message))"); exit 1 }
}
if ($PlanTmp) { $env:TYCON_PLAN_PIECES = $PlanTmp } else { Remove-Item Env:TYCON_PLAN_PIECES -ErrorAction SilentlyContinue }
function Record-Plan([string]$Kind, [string]$Where, [string]$Id, [string]$Action) {
    if (-not $script:PlanTmp) { return }
    try { [IO.File]::AppendAllText($script:PlanTmp, "$Kind`t$([IO.Path]::GetFullPath($Where))`t$Id`t$Action`n") } catch { $script:PlanIncomplete = $true }
}
function Write-PlanJson {
    if (-not $script:PlanTmp) { return }
    try {
        if ($script:PlanIncomplete) {
            [Console]::Error.WriteLine('install-tycon-hooks.ps1: el plan quedó incompleto (alguna pieza no se pudo anotar): no lo escribo')
            exit 1
        }
        $seen = @{}; $out = New-Object System.Collections.ArrayList
        foreach ($line in [IO.File]::ReadAllLines($script:PlanTmp)) {
            $p = $line -split "`t"
            if ($p.Count -ne 4 -or -not $p[0] -or -not $p[1] -or -not $p[2] -or ('add', 'update', 'remove', 'keep' -notcontains $p[3])) { continue }
            $key = "$($p[0])`t$([IO.Path]::GetFullPath($p[1]))`t$($p[2])"
            if ($seen.ContainsKey($key)) {
                # la misma pieza anotada dos veces: gana la acción que cambia algo
                if ($out[$seen[$key]].action -eq 'keep' -and $p[3] -ne 'keep') { $out[$seen[$key]].action = $p[3] }
                continue
            }
            $seen[$key] = $out.Count
            [void]$out.Add([ordered]@{ kind = $p[0]; where = [IO.Path]::GetFullPath($p[1]); id = $p[2]; action = $p[3] })
        }
        $dst = [IO.Path]::GetFullPath($PlanJson)
        # con -InputObject una lista de una sola pieza sale como lista (medido con pwsh 7; -AsArray la envolvería dos veces)
        $json = if ($out.Count) { ConvertTo-Json -InputObject $out.ToArray() -Depth 4 } else { '[]' }
        $tmp = "$dst.tmp.$PID"
        [IO.File]::WriteAllText($tmp, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -Path $tmp -Destination $dst -Force
    } catch {
        [Console]::Error.WriteLine("install-tycon-hooks.ps1: no pude escribir el plan en ${PlanJson}: $($_.Exception.Message)")
        exit 1
    } finally {
        Remove-Item -LiteralPath $script:PlanTmp -ErrorAction SilentlyContinue
    }
}
# Los bloques de CLAUDE.md en el plan: con -Check el sync corre también con -Check y no anota nada, así que se calculan acá
# con la regla del cuerpo del sync: entero en su lugar → keep; el marcador está y el cuerpo no → update; no está → add. Un bloque que pide una integración apagada no se anota (el sync no lo escribe).
# Los marcadores de las primeras líneas de un bloque y su cuerpo (la regla de read_block del sync .sh y de Read-SyncBlock
# del sync .ps1): `requires-integration` y `requires-profile`, uno de cada uno como mucho y en
# cualquier orden; un marcador casi bien escrito (o repetido) es «no se pudo saber» y tampoco se copia.
function Get-BlockMarkers([string]$Text) {
    $lines = $Text.Split([char]10)
    $req = $null; $prof = $null; $bad = $false; $i = 0
    while ($i -lt $lines.Count) {
        $m = [regex]::Match($lines[$i], '^<!--\s*requires-integration:\s*([a-z]+)\s*-->\s*$')
        $p = [regex]::Match($lines[$i], '^<!--\s*requires-profile:\s*([a-z]+(?:\s*,\s*[a-z]+)*)\s*-->\s*$')
        if ($m.Success -and $null -eq $req) { $req = $m.Groups[1].Value }
        elseif ($p.Success -and $null -eq $prof) {
            $prof = @($p.Groups[1].Value.Split(',') | ForEach-Object { $_.Trim() })
            if (@($prof | Where-Object { @('minimal', 'full') -notcontains $_ }).Count) { $bad = $true }
        }
        elseif ($m.Success -or $p.Success) { $bad = $true }
        else { break }
        $i++
    }
    $rest = @(if ($i -lt $lines.Count) { $lines[$i..($lines.Count - 1)] })
    if (-not $bad) {
        for ($idx = 0; $idx -lt $rest.Count; $idx++) {
            if (-not $rest[$idx].Trim()) { continue }
            if ([regex]::IsMatch($rest[$idx], '^\s*<!--\s*requires-(integration|profile)\b', 'IgnoreCase')) {
                $bad = $true
                $rest = @(for ($k = 0; $k -lt $rest.Count; $k++) { if ($k -ne $idx) { $rest[$k] } })
            }
            break
        }
    }
    return @{ Body = ($rest -join "`n").Trim("`n"); Requires = $req; Profiles = $prof; Bad = $bad }
}
# cómo contesta el asistente (idioma, estilo y tope), leído UNA vez del lector; $null si no se pudo saber
$script:PlanResponse = $null
function Get-PlanResponse([string]$Tree) {
    if ($null -eq $script:PlanResponse) {
        $script:PlanResponse = $false
        try {
            # lo leyó la tanda de la lectura (sin otro proceso de Node); sin tanda, una pregunta propia
            if ($script:ReadBatch -and $script:ReadBatch['response']) { $rc = $script:ReadBatch['response'].Rc; $out = (Split-NativeLines (Get-ChunkText $script:ReadBatch['response'].Chunks 'o')) }
            else { $out = & node (Join-Path (Join-Path (Join-Path $Tree 'scripts') 'lib') 'tycon-config.js') response --json 2>$null; $rc = $LASTEXITCODE }
            if ($rc -eq 0) { $d = ($out | Out-String) | ConvertFrom-Json; if ($d -and $d.style -and $d.language -and $d.max_chars) { $script:PlanResponse = $d } }
        } catch { }   # sin saber, el plan dice «keep» (lo que va a hacer el sync); el motivo lo dice el sync al correr

    }
    if ($script:PlanResponse) { return $script:PlanResponse } else { return $null }
}
function Record-BlocksPlan {
    if (-not $script:PlanTmp -or $env:TYCON_NO_CLAUDEMD_SYNC -eq '1') { return }
    try {
        $tree = Split-Path -Parent $PSScriptRoot
        $blocksDir = Join-Path $tree 'claude-md-blocks'
        $target = $env:CLAUDE_MD_PATH
        if (-not $target) { $target = Join-Path (Get-TyconHome) '.claude\CLAUDE.md' }
        if (-not (Test-Path $blocksDir)) { return }
        # con \r\n pasados a \n, como los lee el sync: si no, un bloque con \r\n saldría «update» siempre
        $content = if (Test-Path $target) { [IO.File]::ReadAllText($target).Replace("`r`n", "`n") } else { '' }
        # cada bloque es un `.md` de la raíz; uno que declara `<!-- variants: response -->` toma su texto de
        # la carpeta del mismo nombre, como lo lee el sync; orden por código de carácter, como el sync
        $list = New-Object System.Collections.Generic.List[object]
        foreach ($f in @(Get-ChildItem -Path $blocksDir -Filter '*.md' -File)) {
            $isVariant = [bool]([regex]::Match([IO.File]::ReadAllText($f.FullName).Replace("`r`n", "`n"), '^(?:<!--\s*requires-(?:integration|profile):[^\n]*-->\n)*<!--\s*variants:\s*response\s*-->\s*(?:\n|$)').Success)
            $list.Add([pscustomobject]@{ Name = [IO.Path]::GetFileNameWithoutExtension($f.Name); Path = $f.FullName; Variant = $isVariant })
        }
        # los bloques de los paquetes activos (`packs/<p>/<n>`), como los lista el sync; uno de paquete escrito que ya no
        # corresponde es un «remove»; sin saber qué paquetes activa la organización, «keep»
        $packRe = '<!--\s*TYCON_BLOCK:(packs/[^/\s>]+/[^/\s>]+)\s+START'
        $packFiles = @(Get-ChildItem -Path (Join-Path $tree 'packs') -Directory -ErrorAction SilentlyContinue | ForEach-Object { Get-ChildItem -Path (Join-Path $_.FullName 'claude-md-blocks') -Filter '*.md' -File -ErrorAction SilentlyContinue })
        $packData = $null; $packAsked = $false
        if ([regex]::IsMatch($content, $packRe) -or $packFiles.Count) {
            $packAsked = $true
            try {
                $pout = & node (Join-Path (Join-Path (Join-Path $tree 'scripts') 'lib') 'pack-pieces.js') blocks --json --tree $tree 2>$null
                if ($LASTEXITCODE -eq 0) { $pd = ($pout | Out-String) | ConvertFrom-Json; if ($pd -and $null -ne $pd.active) { $packData = $pd } }
            } catch { }
            if ($packData) { foreach ($b in @($packData.blocks)) { if ($b.name -and $b.file) { $list.Add([pscustomobject]@{ Name = [string]$b.name; Path = [string]$b.file; Variant = $false }) } } }
        }
        $list.Sort([Comparison[object]] { param($a, $b) [string]::CompareOrdinal($a.Name, $b.Name) })
        $entries = $list.ToArray()   # (@($list) sobre una List genérica falla en pwsh)
        $listed = @($entries | ForEach-Object { $_.Name })
        foreach ($m in [regex]::Matches($content, $packRe)) {
            $n = $m.Groups[1].Value
            if ($listed -ccontains $n) { continue }
            Record-Plan 'block' $target "TYCON_BLOCK:$n" $(if ($packAsked -and $packData) { 'remove' } else { 'keep' })
        }
        foreach ($e in $entries) {
            $name = $e.Name
            $present = $content.Contains("<!-- TYCON_BLOCK:$name START")
            $blockFile = $e.Path; $fill = $null
            $activeProfile = if ($ProfileState -eq 'ok') { if ($ProfileValue) { $ProfileValue } else { 'full' } } else { $null }
            if ($e.Variant) {
                # primero las condiciones del bloque (su archivo trae los marcadores), como el sync: apagado se saca, sin saber
                # queda; recién prendido importa el texto que elige la configuración
                $mkStub = Get-BlockMarkers ([IO.File]::ReadAllText($e.Path).Replace("`r`n", "`n"))
                $stubOff = ($mkStub.Requires -and -not (Integ-Prendida $mkStub.Requires)) -or ($mkStub.Profiles -and $activeProfile -and ($mkStub.Profiles -notcontains $activeProfile))
                if (-not $mkStub.Bad -and $stubOff) { if ($present) { Record-Plan 'block' $target "TYCON_BLOCK:$name" 'remove' }; continue }
                if ($mkStub.Bad -or ($mkStub.Profiles -and -not $activeProfile) -or ($mkStub.Requires -and $IntegEstado -ne 'ok')) { if ($present) { Record-Plan 'block' $target "TYCON_BLOCK:$name" 'keep' }; continue }
                # el texto que elige la configuración; sin poder elegirlo, el sync deja el bloque como estaba
                $resp = Get-PlanResponse $tree
                $blockFile = if ($resp) { Join-Path (Join-Path $blocksDir $name) "$($resp.style).$($resp.language).md" } else { $null }
                if (-not $blockFile -or -not (Test-Path $blockFile)) { if ($present) { Record-Plan 'block' $target "TYCON_BLOCK:$name" 'keep' }; continue }
                $fill = [long]$resp.max_chars
            }
            $mk = Get-BlockMarkers ([IO.File]::ReadAllText($blockFile).Replace("`r`n", "`n"))
            # con la integración apagada, o el perfil activo fuera de la lista, el sync lo saca si ya estaba escrito: eso es
            # un «remove» (espejo del .sh); con el perfil sin saber (o un marcador casi bien escrito) no se agrega ni se saca
            $activeProfile = if ($ProfileState -eq 'ok') { if ($ProfileValue) { $ProfileValue } else { 'full' } } else { $null }
            $off = ($mk.Requires -and -not (Integ-Prendida $mk.Requires)) -or ($mk.Profiles -and $activeProfile -and ($mk.Profiles -notcontains $activeProfile))
            if (-not $mk.Bad -and $off) {
                if ($present) { Record-Plan 'block' $target "TYCON_BLOCK:$name" 'remove' }
                continue
            }
            if (($mk.Bad -or ($mk.Profiles -and -not $activeProfile)) -and -not $present) { continue }
            $body = $mk.Body
            if ($null -ne $fill) { $body = $body.Replace('{{max_chars}}', "$fill").Replace('{{max_lines}}', "$([long][Math]::Floor(($fill + 50) / 100))") }
            # las filas con su integración, como las escribe el sync: prendida queda, apagada no; sin saber,
            # queda si ya estaba en el CLAUDE.md
            $end0 = "<!-- TYCON_BLOCK:$name END -->"
            $i0 = $content.IndexOf("<!-- TYCON_BLOCK:$name START"); $j0 = if ($i0 -ge 0) { $content.IndexOf($end0, $i0) } else { -1 }
            $prev = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
            if ($j0 -ge 0) { foreach ($l in $content.Substring($i0, $j0 - $i0).Split([char]10)) { [void]$prev.Add($l) } }
            $body = (@(foreach ($line in $body.Split([char]10)) {
                $m = [regex]::Match($line, '^(.*\|)[ \t]*<!--\s*integration:\s*([a-z]+)\s*-->\s*$')
                if (-not $m.Success) { $line; continue }
                $row = $m.Groups[1].Value.TrimEnd()
                if ($IntegEstado -eq 'ok') { if (Integ-Prendida $m.Groups[2].Value) { $row } } elseif ($prev.Contains($row)) { $row }
            }) -join "`n")
            $src = if ($name -match '^packs/([^/]+)/([^/]+)$') { "packs/$($Matches[1])/claude-md-blocks/$($Matches[2]).md" } else { "claude-md-blocks/$name.md" }
            $start = "<!-- TYCON_BLOCK:$name START — generado por scripts/setup/sync-claude-md-blocks.sh del arnés · NO EDITAR A MANO (se pisa en el próximo SessionStart); editá $src y commiteá -->"
            $action = if ($content.Contains("$start`n$body`n<!-- TYCON_BLOCK:$name END -->")) { 'keep' } elseif ($present) { 'update' } else { 'add' }
            Record-Plan 'block' $target "TYCON_BLOCK:$name" $action
        }
    } catch { $script:PlanIncomplete = $true }
}
function Write-PieceReport {
    if (-not $script:PiecesTmp) { return }
    try {
        $seen = @{}; $out = New-Object System.Collections.ArrayList
        foreach ($line in [IO.File]::ReadAllLines($script:PiecesTmp)) {
            $p = $line -split "`t"
            if ($p.Count -ne 3 -or -not $p[0] -or -not $p[1] -or -not $p[2] -or $seen.ContainsKey($line)) { continue }
            $seen[$line] = $true
            [void]$out.Add([ordered]@{ kind = $p[0]; where = $p[1]; id = $p[2] })
        }
        $dst = [IO.Path]::GetFullPath($ReportJson)
        $dstDir = Split-Path -Parent $dst
        if ($dstDir -and -not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
        $json = if ($out.Count) { ConvertTo-Json -InputObject $out.ToArray() -Depth 4 } else { '[]' }
        $tmp = "$dst.tmp.$PID"
        [IO.File]::WriteAllText($tmp, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -Path $tmp -Destination $dst -Force
    } catch {
        # el instalador hizo su trabajo: se dice y sale 0; quien lo llamó encuentra el archivo ausente y no funde nada
        Write-Host "⚠ tycon: no pude escribir el reporte de piezas en ${ReportJson}: $($_.Exception.Message)"
    } finally {
        Remove-Item -LiteralPath $script:PiecesTmp -ErrorAction SilentlyContinue
        $script:PiecesTmp = $null
    }
}
# Cada corrida llega a sync-claude-md-blocks.ps1, que es quien anota los bloques (no hay salida temprana que los salte).
# La prueba es T18 F10 de harness-uninstall.test.sh, por ejecución.

# ── El lugar del arnés: ~/.claude/tycon-harness, y el nombre viejo (espejo del .sh) ──
# Los revisores, pasos y skills nombran al arnés por este lugar. La regla de nacimiento vive en canonical-path.js (el
# lugar nace hacia donde apunta el nombre viejo o el estado, no hacia el clon que corre; el viejo se re-apunta al lugar). En Windows se crea un JUNCTION
# (fs.symlinkSync(..., 'junction') dentro de canonical-path.js): un symlink de directorio pide modo
# desarrollador o admin, el junction no. Lo crea si falta, lo repara si está colgado, NO mueve uno que
# apunte a otro clon válido (sólo -Link <ruta> lo re-apunta) y no pisa una carpeta real. Respeta -Check.
# VERIFICADO SÓLO POR LECTURA (sin máquina Windows del autor): deuda declarada, igual que el aviso de abajo.
$rutaCanonica = Join-Path (Join-Path $PSScriptRoot 'lib') 'canonical-path.js'
$SkillsDirJs = Join-Path (Join-Path $PSScriptRoot 'lib') 'skills-dir.js'
$cfgJs = Join-Path (Join-Path $PSScriptRoot 'lib') 'tycon-config.js'
# ¿este clon trae skills/ y agents/? (la condición de Invoke-RepoLinks, más abajo: sin ellas, sin enlaces del repo único)
$RepoLinksHere = (Test-Path (Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'skills') 'tycon-pipeline')) -and (Test-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'agents'))

# La lectura, en una tanda: en el orden de siempre, el lugar del arnés, el enlace de agent-skills, el aviso
# de «el arnés no está donde cree», dónde están las skills y de dónde salió esa carpeta (las dos preguntas de
# Get-InstalledSkillsDir, sin la variable TYCON_SKILLS_DIR), qué integraciones están prendidas, el perfil de instalación
# y las piezas del lugar. Cada respuesta se usa, y lo que dice se imprime, en su lugar de siempre. Las de la
# configuración se usan más abajo: leerlas acá no cambia lo que contestan (lo que corre en el medio no toca la
# configuración del arnés). Cada paso entra sólo si su guion está, como cada llamada suelta lo mira antes de correr.
# Con -Link no hay tanda: un -Link que no se puede cumplir sale 2 antes de tocar nada más, como siempre.
$ReadBatch = $null
if (-not $Link) {
    $readSteps = @()
    if (Test-Path $rutaCanonica) {
        $readSteps += @{ id = 'place'; script = 'canonical-path'; args = @(@('--ensure-link', '--clone', (Split-Path -Parent $PSScriptRoot)) + @(if ($Check) { '--check' })) }
        if ($RepoLinksHere) { $readSteps += @{ id = 'links'; script = 'canonical-path'; args = @(@('--ensure-repo-links', '--clone', (Split-Path -Parent $PSScriptRoot), '--only', 'agent-skills') + @(if ($Check) { '--check' })) } }
        $readSteps += @{ id = 'notice'; script = 'canonical-path'; args = @() }
    }
    if (Test-Path $SkillsDirJs) {
        $readSteps += @{ id = 'skills'; script = 'skills-dir'; args = @('--skills', '--installed'); env = @{ TYCON_SKILLS_DIR = $null } }
        $readSteps += @{ id = 'source'; script = 'skills-dir'; args = @('--source', '--installed'); env = @{ TYCON_SKILLS_DIR = $null } }
    }
    if (Test-Path $cfgJs) {
        $readSteps += @{ id = 'integrations'; script = 'tycon-config'; args = @('integrations', '--json') }
        $readSteps += @{ id = 'profile'; script = 'tycon-config'; args = @('get', 'install.profile') }
        # cómo contesta el asistente: lo usan el plan y el sync de bloques, en la misma tanda
        $readSteps += @{ id = 'response'; script = 'tycon-config'; args = @('response', '--json') }
    }
    if ($script:PiecesTmp -and (Test-Path $rutaCanonica)) {
        $readSteps += @{ id = 'pieces'; script = 'canonical-path'; args = @('--place-pieces', '--home', (Get-TyconHome)) }
    }
    $ReadBatch = Invoke-NodeBatch $readSteps
}

if ((Test-Path $rutaCanonica) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    $clon = Split-Path -Parent $PSScriptRoot
    $enlaceArgs = @('--ensure-link', '--clone', $clon)
    if ($Check) { $enlaceArgs += '--check' }
    if ($Link) { $enlaceArgs += @('--link', $Link) }
    # EAP=Continue + try/catch: con 'Stop' global, una llamada que tira acá mataría el instalador con el
    # candado tomado. Un node que sale distinto de 0 no tira: se mira $LASTEXITCODE.
    $enlaceRc = 0
    if ($ReadBatch -and $ReadBatch['place']) {
        # lo corrió la tanda de lectura: lo que escribió, otra vez acá, por su canal y en su orden
        Write-NodeChunks $ReadBatch['place'].Chunks; $enlaceRc = $ReadBatch['place'].Rc
    } else {
        $eapE = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { & node $rutaCanonica @enlaceArgs; $enlaceRc = $LASTEXITCODE }
        catch { $enlaceRc = -1; Write-Host "⚠ tycon: no pude lanzar canonical-path.js para el lugar del arnés ($(Get-ErrText $_)) — sigo sin tocarlo" }
        finally { $ErrorActionPreference = $eapE }
    }
    if ($enlaceRc -eq 2) { Exit-Installer 2 }   # sólo un -Link que no se puede cumplir sale 2; un enlace que no se pudo escribir avisa y el instalador sigue
} elseif ($Link) {
    # una línea limpia por la salida de error: Write-Error, con $ErrorActionPreference='Stop', imprime el formato de
    # error de PowerShell (el archivo, «Line |», la línea subrayada) en vez del mensaje
    [Console]::Error.WriteLine('install-tycon-hooks.ps1: -Link necesita node y scripts/lib/canonical-path.js')
    Exit-Installer 2
}

# ── Los enlaces del repo único (espejo del .sh) ─────────────────────
# Cuando ESTE clon trae skills/ y agents/ en su raíz (el repo público: el arnés y agent-skills juntos):
# ~/.claude/agent-skills → el clon, ~/.claude/agents → <clon>/agents y ~/.claude/skills → <clon>/skills, con las reglas
# del enlace de arriba; si agents/ o skills/ ya son carpetas reales, un enlace por entrada. Dos llamadas: ACÁ sólo
# agent-skills (la verificación de más abajo y el paso de terceros lo necesitan); agents y skills DESPUÉS del paso de
# terceros. En el clon del equipo no imprime ni toca nada. Respeta -Check; las piezas `link` las anota el propio guion
# en TYCON_REPORT_PIECES. En Windows el enlace a una carpeta es un junction; el enlace por entrada a un ARCHIVO (cada
# revisor es un `.md`) prueba primero el enlace de archivo (pide el modo desarrollador), después un enlace duro, y si
# tampoco puede canonical-path.js lo dice en una línea y no escribe.
# El clon del equipo TAMBIÉN trae skills/ y agents/, y la máquina puede tener además su clon viejo de agent-skills en
# ~/.claude/agent-skills (dos clones). Ahí tampoco imprime ni toca nada: lo decide canonical-path.js
# (`separateSkillsClone`), igual para este archivo y para el .sh. Una carpeta real en ese lugar que NO es un clon de
# agent-skills sigue avisando.
function Invoke-RepoLinks([string]$Only) {
    # sólo si el clon trae skills/ y agents/: en un clon sin ellas ni se lanza node (este archivo corre en cada arranque)
    $root = Split-Path -Parent $PSScriptRoot
    if (-not ((Test-Path (Join-Path (Join-Path $root 'skills') 'tycon-pipeline')) -and (Test-Path (Join-Path $root 'agents')))) { return }
    if (-not (Test-Path $rutaCanonica)) { return }
    # lo corrió una tanda: agent-skills la de lectura, entries la de aplicación. Lo que escribió, otra vez acá
    $fromBatch = if ($Only -eq 'agent-skills') { if ($script:ReadBatch) { $script:ReadBatch['links'] } } else { if ($script:ApplyBatch) { $script:ApplyBatch['entries'] } }
    if ($fromBatch) { Write-NodeChunks $fromBatch.Chunks; return }
    $rlArgs = @('--ensure-repo-links', '--clone', (Split-Path -Parent $PSScriptRoot), '--only', $Only)
    if ($Check) { $rlArgs += '--check' }
    try { & node $rutaCanonica @rlArgs } catch { }   # un enlace que no se pudo escribir avisa, no frena
}
Invoke-RepoLinks 'agent-skills'

# ── ¿El arnés está donde el arnés cree que está? (mira el enlace) ────
# Aviso por stdout si el clon que corre este instalador no es el que apunta el enlace (o el enlace
# falta, está colgado o es una carpeta). Nunca frena; sin node, silencio. Detalle: scripts/lib/canonical-path.js.
# Los nombres viejos de las variables: un interruptor renombrado se lee con Get-LegacyEnv, así el nombre
# en castellano sigue apagando hasta su retiro. Sin la biblioteca, sólo el nombre nuevo.
$legacyNamesPs1 = Join-Path (Join-Path $PSScriptRoot 'lib') 'legacy-names.ps1'
$legacyLoaded = $false
if (Test-Path $legacyNamesPs1) {
    # con try/catch: una biblioteca que tira al cargarse mataría el instalador con el candado tomado
    try {
        . $legacyNamesPs1
        $legacyLoaded = $true
        # el uso del nombre viejo -Enlace (el alias de -Link) se anota como el de cualquier nombre viejo
        if ($Link -and "$($MyInvocation.Line)" -match '(?i)(^|\s)-Enlace(\s|:|$)') { Write-LegacyUse 'option' 'enlace' 'link' 'scripts/install-tycon-hooks.ps1' }
    } catch { Write-Host "⚠ tycon: no pude cargar scripts/lib/legacy-names.ps1 ($(Get-ErrText $_)) — sigo leyendo sólo los nombres nuevos de las variables" }
}
if (-not $legacyLoaded -or -not (Get-Command Get-LegacyEnv -ErrorAction SilentlyContinue)) { function Get-LegacyEnv([string]$Name, [string]$Where) { return [Environment]::GetEnvironmentVariable($Name) } }
if ((Get-LegacyEnv 'TYCON_NO_CANONICAL_PATH' -Where 'scripts/install-tycon-hooks.ps1') -ne '1') {
    if (Test-Path $rutaCanonica) {
        # lo corrió la tanda de lectura: su salida estándar acá, como la llamada suelta con `2>$null`
        if ($ReadBatch -and $ReadBatch['notice']) { Write-NodeChunks @($ReadBatch['notice'].Chunks | Where-Object { $_ -and $_.Substring(0, 1) -eq 'o' }) }
        else { try { & node $rutaCanonica 2>$null } catch { } }
    }
}

# ============================================================
# Paths
# ============================================================
$ClaudeDir   = Join-Path (Get-TyconHome) '.claude'   # la carpeta de os.homedir(): la misma que usan los guiones de Node
$Settings    = Join-Path $ClaudeDir 'settings.json'

# ── Dónde están las skills: lo contesta la regla, no una ruta escrita (espejo del .sh) ───────────
# La regla vive en scripts/lib/skills-dir.js (contrato C3) y acá se le pregunta con la variante de quien ESCRIBE en la
# máquina (`--installed`: lo instalado mientras exista; si no, el propio clon), y SIN la variable TYCON_SKILLS_DIR: una
# variable que apunta a un clon de trabajo no puede re-apuntar los hooks de la máquina a una carpeta que mañana se borra.
# Este archivo no corre las suites rápidas del .sh: sólo escribe, así que sólo usa esa variante.
# Devuelve la línea que da la biblioteca, o $null si la carpeta no existe (su motivo queda en $script:SkillsWhy).
# Va acá y no antes: en el repo único, Invoke-RepoLinks 'agent-skills' acaba de dejar el enlace, que es «lo instalado».
# ⚠️ Medido con pwsh en macOS (installer-ps1.test.sh); en Windows, NO MEDIDO (misma deuda declarada que el resto del .ps1).
$SkillsWhy = ''   # ($SkillsDirJs se define arriba, con la tanda de lectura)
function Get-InstalledSkillsDir([string]$Field) {
    # Sin la biblioteca (una copia parcial de este archivo): lo de siempre, la ruta instalada. Es el único lugar donde
    # queda escrita, y sólo vale cuando no hay a quién preguntarle.
    if (-not (Test-Path $SkillsDirJs)) { if ($Field -eq '--source') { return 'installed' } else { return (Join-Path (Join-Path $ClaudeDir 'agent-skills') 'skills') } }
    $prevVar = $env:TYCON_SKILLS_DIR
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $lines = @(); $rc = 0
    # lo que trajo la tanda de la lectura: la misma llamada, sin la variable; si no lo trajo, la suelta
    $fromBatch = if ($script:ReadBatch) { $script:ReadBatch[$(if ($Field -eq '--source') { 'source' } else { 'skills' })] } else { $null }
    if ($fromBatch) {
        $ErrorActionPreference = $eap
        $rc = $fromBatch.Rc
        $lines = @(Split-NativeLines (Get-ChunkText $fromBatch.Chunks 'o'))
        if ($rc -ne 0 -and -not $lines.Count) { $lines = @(Split-NativeLines (Get-ChunkText $fromBatch.Chunks 'e')) }
    } else {
        try {
            $env:TYCON_SKILLS_DIR = ''
            # Un node que sale distinto de 0 NO lanza en PowerShell: se mira $LASTEXITCODE, como las otras llamadas de este archivo.
            # Se leen la salida y el error POR SEPARADO: con `2>&1` un aviso por stderr (el del enlace que falta) puede quedar como la
            # primera línea y tomarse por la carpeta de skills
            $errTmp = [IO.Path]::GetTempFileName()
            try {
                $lines = @(& node $SkillsDirJs $Field --installed 2>$errTmp | ForEach-Object { "$_" }); $rc = $LASTEXITCODE
                if ($rc -ne 0 -and -not $lines.Count) { $lines = @(Get-Content -LiteralPath $errTmp -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object { "$_" }) }
            } finally { Remove-Item -LiteralPath $errTmp -Force -ErrorAction SilentlyContinue }
        } catch { $lines = @("$($_.Exception.Message)"); $rc = -1 }
        finally {
            $ErrorActionPreference = $eap
            if ($null -eq $prevVar) { Remove-Item Env:TYCON_SKILLS_DIR -ErrorAction SilentlyContinue } else { $env:TYCON_SKILLS_DIR = $prevVar }
        }
    }
    $first = if ($lines.Count) { "$($lines[0])".Trim() } else { '' }
    if ($rc -eq 0 -and $first) { return $first }
    $script:SkillsWhy = if ($first) { $first -replace '^skills-dir: ', '' } else { "scripts/lib/skills-dir.js no contestó (salió $rc)" }
    return $null
}
# (las dos preguntas de Get-InstalledSkillsDir, como las de la configuración, corren en la tanda de lectura, arriba)
$AgentSkills = Get-InstalledSkillsDir '--skills'
$SkillsFrom  = if ($AgentSkills) { Get-InstalledSkillsDir '--source' } else { $null }

# los dos nombres del lugar (junctions) son del arnés aunque esta corrida no los haya tocado: una pieza `link` por cada
# nombre que ES un enlace, y lo pregunta Node, como el .sh. Lo trae la tanda de lectura.
if ($script:PiecesTmp -and (Test-Path $rutaCanonica) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    $pieceLines = if ($ReadBatch -and $ReadBatch['pieces']) { @(Split-NativeLines (Get-ChunkText $ReadBatch['pieces'].Chunks 'o')) }
                  else { @(& node $rutaCanonica '--place-pieces' '--home' (Split-Path -Parent $ClaudeDir) 2>$null) }
    foreach ($pieceLine in $pieceLines) {
        $parts = "$pieceLine" -split "`t"
        if ($parts.Count -eq 3 -and $parts[0] -eq 'link') { Record-Piece 'link' $parts[1] $parts[2] }
    }
}

# Skeleton si no existe. Con -Check no se escribe: más abajo un settings.json que falta se lee como vacío.
# Un fallo (carpeta sin permiso, ~/.claude que es un archivo) se DICE en una línea y sale por Exit-Installer, que suelta el
# candado (con 'Stop' global tiraría y el candado quedaría tomado hasta 10 min).
if (-not (Test-Path $Settings) -and -not $Check) {
    try {
        New-Item -ItemType Directory -Force -Path $ClaudeDir -ErrorAction Stop | Out-Null
        @'
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "hooks": {}
}
'@ | Set-Content -NoNewline -Path $Settings -Encoding UTF8 -ErrorAction Stop
    } catch {
        [Console]::Error.WriteLine("✗ tycon: no pude crear $Settings ($(Get-ErrText $_)): no registré ningún hook")
        Exit-Installer 1
    }
}

# Verificar agent-skills: dónde ESCRIBE esta corrida (ver Get-InstalledSkillsDir, arriba; espejo del .sh).
#   · lo instalado existe            → la ruta instalada, la que queda en settings.json (dos clones, o el enlace).
#   · no existe y el clon es unido   → sólo con -Check: -Check no crea los enlaces, así que esta
#                                      corrida mira las skills en el propio clon —donde el enlace las va a dejar—. Sin
#                                      -Check es que el enlace no se pudo crear (ya se avisó arriba): sale 1, como siempre.
#   · no existe en ningún lado       → sale 1 con una línea que trae el motivo que da la biblioteca.
$CheckInClone = $null
if ($AgentSkills -and -not (Test-Path (Join-Path $AgentSkills 'tycon-pipeline'))) {
    $SkillsWhy = "$AgentSkills no trae tycon-pipeline"; $AgentSkills = $null
} elseif ($AgentSkills -and $SkillsFrom -ne 'installed' -and -not $Check) {
    $SkillsWhy = "~/.claude/agent-skills no está (el enlace al clon no se pudo crear) y sin él no registro hooks hacia $AgentSkills"; $AgentSkills = $null
}
if (-not $AgentSkills) {
    [Console]::Error.WriteLine("✗ tycon: agent-skills no encontrado — $SkillsWhy — ver el README.md del arnés, 'Instalación'")   # una línea limpia
    Exit-Installer 1
}
$AgentSkillsRepo = Split-Path -Parent $AgentSkills   # la raíz que trae skills/ y agents/ (el contrato: skills = <raíz>/skills)
if ($SkillsFrom -ne 'installed') {
    $CheckInClone = $AgentSkillsRepo   # el paso de terceros de más abajo también mira ahí
    Write-Host "(--check) tycon: ~/.claude/agent-skills todavía no está: esta revisión mira las skills en $AgentSkills (el instalador crea el enlace)"
}

# ── El mecanismo de instalación ─────────────────────────────────────
# En una máquina que todavía no tiene estado (`~/.claude/.tycon-pipeline/harness-state.json`), este aplicador crea el
# estado sobre el clon, el enlace y el agent-skills que ya están, copia el arranque fijo y migra la línea de arranque UNA
# sola vez (`harness.js install --from-existing`: sin candado propio ni aplicador anidado — TYCON_HARNESS_LOCK_HELD=1).
# Corre DESPUÉS de escribir settings.json cuando hubo cambios, y TAMBIÉN en el camino del `exit 0` temprano cuando no los
# hubo: la migración de la línea no puede depender de que haya hooks nuevos. Con -Check no se llama. Un `node` por
# debajo del piso: harness.js lo dice en una línea y deja la línea vieja, que sigue haciendo el pull.
function Invoke-HarnessFromExisting {
    if ($Check) { return }
    # lanzado POR harness.js: el estado lo escribe quien lo lanzó (se escribiría dos veces, con una copia de más)
    if ($env:TYCON_HARNESS_LOCK_HELD -eq '1') { return }
    $harnessJs = Join-Path (Join-Path $PSScriptRoot 'setup') 'harness.js'
    $stateFile = Join-Path (Join-Path $ClaudeDir '.tycon-pipeline') 'harness-state.json'
    if (-not (Test-Path $harnessJs) -or (Test-Path $stateFile)) { return }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return }
    $prev = $env:TYCON_HARNESS_LOCK_HELD
    $env:TYCON_HARNESS_LOCK_HELD = '1'
    try { & node $harnessJs install --from-existing }
    catch { Write-Host "⚠ tycon: no pude crear el estado del mecanismo de instalación (harness.js install --from-existing: $($_.Exception.Message)); seguís con la línea de arranque vieja y se reintenta en la próxima corrida" }
    finally {
        if ($null -eq $prev) { Remove-Item Env:TYCON_HARNESS_LOCK_HELD -ErrorAction SilentlyContinue } else { $env:TYCON_HARNESS_LOCK_HELD = $prev }
    }
}

# ── La aplicación, en una tanda ──────────────────────────────────────────────────────────────────────
# En el orden de siempre: las skills de terceros, los enlaces de agents y skills, los nombres viejos y los hooks de
# settings.json (más abajo). Entre esos pasos este archivo sólo imprime y anota (el estado de las integraciones y del
# perfil, el plan, las piezas): nada de lo que hacen depende de eso. Cada resultado se usa, y lo que escribió se imprime,
# en su lugar de siempre. El temporal del aplicador se pide acá; si no se puede, el registro de hooks corre suelto más
# abajo, que lo vuelve a pedir y dice por qué no pudo. Cada paso entra sólo si su guion está, como cada llamada suelta.
$ThirdPartyJs = Join-Path (Join-Path $PSScriptRoot 'publishing') 'install-third-party.js'
$tpArgs = @()
if ($Check) { $tpArgs += '--check' }
# los argumentos de las dos llamadas sueltas de abajo, para la tanda: la del modo revisión sin el enlace todavía y la de
# siempre (las dos explicadas abajo)
$tpRunArgs = if ($CheckInClone) { @('--repo', $CheckInClone, '--check') } else { @(@('--repo', $AgentSkillsRepo) + $tpArgs) }
$LegacyNames = Join-Path (Join-Path $PSScriptRoot 'lib') 'legacy-names.js'
$lnArgs = @('--migrate-machine', '--guides', (Split-Path -Parent $PSScriptRoot), '--skills', $AgentSkillsRepo)
if ($Check) { $lnArgs += '--check' }
$ApplyJs = Join-Path (Join-Path $PSScriptRoot 'setup') 'apply-hooks.js'
function New-ApplyArgs([string]$JsonOut) {
    $a = @('--settings', $Settings, '--hooks-dir', (Join-Path $PSScriptRoot 'hooks'), '--skills', $AgentSkills, '--platform', 'windows', '--json-out', $JsonOut)
    if ($Check) { $a += '--check' }
    return , $a
}
$ApplyOut = $null
try { $ApplyOut = [IO.Path]::GetTempFileName() } catch { $ApplyOut = $null }
# Las piezas y el plan que anota el registro de hooks van, dentro de la tanda, a temporales propios, y se suman a los de
# esta corrida en el lugar donde corría su llamada suelta (más abajo): así quedan en el mismo orden que sin la tanda,
# después de las de terceros que este archivo anota en el medio. Si no hay temporal, anota directo (mismo contenido).
$ApplyPiecesTmp = $null; $ApplyPlanTmp = $null
try { if ($PiecesTmp) { $ApplyPiecesTmp = [IO.Path]::GetTempFileName() } } catch { $ApplyPiecesTmp = $null }
try { if ($PlanTmp) { $ApplyPlanTmp = [IO.Path]::GetTempFileName() } } catch { $ApplyPlanTmp = $null }
$applyEnv = @{}
if ($ApplyPiecesTmp) { $applyEnv.TYCON_REPORT_PIECES = $ApplyPiecesTmp }
if ($ApplyPlanTmp) { $applyEnv.TYCON_PLAN_PIECES = $ApplyPlanTmp }
$applySteps = @()
if (Test-Path $ThirdPartyJs) { $applySteps += @{ id = 'third'; script = 'install-third-party'; args = $tpRunArgs } }
if ($RepoLinksHere -and (Test-Path $rutaCanonica)) { $applySteps += @{ id = 'entries'; script = 'canonical-path'; args = @(@('--ensure-repo-links', '--clone', (Split-Path -Parent $PSScriptRoot), '--only', 'entries') + @(if ($Check) { '--check' })) } }
if (Test-Path $LegacyNames) { $applySteps += @{ id = 'legacy'; script = 'legacy-names'; args = $lnArgs } }
if ($ApplyOut -and (Test-Path $ApplyJs)) { $applySteps += @{ id = 'apply'; script = 'apply-hooks'; args = (New-ApplyArgs $ApplyOut); env = $applyEnv } }
$ApplyBatch = Invoke-NodeBatch $applySteps

# ── Las skills de terceros vuelven a su lugar (espejo del .sh, mismos argumentos) ──────────────────
# Restituye lo ajeno desde la historia del clon (sin red) o desde su origen (con el retiro hecho, tope 20 s), sin
# borrar ni pisar nada. Todo aviso por stdout; apagado con TYCON_THIRD_PARTY=0, y lo dice.
if ((Test-Path $ThirdPartyJs) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    # lo corrió la tanda de aplicación: lo que escribió, otra vez acá; si no, la llamada suelta
    if ($ApplyBatch -and $ApplyBatch['third']) { Write-NodeChunks $ApplyBatch['third'].Chunks }
    elseif ($CheckInClone) {
        # -Check en el repo único sin el enlace todavía: la revisión de terceros mira el clon, como el resto
        # de esta corrida. Con la ruta del enlace (que no existe) diría «no es un clon de agent-skills» y no revisaría nada.
        try { & node (Join-Path (Join-Path $PSScriptRoot 'publishing') 'install-third-party.js') --repo $CheckInClone --check } catch { }
    } else {
        try { & node (Join-Path (Join-Path $PSScriptRoot 'publishing') 'install-third-party.js') --repo $AgentSkillsRepo @tpArgs } catch { }
    }
}
# ~/.claude/agents y ~/.claude/skills del repo único: después del paso de terceros, ver arriba
Invoke-RepoLinks 'entries'
# el plan (espejo del .sh): cada skill de terceros que el paso restituiría, con la ruta del reporte
# (~\.claude\agent-skills\…, aunque el enlace todavía no exista): completa y en su lugar → keep; si no → add
if ($PlanTmp -and $env:TYCON_THIRD_PARTY -ne '0') {
    try {
        $tpManifest = Join-Path (Join-Path $PSScriptRoot 'publishing') 'third-party-skills.json'
        if (Test-Path $tpManifest) {
            $tpLook = if ($CheckInClone) { $CheckInClone } else { $AgentSkillsRepo }
            $tpWhere = if ($CheckInClone) { Join-Path $ClaudeDir 'agent-skills' } else { $AgentSkillsRepo }
            $tpStateFile = Join-Path (Join-Path $ClaudeDir '.tycon-pipeline') 'third-party-state.json'
            $tpDone = @{}
            if (Test-Path $tpStateFile) {
                foreach ($e in @(((Get-Content -Raw -Path $tpStateFile | ConvertFrom-Json).entries).PSObject.Properties)) { if ($e.Value.complete) { $tpDone[$e.Name.TrimEnd('/')] = $true } }
            }
            foreach ($t in @((Get-Content -Raw -Path $tpManifest | ConvertFrom-Json).third_party)) {
                if ($t.install -ne 'download' -or -not $t.target) { continue }
                $target = ([string]$t.target).TrimEnd('/')
                $there = $tpDone.ContainsKey($target) -and (Test-Path -LiteralPath (Join-Path $tpLook ($target -replace '/', '\')))
                Record-Plan 'third-party' (Join-Path $tpWhere ($target -replace '/', '\')) (($target -split '/')[-1]) $(if ($there) { 'keep' } else { 'add' })
            }
        }
    } catch { $PlanIncomplete = $true }
}
# las skills de terceros que quedaron en su lugar, según el estado del paso (apagado el paso, no se anotan)
if ($PiecesTmp -and $env:TYCON_THIRD_PARTY -ne '0') {
    try {
        $tpState = Join-Path (Join-Path $ClaudeDir '.tycon-pipeline') 'third-party-state.json'
        if (Test-Path $tpState) {
            $tpEntries = (Get-Content -Raw -Path $tpState | ConvertFrom-Json).entries
            foreach ($e in @($tpEntries.PSObject.Properties)) {
                $tpDst = Join-Path $AgentSkillsRepo ($e.Name -replace '/', '\')
                if ($e.Value.complete -and (Test-Path -LiteralPath $tpDst)) { Record-Piece 'third-party' $tpDst (($e.Name.TrimEnd('/') -split '/')[-1]) }
            }
        }
    } catch { }
}

# ============================================================
# Integraciones — espejo del bloque bash. Cada integración tiene su llave en la configuración
# del arnés (lib/tycon-config.js: variable › ~/.claude/tycon.json › perfil del equipo › APAGADA); apagada, este
# instalador no registra sus hooks (clockify: clocki on-prompt + touch-activity; engram: engram-drift-notice y los
# chequeos de versión/sqlite3; nightly: tablero, dependencias y retro-staleness) ni llama a su servicio (ado: el
# refresco de proyectos con az; codex: el despliegue). Configuración ROTA o sin lector: se dice y las integraciones
# quedan COMO ESTÁN (ni se registran ni se remueven hooks; no se llama a nada) — un archivo roto no es «todo apagado».
# ⚠️ Escrito por lectura, sin máquina Windows (misma deuda declarada que el resto del .ps1).
# ============================================================
$IntegEstado = 'sin-lector'
$Integ = @{}
# lo que contestó el lector (su código y su salida), para el sync de bloques: no vuelve a preguntar
$CfgIntegRc = $null; $CfgIntegOut = $null
if ((Test-Path $cfgJs) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    try {
        if ($ReadBatch -and $ReadBatch['integrations']) {
            # lo leyó la tanda de la lectura (más arriba): la misma llamada
            $rc = $ReadBatch['integrations'].Rc
            $out = @(Split-NativeLines (Get-ChunkText $ReadBatch['integrations'].Chunks 'o'))
            $err = Get-ChunkText $ReadBatch['integrations'].Chunks 'e'
        } else {
            # stderr APARTE del JSON (un aviso de node por stderr con rc 0 rompería ConvertFrom-Json y dejaría «sin-lector»), y sin
            # $ErrorActionPreference='Stop' mientras corre node: en Windows PowerShell 5.1 una linea por stderr seria NativeCommandError
            $errTmp = [System.IO.Path]::GetTempFileName()
            $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
            try { $out = & node $cfgJs integrations --json 2>$errTmp; $rc = $LASTEXITCODE } finally { $ErrorActionPreference = $eap }
            $err = if (Test-Path $errTmp) { (Get-Content $errTmp -Raw -ErrorAction SilentlyContinue); Remove-Item $errTmp -ErrorAction SilentlyContinue } else { '' }
        }
        $CfgIntegRc = $rc; $CfgIntegOut = ($out | Out-String)
        if ($rc -eq 0) {
            $j = ($out | Out-String) | ConvertFrom-Json
            foreach ($p in $j.PSObject.Properties) { $Integ[$p.Name] = $p.Value }
            $IntegEstado = 'ok'
        } elseif ($rc -eq 2) {
            $IntegEstado = 'rota'
            Write-Host "! tycon: la configuracion del arnes esta ROTA - las integraciones quedan como estaban (ni se registran ni se remueven sus hooks; no se llama a ningun servicio) hasta arreglarla:"
            Write-Host ("   " + (("$err" + ($out | Out-String)).Trim() -replace "`n", "`n   "))
        } else {
            Write-Host "! tycon: no pude leer la configuracion del arnes (rc $rc) - las integraciones quedan como estaban"
        }
    } catch { Write-Host "! tycon: no pude leer la configuracion del arnes ($($_.Exception.Message)) - las integraciones quedan como estaban" }
} else {
    Write-Host "! tycon: sin scripts/lib/tycon-config.js (o sin node): no se que integraciones estan prendidas - quedan como estaban"
}
function Integ-Prendida([string]$k) {
    if ($IntegEstado -ne 'ok') { return $false }
    return (($Integ[$k] -eq $true) -or ($Integ[$k] -eq 'detect'))
}
# La tabla «hook → integración» y la lista de lo que se saca con la llave apagada las decide apply-hooks.js desde la lista única.

# ── El perfil de instalación (espejo del bloque del .sh) ─────────────────────────────
# `install.profile` de la configuración del arnés (`tycon-config.js get install.profile`), leído UNA vez. full o sin valor:
# todo lo del instalador. minimal: de la tabla de abajo sólo entran los hooks que scripts/setup/install-effects.json marca `minimal`
# (más los de una integración prendida), los demás se SACAN si estaban, y los frenos que nacen prendidos sólo entran con
# su variable en `1`. Rota o sin lector: lo que depende del perfil QUEDA COMO ESTÁ (ni se registra ni se saca), y se dice.
# Este instalador filtra SUS listas: lo que en Windows no registra en full tampoco aparece en minimal.
$ProfileState = 'sin-lector'; $ProfileValue = $null
$CfgProfileRc = $null; $CfgProfileOut = $null   # para el sync de bloques, como $CfgIntegRc
if ((Test-Path $cfgJs) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    if ($ReadBatch -and $ReadBatch['profile']) {
        # lo leyó la tanda de la lectura (más arriba): la misma llamada
        $pOut = ((Split-NativeLines (Get-ChunkText $ReadBatch['profile'].Chunks 'o')) | Out-String).Trim(); $pRc = $ReadBatch['profile'].Rc
        $CfgProfileRc = $pRc; $CfgProfileOut = $pOut
    } else {
        $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        # con catch: un try/finally solo dejaría pasar lo que tira y mataría el instalador con el candado tomado
        try { $pOut = ((& node $cfgJs get install.profile 2>$null) | Out-String).Trim(); $pRc = $LASTEXITCODE; $CfgProfileRc = $pRc; $CfgProfileOut = $pOut }
        catch { $pOut = ''; $pRc = -1 } finally { $ErrorActionPreference = $eap }
    }
    if ($pRc -eq 3) { $ProfileState = 'ok' }
    elseif ($pRc -eq 0 -and @('minimal', 'full') -contains $pOut) { $ProfileState = 'ok'; $ProfileValue = $pOut }
    else { $ProfileState = 'rota' }
}
$ProfileIsMinimal = ($ProfileState -eq 'ok') -and ($ProfileValue -eq 'minimal')
# los hooks de minimal, por su id «EVENTO:ruta de su spec» (la misma lista que el .sh; sin ella no se puede decidir)
$ProfileMinimalIds = @()
try {
    $effJson = [IO.File]::ReadAllText((Join-Path (Join-Path $PSScriptRoot 'setup') 'install-effects.json')) | ConvertFrom-Json
    $ProfileMinimalIds = @($effJson.effects | Where-Object { $_.kind -eq 'hook' -and @($_.profiles) -contains 'minimal' } | ForEach-Object { $_.id })
} catch { $ProfileMinimalIds = @() }
if ($ProfileIsMinimal -and $ProfileMinimalIds.Count -eq 0) {
    $ProfileState = 'rota'; $ProfileIsMinimal = $false
    Write-Host "! tycon: no pude leer que trae el perfil minimal (scripts/setup/install-effects.json): lo del perfil de instalacion queda como estaba"
}
if ($ProfileIsMinimal) { Write-Host "tycon: perfil de instalacion: minimal - con el freno de comandos destructivos y el de editar codigo sin historia ni ajuste puntual, sin los demas frenos, sin los bloques que cambian como contesta el asistente, sin hooks de git ni tareas de fondo (full: install.profile en ~/.claude/tycon.json)" }
elseif ($ProfileState -eq 'rota') { Write-Host "! tycon: la configuracion del arnes esta ROTA - lo del perfil de instalacion queda como estaba (ni se registra ni se saca; los dos frenos de comandos se registran igual) hasta arreglarla: node scripts/lib/tycon-config.js validate" }
elseif ($ProfileState -ne 'ok') { Write-Host "! tycon: sin scripts/lib/tycon-config.js (o sin node): no se que perfil de instalacion tiene esta maquina - lo del perfil queda como estaba (los dos frenos de comandos se registran igual)" }
$ProfileFull = ($ProfileState -eq 'ok') -and -not $ProfileIsMinimal
$ProfileOff = @()   # lo que se saca por el perfil (su línea lo dice)

# ── Los nombres viejos (espejo del .sh, la misma lista y el mismo guion) ───────────────────
# Las rutas de archivos renombrados a inglés, a su nombre nuevo, en settings.json (hooks y permisos),
# settings.local.json, ~/.codex/hooks.json y ~/.git-hooks/*, comparando la ruta COMPLETA. Va antes de cargar
# settings.json, así el bloque de hooks encuentra el nuevo ya registrado y no lo duplica. Con el mapa vacío no toca nada.
if ((Test-Path $LegacyNames) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    $lnOut = @(); $lnRc = 0
    if ($ApplyBatch -and $ApplyBatch['legacy']) {
        # lo corrió la tanda de la aplicación: sus dos canales en renglones, como los da `2>&1`
        $lnOut = @(Get-MergedLines $ApplyBatch['legacy'].Chunks); $lnRc = $ApplyBatch['legacy'].Rc
    } else {
        # Un node que se cae NO lanza en PowerShell: se mira $LASTEXITCODE, como las otras llamadas a node de este archivo.
        # EAP=Continue mientras corre (en Windows PowerShell 5.1 una línea por stderr sería NativeCommandError).
        $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { $lnOut = @(& node $LegacyNames @lnArgs 2>&1 | ForEach-Object { "$_" }); $lnRc = $LASTEXITCODE }
        catch { $lnOut = @("$($_.Exception.Message)"); $lnRc = -1 }
        finally { $ErrorActionPreference = $eap }
    }
    if ($lnRc -ne 0) {
        $lnErr = $lnOut | Where-Object { $_ -like '⛔*' } | Select-Object -First 1
        if (-not $lnErr) { $lnErr = $lnOut | Select-Object -Last 1 }
        Write-Output "⚠ tycon: la migración de nombres viejos falló (salió $lnRc) — $lnErr"
    } else {
        $lnN = ($lnOut | Where-Object { $_ -match '^RENAMED:(\d+)$' } | Select-Object -First 1) -replace '^RENAMED:', ''
        if ($lnN -and $lnN -ne '0') {
            if ($Check) { Write-Output "⚠ tycon: $lnN ruta(s) vieja(s) de archivos renombrados siguen en la configuración de esta máquina — corré install-tycon-hooks.ps1" }
            else { Write-Output "✓ tycon: reescribí $lnN ruta(s) vieja(s) de archivos renombrados a su nombre nuevo (story 8.9):" }
            $lnOut | Where-Object { $_ -like '  *' } | ForEach-Object { Write-Output $_ }
        } else {
            # nada reescrito, pero algo quedó sin tocar (un plist binario, un archivo sin respaldo): se dice igual
            $lnNotas = @($lnOut | Where-Object { $_ -like '  ⚠*' })
            if ($lnNotas.Count) {
                Write-Output "⚠ tycon: la migración de nombres viejos dejó avisos (story 8.9):"
                $lnNotas | ForEach-Object { Write-Output $_ }
            }
        }
    }
}

# ============================================================
# Los hooks de settings.json
# ============================================================
# La lista de hooks vive en scripts/setup/hooks-list.json y la aplica scripts/setup/apply-hooks.js: el mismo aplicador que
# llama install-tycon-hooks.sh, con `--platform windows`. Este archivo no lleva una lista propia ni código propio para
# settings.json: una lista escrita aparte de la del .sh se desfasa sin que nada lo diga, y ConvertFrom-Json convierte una
# cadena con forma de fecha en una fecha y no acepta dos claves que sólo difieren en mayúsculas (el archivo del dev
# saldría cambiado o el instalador se caería). Node lee y escribe el JSON tal cual.
# Lo que hace en Windows, además de lo de Mac y Linux (detalle en la cabecera de apply-hooks.js): un hook es «el mismo» por
# la ruta del guion dentro de su repo (con cualquier raíz: el clon, el enlace, /c/…); un .sh va como `bash "<ruta>"` (no
# con la ruta absoluta del bash de Git: lanzado por PowerShell sería un error de sintaxis, y Claude Code lanza los hooks
# con el bash de Git, donde `bash` ya es ése); un .sh con \r\n en
# el disco, o que no se pudo leer, no se registra; una ruta con `$`, acento grave o comilla doble tampoco; y lo que
# la lista excluye de Windows (platforms.windows: false, con el motivo en scripts/setup/windows-support.json) no se toca.
# Lista rota o settings.json roto: el aplicador sale distinto de 0 nombrando el archivo, no escribe nada, y este instalador
# sale 1 acá. Las piezas y el plan los anota el propio aplicador en TYCON_REPORT_PIECES y TYCON_PLAN_PIECES.
if (-not $ApplyOut) {
    try { $ApplyOut = [IO.Path]::GetTempFileName() }
    catch {
        # sin un temporal no hay dónde leer lo que hizo el aplicador
        Write-Host "✗ tycon: no registré los hooks: no pude crear un archivo temporal ($(Get-ErrText $_)); settings.json quedó como estaba"
        Exit-Installer 1
    }
}
$applyRc = 1
if ($ApplyBatch -and $ApplyBatch['apply']) {
    # lo corrió la tanda de la aplicación (más arriba): lo que escribió, otra vez acá, por su canal y en su orden
    Write-NodeChunks $ApplyBatch['apply'].Chunks; $applyRc = $ApplyBatch['apply'].Rc
    # sus piezas y su plan, recién ahora: en el mismo lugar y orden que con la llamada suelta (ver $ApplyPiecesTmp, arriba)
    foreach ($pair in @(@($ApplyPiecesTmp, $PiecesTmp), @($ApplyPlanTmp, $PlanTmp))) {
        if (-not $pair[0] -or -not $pair[1]) { continue }
        try { [IO.File]::AppendAllText($pair[1], [IO.File]::ReadAllText($pair[0])) }
        catch { if ($pair[1] -eq $PlanTmp) { $script:PlanIncomplete = $true } else { Write-Host "⚠ tycon: no pude sumar los hooks al reporte de piezas ($(Get-ErrText $_))" } }
    }
} else {
    $applyArgs = New-ApplyArgs $ApplyOut
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & node $ApplyJs @applyArgs; $applyRc = $LASTEXITCODE } catch { Write-Host "✗ tycon: no pude lanzar apply-hooks.js ($($_.Exception.Message))" } finally { $ErrorActionPreference = $eap }
}
foreach ($f in @($ApplyPiecesTmp, $ApplyPlanTmp)) { if ($f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue } }
$Apply = $null
if ($applyRc -eq 0) {
    try { $Apply = [IO.File]::ReadAllText($ApplyOut) | ConvertFrom-Json } catch { $Apply = $null }
}
Remove-Item $ApplyOut -ErrorAction SilentlyContinue
if ($applyRc -ne 0 -or $null -eq $Apply) {
    Write-Host "✗ tycon: no registré los hooks (apply-hooks.js salió $applyRc; el motivo está arriba): settings.json quedó como estaba"
    Exit-Installer 1
}

# ── Lo que NO queda registrado, dicho ──────────────────────────────
# Va SIEMPRE —con -Check, sin cambios y con cambios—: un clon atrasado, o con finales de línea de Windows, es justo el
# caso en que no hay nada que agregar. Una línea por control, con su nombre y el remedio. Informa, no frena.
foreach ($n in @($Apply.notInstalled)) {
    if ($null -eq $n) { continue }
    $repoFwd = ("$($n.repo)" -replace '\\', '/')
    # En DOS comandos («… y después …»), como lo imprime normalizeEol (scripts/setup/harness/sources.js): Windows PowerShell
    # 5.1 no acepta `&&`, y quien copie el remedio ahí se quedaría sin él.
    $eolFix = "git -C `"$repoFwd`" rm --cached -r -q .   y después   git -C `"$repoFwd`" reset --hard -q"
    switch ($n.kind) {
        'missing' { Write-Host "⚠ tycon: el control $($n.relpath) ($($n.event)) NO corre en esta máquina: su guion no está en el disco — la copia en $repoFwd está atrasada o incompleta: actualizala y volvé a correr el instalador" }
        'unverified' { Write-Host "⚠ tycon: el control $($n.relpath) ($($n.event)) NO quedó registrado: no pude leer su guion para comprobar sus finales de línea ($($n.path): $($n.reason)). Con finales de Windows (\r\n) sale 255 al correr, y sin leerlo no sé si los tiene: no lo registro como si frenara (¿lo tiene abierto otro programa?); se vuelve a intentar en la próxima corrida" }
        'unverified-registered' { Write-Host "⚠ tycon: el control $($n.relpath) ($($n.event)) está registrado y no pude leer su guion para comprobar sus finales de línea ($($n.path): $($n.reason)): no sé si funciona. Queda registrado; se vuelve a intentar en la próxima corrida" }
        'unsafe-path' { Write-Host "⚠ tycon: el control $($n.relpath) ($($n.event)) NO quedó registrado: su ruta trae «$($n.char)» ($($n.path)), y el comando con que se registra lo lee un shell, que con ese carácter leería otra ruta. No escribo un comando roto. Remedio: que ni la carpeta del clon ni la de usuario traigan `$, acento grave o comilla doble en su nombre" }
        'crlf' { Write-Host "⚠ tycon: el control $($n.relpath) ($($n.event)) NO quedó registrado: en el disco tiene finales de línea de Windows (\r\n) y así sale 255 al correr (un freno así no frena). Remedio, con ese clon sin cambios locales: $eolFix — y volvé a correr el instalador" }
        'crlf-registered' { Write-Host "⚠ tycon: el control $($n.relpath) ($($n.event)) está registrado pero NO funciona: en el disco tiene finales de línea de Windows (\r\n) y así sale 255 al correr (un freno así no frena). Queda registrado. Remedio, con ese clon sin cambios locales: $eolFix" }
        default { Write-Host "⚠ tycon: el control $($n.relpath) ($($n.event)) no quedó como se esperaba ($($n.kind))" }
    }
}
if (@($Apply.deferred).Count -gt 0) {
    Write-Host "⚠ tycon: $(@($Apply.deferred).Count) control(es) .sh ($(@($Apply.deferred) -join ', ')) se registran en la corrida siguiente: me lanzó un harness.js de una versión anterior, cuya comprobación de salud no sabe revisar un .sh en Windows y haría volver atrás esta actualización"
}
$Added = @($Apply.added | Where-Object { $_ })
$Removed = @($Apply.removed | Where-Object { $_ })
# el cambio de forma de los hooks .js: del node del PATH al Node propio del arnés, o de vuelta
$Reformed = @($Apply.reformed | Where-Object { $_ })
if ($Reformed.Count -gt 0) {
    if ($Check) { Write-Host "⚠ tycon: $($Reformed.Count) hook(s) .js con otro intérprete que el que corresponde (el Node del arnés o el del PATH) — corré install-tycon-hooks.ps1" }
    else { Write-Host "✓ tycon: $($Reformed.Count) hook(s) .js cambiaron de intérprete, en su lugar (el Node del arnés o el del PATH: harness.js doctor lo dice)" }
    foreach ($x in $Reformed) { Write-Host "  ~ $($x.event) → $($x.relpath)  [$($x.from) → $($x.to)]" }
}
if ($Check) {
    if ($Added.Count -gt 0) {
        Write-Host "⚠ tycon: $($Added.Count) hooks faltan en ~/.claude/settings.json — corré install-tycon-hooks.ps1"
        foreach ($a in $Added) { Write-Host "  + $($a.event) (matcher='$(if ($a.matcher) { $a.matcher } else { '*' })') → $($a.relpath)  [$($a.label)]" }
    }
    if ($Removed.Count -gt 0) {
        Write-Host "⚠ tycon: $($Removed.Count) hooks reemplazados o apagados siguen en settings.json — corré install-tycon-hooks.ps1"
        foreach ($r in $Removed) { Write-Host "  - $($r.event) → $($r.relpath)  [$($r.why)]" }
    }
    Record-BlocksPlan   # el plan de los bloques de CLAUDE.md: el sync con -Check no anota nada
} else {
    if ($Added.Count -gt 0) {
        Write-Host "✓ tycon: instalé $($Added.Count) hook(s) en ~/.claude/settings.json"
        foreach ($a in $Added) { Write-Host "  + $($a.event) (matcher='$(if ($a.matcher) { $a.matcher } else { '*' })') → $($a.relpath)  [$($a.label)]" }
    }
    if ($Removed.Count -gt 0) {
        Write-Host "✓ tycon: removí $($Removed.Count) hook(s) reemplazados o apagados"
        foreach ($r in $Removed) { Write-Host "  - $($r.event) → $($r.relpath)  [$($r.why)]" }
    }
    if ($Apply.backup) { Write-Host "✓ tycon: backup en $($Apply.backup)" }
    # la migración de la línea de arranque, después de escribir settings.json — también sin cambios
    Invoke-HarnessFromExisting
}
# 🔴 NO hay salida temprana cuando la lista de hooks no cambió: una segunda corrida sin hooks nuevos que saliera acá con
# `exit 0` no sincronizaría los bloques del CLAUDE.md (un bloque editado en el clon no llegaría nunca), no revisaría la
# versión de engram ni sqlite3, no limpiaría el core.hooksPath vestigial ni imprimiría el estado de las integraciones.
# Cada corrida, con cambios o sin ellos, sigue hasta el final; con -Check, revisando todo sin escribir nada.

# ============================================================
# Bloques team-wide de ~/.claude/CLAUDE.md.
# Ver el header de sync-claude-md-blocks.sh para el porqué. Quirúrgico sobre sus
# propios marcadores TYCON_BLOCK:<nombre>; fail-open. Opt-out: TYCON_NO_CLAUDEMD_SYNC=1.
# ============================================================
$syncBlocks = Join-Path (Join-Path $PSScriptRoot 'setup') 'sync-claude-md-blocks.ps1'
if (Test-Path $syncBlocks) {
    # con -Check revisa sin escribir: dice qué bloque está desactualizado
    # lo que el lector de configuración ya contestó: el sync no vuelve a preguntarle a Node. Sólo si este sync
    # sabe recibirlo (una copia parcial con el sync de antes lo llamaría con un parámetro que no conoce y no correría).
    $syncGiven = @{}
    if ($null -ne $CfgProfileRc) { $syncGiven.ProfileRc = $CfgProfileRc; $syncGiven.ProfileOut = $CfgProfileOut }
    if ($null -ne $CfgIntegRc) { $syncGiven.IntegRc = $CfgIntegRc; $syncGiven.IntegOut = $CfgIntegOut }
    if ($script:ReadBatch -and $script:ReadBatch['response']) { $syncGiven.RespRc = $script:ReadBatch['response'].Rc; $syncGiven.RespOut = ((Split-NativeLines (Get-ChunkText $script:ReadBatch['response'].Chunks 'o')) | Out-String) }
    $syncArgs = @{}
    if ($Check) { $syncArgs.Check = $true }
    try { if ($syncGiven.Count -and (Get-Command $syncBlocks -ErrorAction Stop).Parameters.ContainsKey('Given')) { $syncArgs.Given = $syncGiven } } catch { }
    try { & $syncBlocks @syncArgs } catch { }
}

# La línea de ~/.claude/CLAUDE.md que carga el índice de guías: el índice es INDEX.md y README.md es la
# portada. Este aplicador es el del árbol NUEVO aunque la actualización la haya decidido el programa instalado antes, así
# que la misma actualización deja la línea nueva (la vieja, reescrita en su lugar; nunca dos). No la agrega si no está:
# eso es de harness.js. Fail-open: si no puede, la reescribe el próximo arranque. Detalle: setup/harness/import-line.js.
$importLineJs = Join-Path (Join-Path (Join-Path $PSScriptRoot 'setup') 'harness') 'import-line.js'
if ((Test-Path $importLineJs) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    $ilArgs = @('--fix', '--quiet'); if ($Check) { $ilArgs += '--check' }
    try { & node $importLineJs @ilArgs 2>$null } catch { }
}

# ============================================================
# Versión de engram vs el pin del equipo. AVISA, nunca actualiza.
# Ver el header de check-engram-version.sh. Opt-out: TYCON_NO_ENGRAM_VERSION_CHECK=1.
# ============================================================
$engramVerCheck = Join-Path (Join-Path $PSScriptRoot 'setup') 'check-engram-version.ps1'
# los chequeos de engram sólo con la integración prendida
if ((Integ-Prendida 'engram') -and (Test-Path $engramVerCheck)) {
    try { & $engramVerCheck } catch { }

# ============================================================
# Dependencia de los chequeos de salud de la memoria: el COMANDO `sqlite3`.
# Windows es EL caso: no viene con el sistema NI con engram (que acá se instala por `go install`).
# Engram lleva su propio SQLite compilado adentro, así que anda igual — pero los dos chequeos que
# leen su base por dentro no pueden correr sin el comando.
# Opt-outs: TYCON_NO_SQLITE_CHECK=1 - TYCON_SQLITE_AUTO_INSTALL=0.
# ============================================================
$sqliteEnsure = Join-Path (Join-Path $PSScriptRoot 'setup') 'ensure-sqlite3.ps1'
if ((Integ-Prendida 'engram') -and (Test-Path $sqliteEnsure) -and -not $Check) {   # instala: con -Check no
  try { & $PSHOME\pwsh.exe -NoProfile -ExecutionPolicy Bypass -File $sqliteEnsure } catch {
    try { powershell -NoProfile -ExecutionPolicy Bypass -File $sqliteEnsure } catch { }
  }
}
}

# ============================================================
# Lado Codex (opt-in TYCON_CODEX=1). Espeja el bloque
# equivalente de install-tycon-hooks.sh: despliega profiles de advisors,
# hooks.json (merge quirúrgico + aviso de TRUST por hash), [mcp_servers]
# (traducción del registro de Claude, secretos jamás al TOML) y skills por
# symlink/junction. Los deployers son node (cross-platform); requisitos en
# Windows: node en PATH y bash.exe (git-bash) para los hooks .sh.
# ⚠ Sin verificar todavía en una máquina Windows real.
#
# ¿Esta máquina usa Codex? (espejo del
# bloque de install-tycon-hooks.sh). La llave del ambiente no siempre llega al instalador: decide
# el DISCO, con codexDeployed() de scripts/lib/harness-parity.js. TYCON_CODEX=1 → sí (estrena);
# TYCON_CODEX=0 explícito → no; sin la variable → lo que diga el disco.
# ============================================================
$codexOn = $false
# La llave es `integrations.codex` (TYCON_CODEX › ~/.claude/tycon.json › perfil › apagada): $true sí,
# $false no, 'detect' lo que diga el disco. Configuración rota: nada de Codex. Sin lector: la variable.
$codexLlave = 'detect'
if ($IntegEstado -eq 'ok') { $codexLlave = $Integ['codex'] }
elseif ($IntegEstado -eq 'rota') { $codexLlave = $false }
elseif ($env:TYCON_CODEX -eq '1') { $codexLlave = $true }
elseif ($env:TYCON_CODEX -eq '0') { $codexLlave = $false }
if ($codexLlave -eq $true) {
    $codexOn = $true
} elseif ($codexLlave -eq 'detect') {
    # Un chequeo que FALLA no se lee como "no usa Codex": 0 = si, 10 = no, otra cosa = se avisa.
    $parity = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/lib/harness-parity.js'
    $motivo = $null
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        $motivo = 'no hay node en el PATH'
    } else {
        try {
            $err = & node -e 'try { process.exit(require(process.argv[1]).codexDeployed() ? 0 : 10) } catch (e) { console.error(e.message); process.exit(2) }' $parity 2>&1
            if ($LASTEXITCODE -eq 0) { $codexOn = $true }
            elseif ($LASTEXITCODE -ne 10) { $motivo = "$err" }
        } catch { $motivo = "$_" }
    }
    if ($motivo) { Write-Host "!! tycon: no pude saber si esta maquina usa Codex ($motivo) - sigo como si no; para desplegarlo igual: TYCON_CODEX=1" }
}
# Bajo el mecanismo de instalación (espejo del .sh): qué herramientas enchufa la máquina lo dice su
# estado, y a Codex lo enchufa harness.js en Node. `TYCON_HARNESS_CODEX` se lo dice a este instalador y gana sobre la
# llave: `done` = la máquina usa Codex y su despliegue ya lo hizo harness.js (acá se saltea, y los AGENTS.md puntero
# siguen) · `off` = esta máquina no enchufa a Codex. Corrido suelto (sin la variable), lo de arriba vale como siempre.
$codexByHarness = $false
if ($env:TYCON_HARNESS_CODEX -eq 'done') { $codexOn = $true; $codexByHarness = $true }
elseif ($env:TYCON_HARNESS_CODEX -eq 'off') { $codexOn = $false }
if ($codexOn) {
    # UN solo entrypoint, el MISMO que usa install-tycon-hooks.sh (espejar las 4 llamadas a mano deja el silencio total
    # ante un deploy caído en cuanto se edita el lado bash: dos copias inline del mismo bloque driftean solas). La
    # política (fingerprint, silencio en estado
    # estable, fallo con causa) vive en deploy-codex-all.js y acá sólo se invoca.
    $deployAll = Join-Path (Split-Path -Parent $PSScriptRoot) 'build/deploy-codex-all.js'
    # las reglas en AGENTS.md, desde los bloques
    $agentsMd = Join-Path $PSScriptRoot 'setup/agents-md-blocks.js'
    # el despliegue escribe en CODEX_HOME: con -Check no corre
    if ($codexByHarness) { }
    elseif ($Check) {
        Write-Host "(-Check) tycon/codex: no despliego el lado Codex (sólo reviso)"
        if (Test-Path $agentsMd) { try { & node $agentsMd --check } catch { } }
    }
    elseif (Test-Path $deployAll) {
        try { & node $deployAll } catch { Write-Host "!! tycon/codex: deploy-codex-all.js fallo - diagnostico: node $deployAll" }
        if (Test-Path $agentsMd) { try { & node $agentsMd } catch { Write-Host "!! tycon/codex: agents-md-blocks.js fallo - diagnostico: node $agentsMd" } }
    }
    # Lo que el despliegue deja en CODEX_HOME y es del arnés (espejo del .sh): un perfil y un subagente
    # nativo por revisor de adapters/codex/, hooks.json y config.toml, y los enlaces de skills que apuntan a agent-skills.
    # Con el despliegue hecho por harness.js, las piezas las anota él (no se anotan dos veces).
    if ($PiecesTmp -and -not $codexByHarness) {
        try {
            $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path (Get-TyconHome) '.codex' }
            $adapters = Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'adapters') 'codex'
            foreach ($f in @(Get-ChildItem -Path (Join-Path $adapters 'agents') -Filter '*.toml' -File -ErrorAction SilentlyContinue)) {
                $rel = "$($f.BaseName).config.toml"
                if (Test-Path (Join-Path $codexHome $rel)) { Record-Piece 'codex' (Join-Path $codexHome $rel) $rel }
            }
            foreach ($f in @(Get-ChildItem -Path (Join-Path $adapters 'agents-native') -Filter '*.toml' -File -ErrorAction SilentlyContinue)) {
                $dstNative = Join-Path (Join-Path $codexHome 'agents') $f.Name
                if (Test-Path $dstNative) { Record-Piece 'codex' $dstNative "agents/$($f.Name)" }
            }
            foreach ($rel in @('hooks.json', 'config.toml')) {
                if (Test-Path (Join-Path $codexHome $rel)) { Record-Piece 'codex' (Join-Path $codexHome $rel) $rel }
            }
            foreach ($i in @(Get-ChildItem -Path (Join-Path $codexHome 'skills') -Force -ErrorAction SilentlyContinue)) {
                if ($i.LinkType -and ("$($i.Target)".StartsWith($AgentSkills.TrimEnd('\') + '\') -or "$($i.Target)".StartsWith(($AgentSkills -replace '\\', '/').TrimEnd('/') + '/'))) {
                    Record-Piece 'codex' $i.FullName "skills/$($i.Name)"
                }
            }
        } catch { }
    }

    # -- AGENTS.md puntero en los repos de proyecto (espejo del bloque bash) --
    # Las reglas de proyecto (CLAUDE.md) llegan a Codex por un AGENTS.md puntero de una
    # linea, SIN segunda copia. Solo repos del equipo (origin en la organizacion configurada,
    # ado.org), 2 niveles bajo la raiz de repos (scripts/lib/repos-root.js), con
    # CLAUDE.md y sin AGENTS.md; nunca pisa uno existente. Sin raiz o sin organizacion no deposita
    # nada y lo dice. Un repo no escribible NO corta el instalador (avisa y sigue).
    # Opt-out: TYCON_NO_AGENTSMD_POINTER=1.
    # (Ambiente: en Windows las variables de usuario viven en el registro y son permanentes -
    #  no hace falta el LaunchAgent del lado Mac; TYCON_CODEX y los secretos MCP los deja el
    #  onboarding PASO 7 con [Environment]::SetEnvironmentVariable(..., 'User').)
    # Sin verificar en maquina Windows real - escrito como espejo del .sh probado.
    if ($env:TYCON_NO_AGENTSMD_POINTER -ne '1') {
        $puntero = @"
# AGENTS.md - puntero (lo deposito el arnes TYCON; commitealo asi le llega al equipo)

Las reglas de este repo viven en ``CLAUDE.md``, el canonico multi-herramienta.
**Antes de trabajar aca: lee ``./CLAUDE.md`` COMPLETO y aplicalo como si fuera este archivo.**
Si existe ``./CLAUDE.local.md``, leelo y aplicalo tambien.

No agregues reglas aca: se escriben en ``CLAUDE.md`` - este puntero existe para que no haya
dos copias que mantener. (Convencion: INSTALL.md del arnés, seccion Lado Codex.)
"@
        # rc 2 = configuracion del arnes ROTA (tycon.json / perfil): se dice tal cual y no se deposita nada; rc 3 = sin valor.
        # (espejo del .sh; escrito sin poder probarlo en Windows)
        $srcRoot = ''; $orgNombre = ''; $cfgRota = @()
        try {
            $out = & node (Join-Path (Join-Path $PSScriptRoot 'lib') 'repos-root.js') --plain 2>&1; $rc = $LASTEXITCODE
            if ($rc -eq 0) { $srcRoot = ($out | Out-String).Trim() } elseif ($rc -eq 2) { $cfgRota += ($out | Out-String) }
        } catch {}
        try {
            $out = & node (Join-Path (Join-Path $PSScriptRoot 'lib') 'tycon-config.js') get ado.org 2>&1; $rc = $LASTEXITCODE
            if ($rc -eq 0) { $orgNombre = ($out | Out-String).Trim().Split('/')[-1] } elseif ($rc -eq 2) { $cfgRota += ($out | Out-String) }
        } catch {}
        if ($cfgRota.Count -gt 0) {
            Write-Host "! tycon/codex: la configuracion del arnes esta rota - no deposito punteros AGENTS.md hasta que se arregle:"
            foreach ($l in $cfgRota) { Write-Host "   $l" }
            $srcRoot = ''; $orgNombre = ''
        }
        elseif (-not $srcRoot) { Write-Host "i tycon/codex: sin raiz de repos conocida (TYCON_REPOS_ROOT, o rutas.repos en ~/.claude/tycon.json): no deposito punteros AGENTS.md" }
        elseif (-not $orgNombre) { Write-Host "i tycon/codex: sin organizacion de Azure DevOps configurada (ado.org): no se cuales repos son del equipo, no deposito punteros AGENTS.md" }
        $candidatos = @()
        if ($srcRoot -and $orgNombre -and (Test-Path $srcRoot)) {
            $nivel1 = @(Get-ChildItem -Path $srcRoot -Directory -ErrorAction SilentlyContinue)
            $candidatos += $nivel1
            foreach ($d in $nivel1) { $candidatos += @(Get-ChildItem -Path $d.FullName -Directory -ErrorAction SilentlyContinue) }
        }
        foreach ($repo in $candidatos) {
            $dir = $repo.FullName
            if (-not (Test-Path (Join-Path $dir '.git'))) { continue }
            if (-not (Test-Path (Join-Path $dir 'CLAUDE.md'))) { continue }
            $agentsPath = Join-Path $dir 'AGENTS.md'
            if (Get-Item -LiteralPath $agentsPath -Force -ErrorAction SilentlyContinue) { continue }   # existe o es symlink (roto incluido)
            $origen = ''
            try { $origen = [string](& git -C $dir remote get-url origin 2>$null) } catch {}
            $orgRe = [regex]::Escape($orgNombre)
            if ($origen -notmatch "dev\.azure\.com/$orgRe|$orgRe\.visualstudio\.com") { continue }
            if ($Check) { Write-Host "! $dir tiene CLAUDE.md sin AGENTS.md - bajo Codex sus reglas de proyecto no se cargan"; continue }
            try {
                [System.IO.File]::WriteAllText($agentsPath, $puntero, (New-Object System.Text.UTF8Encoding($false)))
                Write-Host "+ $dir : AGENTS.md puntero depositado (commitealo cuando puedas)"
            } catch { Write-Host "! $dir : no pude escribir AGENTS.md (permisos?) - sigo con el resto" }
        }
    }
}

# -- la lista de proyectos de Azure DevOps para failed-query-notice.js (espejo del bloque bash) --
# Sin lista cacheada la segunda mirada del hook (--project inexistente) calla. Cada 7 dias, en segundo
# plano, si hay `az`. Off: TYCON_NO_AZ_PROJECTS_REFRESH=1. ESCRITO SIN PODER PROBARLO EN WINDOWS.
# Sólo corre con Azure DevOps prendida (ado.org configurada), y usa la organización del lector
if ((Integ-Prendida 'ado') -and $env:TYCON_NO_AZ_PROJECTS_REFRESH -ne '1' -and -not $Check -and (Get-Command az -ErrorAction SilentlyContinue)) {
  $azCache = Join-Path $ClaudeDir '.tycon-pipeline\az-projects.json'
  $vieja = (-not (Test-Path $azCache)) -or ((Get-Item $azCache).LastWriteTime -lt (Get-Date).AddDays(-7))
  if ($vieja) {
    $hookAz = Join-Path $PSScriptRoot 'hooks\failed-query-notice.js'
    $orgRef = ''
    try { $o = & node $cfgJs get ado.org 2>$null; if ($LASTEXITCODE -eq 0) { $orgRef = ($o | Out-String).Trim() } } catch {}
    $argsAz = @($hookAz, '--refresh'); if ($orgRef) { $argsAz += @('--org', $orgRef) }
    # Start-Process junta un arreglo de argumentos con espacios y SIN comillas: una carpeta de usuario con espacio partiría
    # la ruta del guion en dos. Va una sola línea con cada argumento entre comillas. -WindowStyle sólo
    # existe en Windows (fuera de Windows cortaría el instalador); fuera de Windows su salida estándar va a la nada (lo que
    # diga por la de error, si falla, se ve: las dos no pueden ir al mismo archivo). Nunca frena.
    if (Test-Path $hookAz) {
        # las reglas de Windows para leer una línea de comando: las barras antes de una comilla (o del cierre) se duplican
        $azLine = ($argsAz | ForEach-Object { '"' + (("$_" -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }) -join ' '
        $azStart = @{ FilePath = $script:NodeProgram; ArgumentList = $azLine }
        if ($IsWindows) { $azStart.WindowStyle = 'Hidden' } else { $azStart.RedirectStandardOutput = '/dev/null' }
        try { Start-Process @azStart -ErrorAction Stop } catch { Write-Host "!! tycon: no pude lanzar el refresco de la lista de proyectos de Azure DevOps ($($_.Exception.Message))" }
    }
  }
}

# -- las corridas del pipeline al buzón del equipo (espejo de la subida del .sh) --
# Sin esto, las corridas de una máquina Windows nunca llegarían al buzón ni al tablero
# del equipo. En cada arranque, de fondo y con la ventana oculta: no frena el arranque. Sólo con la integración del buzón
# prendida, fuera de -Check y fuera de un agente de CI (un agente no es una máquina del equipo). Apagar:
# TYCON_NO_UPLOAD_RUNS=1. Un proceso de fondo de PowerShell no puede AGREGAR a un archivo: la subida agrega ella misma a su
# registro (`--log`, con la rotación del .sh pasado ~512 KB). Registro: upload-runs.log en la carpeta de estado.
$upJs = Join-Path (Join-Path $PSScriptRoot 'metrics') 'upload-runs.js'
if ((Integ-Prendida 'mailbox') -and (Get-LegacyEnv 'TYCON_NO_UPLOAD_RUNS' -Where 'scripts/install-tycon-hooks.ps1') -ne '1' -and -not $Check -and "$env:TF_BUILD" -notmatch '^(?i)true$' -and (Test-Path $upJs)) {
    $upDir = Join-Path $ClaudeDir '.tycon-pipeline'
    $upLog = Join-Path $upDir 'upload-runs.log'
    try {
        New-Item -ItemType Directory -Force -Path $upDir -ErrorAction Stop | Out-Null
        # una sola línea con cada argumento entre comillas (las reglas de Windows: las barras antes de una comilla se duplican)
        $upLine = (@($upJs, '--budget-ms', '90000', '--log', $upLog) | ForEach-Object { '"' + (("$_" -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }) -join ' '
        $upStart = @{ FilePath = $script:NodeProgram; ArgumentList = $upLine }
        if ($IsWindows) { $upStart.WindowStyle = 'Hidden' } else { $upStart.RedirectStandardOutput = '/dev/null' }
        # la constancia de que se lanzó, antes de lanzar: si node muere sin escribir nada, el registro igual lo dice
        Add-Content -LiteralPath $upLog -Value ("[{0}] tycon: el arranque lanza la subida de corridas" -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')) -Encoding utf8 -ErrorAction SilentlyContinue
        Start-Process @upStart -ErrorAction Stop
    } catch { Write-Host "!! tycon: no pude lanzar la subida de corridas al buzón ($($_.Exception.Message))" }
}

# una linea con el estado de las ocho integraciones
if ($IntegEstado -eq 'ok') {
    $prend = @(); $apag = @()
    foreach ($k in @('ado', 'clockify', 'engram', 'codegraph', 'mailbox', 'codex', 'nightly', 'telegram')) {
        # la cadena a la IZQUIERDA: PowerShell convierte el operando derecho al tipo del izquierdo, y `$true -eq 'detect'`
        # es True (toda prendida saldría como «(detect)»)
        if ('detect' -eq $Integ[$k]) { $prend += "$k(detect)" } elseif ($true -eq $Integ[$k]) { $prend += $k } else { $apag += $k }
    }
    $sp = if ($prend.Count) { $prend -join ' ' } else { '(ninguna)' }
    $sa = if ($apag.Count) { $apag -join ' ' } else { '(ninguna)' }
    Write-Host "tycon: integraciones - prendidas: $sp - apagadas: $sa - detalle: node $cfgJs explain"
}

# ============================================================
# Los hooks globales de git `pre-commit` y `post-commit` (espejo del bloque del .sh)
# ============================================================
# Sin ellos, en Windows no corre la delegación al `.githooks/` de cada repo (el lint de
# las stories, el de la wiki) ni el aviso de lo que quedó afuera de un commit. Mismas reglas que el .sh: van a
# ~/.git-hooks (o TYCON_GIT_HOOKS_DIR) sólo si difieren; uno propio de la persona no se pisa: pasa a `.local` y el
# nuestro lo sigue llamando (si ya hay `.local`, el ajeno queda en `.bak-<fecha>`); con copia salvo bajo harness.js
# (TYCON_HARNESS_SNAPSHOT_DIR). Se escriben con finales LF aunque el clon los tenga con \r\n: git los corre con el bash de
# Git, que con \r\n sale 255. Sólo en full; con -Check sólo avisa. Se anotan como piezas `git-hook`. Opt-out:
# TYCON_NO_GIT_HOOKS=1.
# Un fallo (leer el guion o el que ya está, crear la carpeta, mover, copiar, escribir) se DICE en una línea y el instalador
# sigue con el resto, como el .sh (con 'Stop' global tiraría y moriría con el candado tomado, sin reporte).
# La pieza no se anota: quien lee el reporte la ve faltar.
function Install-GitHook([string]$SrcName, [string]$Name, [string]$Marker, [string]$What) {
    $dst = Join-Path $script:GitHooksDir $Name
    try { Install-GitHookCore $SrcName $Name $Marker $What $dst }
    catch { Write-Host "✗ tycon: no pude dejar el $Name global de git en $dst ($(Get-ErrText $_)) — sigo con el resto; revisá esa carpeta y volvé a correr el instalador" }
}
function Install-GitHookCore([string]$SrcName, [string]$Name, [string]$Marker, [string]$What, [string]$dst) {
    $src = Join-Path (Join-Path $PSScriptRoot 'hooks') $SrcName
    if (-not (Test-Path $src)) { return }
    $want = [Text.Encoding]::UTF8.GetBytes(([IO.File]::ReadAllText($src) -replace "`r`n", "`n"))
    $have = if (Test-Path $dst) { [IO.File]::ReadAllBytes($dst) } else { $null }
    $same = ($null -ne $have) -and ($have.Length -eq $want.Length) -and (-not (Compare-Object $have $want -SyncWindow 0))
    Record-Plan 'git-hook' $dst $Name $(if ($same) { 'keep' } elseif ($null -ne $have) { 'update' } else { 'add' })
    if (-not $same) {
        if ($Check) {
            Write-Host "⚠ el $Name global de git está desactualizado (o falta): $dst"
        } else {
            New-Item -ItemType Directory -Force -Path $script:GitHooksDir -ErrorAction Stop | Out-Null
            $local = Join-Path $script:GitHooksDir "$Name.local"
            $stamp = Get-Date -Format 'yyyyMMddHHmmss'
            if (($null -ne $have) -and -not ([Text.Encoding]::UTF8.GetString($have).Contains($Marker))) {
                # el que la persona ya tenía no se pisa: queda como .local y el nuestro lo invoca primero
                if (-not (Test-Path $local)) {
                    Move-Item -Path $dst -Destination $local -ErrorAction Stop
                    Write-Host "ℹ tu $Name global anterior sigue corriendo desde $local (lo invoca el nuestro primero)"
                } else {
                    # también bajo harness.js: es el único lugar donde el ajeno sobrevive
                    Copy-Item -Path $dst -Destination "$dst.bak-$stamp" -ErrorAction Stop
                    Write-Host "⚠ había un $Name global ajeno y ya existe $Name.local: el ajeno quedó en .bak, revisalo"
                }
            } elseif (($null -ne $have) -and -not $env:TYCON_HARNESS_SNAPSHOT_DIR) {
                Copy-Item -Path $dst -Destination "$dst.bak-$stamp" -ErrorAction Stop
            }
            [IO.File]::WriteAllBytes($dst, $want)
            Write-Host "✓ $Name global de git actualizado ($dst) — $What"
            $same = $true
        }
    }
    if ($same) { Record-Piece 'git-hook' $dst $Name }
}
# La carpeta global de hooks que git usa ($Configured: el valor de core.hooksPath), ¿es la que el instalador llena
# ($Installed)? Devuelve UNA de: 'same' · 'other' · 'missing' (apunta a una carpeta que no está) · 'relative' (cada repo
# usa la suya: no hay una sola con qué comparar) · 'unix-form' (en Windows, /c/carpeta/… o /usr/…: la forma de Git Bash,
# que PowerShell no resuelve como git) · 'unreadable' (no se pudo mirar). No escribe ni cambia nada.
# Se juzga por lo que hay en el disco, no por cómo está escrita la ruta: el ~ expandido, la ruta completa, la ruta REAL
# de las dos (cada enlace o junction seguido, esté en el tramo que esté: una carpeta alcanzada por un enlace es LA
# MISMA) y, en Windows, sin distinguir mayúsculas ni \ de /. Fuera de Windows las mayúsculas cuentan: en un disco que
# las distingue son dos carpetas. -Platform y -HomeDir son para las pruebas (installer-ps1.test.sh, sección gh).
function Compare-GlobalHooksDir([string]$Configured, [string]$Installed, [string]$Platform = [Environment]::OSVersion.Platform, [string]$HomeDir = '') {
    $windows = ($Platform -eq 'Win32NT')
    $used = "$Configured".Trim()
    if ($used -eq '~' -or $used -match '^~[\\/]') {
        if (-not $HomeDir) { $HomeDir = Get-TyconHome $Platform }
        $used = "$HomeDir" + $used.Substring(1)
    }
    $how = if ($windows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    $flat = {
        param([string]$p)
        if ($windows) { $p = $p -replace '\\', '/' }
        if ($p.Length -gt 1) { $p = $p.TrimEnd('/') }
        $p
    }
    if ([string]::Equals((& $flat $used), (& $flat $Installed), $how)) { return 'same' }
    if ($windows) {
        if ($used -match '^/($|[^/])') { return 'unix-form' }
        if ($used -notmatch '^[A-Za-z]:[\\/]' -and $used -notmatch '^[\\/]{2}[^\\/]') { return 'relative' }
    } elseif ($used -notmatch '^/') { return 'relative' }
    try {
        if (-not (Test-Path -LiteralPath $used -PathType Container)) { return 'missing' }
        # La ruta REAL entera, tramo por tramo: si un tramo es un enlace o un junction se lo sigue y se vuelve a resolver
        # desde ahí (GetFullPath no sigue enlaces, y Get-Item sólo dice si lo es el ÚLTIMO tramo). Mirando sólo el último,
        # la misma carpeta alcanzada por un enlace intermedio —un perfil de usuario redirigido— saldría «otra» y el
        # instalador avisaría en falso, cuando el .sh la da por la misma. Lo que no está en el disco queda como está
        # escrito (la del instalador puede no existir todavía); 64 saltos como tope, por un enlace que se apunte a sí mismo.
        $real = {
            param([string]$p)
            $left = [System.IO.Path]::GetFullPath($p)
            for ($hops = 0; $hops -lt 64; $hops++) {
                $root = [System.IO.Path]::GetPathRoot($left)
                $parts = @($left.Substring($root.Length) -split '[\\/]+' | Where-Object { $_ })
                $done = $root
                $jumped = $false
                for ($i = 0; $i -lt $parts.Count; $i++) {
                    $next = [System.IO.Path]::Combine($done, $parts[$i])
                    $item = Get-Item -LiteralPath $next -Force -ErrorAction SilentlyContinue
                    $target = if ($item -and $item.LinkType) { [string](@($item.Target)[0]) } else { '' }
                    if ($target) {
                        if (-not [System.IO.Path]::IsPathRooted($target)) { $target = [System.IO.Path]::Combine($done, $target) }
                        for ($j = $i + 1; $j -lt $parts.Count; $j++) { $target = [System.IO.Path]::Combine($target, $parts[$j]) }
                        $left = [System.IO.Path]::GetFullPath($target)
                        $jumped = $true
                        break
                    }
                    $done = $next
                }
                if (-not $jumped) { return $done }
            }
            $left
        }
        if ([string]::Equals((& $flat (& $real $used)), (& $flat (& $real $Installed)), $how)) { return 'same' }
        return 'other'
    } catch { return 'unreadable' }
}
$GitHooksDir = if ($env:TYCON_GIT_HOOKS_DIR) { $env:TYCON_GIT_HOOKS_DIR } else { Join-Path (Split-Path -Parent $ClaudeDir) '.git-hooks' }
if ($env:TYCON_NO_GIT_HOOKS -ne '1' -and $ProfileFull) {
    Install-GitHook 'git-pre-commit-global.sh' 'pre-commit' 'git-pre-commit-global.sh' 'ahora delega en el .githooks/ de cada repo'
    Install-GitHook 'git-post-commit-global.sh' 'post-commit' 'git-post-commit-global.sh' 'avisa en una línea lo que quedó afuera de cada commit'
    # el freno antes de publicar, en cualquier clon del arnés (espejo del bloque del .sh)
    Install-GitHook 'git-pre-push-global.sh' 'pre-push' 'git-pre-push-global.sh' 'el freno antes de publicar corre en cualquier clon del arnés'
    # La carpeta GLOBAL de hooks de git, ¿es la que este instalador llena? (espejo del bloque del .sh). Avisar sólo cuando
    # git no tiene ninguna dejaría pasar el caso de OTRA: el instalador llenaría la suya, no diría nada, y ningún hook
    # del arnés —tampoco el freno antes de publicar— correría. Se lee con --includes (con --global
    # solo, git no sigue los archivos incluidos y diría «no tiene») y con --type=path (git expande el ~).
    # 🔴 Nunca la cambia, en ningún modo: esa clave es de la persona y puede ser de otra herramienta. Sólo avisa.
    # «Git no contestó» no es «git no tiene»: git config sale 1 cuando la clave no está, y con OTRO código cuando falló
    # (128 con la configuración rota); y si git no está, ni arranca. Leer todo eso como «no tiene» afirmaría algo que no
    # se midió y mandaría a pisar la clave con el comando del aviso. $ghpRc queda sin valor si git no se pudo lanzar.
    $ghp = ''; $ghpPath = ''; $ghpRc = $null; $ghpWhy = ''
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        # 2>&1: lo que git dice por su salida de error llega como ErrorRecord, y así se lo separa de su salida
        $ghpAll = @(& git config --global --includes core.hooksPath 2>&1); $ghpRc = $LASTEXITCODE
        $ghp = (@($ghpAll | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n").Trim()
        $ghpWhy = ("$($ghpAll | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | Select-Object -First 1)" -replace '\s+', ' ').Trim()
        # cualquier fallo de ESTA lectura cae al valor crudo, que ya se leyó bien (un git anterior a 2.18 no conoce --type=path)
        if ($ghpRc -eq 0 -and $ghp) { $ghpPath = [string](& git config --global --includes --type=path core.hooksPath 2>$null) }
    } catch { if ($null -eq $ghpRc) { $ghpWhy = Get-ErrText $_ } } finally { $ErrorActionPreference = $eap }
    $ghpOurs = $GitHooksDir -replace '\\', '/'
    if ($null -eq $ghpRc -or ($ghpRc -ne 0 -and $ghpRc -ne 1)) {
        $ghpHow = if ($null -eq $ghpRc) { "no pude lanzar git: $ghpWhy" } else { "git config salió $ghpRc" }
        Write-Host "⚠ no pude leer la carpeta global de hooks de git (core.hooksPath global; $ghpHow): no sé si los hooks del arnés, incluido el freno antes de publicar, corren en esta máquina. Cuando git conteste, volvé a correr el instalador."
        if ($null -ne $ghpRc -and $ghpWhy) { Write-Host "    git dijo:            $ghpWhy" }
        Write-Host "    el instalador llena: $ghpOurs"
    } elseif (-not $ghp) {
        Write-Host "⚠ git no tiene core.hooksPath global — los hooks del arnés NO corren. Activalo con:"
        Write-Host "    git config --global core.hooksPath $ghpOurs"
    } else {
        $ghpUsed = if ("$ghpPath".Trim()) { "$ghpPath".Trim() } else { $ghp }
        $ghpOnlyIf = 'Los hooks del arnés, incluido el freno antes de publicar, sólo corren si git usa la del instalador:'
        $ghpCannot = '⚠ no pude comparar el core.hooksPath global de git con la carpeta que llena el instalador:'
        $ghpHead = switch (Compare-GlobalHooksDir $ghpUsed $GitHooksDir) {
            'same'      { '' }
            'other'     { '⚠ el core.hooksPath global de git apunta a OTRA carpeta, no a la que llena el instalador — los hooks del arnés, incluido el freno antes de publicar, NO corren. No lo cambio solo (puede ser de otra herramienta):' }
            'missing'   { '⚠ el core.hooksPath global de git apunta a una carpeta que NO existe — los hooks del arnés, incluido el freno antes de publicar, NO corren. No lo cambio solo:' }
            'relative'  { "$ghpCannot es una ruta relativa (cada repo usa la suya, no hay una sola con qué comparar). $ghpOnlyIf" }
            'unix-form' { "$ghpCannot tiene forma de ruta de Unix o de Git Bash, y PowerShell no la resuelve como git. $ghpOnlyIf" }
            default     { "$ghpCannot no pude mirar la carpeta que git usa. $ghpOnlyIf" }
        }
        if ($ghpHead) {
            Write-Host $ghpHead
            Write-Host "    git usa:             $ghpUsed"
            Write-Host "    el instalador llena: $ghpOurs"
            Write-Host "    para apuntarlo:      git config --global core.hooksPath `"$ghpOurs`""
        }
    }
}

# -- core.hooksPath LOCAL vestigial (espejo del bloque bash) --
# Un core.hooksPath local eclipsa al global y con el se anula la delegacion entera, sin aviso.
# Se destapa SOLO si es vestigial comprobado (solo
# tiene *.sample); con hooks reales se avisa y no se toca. Sin verificar en Windows.
#
# «No tiene ningun hook real» se mira en el disco Y en lo que el repo sigue. Ejemplo: un clon viejo de agent-skills con
# core.hooksPath = .githooks (el repo sigue esa carpeta, con un hook de verdad), re-apuntado al repo unido: la vista
# reducida (sparse-checkout) esconde .githooks/. Mirar solo el disco no alcanza: la carpeta no esta, se daria por
# vestigial y se BORRARIA la clave de .git/config; y una carpeta que esta pero no se deja leer contaria como «sin hooks».
# Son tres respuestas:
#   - la carpeta esta y se puede leer -> se cuentan sus hooks, como siempre;
#   - la carpeta no esta pero el repo la sigue con archivos que no son *.sample (la esconde la vista reducida, o se
#     borro sin commitear) -> NO es vestigial: se avisa y no se toca;
#   - no se pudo mirar (la carpeta no se deja leer, o git no contesto: una ruta absoluta fuera del clon, por ejemplo)
#     -> tampoco se toca, y se dice.
# Solo lo que no esta en el disco NI en el repo, o esta con puros *.sample, es vestigial. La misma regla en el .sh.
# Medido con pwsh: scripts/tests/installer-ps1.test.sh (k). En Windows: no medido.
# Sólo en full (como el .sh): fuera de full no se toca el core.hooksPath de ningún repo.
foreach ($repo in @(if ($ProfileFull) { @($AgentSkillsRepo, (Split-Path -Parent $PSScriptRoot)) })) {
    if (-not (Test-Path (Join-Path $repo '.git'))) { continue }
    $lhp = ''
    try { $lhp = [string](& git -C $repo config --local core.hooksPath 2>$null) } catch {}
    if ([string]::IsNullOrWhiteSpace($lhp)) { continue }
    # Paths estilo MSYS/Git-Bash ('/c/...', '~/...') no se resuelven desde PowerShell: no se
    # tocan (un destape sobre un path mal resuelto podria pisar hooks REALES). Se avisa.
    if ($lhp -match '^(~|/)') { Write-Host "! $repo tiene core.hooksPath LOCAL con path estilo Unix ($lhp) - no lo toco; revisalo desde Git Bash"; continue }
    $lhpAbs = if ([System.IO.Path]::IsPathRooted($lhp)) { $lhp } else { Join-Path $repo $lhp }
    $reales = 0
    if (Test-Path -LiteralPath $lhpAbs -PathType Container) {
        try { $reales = @(Get-ChildItem -LiteralPath $lhpAbs -File -ErrorAction Stop | Where-Object { $_.Name -notlike '*.sample' }).Count }
        catch { Write-Host "! $repo tiene core.hooksPath LOCAL ($lhp) y no pude mirar que hay en esa carpeta ($($_.Exception.Message)) - no lo toco."; continue }
    } else {
        # la carpeta no esta en el disco: se le pregunta a git si el repo la sigue. Cada linea es `<letra> <ruta>`;
        # `S` = el archivo esta en el repo y la vista reducida lo esconde. EAP=Continue mientras corre git (en Windows
        # PowerShell 5.1 una linea por stderr seria NativeCommandError); el veredicto es $LASTEXITCODE.
        $lhpTracked = @(); $lhpRc = -1
        $lhpEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { $lhpTracked = @(& git -C $repo ls-files -t -- (':(literal)' + ($lhp -replace '\\', '/')) 2>$null | ForEach-Object { "$_" }); $lhpRc = $LASTEXITCODE }
        catch { $lhpRc = -1 }
        finally { $ErrorActionPreference = $lhpEap }
        if ($lhpRc -ne 0) { Write-Host "! $repo tiene core.hooksPath LOCAL ($lhp), esa carpeta no esta en el disco y no pude mirar si el repo la sigue (git ls-files salio $lhpRc) - no lo toco."; continue }
        $lhpKept = @($lhpTracked | Where-Object { $_ -and ($_ -notlike '*.sample') })
        if ($lhpKept.Count -gt 0) {
            $lhpWhy = if (@($lhpKept | Where-Object { $_ -clike 'S *' }).Count -gt 0) { 'la esconde la vista reducida (sparse-checkout) de un clon re-apuntado' } else { 'se borro del disco sin commitear' }
            Write-Host "! $repo tiene core.hooksPath LOCAL ($lhp): esa carpeta no esta en el disco, pero el repo la sigue con $($lhpKept.Count) archivo(s) - $lhpWhy. No es vestigial: no lo toco."
            continue
        }
    }
    if ($reales -eq 0) {
        if ($Check) { Write-Host "! $repo tiene core.hooksPath LOCAL vestigial ($lhp) - eclipsa los hooks del arnes" }
        else {
            # EAP=Continue + $LASTEXITCODE: con 'Stop' global, un git que tira mataría el instalador
            # con el candado tomado, y uno que sale distinto de 0 se anunciaría igual como «removido»
            $unRc = -1; $unErr = ''
            $unEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
            try { $unErr = (@(& git -C $repo config --local --unset core.hooksPath 2>&1 | ForEach-Object { "$_" }) -join ' ').Trim(); $unRc = $LASTEXITCODE }
            catch { $unErr = Get-ErrText $_; $unRc = -1 }
            finally { $ErrorActionPreference = $unEap }
            if ($unRc -eq 0) { Write-Host "+ $repo : core.hooksPath local vestigial removido - la delegacion global vuelve a regir" }
            else { Write-Host "! $repo tiene core.hooksPath LOCAL vestigial ($lhp) y no pude sacarlo (git salio $unRc$(if ($unErr) { ": $unErr" })) - sigue eclipsando los hooks del arnes ahi" }
        }
    } else {
        Write-Host "! $repo tiene core.hooksPath LOCAL con $reales hook(s) reales ($lhp) - los hooks del arnes NO corren ahi. Revisalo vos: no lo toco."
    }
}

if ($Check) { Write-PlanJson }   # el plan: con todo lo que se revisó, al final
Write-PieceReport
Exit-Installer 0

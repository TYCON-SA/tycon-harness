# bootstrap-fallback.ps1 — el RESPALDO en PowerShell del arranque del arnés (story 8.13, AC 13), gemelo de
# bootstrap-fallback.sh. Vive en ~/.claude/.tycon-pipeline/harness/, fuera del árbol; la línea de arranque lo corre
# cuando bootstrap.js no sale 0 (harness.js roto, enlace colgado, árbol ausente, node por debajo del piso, startup fallido).
#
# Hace lo de siempre: `git pull --ff-only --autostash --quiet` en el enlace del arnés y en ~/.claude/agent-skills (si
# existen) y después el aplicador (install-tycon-hooks.ps1). Si el enlace no resuelve, usa el árbol que dice el estado.
# Silencioso; una línea en startup.log y, si hay node, el aviso en `notice` del estado. Sale 0 siempre, salvo con un
# PowerShell más viejo que 7 (story 8.17, AC 35): ahí UNA línea y sale 1, antes de escribir nada.

# PowerShell 7 es un requisito (story 8.17): con Windows PowerShell 5.1 lo dice y no escribe nada (ni el log). Misma guarda
# y misma variable de prueba que install-tycon-hooks.ps1 (sólo simula una versión más vieja; el texto, sin tildes: allá
# está el porqué).
$TyconPsMajor = $PSVersionTable.PSVersion.Major
if ($env:TYCON_PS_MAJOR_FOR_TEST -match '^\d+$' -and [int]$env:TYCON_PS_MAJOR_FOR_TEST -lt $TyconPsMajor) {
    $TyconPsMajor = [int]$env:TYCON_PS_MAJOR_FOR_TEST
}
if ($TyconPsMajor -lt 7) {
    if ($TyconPsMajor -ne $PSVersionTable.PSVersion.Major) {
        Write-Output ("tycon: la variable TYCON_PS_MAJOR_FOR_TEST=$($env:TYCON_PS_MAJOR_FOR_TEST) esta puesta y simula un PowerShell viejo: " +
            "el respaldo del arranque NO corrio. Es una variable de prueba: sacala del entorno y volve a correrlo.")
        exit 1
    }
    Write-Output ("tycon: FALTA PowerShell 7 (pwsh): el respaldo del arranque NO corrio (no actualizo el arnes ni aplico los controles). " +
        "Este guion no corre con Windows PowerShell $TyconPsMajor. Instalar: winget install Microsoft.PowerShell")
    exit 1
}

# La carpeta de usuario: copia exacta de la función de install-tycon-hooks.ps1 (story 8.17, AC 33; allá está el porqué).
# Este archivo leía HOME primero: en Windows, con Git Bash, HOME no es la carpeta que usan harness.js y bootstrap.js.
# Lo mismo que os.homedir() de Node: en Windows USERPROFILE si esta puesta y, si no, la carpeta del perfil; en Linux y
# Mac HOME y, si no, la del perfil. -Platform es para las pruebas.
function Get-TyconHome([string]$Platform = [Environment]::OSVersion.Platform) {
    if ($Platform -eq 'Win32NT') { $h = $env:USERPROFILE } else { $h = $env:HOME }
    if (-not $h) { $h = [Environment]::GetFolderPath('UserProfile') }
    return $h
}

$ErrorActionPreference = 'SilentlyContinue'
# git nunca pregunta nada desde acá: ni la terminal ni el gestor de credenciales (un login invisible dejaba al arranque
# esperando hasta el tope del hook; story 8.23, tanda L)
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'
$H = Get-TyconHome
# dónde vive el estado (story 8.23, tanda C; gemelo del .sh): una máquina sin Claude Code vive entera en la casa propia
# del arnés (~/.tycon, o TYCON_HOME) y su estado es <casa>\state. La regla de tycon-home.js, escrita acá: si esa carpeta
# existe, es ésa; si no, la de siempre.
$Own = if ($env:TYCON_HOME) { $env:TYCON_HOME } else { Join-Path $H '.tycon' }
$Pipe = Join-Path $H '.claude\.tycon-pipeline'
if (Test-Path (Join-Path $Own 'state') -PathType Container) { $Pipe = Join-Path $Own 'state' }
$HDir = Join-Path $Pipe 'harness'
$Log = Join-Path $HDir 'startup.log'
$State = Join-Path $Pipe 'harness-state.json'
# los dos nombres del lugar del arnés (story 8.19, AC 9): primero el lugar, después el viejo; bajo HOME y bajo
# USERPROFILE si difieren. Escritos acá: esta copia fija no carga nada del árbol (copia declarada en
# scripts/tests/fixtures/harness-place-names.json)
$Link = Join-Path $H '.claude\tycon-harness'
$LinkTree = ''
# las dos carpetas salen de Get-TyconHome (story 8.17, AC 33): la de Linux/Mac es HOME y la de Windows, USERPROFILE
foreach ($b in @($H, (Get-TyconHome 'Unix'), (Get-TyconHome 'Win32NT'))) {
    if (-not $b -or $LinkTree) { continue }
    foreach ($n in @('tycon-harness', 'tycon-claude-guides')) {
        $cand = Join-Path (Join-Path $b '.claude') $n
        if (-not $LinkTree -and (Test-Path (Join-Path $cand 'scripts\install-tycon-hooks.ps1'))) { $LinkTree = $cand }
    }
}
$Skills = Join-Path $H '.claude\agent-skills'
New-Item -ItemType Directory -Force -Path $HDir | Out-Null
if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt 1048576)) { Move-Item -Force $Log "$Log.1" }

# ── la versión BAJADA (story 8.23, tanda B · AC 13 y 19), gemelo del .sh: sin git y sin Node en este camino ─────────
# Si el estado dice `kind: release`, el árbol es ~/.tycon/harness (o TYCON_HOME\harness) y no hay pull: un cambio de
# versión cortado a mitad se repara desde su diario (swap.json), y si harness.js no arranca y hay una versión anterior
# (previous\), se vuelve a ella (la rota queda apartada en trash\) y se corre su aplicador; sin previous\, el aviso.
# (`$Own`, la casa propia, se definió arriba.)
$Release = $false
if ((Test-Path $State) -and ((Get-Content $State -Raw) -match '"kind"\s*:\s*"release"')) { $Release = $true }
$Repaired = ''
$Journal = Join-Path $Own 'swap.json'
if (Test-Path $Journal) {
    try { $J = Get-Content $Journal -Raw | ConvertFrom-Json } catch { $J = $null }
    $OwnHarness = Join-Path $Own 'harness'; $OwnPrevious = Join-Path $Own 'previous'
    $stage = if ($J) { [string]$J.stage } else { '' }
    # cada mv se comprueba: «completó» sólo si movió de verdad (un archivo tomado lo hace fallar; el aviso no puede mentir —
    # revisor de fallos silenciosos de la tanda B)
    function Move-Checked([string]$From, [string]$To, [string]$Done) {
        try { Move-Item $From $To -ErrorAction Stop; return $Done } catch { return "no pude mover $From → $To ($($_.Exception.Message)); queda para el próximo arranque" }
    }
    switch ($stage) {
        { $_ -in 'harness-out', 'start', 'previous-cleared' } {
            if (-not (Test-Path $OwnHarness) -and $J.incoming -and (Test-Path $J.incoming)) { $Repaired = Move-Checked $J.incoming $OwnHarness 'completó el cambio (incoming → harness)' }
            elseif (-not (Test-Path $OwnHarness) -and (Test-Path $OwnPrevious)) { $Repaired = Move-Checked $OwnPrevious $OwnHarness 'deshizo el cambio (previous → harness)' }
            else { $Repaired = 'harness/ ya estaba' }
        }
        { $_ -in 'back-start', 'back-harness-out' } {
            if (-not (Test-Path $OwnHarness) -and (Test-Path $OwnPrevious)) {
                $Repaired = Move-Checked $OwnPrevious $OwnHarness 'completó la vuelta atrás (previous → harness)'
                if ((Test-Path $OwnHarness) -and $J.why -eq 'rollback' -and $J.aside -and (Test-Path $J.aside) -and -not (Test-Path $OwnPrevious)) { Move-Item $J.aside $OwnPrevious -ErrorAction SilentlyContinue }
            }
            elseif (-not (Test-Path $OwnHarness) -and $J.aside -and (Test-Path $J.aside)) { $Repaired = Move-Checked $J.aside $OwnHarness 'recuperó la versión activa' }
            else { $Repaired = 'harness/ ya estaba' }
        }
        'back-previous-in' {
            if (-not (Test-Path $OwnPrevious) -and $J.aside -and (Test-Path $J.aside)) { $Repaired = Move-Checked $J.aside $OwnPrevious 'la deshecha quedó como previous/' } else { $Repaired = 'la vuelta atrás ya estaba completa' }
        }
        default { $Repaired = "diario en «$stage» sin nada a medias" }
    }
    if (Test-Path $OwnHarness) { Remove-Item $Journal -Force -ErrorAction SilentlyContinue }
}

# el árbol: el enlace si resuelve; si no, el `tree` del estado
$Tree = ''
$Why = ''
if ($Release) {
    $Tree = Join-Path $Own 'harness'
    $HarnessJs = Join-Path $Tree 'scripts\setup\harness.js'
    $HasNode = [bool](Get-Command node -ErrorAction SilentlyContinue)
    $Broken = -not (Test-Path $HarnessJs)
    if (-not $Broken -and $HasNode) { & node --check $HarnessJs *> $null; if ($LASTEXITCODE -ne 0) { $Broken = $true } }
    if (-not $HasNode) {
        # sin node no se sabe si harness.js arranca (bootstrap.js no corrió por eso): no se vuelve a ninguna versión
        $Why = 'node no está en el PATH: no puedo saber si harness.js arranca; no vuelvo a ninguna versión; '
    } elseif ($Broken) {
        $OwnPrevious = Join-Path $Own 'previous'
        if (Test-Path $OwnPrevious) {
            New-Item -ItemType Directory -Force -Path (Join-Path $Own 'trash') | Out-Null
            $Aside = Join-Path (Join-Path $Own 'trash') ("failed-" + (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss'))
            try { Move-Item $Tree $Aside -ErrorAction Stop; Move-Item $OwnPrevious $Tree -ErrorAction Stop; $Why = "harness.js no arrancaba: volví a la versión anterior (previous → harness; la rota en $Aside); " }
            catch { $Why = 'harness.js no arranca y no pude volver a previous/; ' }
        } else {
            $Why = 'harness.js no arranca y no hay versión anterior: volvé a instalar con node <copia>\scripts\setup\harness.js install --version latest; '
        }
    }
    if ($Repaired) { $Why += "reparación desde el diario: $Repaired; " }
} elseif ($LinkTree) {
    $Tree = $LinkTree
} else {
    $Why = "el enlace $Link no resuelve; "
    if (Test-Path $State) {
        try { $t = (Get-Content $State -Raw | ConvertFrom-Json).tree } catch { $t = '' }
        if ($t -and (Test-Path (Join-Path $t 'scripts\install-tycon-hooks.ps1'))) { $Tree = $t }
    }
}

# en modo developer el árbol es el clon propio del dev: el respaldo NO toca su git, sólo corre el aplicador (gemelo del .sh)
$Mode = ''
if (Test-Path $State) { try { $Mode = (Get-Content $State -Raw | ConvertFrom-Json).mode } catch { $Mode = '' } }

$NodeV = ''
try { $NodeV = (& node --version 2>$null) } catch {}
$Pulled = ''
if ($Mode -eq 'developer') { $Pulled = ' ninguno (modo desarrollador: el git del clon es del dev)' }

# La guarda (story 8.18, AC 34), gemela de la del .sh: el clon del que salen las skills (~/.claude/agent-skills: el clon
# viejo, re-apuntado o no, o el único árbol) NUNCA avanza a una punta que no trae skills/tycon-pipeline (`main` devuelto a
# un árbol de antes de la unión de los dos repos). Se mira ANTES del pull: se trae sin mover y se mira el árbol de lo
# traído. Si no las trae no se mueve NINGUNO de los dos clones; el aplicador corre igual, con lo que hay.
#
# «No pude mirar» no es «no las trae» (story 8.18, tramo 3 · revisor de fallos silenciosos, 2026-10-04), como en el .sh:
# `git cat-file -e <commit>:skills/tycon-pipeline` contesta lo mismo si el árbol no trae la carpeta que si git no pudo
# leerlo. Con el árbol de HEAD sin leer el respaldo hacía el pull —a una punta sin skills—; con el de lo traído sin leer
# frenaba diciendo «no trae las skills», que no era cierto. Tres respuestas: `git ls-tree -d --name-only` sale 0 y nombra
# la carpeta (yes) · sale 0 y no la nombra (no) · no sale 0 (unknown). Con «unknown» tampoco se mueve ningún clon, y la
# línea dice qué no se pudo leer. Un clon sin rama de la que traer (rev-parse sale 1) no tiene a dónde avanzar.
# Medido con pwsh: scripts/tests/harness-bootstrap.test.sh (T35). En Windows: no medido.
function Get-SkillsAt([string]$Rev) {
    $names = @(& git -C $Skills ls-tree -d --name-only "${Rev}^{tree}" -- 'skills/tycon-pipeline' 2>$null)
    if ($LASTEXITCODE -ne 0) { return 'unknown' }
    if ($names -contains 'skills/tycon-pipeline') { return 'yes' }
    return 'no'
}
$Guard = $false
if ($Release) { $Pulled = ' ninguno (versión bajada: sin git)' }
if (($Mode -ne 'developer') -and (-not $Release) -and (Test-Path $Skills)) {
    & git -C $Skills rev-parse --git-dir *> $null
    if ($LASTEXITCODE -eq 0) {
        $Here = Get-SkillsAt 'HEAD'
        if ($Here -eq 'unknown') {
            $Guard = $true; $Pulled = " ninguno (no pude mirar si de $Skills salen las skills: git no leyó el árbol de HEAD; no se aplica)"
        } elseif ($Here -eq 'yes') {
            & git -C $Skills fetch --quiet *> $null
            $Up = (& git -C $Skills rev-parse --verify -q '@{upstream}^{commit}' 2>$null)
            $UpRc = $LASTEXITCODE
            if (($UpRc -eq 0) -and $Up) {
                $There = Get-SkillsAt "$Up"
                if ($There -eq 'no') { $Guard = $true; $Pulled = ' ninguno (la versión nueva no trae las skills: no se aplica)' }
                elseif ($There -eq 'unknown') { $Guard = $true; $Pulled = " ninguno (no pude mirar si la versión nueva trae las skills: git no leyó el árbol de $Up en $Skills; no se aplica)" }
            } elseif ($UpRc -ne 1) {
                # 1 = no hay rama de la que traer (o HEAD suelto); otra salida es git que no pudo contestar
                $Guard = $true; $Pulled = " ninguno (no pude mirar a qué versión avanzaría ${Skills}: git rev-parse salió $UpRc; no se aplica)"
            }
        }
    }
}

foreach ($d in @($Tree, $Skills)) {
    if ($Mode -eq 'developer') { break }
    if ($Release) { break }
    if ($Guard) { break }
    if (-not $d -or -not (Test-Path $d)) { continue }
    & git -C $d rev-parse --git-dir *> $null
    if ($LASTEXITCODE -ne 0) { continue }
    & git -C $d pull --ff-only --autostash --quiet *> $null
    $name = Split-Path -Leaf $d
    if ($LASTEXITCODE -eq 0) { $Pulled += " ${name}:ok" } else { $Pulled += " ${name}:no" }
}
$Applier = 'sin aplicador (árbol no encontrado)'
# el aplicador es el enchufe de Claude Code (story 8.23, tanda C; gemelo del .sh): si el estado dice qué herramientas
# enchufa la máquina y Claude Code no está entre ellas, no corre. Sin `tools` en el estado, como siempre.
$NoClaude = $false
if (Test-Path $State) {
    try {
        $st = Get-Content $State -Raw | ConvertFrom-Json
        if ($null -ne $st.tools -and (@($st.tools) -notcontains 'claude')) { $NoClaude = $true }
    } catch { $NoClaude = $false }
}
if ($Tree) {
    if ($NoClaude) { $Applier = 'aplicador no corrido (esta máquina no enchufa a Claude Code)' }
    elseif ($env:TYCON_NO_AUTOINSTALL -eq '1') { $Applier = 'aplicador no corrido (TYCON_NO_AUTOINSTALL=1)' }
    else {
        & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Tree 'scripts\install-tycon-hooks.ps1') *> $null
        if ($LASTEXITCODE -eq 0) { $Applier = 'aplicador ok' } else { $Applier = "aplicador salió $LASTEXITCODE" }
    }
}
if (-not $NodeV) { $NodeV = 'ausente' }
if (-not $Pulled) { $Pulled = ' ninguno' }
$Line = "respaldo en shell: bootstrap.js no arrancó harness.js (${Why}node $NodeV); pull:$Pulled; $Applier"
$Stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
Add-Content -Path $Log -Value "$Stamp fallback: $Line"

# el aviso en el estado, para que el hook síncrono se lo diga a la persona
if ((Test-Path $State) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    $js = 'const fs=require("fs"),f=process.argv[1],text=process.argv[2];try{const s=JSON.parse(fs.readFileSync(f,"utf8"));if(!s||typeof s!=="object")process.exit(0);s.notice=text+" — mirá "+process.argv[3]+" y corré harness.js doctor";const tmp=f+"."+process.pid+".tmp";fs.writeFileSync(tmp,JSON.stringify(s,null,2)+"\n");fs.renameSync(tmp,f);}catch(e){}'
    & node -e $js $State $Line $Log *> $null
}
exit 0

# sync-claude-md-blocks.ps1 — contraparte Windows de sync-claude-md-blocks.sh
#
# Sincroniza los bloques team-wide de `~/.claude/CLAUDE.md` desde `claude-md-blocks/*.md`.
# Mismo contrato que la versión bash: idempotente, quirúrgico (solo toca lo que está entre
# sus propios marcadores), backup antes del primer cambio, atomic write, silencioso si no
# hubo cambios, fail-open total, opt-out via TYCON_NO_CLAUDEMD_SYNC=1.
#
# Ver el header de sync-claude-md-blocks.sh para el porqué y el flujo de propagación.
#
# Story 8.13 (tanda B), como el .sh: lanzado por harness.js (`TYCON_HARNESS_SNAPSHOT_DIR` puesta) no escribe sus `.bak`
# —la copia ya la tomó el mecanismo—; con `TYCON_REPORT_PIECES=<archivo>` (se la deja el aplicador con -ReportJson)
# anota ahí los bloques que quedaron en su lugar y el espejo de Codex. Con -Check no anota nada.
#
# Story 8.7 (AC 25), como el .sh: un bloque cuya PRIMERA línea es `<!-- requires-integration: <integración> -->` se
# escribe sólo con esa integración prendida según `scripts/lib/tycon-config.js integrations --json` (una sola pregunta,
# y sólo si algún bloque lo declara); apagada, no se agrega y, si estaba, se quita (con -Check sólo avisa que sobra); si no
# se pudo saber (configuración rota, sin node, integración desconocida), no se agrega si falta, queda y se actualiza si
# está, y una línea lo dice. Esa primera línea nunca se copia al CLAUDE.md.
#
# Uso:
#   .\sync-claude-md-blocks.ps1          # sincroniza
#   .\sync-claude-md-blocks.ps1 -Check   # reporta qué está desactualizado, no modifica
#
# -Given (story 8.36; lo pasa install-tycon-hooks.ps1): lo que el lector de configuración ya le contestó al aplicador en
# esta misma corrida —@{ ProfileRc; ProfileOut; IntegRc; IntegOut }, el código y la salida de `get install.profile` y de
# `integrations --json`—. Con eso no vuelve a lanzar Node para preguntarlo; lo interpreta igual. Sin -Given (corrido
# suelto), pregunta como siempre.

param([switch]$Check, [hashtable]$Given)

$ErrorActionPreference = 'Continue'

if ($env:TYCON_NO_CLAUDEMD_SYNC -eq '1') { exit 0 }

# PowerShell 7 es un requisito (story 8.17): lanzado suelto con Windows PowerShell 5.1, lo dice y no toca el CLAUDE.md.
# El instalador ya frena antes de llegar acá; esto cubre a quien lo corre a mano. Mismo criterio y misma variable de
# prueba que install-tycon-hooks.ps1 (sólo simula una versión más vieja; el texto, sin tildes: ver allá).
$TyconPsMajor = $PSVersionTable.PSVersion.Major
if ($env:TYCON_PS_MAJOR_FOR_TEST -match '^\d+$' -and [int]$env:TYCON_PS_MAJOR_FOR_TEST -lt $TyconPsMajor) {
    $TyconPsMajor = [int]$env:TYCON_PS_MAJOR_FOR_TEST
}
if ($TyconPsMajor -lt 7) {
    if ($TyconPsMajor -ne $PSVersionTable.PSVersion.Major) {
        Write-Output ("tycon: la variable TYCON_PS_MAJOR_FOR_TEST=$($env:TYCON_PS_MAJOR_FOR_TEST) esta puesta y simula un PowerShell viejo: " +
            "las reglas NO se sincronizaron. Es una variable de prueba: sacala del entorno y volve a correrlo.")
        exit 1
    }
    Write-Output ("tycon: FALTA PowerShell 7 (pwsh): las reglas del equipo NO se sincronizaron en el CLAUDE.md. " +
        "Este guion no corre con Windows PowerShell $TyconPsMajor. Instalar: winget install Microsoft.PowerShell")
    exit 1
}

# La carpeta de usuario: copia exacta de la función de install-tycon-hooks.ps1 (story 8.17, AC 33; allá está el porqué).
# Lo mismo que os.homedir() de Node: en Windows USERPROFILE si esta puesta y, si no, la carpeta del perfil; en Linux y
# Mac HOME y, si no, la del perfil. -Platform es para las pruebas.
function Get-TyconHome([string]$Platform = [Environment]::OSVersion.Platform) {
    if ($Platform -eq 'Win32NT') { $h = $env:USERPROFILE } else { $h = $env:HOME }
    if (-not $h) { $h = [Environment]::GetFolderPath('UserProfile') }
    return $h
}

# Los finales de línea, como los lee el .sh (story 8.17, AC 36): python abre con saltos universales, así que \r\n y un
# \r suelto pasan a \n, en los bloques y en el CLAUDE.md. Sin esto, un clon de Windows con autocrlf copiaba los \r al
# CLAUDE.md y el resultado no era el del .sh.
function ConvertTo-SyncLf([string]$Text) { return (($Text -replace "`r`n", "`n") -replace "`r", "`n") }

# una pieza para el reporte del aplicador: kind<TAB>ruta absoluta<TAB>id, una por línea. Nunca rompe el sync.
function Record-SyncPiece([string]$Line) {
    if ($Check -or -not $env:TYCON_REPORT_PIECES) { return }
    try { [IO.File]::AppendAllText($env:TYCON_REPORT_PIECES, "$Line`n") } catch { }
}

# el cuerpo de un bloque, la integración que requiere (o $null) y el marcador mal escrito (o $null): el cuerpo va sin la
# línea del marcador (bien o mal escrito: nunca se copia) y con el recorte de siempre. Espejo de read_block del .sh.
# Un marcador CASI bien escrito (otra forma, o fuera de la primera línea) no es un bloque común: sería una regla escrita
# donde su servicio está apagado, con el comentario copiado al CLAUDE.md y sin una palabra. Es «no se pudo saber».
# Un BOM delante no cambia nada: ReadAllText ya lo descarta.
# Story 8.16 (tanda C · AC 24), como el .sh: las primeras líneas pueden traer también `<!-- requires-profile: full -->`,
# una de cada clase como mucho y en cualquier orden. BadMarker es @{ Kind = 'integration'|'profile'; Line = … } o $null.
$SyncProfiles = @('minimal', 'full')
function Read-SyncBlock([string]$Path) {
    $raw = ConvertTo-SyncLf ([IO.File]::ReadAllText($Path))
    $lines = $raw.Split([char]10)
    $requires = $null; $profiles = $null; $bad = $null; $i = 0
    while ($i -lt $lines.Count) {
        $m = [regex]::Match($lines[$i], '^<!--\s*requires-integration:\s*([a-z]+)\s*-->\s*$')
        $p = [regex]::Match($lines[$i], '^<!--\s*requires-profile:\s*([a-z]+(?:\s*,\s*[a-z]+)*)\s*-->\s*$')
        if ($m.Success -and $null -eq $requires) { $requires = $m.Groups[1].Value }
        elseif ($p.Success -and $null -eq $profiles) {
            $profiles = @($p.Groups[1].Value.Split(',') | ForEach-Object { $_.Trim() })
            if (@($profiles | Where-Object { $SyncProfiles -notcontains $_ }).Count) { $bad = @{ Kind = 'profile'; Line = $lines[$i].Trim() } }
        }
        elseif ($m.Success -or $p.Success) { $bad = @{ Kind = $(if ($m.Success) { 'integration' } else { 'profile' }); Line = $lines[$i].Trim() } }
        else { break }
        $i++
    }
    $rest = @(if ($i -lt $lines.Count) { $lines[$i..($lines.Count - 1)] })
    if ($null -eq $bad) {
        for ($idx = 0; $idx -lt $rest.Count; $idx++) {
            if (-not $rest[$idx].Trim()) { continue }
            $li = [regex]::IsMatch($rest[$idx], '^\s*<!--\s*requires-integration\b', 'IgnoreCase')
            $lp = [regex]::IsMatch($rest[$idx], '^\s*<!--\s*requires-profile\b', 'IgnoreCase')
            if ($li -or $lp) {
                $bad = @{ Kind = $(if ($li) { 'integration' } else { 'profile' }); Line = $rest[$idx].Trim() }
                $rest = @(for ($k = 0; $k -lt $rest.Count; $k++) { if ($k -ne $idx) { $rest[$k] } })
            }
            break   # la primera línea con texto es otra cosa: el cuerpo
        }
    }
    return @{ Body = ($rest -join "`n").Trim("`n"); Requires = $requires; Profiles = $profiles; BadMarker = $bad }
}

# El perfil de instalación activo (`minimal` | `full`; sin valor es `full`), una sola vez: @{ Value; Why }.
$script:SyncProfile = $null
function Get-SyncProfile([string]$Reader) {
    if ($null -eq $script:SyncProfile) {
        $value = $null; $why = $null
        $known = $Given -and $Given.ContainsKey('ProfileRc')   # ya lo leyó el aplicador (ver -Given, arriba)
        if (-not $known -and -not (Test-Path $Reader)) { $why = 'no encontré el lector de configuración (scripts/lib/tycon-config.js)' }
        elseif (-not $known -and -not (Get-Command node -ErrorAction SilentlyContinue)) { $why = 'falta node en el PATH' }
        else {
            try {
                if ($known) { $out = ("$($Given.ProfileOut)" | Out-String).Trim(); $rc = $Given.ProfileRc }
                else {
                    $out = (& node $Reader get install.profile 2>$null | Out-String).Trim()
                    $rc = $LASTEXITCODE
                }
                if ($rc -eq 3) { $value = 'full' }
                elseif ($rc -eq 0 -and $SyncProfiles -contains $out) { $value = $out }
                elseif ($rc -eq 2) { $why = 'configuración rota: `node scripts/lib/tycon-config.js validate` dice qué' }
                else { $why = "el lector de configuración falló (exit $rc)" }
            } catch { $why = 'el lector de configuración contestó algo que no se entiende' }
        }
        $script:SyncProfile = @{ Value = $value; Why = $why }
    }
    return $script:SyncProfile
}

# el estado de una integración: on · off · unknown (con el motivo). Pregunta UNA vez al lector de configuración del arnés;
# `detect` cuenta como prendida, igual que en el lector. No saber no es «apagada».
$script:SyncIntegrations = $null
function Get-SyncIntegrationState([string]$Name, [string]$Reader) {
    if ($null -eq $script:SyncIntegrations) {
        $data = $null; $why = $null
        $known = $Given -and $Given.ContainsKey('IntegRc')   # ya lo leyó el aplicador (ver -Given, arriba)
        if (-not $known -and -not (Test-Path $Reader)) { $why = 'no encontré el lector de configuración (scripts/lib/tycon-config.js)' }
        elseif (-not $known -and -not (Get-Command node -ErrorAction SilentlyContinue)) { $why = 'falta node en el PATH' }
        else {
            try {
                if ($known) { $out = $Given.IntegOut; $rc = $Given.IntegRc }
                else {
                    $out = & node $Reader integrations --json 2>$null
                    $rc = $LASTEXITCODE
                }
                if ($rc -eq 2) { $why = 'configuración rota: `node scripts/lib/tycon-config.js validate` dice qué' }
                elseif ($rc -ne 0) { $why = "el lector de configuración falló (exit $rc)" }
                else { $data = ($out | Out-String) | ConvertFrom-Json }
            } catch { $data = $null }
            if ($null -eq $data -and -not $why) { $why = 'el lector de configuración contestó algo que no se entiende' }
        }
        $script:SyncIntegrations = @{ Data = $data; Why = $why }
    }
    $known = $script:SyncIntegrations
    if ($null -eq $known.Data) { return @{ State = 'unknown'; Why = $known.Why } }
    $prop = $known.Data.PSObject.Properties[$Name]
    if ($null -eq $prop) { return @{ State = 'unknown'; Why = 'el lector no conoce esa integración' } }
    if ($prop.Value -is [bool] -and -not $prop.Value) { return @{ State = 'off'; Why = $null } }
    return @{ State = 'on'; Why = $null }
}

# Story 2.31, como el .sh: cómo contesta el asistente (idioma, estilo y tope, ya resueltos por el lector), una sola vez:
# @{ Data; Why }. Un bloque con variantes es una carpeta `claude-md-blocks/<bloque>/` con `<estilo>.<idioma>.md`.
$script:SyncResponse = $null
function Get-SyncResponse([string]$Reader) {
    if ($null -eq $script:SyncResponse) {
        $data = $null; $why = $null
        if (-not (Test-Path $Reader)) { $why = 'no encontré el lector de configuración (scripts/lib/tycon-config.js)' }
        elseif (-not (Get-Command node -ErrorAction SilentlyContinue)) { $why = 'falta node en el PATH' }
        else {
            try {
                $out = & node $Reader response --json 2>$null
                $rc = $LASTEXITCODE
                if ($rc -eq 2) { $why = 'configuración rota: `node scripts/lib/tycon-config.js validate` dice qué' }
                elseif ($rc -ne 0) { $why = "el lector de configuración falló (exit $rc)" }
                else {
                    $data = ($out | Out-String) | ConvertFrom-Json
                    if (-not ($data.max_chars -is [long] -or $data.max_chars -is [int])) { $data = $null }
                }
            } catch { $data = $null }
            if ($null -eq $data -and -not $why) { $why = 'el lector de configuración contestó algo que no se entiende' }
        }
        $script:SyncResponse = @{ Data = $data; Why = $why }
    }
    return $script:SyncResponse
}

# Una fila de tabla que termina en `<!-- integration: <x> -->` se escribe sólo con esa integración prendida; el marcador
# nunca se copia. No se pudo saber: la fila queda como estaba en el destino (espejo de filter_rows del .sh).
function Select-SyncRows([string]$Body, [string]$Existing, [string]$Reader) {
    # con mayúsculas y minúsculas distintas no es la misma fila (un @{} de PowerShell las confunde; el .sh y el .js no)
    $kept = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    if ($Existing) { foreach ($l in $Existing.Split([char]10)) { [void]$kept.Add($l.TrimEnd([char]13)) } }
    $out = foreach ($line in $Body.Split([char]10)) {
        $m = [regex]::Match($line, '^(.*\|)[ \t]*<!--\s*integration:\s*([a-z]+)\s*-->\s*$')
        if (-not $m.Success) { $line; continue }
        $row = $m.Groups[1].Value.TrimEnd()
        $st = Get-SyncIntegrationState $m.Groups[2].Value $Reader
        if ($st.State -eq 'on' -or ($st.State -eq 'unknown' -and $kept.Contains($row))) { $row }
    }
    return (@($out) -join "`n")
}

try {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $blocksDir = Join-Path (Split-Path -Parent (Split-Path -Parent $scriptDir)) 'claude-md-blocks'

    $target = $env:CLAUDE_MD_PATH
    if (-not $target) { $target = Join-Path (Get-TyconHome) '.claude\CLAUDE.md' }

    if (-not (Test-Path $blocksDir)) { exit 0 }

    $files = @(Get-ChildItem -Path $blocksDir -Filter '*.md' -File | Sort-Object Name)
    # los bloques con variantes (story 2.31): una carpeta con `<estilo>.<idioma>.md`; `names` son las variantes de Codex
    # (sólo cuenta una carpeta con algún `<estilo>.<idioma>.md`: otro .md anidado no es un bloque)
    # (una carpeta que no se deja leer cuenta como bloque sin texto elegible: queda como estaba y se avisa)
    $unreadable = @{}
    $variantDirs = @(Get-ChildItem -Path $blocksDir -Directory | Where-Object {
        $dir = $_
        if ($dir.Name -ceq 'names') { return $false }
        try { return [bool]@([IO.Directory]::GetFiles($dir.FullName) | Where-Object { [IO.Path]::GetFileName($_) -cmatch '^[a-z]+\.[a-z]{2}\.md$' }).Count }
        catch { $unreadable[$dir.FullName] = $true; return $true }
    })
    # un archivo y una carpeta con el mismo nombre: gana el archivo (como el .sh y agents-md-blocks.js); el orden, por
    # código de carácter, igual que ellos (Sort-Object compara con reglas de idioma y ordenaba distinto)
    $fileNames = @{}; foreach ($f in $files) { $fileNames[[IO.Path]::GetFileNameWithoutExtension($f.Name)] = $true }
    $list = New-Object System.Collections.Generic.List[object]
    foreach ($f in $files) { $list.Add([pscustomobject]@{ Name = [IO.Path]::GetFileNameWithoutExtension($f.Name); Path = $f.FullName; Variant = $false }) }
    foreach ($d in $variantDirs) { if (-not $fileNames.ContainsKey($d.Name)) { $list.Add([pscustomobject]@{ Name = $d.Name; Path = $d.FullName; Variant = $true }) } }
    $list.Sort([Comparison[object]] { param($a, $b) [string]::CompareOrdinal($a.Name, $b.Name) })
    $entries = $list.ToArray()   # (@($list) sobre una List genérica falla en pwsh: «Argument types do not match»)
    if ($entries.Count -eq 0) { exit 0 }

    $original = ''
    $originalRaw = ''   # tal cual está en el disco: es lo que va a la copia de respaldo
    if (Test-Path $target) {
        $originalRaw = [IO.File]::ReadAllText($target)
        $original = ConvertTo-SyncLf $originalRaw
    }
    $content = $original
    $changed = @()
    $removed = @{}   # bloque → la integración apagada por la que se quita
    $unknown = @()   # avisos: bloques cuya integración no se pudo saber
    $configReader = Join-Path (Join-Path (Split-Path -Parent $scriptDir) 'lib') 'tycon-config.js'

    $final = @{}   # bloque → su texto entero entre marcadores, como debería quedar (para el reporte del aplicador)
    foreach ($e in $entries) {
        $name = $e.Name
        $blockPath = $e.Path
        $startPrefix = "<!-- TYCON_BLOCK:$name START"
        $end = "<!-- TYCON_BLOCK:$name END -->"
        $i0 = $content.IndexOf($startPrefix)
        $j0 = if ($i0 -ge 0) { $content.IndexOf($end, $i0) } else { -1 }
        $existingBody = ''
        if ($j0 -ge 0) { $nl = $content.IndexOf("`n", $i0) + 1; if ($nl -gt 0 -and $nl -le $j0) { $existingBody = $content.Substring($nl, $j0 - $nl) } }
        if ($e.Variant) {
            $resp = if ($unreadable.ContainsKey($e.Path)) { @{ Data = $null; Why = 'no pude leer su carpeta de variantes' } } else { Get-SyncResponse $configReader }
            $vwhy = $resp.Why
            if ($resp.Data) {
                $blockPath = Join-Path $e.Path "$($resp.Data.style).$($resp.Data.language).md"
                if (-not (Test-Path $blockPath)) { $vwhy = "no hay texto para el estilo «$($resp.Data.style)» en «$($resp.Data.language)»" }
            }
            if ($vwhy) {
                # no se pudo elegir el texto: no se inventa uno; lo que había queda tal cual, sin actualizar (AC 6)
                $unknown += "⚠ tycon: bloque CLAUDE.md '$name': no pude saber cómo tiene que contestar el asistente (${vwhy}): $(if ($i0 -lt 0) { 'no se agrega' } else { 'queda como estaba' })"
                if ($j0 -ge 0) { $final[$name] = $content.Substring($i0, $j0 + $end.Length - $i0) }
                continue
            }
        }
        $block = Read-SyncBlock $blockPath
        $body = $block.Body
        if ($e.Variant) {
            $n = [long]$resp.Data.max_chars
            $body = $body.Replace('{{max_chars}}', "$n").Replace('{{max_lines}}', "$([long][Math]::Floor(($n + 50) / 100))")
        }
        $body = Select-SyncRows $body $existingBody $configReader
        $requires = $block.Requires
        $profiles = $block.Profiles
        $badMarker = $block.BadMarker
        # apagado por una de las dos razones alcanza; si no, no saber cualquiera de las dos es «no se pudo saber»
        $state = 'on'; $why = $null; $whyKind = $null; $offWhy = $null
        if ($badMarker) { $state = 'unknown' }
        else {
            $parts = @()
            if ($requires) { $st = Get-SyncIntegrationState $requires $configReader; $parts += , @($st.State, $(if ($st.State -eq 'off') { "integración «$requires» apagada" } else { $st.Why }), 'integration') }
            if ($profiles) {
                $pr = Get-SyncProfile $configReader
                if ($null -eq $pr.Value) { $parts += , @('unknown', $pr.Why, 'profile') }
                elseif ($profiles -contains $pr.Value) { $parts += , @('on', $null, 'profile') }
                else { $parts += , @('off', "perfil «$($pr.Value)»", 'profile') }
            }
            $off = @($parts | Where-Object { $_[0] -eq 'off' })
            $unk = @($parts | Where-Object { $_[0] -eq 'unknown' })
            if ($off.Count) { $state = 'off'; $offWhy = $off[0][1] }
            elseif ($unk.Count) { $state = 'unknown'; $why = $unk[0][1]; $whyKind = $unk[0][2] }
        }

        $start = "<!-- TYCON_BLOCK:$name START — generado por scripts/setup/sync-claude-md-blocks.sh del arnés · NO EDITAR A MANO (se pisa en el próximo SessionStart); editá claude-md-blocks/$name.md y commiteá -->"
        $end = "<!-- TYCON_BLOCK:$name END -->"
        $desired = "$start`n$body`n$end"
        $final[$name] = $desired

        # Localizar por PREFIJO (ver comentario equivalente en la versión bash).
        $i = $i0
        if ($state -eq 'unknown') {
            # No saber no es «apagada»: lo que falta no se agrega; lo que está queda y se actualiza abajo, como siempre.
            $fate = if ($i -lt 0) { 'no se agrega' } else { 'queda donde está' }
            if ($badMarker -and $badMarker.Kind -eq 'integration') {
                $unknown += "⚠ tycon: bloque CLAUDE.md '$name': su marcador requires-integration está mal escrito ($($badMarker.Line); va en la primera línea, exacto: <!-- requires-integration: nombre -->): $fate"
            } elseif ($badMarker) {
                $unknown += "⚠ tycon: bloque CLAUDE.md '$name': su marcador requires-profile está mal escrito o repetido ($($badMarker.Line); va en las primeras líneas, una vez y exacto: <!-- requires-profile: full -->): $fate"
            } elseif ($whyKind -eq 'profile') {
                $unknown += "⚠ tycon: bloque CLAUDE.md '$name' requiere el perfil «$($profiles -join ', ')» y no pude saber cuál tiene esta máquina (${why}): $fate"
            } else {
                $unknown += "⚠ tycon: bloque CLAUDE.md '$name' requiere la integración «$requires» y no pude saber si está prendida (${why}): $fate"
            }
        }
        if ($i -lt 0) {
            if ($state -ne 'on') { continue }
            $content = $content.TrimEnd("`n") + "`n`n" + $desired + "`n"
            $changed += , @($name, 'agregado')
            continue
        }

        $j = $content.IndexOf($end, $i)
        if ($j -lt 0) {
            $changed += , @($name, 'MARCADOR DE CIERRE FALTANTE — revisar a mano')
            continue
        }

        if ($state -eq 'off') {
            # Integración apagada con el bloque ya escrito: se va entre sus marcadores, con el renglón en blanco que el
            # agregado le puso delante (ver el comentario equivalente en la versión bash).
            $before = $content.Substring(0, $i).TrimEnd("`n")
            $after = $content.Substring($j + $end.Length)
            if ($after.StartsWith("`r`n", [StringComparison]::Ordinal)) { $after = $after.Substring(2) }
            elseif ($after.StartsWith("`n", [StringComparison]::Ordinal)) { $after = $after.Substring(1) }
            if ($before -or $after) { $content = $before + "`n" + $after } else { $content = '' }
            $changed += , @($name, "quitado ($offWhy)")
            $removed[$name] = $offWhy
            continue
        }

        $existing = $content.Substring($i, $j + $end.Length - $i)
        if ($existing -ceq $desired) { continue }
        $content = $content.Substring(0, $i) + $desired + $content.Substring($j + $end.Length)
        $changed += , @($name, 'actualizado')
    }

    foreach ($c in $changed) {
        if ($c[1] -like '*FALTANTE*') {
            Write-Host "⚠ tycon: bloque '$($c[0])' en ${target}: $($c[1])"
        }
    }
    foreach ($u in $unknown) { Write-Host $u }

    # ============================================================
    # Lado Codex (opt-in TYCON_CODEX=1): AGENTS.md = espejo del CLAUDE.md ya
    # sincronizado, con los bloques que tienen variante names/<name>.codex.md
    # reemplazados por el cuerpo de la variante. Copia tonta del resto.
    # Corre ANTES de los early-exits: el espejo depende del contenido final,
    # no de si el lado Claude cambió (mismo contrato que la versión bash).
    # ============================================================
    # Desde la tanda C de la story 8.23 AGENTS.md lleva los BLOQUES entre marcas, escritos por agents-md-blocks.js (lo
    # llama el enchufe de Codex); la copia ENTERA del CLAUDE.md la hace sólo un árbol de antes, sin ese escritor (el .sh
    # dejó de hacerla; pase adversarial de la C, clase 19: los dos escribían el mismo archivo y se pisaban)
    if ($env:TYCON_CODEX -eq '1' -and -not (Test-Path (Join-Path $PSScriptRoot 'agents-md-blocks.js'))) {
        try {
            $codexTarget = $env:CODEX_AGENTS_MD_PATH
            if (-not $codexTarget) { $codexTarget = Join-Path (Get-TyconHome) '.codex\AGENTS.md' }
            $codexContent = $content
            foreach ($f in $files) {
                $name = [IO.Path]::GetFileNameWithoutExtension($f.Name)
                $variant = Join-Path (Join-Path $blocksDir 'names') "$name.codex.md"
                if (-not (Test-Path $variant)) { continue }
                $vbody = (ConvertTo-SyncLf ([IO.File]::ReadAllText($variant))).Trim("`n")
                $start = "<!-- TYCON_BLOCK:$name START — generado por scripts/setup/sync-claude-md-blocks.sh del arnés · NO EDITAR A MANO (se pisa en el próximo SessionStart); editá claude-md-blocks/$name.md y commiteá -->"
                $end = "<!-- TYCON_BLOCK:$name END -->"
                $startPrefix = "<!-- TYCON_BLOCK:$name START"
                $ci = $codexContent.IndexOf($startPrefix)
                if ($ci -lt 0) { continue }
                $cj = $codexContent.IndexOf($end, $ci)
                if ($cj -lt 0) { continue }
                $codexContent = $codexContent.Substring(0, $ci) + "$start`n$vbody`n$end" + $codexContent.Substring($cj + $end.Length)
            }
            $codexOriginal = ''; $codexOriginalRaw = ''
            if (Test-Path $codexTarget) { $codexOriginalRaw = [IO.File]::ReadAllText($codexTarget); $codexOriginal = ConvertTo-SyncLf $codexOriginalRaw }
            if ($codexContent -cne $codexOriginal) {
                if ($Check) {
                    Write-Host "⚠ tycon: $codexTarget desactualizado respecto del canónico — corré sync-claude-md-blocks.ps1"
                } else {
                    $codexDir = Split-Path -Parent $codexTarget
                    if ($codexDir -and -not (Test-Path $codexDir)) { New-Item -ItemType Directory -Path $codexDir -Force | Out-Null }
                    if ($codexOriginal -and -not $env:TYCON_HARNESS_SNAPSHOT_DIR) {
                        $cts = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss'
                        [IO.File]::WriteAllText("$codexTarget.bak.$cts", $codexOriginalRaw)
                    }
                    $ctmp = "$codexTarget.tmp.$(Get-Random)"
                    [IO.File]::WriteAllText($ctmp, $codexContent)
                    Move-Item -Path $ctmp -Destination $codexTarget -Force
                    Write-Host "✓ tycon: $codexTarget espejado desde CLAUDE.md (lado Codex)"
                }
            }
            Record-SyncPiece ("codex`t" + [IO.Path]::GetFullPath($codexTarget) + "`tAGENTS.md")
        } catch { }
    }

    # Los bloques que quedan en su lugar al terminar (escritos ahora o que ya estaban), para el reporte del aplicador.
    # Se calculan acá y se anotan recién cuando el archivo quedó escrito (o no hacía falta escribirlo): si la escritura
    # falla, el sync sale sin anotarlos. Uno con el marcador de cierre perdido no cuenta: no está en su lugar. Uno quitado
    # por su integración apagada, tampoco.
    $blocksInPlace = @()
    foreach ($e in $entries) {
        $whole = $final[$e.Name]
        if ($whole -and $content.Contains($whole)) { $blocksInPlace += $e.Name }
    }
    $targetFull = [IO.Path]::GetFullPath($target)

    $real = @($changed | Where-Object { $_[1] -notlike '*FALTANTE*' })
    if ($real.Count -eq 0 -or $content -ceq $original) {
        foreach ($n in $blocksInPlace) { Record-SyncPiece ("block`t$targetFull`tTYCON_BLOCK:$n") }
        exit 0
    }

    if ($Check) {
        foreach ($c in $real) {
            if ($removed.ContainsKey($c[0])) {
                Write-Host "⚠ tycon: bloque CLAUDE.md '$($c[0])' sobra ($($removed[$c[0]])) — corré sync-claude-md-blocks.ps1"
                continue
            }
            Write-Host "⚠ tycon: bloque CLAUDE.md '$($c[0])' desactualizado ($($c[1])) — corré sync-claude-md-blocks.ps1"
        }
        exit 0
    }

    $backup = $null
    if ($original -and -not $env:TYCON_HARNESS_SNAPSHOT_DIR) {
        $ts = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss'
        $backup = "$target.bak.$ts"
        [IO.File]::WriteAllText($backup, $originalRaw)
    } elseif (-not $original) {
        $dir = Split-Path -Parent $target
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    }

    # Atomic write.
    $tmp = "$target.tmp.$(Get-Random)"
    try {
        [IO.File]::WriteAllText($tmp, $content)
        Move-Item -Path $tmp -Destination $target -Force
    } catch {
        if (Test-Path $tmp) { Remove-Item -Path $tmp -Force }
        exit 0
    }

    foreach ($n in $blocksInPlace) { Record-SyncPiece ("block`t$targetFull`tTYCON_BLOCK:$n") }
    foreach ($c in $real) {
        Write-Host "✓ tycon: bloque CLAUDE.md '$($c[0])' $($c[1])"
    }
    if ($backup) { Write-Host "✓ tycon: backup en $backup" }
} catch {
    # Fail-open: este script jamás debe romper el arranque de una sesión.
    exit 0
}

exit 0

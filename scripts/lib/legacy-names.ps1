# legacy-names.ps1 — que un nombre viejo siga andando en un guion de PowerShell
#
# El par de scripts/lib/legacy-names.js para PowerShell (≥ 6.2, el del instalador .ps1). Lee el mismo mapa
# (scripts/lib/renames.json) con UNA llamada a node, sólo si el mapa tiene alguna entrada; sin mapa, o vacío, es paso
# directo. Revisado por lectura, sin correrlo en Windows.
#
# Uso (con dot-source):
#   . (Join-Path $Arnes 'scripts/lib/legacy-names.ps1')
#   $valor = Get-LegacyEnv 'TYCON_NEW'                       # la nueva, o la vieja si sólo está la vieja
#   $argv  = Get-LegacyArgs -Where 'scripts/x.ps1' $args      # opciones, subcomandos y valores viejos → nuevos
# Get-LegacyArgs lanza un error «la misma opción dos veces» si llegan el viejo y el nuevo de una opción que no se repite:
# el guion lo trata como a su opción desconocida.

$script:LegacyNamesDir = $PSScriptRoot
$script:LegacyNamesFor = $null
$script:LegacyNamesLines = @()

function Get-LegacyNamesMap {
  if ($env:TYCON_LEGACY_NAMES_MAP) { return $env:TYCON_LEGACY_NAMES_MAP }
  return (Join-Path $script:LegacyNamesDir 'renames.json')
}

function Import-LegacyNames([string]$Where) {
  if ($script:LegacyNamesFor -eq "x$Where") { return }
  $script:LegacyNamesFor = "x$Where"
  $script:LegacyNamesLines = @()
  $map = Get-LegacyNamesMap
  if (-not (Test-Path -LiteralPath $map)) { return }
  if (-not (Select-String -LiteralPath $map -Pattern '"old"' -Quiet)) { return }   # mapa vacío: ni se lanza node
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return }
  try {
    $out = & node (Join-Path $script:LegacyNamesDir 'legacy-names.js') --shell $Where 2>$null
    if ($LASTEXITCODE -eq 0 -and $out) { $script:LegacyNamesLines = @($out) }
  } catch { $script:LegacyNamesLines = @() }
}

function Find-LegacyName([string]$Kind, [string]$Field, [string]$Name) {
  foreach ($line in $script:LegacyNamesLines) {
    $p = $line -split "`t"
    if ($p.Count -lt 3 -or $p[0] -ne $Kind) { continue }
    if (($Field -eq 'old' -and $p[1] -ceq $Name) -or ($Field -eq 'new' -and $p[2] -ceq $Name)) {
      # cuarto campo: en una opción, '1' si se repite; en un valor, la opción de la que es ('' = cualquiera)
      return [pscustomobject]@{ Old = $p[1]; New = $p[2]; Repeatable = ($p.Count -gt 3 -and $p[3] -eq '1'); Option = $(if ($p.Count -gt 3) { $p[3] } else { '' }) }
    }
  }
  return $null
}

function Write-LegacyUse([string]$Kind, [string]$Old, [string]$New, [string]$Where, [switch]$Conflict) {
  if ("$env:TF_BUILD" -match '^(?i)true$') {
    [Console]::Error.WriteLine("##vso[task.logissue type=warning]nombre viejo «$Old» ($Kind) en ${Where}: sigue andando y no es la causa de ningún error de este paso — cuando puedas, cambialo por «$New»")
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return }
  $argList = @((Join-Path $script:LegacyNamesDir 'legacy-names.js'), '--log-use', $Kind, $Old, $New, $Where)
  if ($Conflict) { $argList += '--conflict' }
  # de fondo y en cualquier sistema (Start-Process -WindowStyle sólo existe en Windows): un proceso que no se espera
  try {
    $psi = [System.Diagnostics.ProcessStartInfo]::new('node')
    foreach ($a in $argList) { $psi.ArgumentList.Add([string]$a) }
    $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $psi.Environment['TF_BUILD'] = ''   # el warning de CI ya lo dio este guion
    [void][System.Diagnostics.Process]::Start($psi)
  } catch { }
}

function Get-LegacyEnv([string]$Name, [string]$Where = 'desconocido') {
  Import-LegacyNames $Where
  $new = [Environment]::GetEnvironmentVariable($Name)
  $hit = Find-LegacyName 'env' 'new' $Name
  if (-not $hit) { return $new }
  $old = [Environment]::GetEnvironmentVariable($hit.Old)
  if ($null -eq $old) { return $new }
  if ($null -eq $new) { Write-LegacyUse 'env' $hit.Old $Name $Where; return $old }
  if ($new -ceq $old) { Write-LegacyUse 'env' $hit.Old $Name $Where } else { Write-LegacyUse 'env' $hit.Old $Name $Where -Conflict }
  return $new
}

function Get-LegacyArgs {
  param([Parameter(Mandatory = $true)][string]$Where, [Parameter(ValueFromRemainingArguments = $true)][object[]]$Arguments)
  Import-LegacyNames $Where
  if ($null -eq $Arguments) { $Arguments = @() }   # sin argumentos: un arreglo vacío, no uno con una cadena vacía
  $in = @($Arguments | ForEach-Object { "$_" })
  if ($script:LegacyNamesLines.Count -eq 0) { return , $in }
  $out = New-Object System.Collections.Generic.List[string]
  $seenOld = [ordered]@{}; $seenNew = @{}; $done = $false   # ordenado: el mensaje nombra siempre el primero del argv
  # un valor viejo se traduce sólo detrás de su opción; uno sin opción en el mapa, en cualquier argumento
  $valueOf = {
    param($opt, $val)
    $v = Find-LegacyName 'value' 'old' $val
    if (-not $v -or ($v.Option -ne '' -and $v.Option -cne $opt)) { return $val }
    Write-LegacyUse 'value' $val $v.New $Where
    return $v.New
  }
  $prev = ''
  for ($i = 0; $i -lt $in.Count; $i++) {
    $a = $in[$i]
    $after = $prev; $prev = ''
    if ($done) { $out.Add($a); continue }
    if ($a -eq '--') { $done = $true; $out.Add($a); continue }
    if ($a.StartsWith('--') -and $a.Length -gt 2) {
      $name = $a.Substring(2); $val = $null
      $eq = $name.IndexOf('=')
      if ($eq -ge 0) { $val = $name.Substring($eq + 1); $name = $name.Substring(0, $eq) }
      $nu = $name
      $o = Find-LegacyName 'option' 'old' $name
      if ($o) {
        Write-LegacyUse 'option' $name $o.New $Where
        if (-not $o.Repeatable) { $seenOld[$name] = $o.New }
        $nu = $o.New
      } elseif (Find-LegacyName 'option' 'new' $name) { $seenNew[$name] = $true }
      if ($null -ne $val) { $out.Add("--$nu=$(& $valueOf $nu $val)") } else { $out.Add("--$nu"); $prev = $nu }
      continue
    }
    if ($i -eq 0) {
      $s = Find-LegacyName 'subcommand' 'old' $a
      if ($s) { Write-LegacyUse 'subcommand' $a $s.New $Where; $out.Add($s.New); continue }
    }
    $out.Add((& $valueOf $after $a))
  }
  foreach ($k in $seenOld.Keys) {
    if ($seenNew.ContainsKey($seenOld[$k])) {
      throw "la misma opción dos veces: --$k y --$($seenOld[$k]) (--$k es el nombre viejo de --$($seenOld[$k]))"
    }
  }
  return , $out.ToArray()
}

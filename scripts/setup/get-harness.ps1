# get-harness.ps1 — baja la versión publicada del arnés (sin git) y la instala (el gemelo de get-harness.sh). Leelo entero antes de correrlo.
#
# Uso: pwsh -File get-harness.ps1 [--repo <org/nombre>] [-- <opciones de harness.js install>]
#      ./get-harness.ps1 [--repo …] [<opciones de install>]   (desde una sesión de PowerShell, que se come el `--`: por
#      eso todo lo que no es --repo ni --help también va a install, con o sin `--`)
#
# Qué hace, en orden:
#   1. Revisa los requisitos: PowerShell 7, node ($NodeFloor o más) y tar (Windows 10 y posteriores lo traen); fuera de
#      Windows, también bash y python3. Nada de git. Si falta alguno, te dice cómo instalarlo y sale 1 sin bajar nada.
#      El comando sugerido se imprime; este guion nunca instala nada.
#   2. La credencial, ANTES de bajar: el repo es público y no hace falta. Usa el permiso de lectura de GitHub si lo hay
#      (TYCON_GITHUB_TOKEN, o el guardado en ~/.tycon/config.json); lo pide —sin eco; sin terminal sale 1— sólo ante 401 o 404.
#   3. Baja el comprimido de la versión por la API de GitHub (la credencial viaja sólo al host de la API; la redirección
#      a codeload va sin ella) a una carpeta temporal y lo desempaqueta con tar. No escribe nada fuera de esa carpeta.
#   4. Desde ese árbol: guarda el permiso si lo pidió (`harness.js config set github.token`, por stdin) y corre
#      `harness.js install --version latest --repo <org/nombre> <opciones>` en esta misma terminal: la bajada VERIFICADA y
#      la instalación son las del arnés (quedan en ~/.tycon); la carpeta temporal se borra al terminar.
#
# Escrito para PowerShell 7 (pwsh), con BOM UTF-8 y sin nada que Windows PowerShell 5.1 no sepa leer: corrido con
# `powershell`, llega al chequeo de versión y dice qué falta, en vez de cortar con un error de sintaxis.

$Repo = 'TYCON-SA/tycon-harness'
$Api = if ($env:TYCON_RELEASE_API) { $env:TYCON_RELEASE_API } else { 'https://api.github.com' }   # TYCON_RELEASE_API: sólo pruebas
$NodeFloor = 20   # el mismo piso que scripts/setup/harness.js
$TokenUrl = 'https://github.com/settings/personal-access-tokens/new'

function Say([string]$Text) { [Console]::Error.WriteLine("get-harness: $Text") }
if ($Api -notmatch '^https?://') { Say "TYCON_RELEASE_API tiene que empezar con http:// o https:// (no sigo otros esquemas): $Api"; exit 2 }

$OnWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or ($IsWindows -eq $true)
$OnMac = ($IsMacOS -eq $true)

function Suggest([string]$Tool) {
  $winget = @{ node = 'winget install OpenJS.NodeJS.LTS'; pwsh = 'winget install Microsoft.PowerShell'; tar = 'tar viene con Windows 10 y posteriores: actualizá Windows, o https://www.gnu.org/software/tar/' }
  $brew = @{ node = 'brew install node'; bash = 'brew install bash'; python3 = 'brew install python'; tar = 'brew install gnu-tar' }
  $page = @{ node = 'https://nodejs.org/en/download'; bash = 'https://www.gnu.org/software/bash/'; python3 = 'https://www.python.org/downloads/'; tar = 'https://www.gnu.org/software/tar/' }
  if ($OnWindows -and $winget.ContainsKey($Tool)) { return $winget[$Tool] }
  if ($OnMac -and $brew.ContainsKey($Tool)) { return $brew[$Tool] }
  return $page[$Tool]
}

if ($PSVersionTable.PSVersion.Major -lt 7) {
  Say "este guion pide PowerShell 7 (pwsh) y lo corrió PowerShell $($PSVersionTable.PSVersion) — sugerido (no lo corro): $(Suggest 'pwsh'); después: pwsh -File get-harness.ps1"
  exit 1
}

$Rest = @()
$i = 0
while ($i -lt $args.Count) {
  $a = [string]$args[$i]
  if ($a -eq '--') {
    if ($i + 1 -lt $args.Count) { $Rest = @($args[($i + 1)..($args.Count - 1)]) }
    break
  }
  if ($a -eq '--repo') {
    if ($i + 1 -ge $args.Count -or -not [string]$args[$i + 1]) { Say '--repo pide un valor (org/nombre)'; exit 2 }
    $Repo = [string]$args[$i + 1]
    $i += 2
    continue
  }
  if ($a -eq '-h' -or $a -eq '--help') {
    Say 'uso: pwsh -File get-harness.ps1 [--repo <org/nombre>] [-- <opciones de install>]'
    Say '     desde una sesión de PowerShell: ./get-harness.ps1 [--repo …] [<opciones de install>]'
    Say 'sin terminal (instalación desatendida): agregá `-- --profile minimal --yes` (o --profile full; desde una sesión, ./get-harness.ps1 --profile minimal --yes)'
    Say 'el permiso de lectura de GitHub: el guardado en ~/.tycon/config.json, TYCON_GITHUB_TOKEN, o se pide en la terminal'
    exit 0
  }
  $Rest += $a   # una opción de install sin el `--` (una sesión de PowerShell se lo come)
  $i += 1
}

# ── 1. los requisitos (sin git: la versión se baja como archivos) ─────────────────────────────────────────────
$Tools = @('node', 'tar')
# bash y python3 los pide el aplicador de Claude Code: con `--tool codex` (sólo Codex) no hacen falta
$codexOnly = $false
for ($k = 0; $k -lt $Rest.Count - 1; $k++) { if ([string]$Rest[$k] -eq '--tool' -and [string]$Rest[$k + 1] -eq 'codex') { $codexOnly = $true } }
if (-not $OnWindows -and -not $codexOnly) { $Tools += @('bash', 'python3') }
$Missing = $false
foreach ($t in $Tools) {
  if (-not (Get-Command $t -CommandType Application -ErrorAction SilentlyContinue)) {
    Say "falta $t — sugerido (no lo corro): $(Suggest $t)"
    $Missing = $true
  }
}
if (Get-Command node -CommandType Application -ErrorAction SilentlyContinue) {
  $nv = [string](& node --version 2>$null)
  $nv = $nv.Trim() -replace '^v', ''
  $major = 0
  if (-not [int]::TryParse(($nv -split '\.')[0], [ref]$major)) {
    Say "node no dice su versión: el arnés pide Node $NodeFloor o más — sugerido (no lo corro): $(Suggest 'node')"
    $Missing = $true
  } elseif ($major -lt $NodeFloor) {
    Say "node $nv es viejo: el arnés pide Node $NodeFloor o más — sugerido (no lo corro): $(Suggest 'node')"
    $Missing = $true
  }
}
if ($Missing) { Say 'no bajé nada: instalá lo que falta y volvé a correr este guion'; exit 1 }

# ── 2. el permiso de lectura, antes de bajar ──────────────────────────────────────────────────────────────────
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ('get-harness.' + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null
$TyconHome = if ($env:TYCON_HOME) { $env:TYCON_HOME } else { Join-Path $HOME '.tycon' }
$Cfg = Join-Path $TyconHome 'config.json'
$Token = ([string]$env:TYCON_GITHUB_TOKEN) -replace "[`r`n]", ''   # un salto de línea final (un archivo CRLF) no es parte del permiso
$Save = [bool]$Token
if (-not $Token -and (Test-Path -LiteralPath $Cfg)) {
  # un archivo que no se lee NO es «sin permiso guardado»: se dice y se sigue sin él
  try { $j = Get-Content -LiteralPath $Cfg -Raw | ConvertFrom-Json; if ($j.github -and $j.github.token) { $Token = [string]$j.github.token } }
  catch { Say "no pude leer $Cfg (¿roto?): sigo como si no hubiera permiso guardado" }
}
# Fetch <URL> <archivo> → el código HTTP del último salto (0 sin red; -2 otro error, ya dicho). HttpClient sin
# redirecciones automáticas, para decidirlas acá: la credencial sigue sólo mientras el HOST no cambie (GitHub manda 301
# dentro de la API cuando un repo se renombró; a codeload, otro host, va sin ella). Honra el proxy del sistema. Las
# llamadas van por SendAsync/ReadAsStreamAsync + GetAwaiter: las sincrónicas existen recién en PowerShell 7.1 (.NET 5).
function Fetch([string]$Url, [string]$Out) {
  $u = $Url; $auth = $true; $code = 0
  for ($hop = 0; $hop -le 4; $hop++) {
    $handler = [System.Net.Http.HttpClientHandler]::new(); $handler.AllowAutoRedirect = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    try {
      $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $u)
      $req.Headers.UserAgent.ParseAdd('get-harness'); $req.Headers.Accept.ParseAdd('application/vnd.github+json')
      if ($auth -and $script:Token) { $req.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $script:Token) }
      $resp = $client.SendAsync($req).GetAwaiter().GetResult()
      $code = [int]$resp.StatusCode
      if ($code -ge 300 -and $code -lt 400 -and $resp.Headers.Location) {
        if ($hop -eq 4) { return $code }   # demasiadas redirecciones: el código del último salto, no «sin red»
        $next = if ($resp.Headers.Location.IsAbsoluteUri) { $resp.Headers.Location } else { [Uri]::new([Uri]$u, $resp.Headers.Location) }
        if ($next.Scheme -ne 'http' -and $next.Scheme -ne 'https') { Say "la redirección de $u apunta a un esquema que no es http(s): no la sigo"; return -2 }
        if ($next.Authority -ne ([Uri]$u).Authority) { $auth = $false }   # el ORIGEN (host y puerto), como scripts/lib/http-get.js
        $u = $next.AbsoluteUri
        continue
      }
      if ($code -ne 200) { return $code }
      $fs = [IO.File]::Create($Out)
      try { $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult().CopyTo($fs) } finally { $fs.Dispose() }
      return 200
    } catch {
      # sin red (o el host no contesta) es 0; cualquier otra cosa —una redirección ilegible, no poder escribir el
      # archivo— se dice con su motivo y es -2: «sin red» no tapa un error que no es de red
      $ex = $_.Exception; if ($ex.InnerException) { $ex = $ex.InnerException }
      if ($ex -is [System.Net.Http.HttpRequestException] -or $ex -is [System.Net.Sockets.SocketException] -or $ex -is [System.Threading.Tasks.TaskCanceledException]) { return 0 }
      Say "no pude bajar $u`: $($_.Exception.Message)"
      return -2
    } finally { $client.Dispose() }
  }
  return 0
}
function Ask {   # sin permiso y el repo no se lee: en la terminal se pide sin eco; sin terminal, la única acción y 1
  if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    Say "el repo $Repo no se puede leer sin tu permiso de GitHub: uno de sólo lectura (Fine-grained, Contents: read) en $TokenUrl"
    $secure = Read-Host -AsSecureString -Prompt 'get-harness: pegá el permiso de GitHub y Enter'
    $script:Token = ([System.Net.NetworkCredential]::new('', $secure).Password) -replace "[`r`n]", ''
    $script:Save = $true
    if (-not $script:Token) { Say 'sin permiso no puedo bajar la versión: no bajé nada'; exit 1 }
  } else {
    Say "el repo $Repo no se puede leer sin un permiso de GitHub: creá uno de sólo lectura (Fine-grained, Contents: read) en $TokenUrl y pasalo en TYCON_GITHUB_TOKEN (o pegalo después con harness.js config set github.token). No bajé nada."
    exit 1
  }
}
try {
  $Ref = Join-Path $Tmp 'ref.json'
  $Code = Fetch "$Api/repos/$Repo/git/ref/heads/main" $Ref
  if (-not $Token -and ($Code -eq 401 -or $Code -eq 404)) { Ask; $Code = Fetch "$Api/repos/$Repo/git/ref/heads/main" $Ref }
  switch ($Code) {
    200 { }
    401 { Say "el permiso de GitHub no vale (401): venció o se revocó. Creá otro en $TokenUrl y pegalo con harness.js config set github.token. No bajé nada."; exit 1 }
    404 { Say "GitHub no muestra $Repo (404): sin permiso guardado, o el permiso no ve el repo, o falta aceptar la invitación. El permiso: $TokenUrl. No bajé nada."; exit 1 }
    0 { Say "sin red: no pude llegar a $Api. No bajé nada."; exit 1 }
    -2 { Say 'No bajé nada.'; exit 1 }   # el motivo ya lo dijo Fetch
    default { Say "GitHub contestó $Code al pedir la rama main de $Repo. No bajé nada."; exit 1 }
  }
  $Sha = ''
  try { $Sha = [string](Get-Content -LiteralPath $Ref -Raw | ConvertFrom-Json).object.sha } catch { }
  if (-not $Sha) { Say "la respuesta de GitHub no trae el commit de main de $Repo"; exit 1 }

  # ── 3. la bajada, a la carpeta temporal ─────────────────────────────────────────────────────────────────────
  Say "bajo $Repo (main $($Sha.Substring(0, 7))) a una carpeta temporal"
  $Tgz = Join-Path $Tmp 'arnes.tgz'
  $Code = Fetch "$Api/repos/$Repo/tarball/$Sha" $Tgz
  if ($Code -eq -2) { Say 'No bajé nada.'; exit 1 }   # el motivo ya lo dijo Fetch
  if ($Code -ne 200) { Say "no pude bajar el comprimido (GitHub contestó $Code): no quedó nada"; exit 1 }
  # antes de abrirlo con el tar del sistema se mira el listado: un enlace (l), un enlace duro (h) o una ruta que sale (`..`)
  # lo rechazan entero (la verificación de verdad —el árbol de git contra el commit— la hace install con la bajada suya)
  $listing = @(& tar -tvzf $Tgz 2>$null | ForEach-Object { "$_" }); $listed = $LASTEXITCODE   # cada listado con SU código: el segundo no tapa al primero
  $names = @(& tar -tzf $Tgz 2>$null | ForEach-Object { "$_" })
  if ($listed -ne 0 -or $LASTEXITCODE -ne 0 -or -not $names.Count -or -not $listing.Count) { Say 'el comprimido no se pudo leer: no quedó nada'; exit 1 }
  if (($listing | Where-Object { $_ -match '^[lh]' }).Count -gt 0 -or ($names | Where-Object { $_ -match '^/|(^|/)\.\.(/|$)' }).Count -gt 0) {
    Say 'el comprimido trae enlaces o rutas que salen de su carpeta: no lo abro, no quedó nada'; exit 1
  }
  $TreeDir = Join-Path $Tmp 'tree'
  New-Item -ItemType Directory -Path $TreeDir -Force | Out-Null
  & tar -xzf $Tgz -C $TreeDir
  if ($LASTEXITCODE -ne 0) { Say 'el comprimido no se pudo desempaquetar: no quedó nada'; exit 1 }
  $Tree = Get-ChildItem -LiteralPath $TreeDir -Directory | Select-Object -First 1
  if (-not $Tree -or -not (Test-Path -LiteralPath (Join-Path $Tree.FullName 'scripts/setup/harness.js'))) { Say 'el comprimido no trae scripts/setup/harness.js: no instalo'; exit 1 }
  $HarnessJs = Join-Path $Tree.FullName 'scripts/setup/harness.js'

  # ── 4. la instalación, desde ese árbol y en esta misma terminal ─────────────────────────────────────────────
  if ($Save) {
    $Token | & node $HarnessJs config set github.token
    if ($LASTEXITCODE -ne 0) { Say 'no pude guardar el permiso'; exit 1 }
  }
  & node $HarnessJs install --version latest --repo $Repo @Rest
  exit $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

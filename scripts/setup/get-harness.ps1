# get-harness.ps1 — baja la versión publicada del arnés (sin git) y la instala (el gemelo de get-harness.sh). Leelo entero antes de correrlo.
# Es la entrada «a mano». Próximamente la otra, en una línea y en Node: `npx @tycon-sa/harness@latest` (scripts/setup/npm/).
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
#   3. Baja el comprimido de la versión a una carpeta temporal y lo desempaqueta con tar. No escribe nada fuera de esa
#      carpeta. SIN permiso (story 8.34) no usa la API de GitHub, que sin permiso tiene un tope de 60 consultas por hora
#      por conexión: lee el commit de main de la página pública `info/refs` (la que lee `git ls-remote`, sin git) y baja
#      de codeload. Si github.com no contesta, cae a la API. CON permiso, por la API (la credencial viaja sólo al host de
#      la API; la redirección a codeload va sin ella). Al tope de la API, dice hasta qué hora.
#   4. Desde ese árbol: guarda el permiso si lo pidió (`harness.js config set github.token`, por stdin) y corre
#      `harness.js install --version latest --repo <org/nombre> <opciones>` en esta misma terminal: la bajada VERIFICADA y
#      la instalación son las del arnés (quedan en ~/.tycon); la carpeta temporal se borra al terminar.
#
# Escrito para PowerShell 7 (pwsh), con BOM UTF-8 y sin nada que Windows PowerShell 5.1 no sepa leer: corrido con
# `powershell`, llega al chequeo de versión y dice qué falta, en vez de cortar con un error de sintaxis.

$Repo = 'TYCON-SA/tycon-harness'
$Api = if ($env:TYCON_RELEASE_API) { $env:TYCON_RELEASE_API } else { 'https://api.github.com' }   # TYCON_RELEASE_API: sólo pruebas
# las rutas públicas (story 8.34; sólo pruebas: TYCON_RELEASE_GIT / _ARCHIVE). Con la API apuntada a un juguete y sin
# TYCON_RELEASE_GIT, no hay rutas públicas: un laboratorio no sale al GitHub de verdad (la regla de public-git.js)
$GitBase = if ($env:TYCON_RELEASE_GIT) { $env:TYCON_RELEASE_GIT } else { 'https://github.com' }
$Codeload = if ($env:TYCON_RELEASE_ARCHIVE) { $env:TYCON_RELEASE_ARCHIVE } else { 'https://codeload.github.com' }
$Public = -not ($env:TYCON_RELEASE_API -and -not $env:TYCON_RELEASE_GIT)
$NodeFloor = 20   # el mismo piso que scripts/setup/harness.js
$TokenUrl = 'https://github.com/settings/personal-access-tokens/new'

function Say([string]$Text) { [Console]::Error.WriteLine("get-harness: $Text") }
if ($Api -notmatch '^https?://') { Say "TYCON_RELEASE_API tiene que empezar con http:// o https:// (no sigo otros esquemas): $Api"; exit 2 }
if ($GitBase -notmatch '^https?://' -or $Codeload -notmatch '^https?://') { Say "TYCON_RELEASE_GIT y TYCON_RELEASE_ARCHIVE tienen que empezar con http:// o https://"; exit 2 }

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
      # el tope de la API (story 8.34): lo que quedó y la hora de renovación del último pedido
      $script:RateRemaining = $null; $script:RateReset = $null
      $vals = $null
      if ($resp.Headers.TryGetValues('X-RateLimit-Remaining', [ref]$vals)) { $script:RateRemaining = [string]($vals | Select-Object -First 1) }
      if ($resp.Headers.TryGetValues('X-RateLimit-Reset', [ref]$vals)) { $script:RateReset = [string]($vals | Select-Object -First 1) }
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
function Limited {   # si el último 403 fue el tope de la API: hasta qué hora (hora local), y sale 1 (story 8.34)
  if ($script:RateRemaining -ne '0') { return }
  $n = 0; [void][long]::TryParse([string]$script:RateReset, [ref]$n)
  $when = if ($n -gt 0) { [DateTimeOffset]::FromUnixTimeSeconds($n).LocalDateTime } else { (Get-Date).AddHours(1) }
  $hora = $when.ToString('HH:mm')
  if ($script:Token) { Say "GitHub limita las consultas de tu permiso hasta las $hora`: probá de nuevo después de esa hora. No bajé nada." }
  else { Say "GitHub limita las consultas sin permiso de esta conexión hasta las $hora`: probá de nuevo después de esa hora (un permiso guardado tiene otro tope, pero el repo público no lo necesita). No bajé nada." }
  exit 1
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
  # sin permiso, el commit de main sale de info/refs (0 consultas a la API); un 401/404 es un repo que no se ve sin permiso
  # (se pide); sin red, un 5xx o algo que no es git → la API, como antes
  $Sha = ''
  $Refs = Join-Path $Tmp 'refs'
  # el commit de main de info/refs, o '' si lo que contestó no es la lista de ramas
  function MainOfRefs {
    $text = [IO.File]::ReadAllText($Refs, [Text.Encoding]::GetEncoding('ISO-8859-1'))
    $m = [regex]::Match($text, '([0-9a-f]{40}) refs/heads/main[\x00\n]')
    if ($text.StartsWith("001e# service=git-upload-pack`n0000") -and $m.Success) { return $m.Groups[1].Value }
    return ''
  }
  if (-not $Token -and $Public) {
    $Code = Fetch "$GitBase/$Repo.git/info/refs?service=git-upload-pack" $Refs
    if ($Code -eq 200) {
      $Sha = MainOfRefs
      if (-not $Sha) { Say 'github.com contestó algo que no es la lista de ramas: miro por la API' }
    } elseif ($Code -eq 401 -or $Code -eq 404) { Ask }
    elseif ($Code -ne -2) { Say "github.com no contestó ($Code): miro por la API" }
  }
  $Ref = Join-Path $Tmp 'ref.json'
  $Code = 200
  if (-not $Sha) {
    $Code = Fetch "$Api/repos/$Repo/git/ref/heads/main" $Ref
    if (-not $Token -and ($Code -eq 401 -or $Code -eq 404)) { Ask; $Code = Fetch "$Api/repos/$Repo/git/ref/heads/main" $Ref }
  }
  # un permiso que venció (401) y el repo se lee sin él (info/refs sin credencial, 200): se sigue SIN el permiso y no se
  # guarda. El guardado en ~/.tycon/config.json lo dice install (la misma línea que el arranque); el de la variable, acá
  if ($Code -eq 401 -and $Token -and $Public) {
    $t0 = $Token; $script:Token = ''
    if ((Fetch "$GitBase/$Repo.git/info/refs?service=git-upload-pack" $Refs) -eq 200) { $Sha = MainOfRefs }
    if ($Sha) {
      $Code = 200
      if ($Save) { Say 'el permiso de GitHub de TYCON_GITHUB_TOKEN venció o se revocó (401), pero no hace falta: el repo del arnés es público. Sigo sin él y no lo guardo.' }
      $script:Save = $false
    } else { $script:Token = $t0 }
  }
  switch ($Code) {
    200 { }
    403 { Limited; Say "GitHub contestó 403 al pedir la rama main de $Repo. No bajé nada."; exit 1 }
    401 { Say "el permiso de GitHub no vale (401): venció o se revocó. Creá otro en $TokenUrl y pegalo con harness.js config set github.token. No bajé nada."; exit 1 }
    404 { Say "GitHub no muestra $Repo (404): sin permiso guardado, o el permiso no ve el repo, o falta aceptar la invitación. El permiso: $TokenUrl. No bajé nada."; exit 1 }
    0 { Say "sin red: no pude llegar a $Api. No bajé nada."; exit 1 }
    -2 { Say 'No bajé nada.'; exit 1 }   # el motivo ya lo dijo Fetch
    default { Say "GitHub contestó $Code al pedir la rama main de $Repo. No bajé nada."; exit 1 }
  }
  if (-not $Sha) { try { $Sha = [string](Get-Content -LiteralPath $Ref -Raw | ConvertFrom-Json).object.sha } catch { } }
  if (-not $Sha) { Say "la respuesta de GitHub no trae el commit de main de $Repo"; exit 1 }

  # ── 3. la bajada, a la carpeta temporal ─────────────────────────────────────────────────────────────────────
  Say "bajo $Repo (main $($Sha.Substring(0, 7))) a una carpeta temporal"
  $Tgz = Join-Path $Tmp 'arnes.tgz'
  # sin permiso, de codeload (el mismo archivo al que redirige la API, sin gastar una consulta); con permiso, por la API
  if (-not $Token -and $Public) { $Code = Fetch "$Codeload/$Repo/tar.gz/$Sha" $Tgz } else { $Code = Fetch "$Api/repos/$Repo/tarball/$Sha" $Tgz }
  if ($Code -eq -2) { Say 'No bajé nada.'; exit 1 }   # el motivo ya lo dijo Fetch
  if ($Code -eq 403) { Limited }
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

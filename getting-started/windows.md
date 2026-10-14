# Instalar el arnés TYCON con Claude Code · Windows

Copiá todo el bloque de la parte 1 y pegáselo a Claude Code: te guía paso a paso y te avisa cuando un paso lo tenés que
hacer vos. No hace falta cuenta de GitHub ni permiso: el arnés se baja de un repo público. Los opcionales (parte 2) van
después, en una sesión nueva de Claude Code.

Instala el perfil completo (`full`), que cambia cómo te contesta Claude en todos tus proyectos (ver la portada, «Antes
de instalar»). Para el perfil mínimo, escribí «quiero el perfil mínimo» arriba del bloque al pegarlo.

## Parte 1 — instalación base

<!-- guided:base -->
```text
Necesito instalar en esta máquina el arnés TYCON para trabajar con Claude Code (y con BIZUIT Extensions). El arnés
vive en un repo público de GitHub: se baja sin cuenta y sin permiso. Seguí estos pasos EN ORDEN, en PowerShell 7,
corriendo cada comando TAL CUAL (no lo reescribas ni lo "mejores"). Si una salida no es la esperada, o aparece un error
que no está acá, PARÁ, no arregles nada a mano y mostrame la salida tal cual.

Perfil: si arriba de este pedido te escribí «quiero el perfil mínimo», en los pasos 3 y 4 cambiá --profile full por
--profile minimal, y salteá el paso 5. Si no, va full.

Si un paso contesta 403 o «límite de la API de GitHub»: GitHub limita los pedidos sin credencial a 60 por hora por
dirección de red, y una oficina entera suele compartir la suya. PARÁ y avisame, sin reintentar: o espero a que se
renueve (como mucho una hora) y repetimos ese paso; o, si tengo un permiso de GitHub propio, lo pongo YO en la variable
TYCON_GITHUB_TOKEN con la línea de abajo, en la misma terminal donde corro el guion (no se ve al pegarlo; vos no lo
leas ni lo muestres), y vuelvo a correr get-harness, que lo usa y lo guarda:
    $s = Read-Host -AsSecureString 'Permiso de GitHub'; $env:TYCON_GITHUB_TOKEN = [System.Net.NetworkCredential]::new('', $s).Password
Bajar el propio guion va siempre sin credencial: si el 403 fue ahí, sólo queda esperar.

1. Herramientas:
   $PSVersionTable.PSVersion.ToString(); node --version; tar --version
   Esperado: PowerShell 7.algo, node v22 o más y tar (viene con Windows 10 y posteriores). Lo que falte, decime que lo
   instale yo, de a uno:  winget install Microsoft.PowerShell · winget install OpenJS.NodeJS.LTS
   Después de instalar algo, tengo que cerrar y volver a abrir la terminal y Claude Code: avisame y esperá.
   (git NO hace falta: el arnés se baja como archivos, no se clona.)

2. Bajar el guion de instalación (se baja, se lee y después se corre; no se clona nada): dame estas dos líneas para
   pegar en mi ventana de PowerShell 7, una por una:
       Invoke-WebRequest -Headers @{ Accept = 'application/vnd.github.raw' } -OutFile get-harness.ps1 https://api.github.com/repos/TYCON-SA/tycon-harness/contents/scripts/setup/get-harness.ps1
       Get-Content get-harness.ps1
   Esperado: el archivo get-harness.ps1 en mi carpeta y un guion que empieza con «# get-harness.ps1 — baja la versión
   publicada del arnés (sin git)».

3. Ver el plan de instalación (no instala nada): dame esta línea para mi ventana:
       pwsh -File get-harness.ps1 -- --profile full --integrations none --packs all --dry-run
   Baja la versión a una carpeta temporal y muestra el plan. Te paso la salida: mostrame el plan resumido (qué escribe,
   qué hooks pone) y preguntame si sigo.

4. Con mi sí, instalar, en mi ventana:
       pwsh -File get-harness.ps1 -- --profile full --integrations none --packs all --yes
   Esperado: termina con «versión: …» y un resumen, sin rojo. El arnés queda en $env:USERPROFILE\.tycon\harness
   (archivos, sin git).

5. Los controles que corren al commitear (hooks globales de git). Antes de configurar nada, avisame esto y esperá mi
   sí: con una carpeta global de hooks, git deja de correr los .git/hooks/ propios de cada uno de mis repos (el control
   del arnés corre en su lugar el .githooks/pre-commit de cada repo). Si te digo que no, salteá este paso.
   Con mi sí, primero mirá si ya tengo algo configurado:
   git config --global --get core.hooksPath
   Si no devuelve nada, corré:  git config --global core.hooksPath "$env:USERPROFILE\.git-hooks"
   Si devuelve otra carpeta, NO la pises: mostrámela y decidimos.

6. Verificar (tres comandos):
   node "$env:USERPROFILE\.claude\tycon-harness\scripts\setup\harness.js" doctor
   @(Get-ChildItem "$env:USERPROFILE\.claude\skills" -Directory).Count
   (Select-String -Path "$env:USERPROFILE\.claude\CLAUDE.md" -Pattern "INDEX.md").Count
   Esperado: doctor dice «perfil: full» (o «perfil: minimal» si pedí el mínimo) y cierra con «todo en orden» (o «N aviso(s), nada en rojo»); más de 40 skills; 1.

7. Armame UN solo bloque de texto, para guardarlo o para pedir ayuda, con la salida de los pasos 1, 2 y 4 (el final), y
   la salida COMPLETA del paso 6, más una línea final «OK» o «NO OK». Después decime que cierre y vuelva a abrir Claude
   Code.

Para trabajar con BIZUIT Extensions: el paquete bizuit ya queda prendido para todos mis repos (--packs all). Las guías
para empezar un plugin o un formulario están en ~/.claude/tycon-harness/guides/bizuit/ y te mandan a los templates públicos.
```
<!-- /guided:base -->

## Parte 2 — opcionales: engram, codegraph, codex y telegram

```text
Esto va DESPUÉS de la parte 1, en una sesión NUEVA de Claude Code (ya cerré y reabrí). Las mismas reglas: cada comando
TAL CUAL, en PowerShell 7 salvo donde diga Bash; si una salida no es la esperada, PARÁ y mostrámela tal cual.

- Primero preguntame cuáles de las cuatro quiero. Hacé sólo esas, en este orden, cada una completa antes de la otra.
- Son independientes: si una falla, PARÁ, mostrame la salida y preguntame si seguimos con la siguiente. No desinstales
  nada ni toques lo de la parte 1 para arreglarla.
- No soy administrador de esta máquina: si Windows pide permiso de administrador, lo cancelo y te aviso. No busques otro
  camino por tu cuenta.
- Nunca leas ni muestres un token o una clave, aunque te lo pida.
- «PRENDER <x>» son estos dos comandos, con <x> el nombre de la integración:
     node "$env:USERPROFILE\.claude\tycon-harness\scripts\lib\tycon-config.js" set integrations.<x> true
     node "$env:USERPROFILE\.claude\tycon-harness\scripts\setup\harness.js" apply
  Esperado: el primero dice «integrations.<x>: (sin valor) → true en …tycon.json»; el segundo termina sin rojo.
  Para apagar una que quedó a medias: los mismos dos comandos con false en vez de true.

A. engram — memoria del agente entre sesiones. No pide cuenta. El equipo usa la versión 1.20.0 (archivo engram-version
   del arnés). Sin administrador va el binario oficial de esa versión, bajado de GitHub.
   A1. $env:PROCESSOR_ARCHITECTURE
       Esperado: AMD64. Si dice ARM64, en A2 cambiá amd64 por arm64, y el número esperado es
       eb93c6d7d5a4020ddcf1ff956909f3e90694f6447519433316b10f964f8f37b5.
   A2. $z = "$env:TEMP\engram_1.20.0.zip"; Invoke-WebRequest https://github.com/Gentleman-Programming/engram/releases/download/v1.20.0/engram_1.20.0_windows_amd64.zip -OutFile $z; (Get-FileHash $z -Algorithm SHA256).Hash.ToLower()
       Esperado: c945c47d58367f943642cb8451fa45f208174407839f1dda33a975a05d6e465b (el de checksums.txt de esa versión).
   A3. New-Item -ItemType Directory -Force "$env:USERPROFILE\bin" | Out-Null; Expand-Archive "$env:TEMP\engram_1.20.0.zip" -DestinationPath "$env:USERPROFILE\bin" -Force; & "$env:USERPROFILE\bin\engram.exe" version
       Esperado: «engram 1.20.0» (si además avisa que hay una versión nueva, ignoralo). Si el antivirus bloquea o borra
       engram.exe, PARÁ: no lo apagues. La guía oficial de engram lo explica como falso positivo; la alternativa es
       compilarlo con Go, y eso lo decidimos juntos.
   A4. $p = [Environment]::GetEnvironmentVariable('Path','User'); if (($p -split ';') -notcontains "$env:USERPROFILE\bin") { [Environment]::SetEnvironmentVariable('Path', "$env:USERPROFILE\bin;$p", 'User') }; 'ok'
       Esperado: ok. (Suma esa carpeta a MI ruta de usuario: no pide administrador.)
   A5. Esto lo hago YO, porque hace preguntas. PARÁ y decime que en una ventana NUEVA de PowerShell 7 corra:
           engram version
           engram setup claude-code
       y que a la pregunta de los permisos conteste que sí. Esperado: «engram 1.20.0» y el setup sin error.
   A6. PRENDER engram. Puede intentar instalar sqlite3 con winget: si Windows pide administrador, lo cancelo. Sin
       sqlite3 engram anda igual; sólo no corren dos de los chequeos de salud de la memoria.
   Nota: la memoria viaja en los commits sólo en los repos que tienen un archivo .engram-project
   (~/.claude/tycon-harness/guides/engram-workflow.md). Cuando el equipo cambie de versión, el arranque lo avisa; con el
   binario suelto se actualiza a mano, repitiendo A2 y A3 con el número nuevo.

B. codegraph — índice del código, para que el agente encuentre las cosas sin leer archivo por archivo. No pide cuenta.
   Se instala con npm en mi usuario, sin administrador. El equipo no fija versión: el instalador baja la última.
   B1. PARÁ y preguntame dos cosas: la ruta de UN repo mío con código (nunca mi carpeta de usuario), y si quiero que de
       ahí en adelante indexe solo cada repo que abra (por defecto, sí).
   B2. pwsh -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\tycon-harness\scripts\setup\install-codegraph.ps1" "<ruta del repo>"
       (si contesté que no indexe solo, agregá -NoAuto al final). Puede tardar unos minutos.
       Esperado: termina con «OK: CodeGraph instalado.».
   B3. codegraph --version; Push-Location "<ruta del repo>"; claude mcp list; Pop-Location
       Esperado: un número de versión y una línea «codegraph» en la lista.
   B4. PRENDER codegraph (en el arnés sólo deja constancia: no registra nada).

C. codex — el mismo arnés bajo Codex, el asistente de OpenAI. Pide cuenta de OpenAI: un plan de ChatGPT (Plus, Pro,
   Business, Edu o Enterprise) o una clave de API. Ojo: en Windows el código está, pero el arnés todavía no lo probó en
   una máquina Windows real (lo dice su INSTALL.md). Lo que no salga como acá, PARÁ y anotalo.
   C1. codex --version
       Si no está: npm install -g @openai/codex (instalador oficial por npm, sin administrador) y otra vez codex --version.
       Esperado: un número de versión.
   C2. Esto lo hago YO, porque abre el navegador. PARÁ y decime que en una ventana NUEVA de PowerShell 7 corra:
           codex login
       Entro con mi cuenta de OpenAI. Esperá mi «listo».
   C3. PRENDER codex. Esperado: además del resumen, puede salir un aviso «TRUST»: es normal la primera vez.
   C4. Esto lo hago YO. PARÁ y decime que en una ventana de PowerShell 7 corra codex, adentro escriba /hooks, apruebe
       todos y salga. Sin eso los hooks del arnés no corren bajo Codex, y no dan error. Se repite cada vez que el
       arranque diga «TRUST».
   C5. node "$env:USERPROFILE\.claude\tycon-harness\scripts\lib\harness-audit.js" --parity
       Esperado: sin rojos. Si hay, mostrámelos tal cual: no los silencies.
   Nota: una vez por día el arnés corre de fondo una prueba dentro de Codex que gasta de mi plan; se apaga con la
   variable TYCON_BENCH_DAILY en 0 (portada del arnés, «Dónde se pone un interruptor»). Eso lo decido y lo hago yo.

D. telegram — avisos a mi celular cuando termina algo largo. Sólo salida: el arnés avisa, no lee lo que yo le escriba.
   Pide una cuenta de Telegram y un bot MÍO. El aviso lo manda un script de bash: en Windows corre con la herramienta
   Bash (Git Bash, viene con Git para Windows), no con PowerShell.
   D1. Esto lo hago YO, en Telegram. PARÁ y decime que: le escriba /newbot a @BotFather, le dé un nombre y un usuario
       que termine en «bot», y guarde el token que me da (a vos NO te lo paso); le escriba «hola» a mi bot (si no, el
       bot no puede escribirme); y le escriba a @userinfobot, que me contesta mi número de id. Te paso SÓLO ese número.
   D2. Esto lo hago YO, para que el token no pase por el chat. PARÁ y decime que en una ventana de PowerShell 7 corra:
           $t = Read-Host 'Token del bot' -MaskInput; New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\channels\telegram" | Out-Null; Set-Content -Path "$env:USERPROFILE\.claude\channels\telegram\.env" -Value "TELEGRAM_BOT_TOKEN=$t" -Encoding utf8NoBOM; Remove-Variable t; 'listo'
       y pegue el token cuando lo pida. Esperado: listo. Vos no abras ni leas ese archivo.
   D3. Con el número que te pasé en lugar de <ID>:
       node "$env:USERPROFILE\.claude\tycon-harness\scripts\lib\tycon-config.js" set telegram.chat_id <ID>
       [Environment]::SetEnvironmentVariable('TYCON_TELEGRAM_CHAT_ID', '<ID>', 'User'); 'ok'
       Esperado: «telegram.chat_id: (sin valor) → <ID> en …tycon.json» y ok. El arnés lee el archivo; el script que
       manda el aviso lee la variable, que vale desde la próxima sesión.
   D4. Con la herramienta Bash:
       bash ~/.claude/tycon-harness/scripts/lib/tycon-telegram-notify.sh --chat-id <ID> "Prueba del arnés: si ves esto, los avisos andan."
       Esperado: un número (o «ok») y el mensaje en mi Telegram: preguntame si llegó. Si sale «telegram-notify: …», PARÁ.
   D5. (Opcional) La herramienta propia de Telegram dentro de Claude Code: es el plugin oficial de Anthropic, que el
       arnés usa si está. No lo probamos en Windows. Necesita Bun:
           npm install -g bun; bun --version
       Después PARÁ y decime que yo escriba en Claude Code, de a uno:
           /plugin install telegram@claude-plugins-official
           /telegram:access allow <ID>
           /telegram:access policy allowlist
       (si el primero no encuentra el plugin: /plugin marketplace add anthropics/claude-plugins-official, y otra vez).
       Usa el mismo token de D2. Si falla, lo dejamos: D4 ya alcanza para los avisos.

R. Reporte de la parte 2. Corré:
       node "$env:USERPROFILE\.claude\tycon-harness\scripts\lib\tycon-config.js" integrations --json
       node "$env:USERPROFILE\.claude\tycon-harness\scripts\setup\harness.js" doctor
   y armame UN solo bloque de texto, para guardarlo o para pedir ayuda (sin tokens, sin mi id de Telegram):

   PARTE 2 — opcionales · Windows
   engram: PRENDIDA / SALTEADA / FALLÓ en el paso ___ · engram version: ___ · setup claude-code: SÍ / NO
   codegraph: PRENDIDA / SALTEADA / FALLÓ en el paso ___ · versión: ___ · aparece en claude mcp list: SÍ / NO
   codex: PRENDIDA / SALTEADA / FALLÓ en el paso ___ · versión: ___ · login: SÍ / NO · /hooks aprobado: SÍ / NO
          · --parity sin rojos: SÍ / NO (si no, los rojos tal cual)
   telegram: PRENDIDA / SALTEADA / FALLÓ en el paso ___ · llegó el aviso de prueba: SÍ / NO · plugin: SÍ / NO / SALTEADO
   integrations --json: (la salida)
   doctor: (la salida COMPLETA)
   Otras cosas raras: ___
   OK / NO OK

   Después decime que cierre y vuelva a abrir Claude Code (en el repo de codegraph, si lo prendí). En esa sesión nueva,
   /mcp tiene que mostrar engram y codegraph conectados (los que haya prendido); y si instalé el plugin de Telegram,
   pedile «mandame hola por Telegram».
```

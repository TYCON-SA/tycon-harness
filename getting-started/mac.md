# Instalar el arnés TYCON con Claude Code · Mac

Copiá todo el bloque de la parte 1 y pegáselo a Claude Code: te guía paso a paso y te avisa cuando un paso lo tenés que
hacer vos. No hace falta cuenta de GitHub ni permiso: el arnés se baja de un repo público. Los opcionales (parte 2) van
después, en una sesión nueva de Claude Code.

Instala el perfil completo (`full`), que cambia cómo te contesta Claude en todos tus proyectos (ver la portada, «Antes
de instalar»). Para el perfil mínimo, escribí «quiero el perfil mínimo» arriba del bloque al pegarlo.

## Parte 1 — instalación base

```text
Necesito instalar en esta máquina el arnés TYCON para trabajar con Claude Code (y con BIZUIT Extensions). El arnés
vive en un repo público de GitHub: se baja sin cuenta y sin permiso. Seguí estos pasos EN ORDEN, en la terminal,
corriendo cada comando TAL CUAL (no lo reescribas ni lo "mejores"). Si una salida no es la esperada, o aparece un error
que no está acá, PARÁ, no arregles nada a mano y mostrame la salida tal cual.

Perfil: si arriba de este pedido te escribí «quiero el perfil mínimo», en los pasos 3 y 4 cambiá --profile full por
--profile minimal, y salteá el paso 5. Si no, va full.

Si un paso contesta 403 o «límite de la API de GitHub»: GitHub limita los pedidos sin credencial a 60 por hora por
dirección de red, y una oficina entera suele compartir la suya. PARÁ y avisame, sin reintentar: o espero a que se
renueve (como mucho una hora) y repetimos ese paso; o, si tengo un permiso de GitHub propio, lo pongo YO en la variable
TYCON_GITHUB_TOKEN con la línea de abajo, en la misma terminal donde corro el guion (no se ve al pegarlo; vos no lo
leas ni lo muestres), y vuelvo a correr get-harness, que lo usa y lo guarda:
    printf 'Permiso de GitHub: ' && read -rs TYCON_GITHUB_TOKEN && echo && export TYCON_GITHUB_TOKEN
Bajar el propio guion va siempre sin credencial: si el 403 fue ahí, sólo queda esperar.

1. Herramientas:
   node --version; python3 --version; tar --version
   Esperado: node v22 o más, python3 3.algo, y tar. Lo que falte, decime que lo instale yo con Homebrew
   (https://brew.sh si no lo tengo), de a uno:  brew install node · brew install python
   (git NO hace falta: el arnés se baja como archivos, no se clona.)

2. Bajar el guion de instalación (se baja, se lee y después se corre; no se clona nada): dame estas dos líneas para
   pegar en mi terminal, una por una:
       curl -fsSL -H "Accept: application/vnd.github.raw" -o get-harness.sh https://api.github.com/repos/TYCON-SA/tycon-harness/contents/scripts/setup/get-harness.sh
       less get-harness.sh
   Esperado: el archivo get-harness.sh en mi carpeta y un guion de unas 120 líneas que empieza con «# get-harness.sh —
   baja la versión publicada del arnés (sin git)».

3. Ver el plan de instalación (no instala nada): dame esta línea para mi terminal:
       bash get-harness.sh -- --profile full --integrations none --packs all --dry-run
   Baja la versión a una carpeta temporal y muestra el plan. Te paso la salida: mostrame el plan resumido (qué escribe,
   qué hooks pone, y si configura la carpeta global de hooks de git) y preguntame si sigo.

4. Con mi sí, instalar, en mi terminal:
       bash get-harness.sh -- --profile full --integrations none --packs all --yes
   Esperado: termina con «versión: …» y un resumen, sin rojo. El arnés queda en ~/.tycon/harness (archivos, sin git).

5. Los controles que corren al commitear (hooks globales de git). Si git no tenía una carpeta global de hooks, la
   instalación la configuró (el plan lo decía): con ella git deja de correr los .git/hooks/ propios de cada uno de mis
   repos, y el control del arnés corre en su lugar el .githooks/pre-commit de cada repo. Mirá cómo quedó:
   git config --global --get core.hooksPath
   Si no devuelve nada, corré:  git config --global core.hooksPath ~/.git-hooks
   Si devuelve otra carpeta, NO la pises: mostrámela y decidimos.

6. Verificar (tres comandos):
   node ~/.claude/tycon-harness/scripts/setup/harness.js doctor
   ls -d ~/.claude/skills/*/ | wc -l
   grep -c "INDEX.md" ~/.claude/CLAUDE.md
   Esperado: doctor dice «perfil: full» (o «perfil: minimal» si pedí el mínimo) y cierra con «todo en orden» (o «N aviso(s), nada en rojo»); más de 40; 1.

7. Armame UN solo bloque de texto, para guardarlo o para pedir ayuda, con la salida de los pasos 1, 2 y 4 (el final), y
   la salida COMPLETA del paso 6, más una línea final «OK» o «NO OK». Después decime que cierre y vuelva a abrir Claude
   Code.

Para trabajar con BIZUIT Extensions: el paquete bizuit ya queda prendido para todos mis repos (--packs all). Las guías
para empezar un plugin o un formulario están en ~/.claude/tycon-harness/guides/bizuit/ y te mandan a los templates públicos.
```

## Parte 2 — opcionales: engram, codegraph, codex y telegram

```text
Esto va DESPUÉS de la parte 1, en una sesión NUEVA de Claude Code (ya cerré y reabrí). Las mismas reglas: cada comando
TAL CUAL, en la terminal; si una salida no es la esperada, PARÁ y mostrámela tal cual.

- Primero preguntame cuáles de las cuatro quiero. Hacé sólo esas, en este orden, cada una completa antes de la otra.
- Son independientes: si una falla, PARÁ, mostrame la salida y preguntame si seguimos con la siguiente. No desinstales
  nada ni toques lo de la parte 1 para arreglarla.
- Nunca leas ni muestres un token o una clave, aunque te lo pida.
- «PRENDER <x>» son estos dos comandos, con <x> el nombre de la integración:
     node ~/.claude/tycon-harness/scripts/lib/tycon-config.js set integrations.<x> true
     node ~/.claude/tycon-harness/scripts/setup/harness.js apply
  Esperado: el primero dice «integrations.<x>: (sin valor) → true en …tycon.json»; el segundo termina sin rojo.
  Para apagar una que quedó a medias: los mismos dos comandos con false en vez de true.

A. engram — memoria del agente entre sesiones. No pide cuenta. El equipo usa la versión 1.20.0 (archivo engram-version
   del arnés).
   A1. Se baja la 1.20.0 de las versiones publicadas de engram (NO con Homebrew: brew instala la última, que no es la
       del equipo). Primero: uname -m  →  arm64 (Apple Silicon) es arm64; x86_64 es amd64. Con ese valor en lugar de <arq>:
           cd /tmp && curl -fsSLO https://github.com/Gentleman-Programming/engram/releases/download/v1.20.0/engram_1.20.0_darwin_<arq>.tar.gz && tar xzf engram_1.20.0_darwin_<arq>.tar.gz && mkdir -p ~/.local/bin && mv engram ~/.local/bin/ && hash -r
           which engram && engram version
       Esperado: ~/.local/bin/engram y «engram 1.20.0» (si además avisa que hay una versión nueva, ignoralo). Si which no
       lo encuentra, ~/.local/bin no está en mi PATH: decime que agregue  export PATH="$HOME/.local/bin:$PATH"  al final
       de ~/.zshrc y que abra otra terminal. Si ya tenía engram de Homebrew, primero: brew uninstall engram. Si dice otro
       número, PARÁ.
   A2. Esto lo hago YO, porque hace preguntas. PARÁ y decime que en una terminal corra:
           engram setup claude-code
       y que a la pregunta de los permisos conteste que sí. Esperado: el setup sin error.
   A3. PRENDER engram. (sqlite3, que usan dos chequeos de salud de la memoria, ya viene con macOS.)
   Nota: la memoria viaja en los commits sólo en los repos que tienen un archivo .engram-project
   (~/.claude/tycon-harness/guides/engram-workflow.md). Cuando el equipo cambie de versión, el arranque lo avisa (y se
   repite este paso con el número nuevo).

B. codegraph — índice del código, para que el agente encuentre las cosas sin leer archivo por archivo. No pide cuenta.
   Se instala con npm. El equipo no fija versión: el instalador baja la última.
   B1. PARÁ y preguntame dos cosas: la ruta de UN repo mío con código (nunca mi carpeta de usuario), y si quiero que de
       ahí en adelante indexe solo cada repo que abra (por defecto, sí).
   B2. bash ~/.claude/tycon-harness/scripts/setup/install-codegraph.sh "<ruta del repo>"
       (si contesté que no indexe solo, agregá --no-auto al final). Puede tardar unos minutos.
       Esperado: termina con «✓ CodeGraph instalado.».
   B3. codegraph --version && (cd "<ruta del repo>" && claude mcp list)
       Esperado: un número de versión y una línea «codegraph» en la lista.
   B4. PRENDER codegraph (en el arnés sólo deja constancia: no registra nada).

C. codex — el mismo arnés bajo Codex, el asistente de OpenAI. Pide cuenta de OpenAI: un plan de ChatGPT (Plus, Pro,
   Business, Edu o Enterprise) o una clave de API.
   C1. codex --version
       Si no está: brew install --cask codex (instalador oficial) y otra vez codex --version.
       Esperado: un número de versión.
   C2. Esto lo hago YO, porque abre el navegador. PARÁ y decime que en una terminal corra:
           codex login
       Entro con mi cuenta de OpenAI. Esperá mi «listo».
   C3. PRENDER codex. Esperado: además del resumen, puede salir un aviso «TRUST»: es normal la primera vez. macOS puede
       avisar «se agregaron elementos en segundo plano»: es el arnés, que deja la configuración visible para el panel de
       Codex en VS Code (si lo uso, hay que cerrar y reabrir VS Code entero una vez).
   C4. Esto lo hago YO. PARÁ y decime que en una terminal corra codex, adentro escriba /hooks, apruebe todos y salga.
       Sin eso los hooks del arnés no corren bajo Codex, y no dan error. Se repite cada vez que el arranque diga «TRUST».
   C5. node ~/.claude/tycon-harness/scripts/lib/harness-audit.js --parity
       Esperado: sin rojos. Si hay, mostrámelos tal cual: no los silencies.
   Nota: una vez por día el arnés corre de fondo una prueba dentro de Codex que gasta de mi plan; se apaga con la
   variable TYCON_BENCH_DAILY en 0 (portada del arnés, «Dónde se pone un interruptor»). Eso lo decido y lo hago yo.

D. telegram — avisos a mi celular cuando termina algo largo. Sólo salida: el arnés avisa, no lee lo que yo le escriba.
   Pide una cuenta de Telegram y un bot MÍO.
   D1. Esto lo hago YO, en Telegram. PARÁ y decime que: le escriba /newbot a @BotFather, le dé un nombre y un usuario
       que termine en «bot», y guarde el token que me da (a vos NO te lo paso); le escriba «hola» a mi bot (si no, el
       bot no puede escribirme); y le escriba a @userinfobot, que me contesta mi número de id. Te paso SÓLO ese número.
   D2. Esto lo hago YO, para que el token no pase por el chat. PARÁ y decime que en una terminal corra:
           mkdir -p ~/.claude/channels/telegram && printf 'Token del bot: ' && read -rs T && echo && printf 'TELEGRAM_BOT_TOKEN=%s\n' "$T" > ~/.claude/channels/telegram/.env && chmod 600 ~/.claude/channels/telegram/.env && unset T && echo listo
       y pegue el token cuando lo pida (no se ve al pegarlo). Esperado: listo. Vos no abras ni leas ese archivo.
   D3. Con el número que te pasé en lugar de <ID>:
       node ~/.claude/tycon-harness/scripts/lib/tycon-config.js set telegram.chat_id <ID>
       echo 'export TYCON_TELEGRAM_CHAT_ID=<ID>' >> ~/.zshrc && echo ok
       Esperado: «telegram.chat_id: (sin valor) → <ID> en …tycon.json» y ok. El arnés lee el archivo; el script que
       manda el aviso lee la variable, que vale desde la próxima sesión.
   D4. bash ~/.claude/tycon-harness/scripts/lib/tycon-telegram-notify.sh --chat-id <ID> "Prueba del arnés: si ves esto, los avisos andan."
       Esperado: un número y el mensaje en mi Telegram: preguntame si llegó. Si sale «telegram-notify: …», PARÁ.
   D5. (Opcional) La herramienta propia de Telegram dentro de Claude Code: es el plugin oficial de Anthropic, que el
       arnés usa si está. Necesita Bun:
           brew install bun && bun --version
       Después PARÁ y decime que yo escriba en Claude Code, de a uno:
           /plugin install telegram@claude-plugins-official
           /telegram:access allow <ID>
           /telegram:access policy allowlist
       (si el primero no encuentra el plugin: /plugin marketplace add anthropics/claude-plugins-official, y otra vez).
       Usa el mismo token de D2. Si falla, lo dejamos: D4 ya alcanza para los avisos.

R. Reporte de la parte 2. Corré:
       node ~/.claude/tycon-harness/scripts/lib/tycon-config.js integrations --json
       node ~/.claude/tycon-harness/scripts/setup/harness.js doctor
   y armame UN solo bloque de texto, para guardarlo o para pedir ayuda (sin tokens, sin mi id de Telegram):

   PARTE 2 — opcionales · Mac
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

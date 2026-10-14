# Arnés TYCON — referencia

[English](reference.md) · Castellano

Lo que sigue es para consultar: instalar a mano, los perfiles, qué escribe en tu máquina, cómo se actualiza. Para
instalar con Claude Code no hace falta leerlo: empezá por la [portada](../README.es.md).

## Qué es y qué no es

**Es** un arnés para un asistente de programación con IA:

- **Guías y reglas** que cada sesión carga o lee cuando las necesita: cómo se escribe una story, cómo se commitea, cómo
  se corren las pruebas sin congelar la máquina, y más.
- **Hooks** que Claude Code corre en momentos fijos (al abrir una sesión, antes de un comando, antes de una edición, al
  cerrar un turno): algunos sólo miden o avisan, otros frenan un comando (ver la tabla en
  [INSTALL.md](../INSTALL.md#los-hooks-que-instala)).
- **Revisores**: subagentes que revisan un cambio contra una lista cerrada de reglas, cada hallazgo con su identificador.
- **Un pipeline de stories** (`tycon-pipeline`). Una story es un documento con un cambio, sus criterios de aceptación y
  sus pruebas. El pipeline la valida, planifica, implementa con portones de compilación y de pruebas, corre los
  revisores en paralelo y prepara el commit. El agente nunca commitea ni sube cambios sin tu permiso explícito.
- **Un banco de controles** que verifica, caso por caso, que cada hook y cada revisor siguen haciendo lo que dicen.

**No es** un modelo, ni un servicio en la nube, ni una aplicación: todo corre en tu máquina, dentro del asistente que ya
usás. No manda tu código a ningún lado más allá de lo que ya hace ese asistente. La mayoría de las guías están en
castellano; esta página y los archivos de la comunidad tienen versión en inglés.

## Requisitos

- **Sin cuenta de GitHub**: este repo es público, y el arnés se baja de acá sin credencial.
- **Claude Code** instalado y con tu sesión iniciada (o Codex, para el lado Codex).
- **En Windows, nativo**: Node 22 o posterior, PowerShell 7 y `tar` (viene con Windows 10 y posteriores). Git y Python
  no hacen falta. Por WSL, lo mismo que en Mac y Linux, dentro de WSL.
- **En Mac y Linux**: Bash, Python 3, `tar`, `curl` y Node 22 o posterior (probado en 22 y 24). Git no hace falta.
- **El paquete del stack de TYCON** pide además el SDK de .NET de tu plugin.

La lista exacta para Mac y Linux (`dotnet`, sólo con el paquete del stack):

<!-- requirements -->
```text
bash
python3
tar
curl
node >= 22
dotnet (bizuit)
```
<!-- /requirements -->

Windows: nativo (con PowerShell 7) o por WSL. El camino nativo se probó el 2026-10-06 en una máquina Windows 11 limpia,
instalado desde esta copia: `doctor` da todo en orden, con los hooks de git instalados. Por WSL todavía no lo probó
nadie.

## Instalar a mano

**A mano** (y en Linux o por WSL) son tres pasos: preparar la máquina, bajar e instalar, y revisar. Seguí sólo los de
tu sistema. La instalación sin nadie delante es opcional y está al final de esta sección, en «Otras formas de instalar».
Usar el arnés no necesita git ni un clon: la versión publicada se baja como archivos a `~/.tycon/harness`.

### 1. Preparar la máquina

**En Windows** (nativo, probado con esta copia; por WSL, seguí los pasos de Mac y Linux dentro de WSL). Instalá lo que
te falte, desde cualquier terminal:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Microsoft.PowerShell
```

Cerrá la terminal y abrí **PowerShell 7** (en el menú Inicio se llama así): todos los comandos de esta página se corren
ahí, no en la 5.1 que viene con el sistema. Comprobá que `node --version` diga v22 o más y que `tar --version` conteste
(el sistema lo trae desde 2018). No hay nada más con que iniciar sesión: el arnés nunca abre un navegador.

**En Mac**, instalá lo que te falte con Homebrew (https://brew.sh):

```bash
brew install node python
```

**En Linux**, lo mismo con el gestor de paquetes de tu distribución. Comprobá que `node --version` diga v22 o más.

### 2. Bajar e instalar

Abrí una terminal en cualquier carpeta y pegá las líneas de tu sistema, una por una: las de `bash` en Mac, Linux y WSL;
las de `powershell` en Windows nativo. La primera baja el guion de instalación por la API de GitHub, sin credencial; la
segunda lo muestra, para que leas lo que vas a correr; la tercera lo corre. El guion revisa los requisitos, baja la
versión publicada como archivos (sin git, sin clon) a una carpeta temporal y sigue con `harness.js install --version
latest` en la misma terminal. Son tres líneas a propósito: una bajada con tubería directa a un shell la bloquea el freno
de comandos (`SUP-C1`). El guion nunca instala paquetes del sistema ni usa `sudo`. Las opciones de `install` van después
de `--`: `bash get-harness.sh -- <opciones>`.

<!-- install:core -->
```bash
curl -fsSL -H "Accept: application/vnd.github.raw" -o get-harness.sh https://api.github.com/repos/TYCON-SA/tycon-harness/contents/scripts/setup/get-harness.sh
less get-harness.sh
bash get-harness.sh
```

```powershell
Invoke-WebRequest -Headers @{ Accept = 'application/vnd.github.raw' } -OutFile get-harness.ps1 https://api.github.com/repos/TYCON-SA/tycon-harness/contents/scripts/setup/get-harness.ps1
Get-Content get-harness.ps1
pwsh -File get-harness.ps1
```
<!-- /install:core -->

GitHub limita los pedidos que van sin credencial a 60 por hora por dirección de red, y una oficina entera suele
compartir la suya. Si una línea contesta 403, esperá a que el límite se renueve (como mucho una hora) y corré esa línea
de nuevo. Con un permiso de GitHub propio te ahorrás la espera del guion: ponelo en la variable `TYCON_GITHUB_TOKEN` de
esa terminal y corré el guion de nuevo (en Mac y Linux, `read -rs TYCON_GITHUB_TOKEN && export TYCON_GITHUB_TOKEN`; en
PowerShell 7, `$env:TYCON_GITHUB_TOKEN = Read-Host -MaskInput`). El guion usa el permiso y lo guarda en
`~/.tycon/config.json`, que sólo tu usuario puede leer; `harness.js config unset github.token` lo saca. La primera
línea, la que baja el guion, nunca lleva credencial.

`install` no escribe nada sin avisarte antes: hace tres preguntas, después muestra el plan y pregunta «¿Instalo?». Para ver
sólo el plan, sin instalar, agregá `--dry-run`.

### Qué contestar

Las preguntas están en castellano. Para «sí» vale `s` o `y`.

1. **«¿Qué perfil instalo?»** Contestá `1` (`minimal`) o `2` (`full`): no hay uno por defecto.
   - `minimal`: las guías, los revisores y el pipeline, sin cambiar cómo te contesta el asistente.
   - `full`: suma los frenos (en un repo con stories, editar código va por el pipeline) y hace que el asistente
     conteste corto y en castellano en todos tus proyectos, no sólo donde uses el arnés.
2. **«¿Qué integraciones prendo?»** Son servicios externos, como Azure DevOps o Clockify. Enter no prende ninguna; se
   prenden después (ver «Qué es opcional»).
3. **«¿Usás el paquete del stack en todos tus repos?»** Son las convenciones para plugins sobre Bizuit (.NET y
   React/Next.js). `s` si todos tus repos son de esos plugins; si no, `n`, y cada repo lo pide después.

Después de las tres preguntas, **el plan y «¿Instalo? [s/N]»** muestra qué archivos toca, qué cambia en cómo trabaja
tu asistente, qué corre solo, a qué sale a la red y qué guarda en disco. Leelo y contestá `s`.

`install` pregunta lo que no puede decidir solo: el perfil, qué integraciones prender y si usás el paquete del stack en
todos tus repos. Pregunta una sola vez, en la primera instalación con terminal: con el perfil ya fijado (por su variable
o en `~/.claude/tycon.json`), con `--yes` o sobre una instalación que ya existe no pregunta nada, y al final dice cómo
cambiar el perfil o las integraciones. Las tres preguntas se contestan también con opciones: `--profile minimal|full`,
`--integrations <lista|none>` y `--packs all|none`.

### 3. Revisar

Revisá cómo quedó (el primero en Mac y Linux, el segundo en PowerShell):

```bash
node ~/.claude/tycon-harness/scripts/setup/harness.js doctor
```

```powershell
node "$HOME\.claude\tycon-harness\scripts\setup\harness.js" doctor
```

En PowerShell, los demás comandos `node ~/.claude/…` de esta página se escriben igual que éste: con `$HOME\.claude\…`.

Si falta una herramienta, el guion (o `install`) corta con una línea que la nombra, con el comando para instalarla, y no
escribe nada. Instalala y corré de nuevo `bash get-harness.sh` (el guion que ya bajaste).

Con `full`, `install` puede avisar que git no tiene `core.hooksPath` global: los hooks de git quedan en `~/.git-hooks/`
y git los usa recién cuando configurás esa clave. Antes de hacerlo, leé qué cambia en «Qué escribe en tu máquina».

### Otras formas de instalar (opcionales)

**Sin nadie delante** (un contenedor, una tarea programada): la misma línea, con el perfil y `--yes`.

<!-- install:unattended -->
```bash
curl -fsSL -H "Accept: application/vnd.github.raw" -o get-harness.sh https://api.github.com/repos/TYCON-SA/tycon-harness/contents/scripts/setup/get-harness.sh
less get-harness.sh
bash get-harness.sh -- --profile minimal --yes
```

```powershell
Invoke-WebRequest -Headers @{ Accept = 'application/vnd.github.raw' } -OutFile get-harness.ps1 https://api.github.com/repos/TYCON-SA/tycon-harness/contents/scripts/setup/get-harness.ps1
Get-Content get-harness.ps1
pwsh -File get-harness.ps1 -- --profile minimal --yes
```
<!-- /install:unattended -->

Con `--yes` se acepta el plan sin que nadie lo vea: conviene mirarlo antes con `--dry-run`. `--yes` no elige el perfil:
el bloque instala el mínimo, o `--profile full` para el arnés completo. Sin terminal el guion no pregunta nada. Donde
muchas máquinas comparten una dirección, como un agente de compilación, el límite de arriba se alcanza seguido.
`TYCON_GITHUB_TOKEN`, puesto como arriba, cubre lo que piden el guion y la instalación. La línea que baja el guion va
sin credencial igual, y un 403 ahí sólo se pasa esperando: en una máquina así, bajá el guion una vez y guardalo con la
imagen de la máquina.

**Modo desarrollador (para cambiar el arnés, no para usarlo).** Quien mantiene el arnés clona este repo e instala desde
el clon: esa máquina corre el arnés desde el clon y actualizarlo es suyo (`harness.js link --local <clon>` apunta una
máquina instalada a un clon para probar un cambio antes de publicarlo; `harness.js link --managed` vuelve). Usar el
arnés nunca necesita esto. Git es requisito sólo acá.

<!-- install:clone -->
```bash
git clone https://github.com/TYCON-SA/tycon-harness tycon-harness && node tycon-harness/scripts/setup/harness.js install
```

```powershell
git clone https://github.com/TYCON-SA/tycon-harness tycon-harness; node tycon-harness/scripts/setup/harness.js install
```
<!-- /install:clone -->

<!-- install:clone-unattended -->
```bash
git clone https://github.com/TYCON-SA/tycon-harness tycon-harness && node tycon-harness/scripts/setup/harness.js install --profile minimal --yes
```

```powershell
git clone https://github.com/TYCON-SA/tycon-harness tycon-harness; node tycon-harness/scripts/setup/harness.js install --profile minimal --yes
```
<!-- /install:clone-unattended -->

## Perfiles

Hay dos, `minimal` y `full`, y no hay uno por defecto: `install` te pregunta si no elegís; sin terminal, pasá `--profile`.

- **`minimal`**: las guías, las skills, los revisores, el pipeline como skill y el aviso de versión nueva. No cambia
  cómo contesta el asistente. Registra siete hooks (seis que sólo anotan y el freno de comandos destructivos), más los
  de cada integración que prendas, y trae los enlaces, los comandos y las skills de terceros.
- **`full`**: todo lo de `minimal`, y además los otros frenos (en un repo con stories, editar código sin el pipeline se
  deniega), los tres bloques que cambian cómo contesta el asistente en todos tus proyectos (en castellano, con la
  conclusión primero y un tope de largo), los dos ajustes de `settings.json`, los hooks de git y las tareas de fondo.

Se elige con `--profile minimal` o `--profile full`, con `install.profile` en `~/.claude/tycon.json` o con la variable
`TYCON_INSTALL_PROFILE`. Cambiar de perfil quita o repone lo que corresponde, con una copia de respaldo antes. En
`minimal`, los otros frenos se prenden con su variable en `1` (`TYCON_TEST_SCOPE_GUARD=1`), y el de comandos
destructivos se apaga sólo con `TYCON_SAFETY_GUARD=0`.

## El paquete del stack de TYCON

El paquete opcional es el paquete del stack de TYCON: .NET + React/Next.js sobre Bizuit. Adentro del repo se llama
`bizuit`. Son las convenciones con que TYCON desarrolla plugins sobre Bizuit; no es un producto de Bizuit.

**Qué agrega**: tres revisores (`tycon-plugin-dotnet-conventions`, `tycon-plugin-react-conventions`,
`tycon-plugin-nextjs-conventions`), sus guías y sus casos en el banco de controles. **Qué pide además**: el SDK de .NET
de tu plugin.

**Viene apagado.** El repo lo trae, pero un repo de producto sólo lo usa si lo pide en su `.tycon/advisors.yaml` con
`packs: [bizuit]`, o si tu máquina lo prende para todos los repos (`TYCON_PACKS_DEFAULT=all`, o `packs.default` en
`~/.claude/tycon.json`). Si no lo usás, ignoralo. Para pedirlo desde un repo de producto, corré esto desde la raíz de
ese repo (si el archivo ya tiene una clave `packs:`, editá esa línea):

<!-- install:bizuit -->
```bash
mkdir -p .tycon && printf 'packs: [bizuit]\n' >> .tycon/advisors.yaml
```

```powershell
New-Item -ItemType Directory -Force .tycon | Out-Null; Add-Content .tycon/advisors.yaml 'packs: [bizuit]'
```
<!-- /install:bizuit -->

Un repo que pide el paquete cuando el clon no lo tiene frena el pipeline (exit 2) con este mensaje (la ruta del final es
la de tu máquina):

```text
el repo declara el paquete «bizuit» en `packs:` y no está instalado en …
```

El paquete vive en `packs/bizuit/` de este repo: si ves ese mensaje, tu clon está incompleto; actualizalo con
`node ~/.claude/tycon-harness/scripts/setup/harness.js update`.

## Qué es opcional

Ocho integraciones, todas **apagadas** por defecto. Cada una se prende con una clave en `~/.claude/tycon.json` o con su
variable; `node ~/.claude/tycon-harness/scripts/lib/tycon-config.js explain` muestra cada valor y de dónde salió.

| Integración | Qué hace | Cómo se prende |
|---|---|---|
| `ado` | Azure DevOps: work items de las stories, controles de pull requests y de pipelines | `ado.org` en `~/.claude/tycon.json`, o `TYCON_ADO_ORG` |
| `clockify` | los hooks de registro de horas en Clockify | `integrations.clockify: true`, o `TYCON_CLOCKIFY=1` |
| `engram` | la memoria persistente de engram: sincroniza en cada commit y la revisa una vez por día | `integrations.engram: true`, o `TYCON_ENGRAM=1` |
| `codegraph` | el índice de código de CodeGraph para los agentes (informativa: CodeGraph lo instalás vos) | `integrations.codegraph: true`, o `TYCON_CODEGRAPH=1` |
| `mailbox` | sube los registros de cada corrida del pipeline a un buzón de tu organización; hace falta que la organización lo tenga armado (hoy, un almacenamiento de Azure) | `integrations.mailbox: true`, o `TYCON_MAILBOX=1` (su llave en `TYCON_MAILBOX_JSON`) |
| `codex` | despliega el lado Codex | `integrations.codex: true` o `"detect"`, o `TYCON_CODEX=1` |
| `claude` | enchufa Claude Code (hooks, ajustes, el import del índice) | `integrations.claude: true` o `"detect"`, o `TYCON_CLAUDE=1` |
| `nightly` | los avisos de los procesos de la noche de tu organización (tablero, dependencias, retrospectivas), que corren desde su repo de operaciones: ver [Para una organización](../README.es.md#para-una-organización) | `integrations.nightly: true`, o `TYCON_NIGHTLY=1` |
| `telegram` | avisos de progreso a un chat de Telegram | `telegram.chat_id` en `~/.claude/tycon.json`, o `TYCON_TELEGRAM_CHAT_ID` |

**El lado Codex**: el mismo arnés bajo Codex, traducido y desplegado solo. Pide `codex` en el PATH y logueado, y
`TYCON_CODEX=1`. El detalle, en [INSTALL.md](../INSTALL.md).

**Cuatro skills propietarias** (`docx`, `pdf`, `pptx`, `xlsx`) no son parte de este repo y no se bajan: vienen con el
plugin oficial de Anthropic. Instalalo si las querés.

## Qué escribe en tu máquina y qué hace solo

Esta sección sale de una lista declarada, `scripts/setup/install-effects.json`, que una prueba cruza con el instalador.
Casi todo lleva su interruptor, y se nombra al lado. Lo que no lo tiene —la línea de import, los dos ajustes de
`settings.json`, el registro de los últimos pedidos y las pruebas rápidas del arranque— se saca a mano o con
`harness.js uninstall`. Dónde se pone un interruptor está al final de la sección.

**Cambia cómo contesta tu asistente**, en todos tus proyectos y no sólo donde uses el arnés. La instalación escribe
tres bloques de reglas en `~/.claude/CLAUDE.md`, entre sus propios marcadores, y una línea de import:

- `response-style`: el asistente contesta en castellano llano, con la conclusión primero y un tope de 1300 caracteres
  de prosa. Un hook mide cada respuesta y le cobra el exceso en el turno siguiente (`TYCON_RESPONSE_METER=0` apaga la
  medición).
- `background-execution`: los pasos de más de dos minutos corren en segundo plano y se anuncian antes. Otro hook mide
  lo que dejó bloqueada la conversación (`TYCON_BLOCKING_METER=0`).
- `tool-names`: la tabla con el nombre exacto de cada herramienta que nombran esas reglas.
- La línea de import carga en cada sesión el `INDEX.md` del arnés: unos 13 KB, en castellano, con el índice de las
  guías y las reglas siempre activas.
- Los enlaces de `~/.claude/skills` y `~/.claude/agents` dejan disponibles en todas tus sesiones las skills y los
  revisores del arnés: el nombre y la descripción de cada uno se cargan en cada sesión.

`TYCON_NO_CLAUDEMD_SYNC=1` deja de sincronizar los bloques; los que ya están se sacan borrando lo que hay entre sus
marcadores.

**Controles que frenan**: algunos hooks de `~/.claude/settings.json` pueden denegar un comando o no dejar cerrar un
turno.

- En cualquier repo: el freno de comandos peligrosos (borrar la raíz, forzar un push a `main`, bajar un guion y correrlo
  con tubería, mostrar con `cat`, `head` o `tail` un `.env`, una llave de `.ssh` o las credenciales de `.aws`;
  `TYCON_SAFETY_GUARD=0` lo apaga; la herramienta de lectura del asistente no pasa por este freno), el de pruebas sin
  filtro para `npm test`, Vitest y `dotnet test` (`TYCON_TEST_SCOPE_GUARD=0`), y el que frena un pull request a `main`
  armado con `az` sin sus banderas (`TYCON_PR_AUTO_COMPLETE_GUARD=0`).
- En un repo que trabaja con el arnés —tiene carpeta `.tycon/`, o stories creadas con la skill, o el pipeline ya corrió
  ahí—: el portón que deniega editar código sin pipeline, el que deniega el commit de una story sin evidencia, y los que
  frenan el cierre del turno después de un push a `main` sin métricas o con trabajo sin subir.

La tabla completa, con qué hace cada hook, si frena y su interruptor, está en
[INSTALL.md](../INSTALL.md#los-hooks-que-instala).

**Qué hace solo**: al abrir una sesión, la línea de arranque mira si tu canal tiene una versión nueva, como mucho una
vez cada 6 horas. Si la hay, avisa y espera: no la aplica sin que se lo pidas desde una terminal
(`node ~/.claude/tycon-harness/scripts/setup/harness.js update --yes`). Después corre el instalador.
`TYCON_UPDATE=0` apaga la consulta; `TYCON_UPDATE_CHANNEL` y `TYCON_UPDATE_APPLY` fijan el canal y la política.

- En cada arranque, de fondo: corre unas pruebas rápidas del propio arnés, y relee las conversaciones del pipeline que
  cerraron sin su registro de consumo (`TYCON_NO_THREAD_RESCUE=1`).
- Una vez por día, de fondo: recorre el historial de git de hasta 200 repos de la carpeta madre del clon y deja un
  archivo por día en la carpeta `.dashboard/` del clon (`TYCON_STAGE_METRICS=0`); y junta en un archivo de tu máquina
  los hallazgos que los revisores dejaron en tus repos (`TYCON_NO_COLLECT_FINDINGS=1`).
- Al declarar un carril «ad-hoc», el portón de edición lanza por su cuenta una consulta corta al modelo de tu
  asistente, con tus últimos pedidos, para decidir si corresponde (`TYCON_LANE_LLM=0`).

**Qué escribe y qué guarda en disco**:

- **Hooks en `~/.claude/settings.json`**, y dos ajustes que valen para todos tus proyectos: `cleanupPeriodDays: 365`
  (Claude Code conserva las conversaciones un año) y `env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` (cada comando
  arranca en la raíz del proyecto). Si ya tenías un valor, queda el tuyo.
- **Enlaces** desde `~/.claude/tycon-harness`, `~/.claude/agent-skills`, `~/.claude/skills` y `~/.claude/agents`
  al clon. Si `~/.claude/skills` o `~/.claude/agents` ya son carpetas de verdad, crea adentro un enlace por entrada y
  nunca pisa nada tuyo.
- **Comandos de barra** copiados a `~/.claude/commands/` (`TYCON_NO_COMMANDS_SYNC=1` saltea la copia).
- **Hooks globales de git** en `~/.git-hooks/` (`TYCON_NO_GIT_HOOKS=1` los saltea). git sólo los usa si configurás
  `core.hooksPath` global, y con un `core.hooksPath` global git deja de correr los `.git/hooks/` de todos tus repos: el
  hook del arnés corre en su lugar el `.githooks/pre-commit` de cada repo.
- **Skills de terceros** bajadas de su origen a la carpeta `skills/` del clon: las que lista
  `scripts/publishing/third-party-skills.json`, cada una fijada a un commit (`TYCON_THIRD_PARTY=0` saltea el paso).
- **Los archivos del propio mecanismo de instalación**: su estado y su copia fija de arranque en
  `~/.claude/.tycon-pipeline/`, la línea de arranque en `~/.claude/settings.json`, y una copia de respaldo antes de cada
  cambio en `~/.claude/.tycon-pipeline/harness/backups/`: quedan las cinco más nuevas, la de antes de instalar —que no
  rota— y la anterior a la versión actual. `harness.js rollback --list` las muestra.
- **Lo que guardan los hooks**, todo en tu máquina: los últimos 8 pedidos de cada sesión y el estado del pipeline en
  `~/.claude/.tycon-pipeline/`, las respuestas que pasaron el tope de largo en `~/.claude/response-style/`, lo que
  anotan los otros dos medidores en `~/.claude/blocking-meter/` y `~/.claude/lectura-grande/` (la carpeta de trabajo de
  cada turno y los archivos leídos enteros), los comandos bloqueados en `~/.claude/safety-guard.log` y, de cada corrida del pipeline, sus tiempos y una copia
  comprimida de la conversación —pedidos, rutas y código incluidos— en `~/.claude/.tycon-pipeline/timing-history/`,
  que no se borra sola.

**Con el lado Codex prendido** (viene apagado: `integrations.codex: true` o `"detect"`, o `TYCON_CODEX=1`), el
instalador escribe además bajo `~/.codex/`, sin pisar lo tuyo: `AGENTS.md` (el espejo de las reglas de
`~/.claude/CLAUDE.md`: los mismos bloques cambian cómo contesta Codex), `hooks.json` (los mismos hooks), la sección
`[mcp_servers]` y los `writable_roots` de `config.toml` (los servidores MCP que ya tenés registrados en Claude Code;
los secretos nunca van al archivo), los perfiles `<nombre>.config.toml` y `agents/<nombre>.toml` de los revisores, y
enlaces en `skills/`. En Mac deja un agente de inicio de sesión (`ar.com.tycon.harness-env`) que publica la llave y los
secretos MCP para las aplicaciones gráficas (`TYCON_NO_GUI_ENV=1` lo saltea). Una vez por día corre de fondo una prueba
dentro de Codex, que gasta sesiones de modelo (`TYCON_BENCH_DAILY=0`). Con Azure DevOps configurado, deja además un
`AGENTS.md` de una línea en los repos de tu equipo que tienen `CLAUDE.md` y no tienen `AGENTS.md`; se commitea con el
repo (`TYCON_NO_AGENTSMD_POINTER=1` lo saltea). Queda un paso a mano: abrir una sesión de `codex`, correr `/hooks` y aprobarlos; sin eso los hooks no corren y no
dan error.

**La red**: el arnés no manda datos de uso. De fábrica habla con GitHub —el repo, para mirar si hay versión nueva, y
los orígenes de las skills de terceros que lista `scripts/publishing/third-party-skills.json`— y, si alguno de tus
repos vecinos es un clon parcial, con el remoto de ese repo, para leer su historial (el barrido diario). La consulta
corta al modelo de tu asistente va por el asistente que ya usás. Cada integración que prendas suma su servicio. La
prueba en máquina limpia de este repo, si la corrés, baja además las imágenes base (Docker Hub y el registro de
Microsoft); git, Python y los certificados (el repositorio de paquetes de Debian); el plugin de ejemplo y las skills de
terceros (GitHub); y los paquetes del plugin (NuGet).

**Dónde se pone un interruptor**: una variable `TYCON_…` se exporta en el shell desde el que abrís Claude Code y,
además, se escribe en `env` de `~/.claude/settings.json`. Conviene en los dos lugares: la extensión de VS Code puede no
ver lo que exportás en el archivo de arranque de tu shell, y `harness.js` corrido desde una terminal no lee `env`. Los
interruptores que apagan algo que el instalador registra valen desde la sesión siguiente. En `~/.claude/tycon.json`
van las integraciones, la política de actualización y los paquetes, no esas variables.

**Quitarlo**: `harness.js uninstall` quita sólo lo que el mecanismo registró. Deja el clon, `~/.claude/tycon.json`, las
copias de respaldo y la carpeta de estado `~/.claude/.tycon-pipeline/`, las skills de terceros ya bajadas y lo que
guardaron los hooks (`~/.claude/response-style/`, `~/.claude/blocking-meter/`, `~/.claude/lectura-grande/` y
`~/.claude/safety-guard.log`); lo lista al correr. Quita también
`cleanupPeriodDays: 365` si sigue con ese valor: Claude Code vuelve a su retención de fábrica y borra las
conversaciones más viejas; para conservarlas, dejá esa clave escrita a mano antes de desinstalar.

## El repo del producto

El pipeline corre sobre el repo de tu producto. Dos archivos opcionales lo configuran:

- `.tycon/advisors.yaml`: lo que los revisores necesitan saber del repo, y `packs:` para pedir un paquete.
- `_bmad/bmm/config.yaml` (con `_bmad/core/config.yaml`): la configuración que leen las skills `bmad-*`. Es opcional:
  sin ella, la skill pregunta tu nombre, el idioma y la carpeta de salida. Hoy esas respuestas no quedan guardadas: si
  querés fijarlas, pedile a Claude que escriba esos dos archivos, y commiteá `_bmad/` con el repo.

**Qué pone un repo bajo el arnés**: la carpeta `.tycon/`, y también la primera story (un `.md` con `story:` y `status:`
en su encabezado) o la carpeta `.advisors/` que deja el pipeline. Desde ahí, editar código sin un pipeline abierto ni un
carril «ad-hoc» declarado se deniega, y un push a `main` frena el cierre del turno, hasta tres veces, mientras no exista
su archivo de métricas (`TYCON_RETRO_PENDING=0` lo apaga). El comando de más arriba que pide el paquete crea la carpeta
`.tycon/`. Dos apagados del portón de edición: `TYCON_STORY_GATE=off` en tu ambiente (el agente no puede ponerla en la
sesión en curso), y `pipeline.story_gate: false` en `.tycon/advisors.yaml`, commiteado, para ese repo.

## Sin red

Sin red, la instalación igual termina (exit 0). El paso de terceros dice en una línea que no pudo preguntar a los
orígenes, y el control de presencia nombra las skills de terceros que faltan. Al abrir cada sesión, `harness.js startup`
dice «sin red» y sigue, en 35 segundos como mucho.

Para reintentar, con red: `node ~/.claude/tycon-harness/scripts/setup/harness.js apply` vuelve a correr el
instalador. Sirve también si, con red, quedaron skills pendientes porque el paso llegó a su tope de red
(`TYCON_THIRD_PARTY_NETWORK_BUDGET_S`, 20 segundos por corrida).

## Cómo se actualiza

- **Versiones**: cada versión lleva un número `AAAA.MM.DD.N`, donde `N` es su orden dentro del día. `stable` es `main` de
  este repo, que sólo cambia por un pull request revisado. `latest` leería una rama de prueba si este repo la tuviera;
  hoy no la tiene, así que los dos canales traen lo mismo. Pasar de `latest` a `stable` nunca baja de versión.
- **Canal**: `stable` por defecto. Se ve o se fija con
  `node ~/.claude/tycon-harness/scripts/setup/harness.js channel [latest|stable]`, o con `TYCON_UPDATE_CHANNEL`.
- **Política**: `ask` por defecto (avisa y espera); `auto` aplica sola. Se fija con `TYCON_UPDATE_APPLY` o con
  `update.apply` en `~/.claude/tycon.json`. Elegir `latest` junto con `auto` te pide que lo confirmes: recibís cada
  cambio que entra a `main`, en minutos, sin revisión tuya.
- **A mano**: `harness.js update --check` dice si hay versión nueva; `harness.js update --yes` la aplica;
  `harness.js version` muestra lo instalado; `harness.js doctor` diagnostica sin cambiar nada.
- **Volver atrás**: `harness.js rollback --list` muestra las copias a las que se puede volver, y
  `harness.js rollback --to <copia>` vuelve a la que elijas. Después de volver atrás, el arnés deja de actualizarse
  solo hasta que lo sueltes con `harness.js rollback --release`.
- **Quitar todo**: `harness.js uninstall --dry-run` muestra qué quitaría; `harness.js uninstall --yes` quita sólo lo que
  registró el mecanismo, y deja intacto lo tuyo.
- **El arranque**: la línea de arranque corre desde una copia fija en `~/.claude/.tycon-pipeline/harness/`, no desde
  la carpeta que se actualiza, así una actualización a medias no la rompe. `TYCON_UPDATE=0` apaga la actualización; `TYCON_UPDATE_CHANNEL` y
  `TYCON_UPDATE_APPLY` fijan el canal y la política.

Todos corren como `node ~/.claude/tycon-harness/scripts/setup/harness.js <comando>`.

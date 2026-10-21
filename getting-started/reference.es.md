# Arnés TYCON — referencia

[English](reference.md) · Castellano

Lo que sigue es para consultar: instalar a mano, la instalación mínima o completa, qué escribe en tu máquina, cómo se
actualiza. Para empezar no hace falta leerlo: empezá por la [portada](../README.es.md).

## Qué es y qué no es

**Es** un arnés para tu agente de código (Claude Code o Codex):

- **Guías y reglas** que cada sesión carga o lee cuando las necesita: cómo se escribe una historia, cómo se commitea,
  cómo se corren las pruebas sin congelar la máquina, y más.
- **Hooks** que tu agente corre en momentos fijos (al abrir una sesión, antes de un comando, antes de una edición, al
  cerrar un turno): algunos sólo miden o avisan, otros frenan un comando (ver la tabla en
  [INSTALL.md](../INSTALL.md#los-hooks-que-instala)).
- **Revisores**: subagentes que revisan un cambio contra una lista cerrada de reglas, cada hallazgo con su identificador.
- **El recorrido de una historia** (`tycon-pipeline`). Una historia (story) es un documento con un cambio, sus criterios
  de aceptación y sus pruebas. El recorrido la valida, planifica, implementa con portones de compilación y de pruebas,
  corre los revisores en paralelo y prepara el commit. El agente nunca commitea ni sube cambios sin tu permiso explícito.
- **Un banco de controles** que verifica, caso por caso, que cada hook y cada revisor siguen haciendo lo que dicen.

**No es** un modelo, ni un servicio en la nube, ni una aplicación: todo corre en tu máquina, dentro del agente que ya
usás. No manda tu código a ningún lado más allá de lo que ya hace ese agente. La mayoría de las guías están en
castellano; esta página y los archivos de la comunidad tienen versión en inglés.

## Las palabras del arnés

Diez palabras, cada una con un solo sentido en estas páginas:

- **Historia** (story): el documento de un cambio, con sus criterios de aceptación y sus pruebas.
- **Recorrido**: lo que hace una historia, de la validación al commit preparado (`tycon-pipeline`).
- **Plan**: lo que el agente va a hacer en una historia; no programa hasta que lo aprobás.
- **Revisores**: los agentes de IA que miran un cambio contra sus reglas. A la persona que aprueba se la llama «quien aprueba».
- **Freno**: un control que deniega un comando, una edición o el cierre de un turno; no sólo avisa.
- **Corrida**: una pasada del recorrido sobre una historia, con sus tiempos y lo que dijeron los revisores.
- **Pedido de cambio** (pull request): la propuesta de un cambio a un repo, que alguien aprueba antes de que entre.
- **Repo del equipo**: el repo propio de una organización con la configuración que llega a cada máquina del equipo.
- **Procesos de la noche**: lo que corre de noche para una organización (dependencias, métricas, tablero), desde su repo de operaciones.
- **Sitio del equipo**: la página opcional donde un equipo ve sus corridas y cambia su configuración.

## Requisitos

- **Sin cuenta de GitHub**: este repo es público, y el arnés se baja de acá sin credencial.
- **Tu agente de código**: Claude Code o Codex, instalado y con tu sesión iniciada.
- **En Windows, nativo**: Node 24 (alcanza con Node 22 o posterior), PowerShell 7 y `tar` (viene con Windows 10 y posteriores). Git y Python
  no hacen falta. Por WSL, lo mismo que en Mac y Linux, dentro de WSL.
- **En Mac y Linux**: Bash, Python 3, `tar`, `curl` y Node 24 (alcanza con Node 22 o posterior; probado en 22 y 24). Git no hace falta.
- **Node 20**: 20 se tolera sólo para actualizar una instalación existente; no se prueba.
- **Los revisores para tu tecnología** que trae tu equipo pueden pedir más (los de .NET, el SDK de .NET de tu plugin):
  lo dice cada paquete.

La lista exacta para Mac y Linux:

<!-- requirements -->
```text
bash
python3
tar
curl
node >= 22
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
ahí, no en la 5.1 que viene con el sistema. Comprobá que `node --version` diga Node 24 (o 22) y que `tar --version` conteste
(el sistema lo trae desde 2018). No hay nada más con que iniciar sesión: el arnés nunca abre un navegador.

**En Mac**, instalá lo que te falte con Homebrew (https://brew.sh):

```bash
brew install node python
```

**En Linux**, lo mismo con el gestor de paquetes de tu distribución. Comprobá que `node --version` diga Node 24 (o 22).

### 2. Bajar e instalar

La entrada principal es una sola línea, igual en Windows nativo, Mac, Linux y WSL. Revisa los requisitos, baja la versión publicada
del arnés a una carpeta temporal y corre su `harness.js install`, que te muestra el plan y te pregunta si sigue. Las
opciones de `install` van después del nombre: `npx @tyconsa/harness@latest <opciones>`.

```bash
npx @tyconsa/harness@latest
```

**A mano, sin npm.** Abrí una terminal en cualquier carpeta y pegá las líneas de tu sistema, una por una: las de `bash` en Mac, Linux y WSL;
las de `powershell` en Windows nativo. La primera baja el guion de instalación de la dirección pública de archivos de
GitHub (`raw.githubusercontent.com`), sin credencial y sin pasar por la API; la segunda lo muestra, para que leas lo
que vas a correr; la tercera lo corre. El guion revisa los requisitos, baja la versión publicada como archivos (sin
git, sin clon) a una carpeta temporal y sigue con `harness.js install --version latest` en la misma terminal. Son
tres líneas a propósito: una bajada con tubería directa a un shell la bloquea el freno de comandos (`SUP-C1`). El guion
nunca instala paquetes del sistema ni usa `sudo`. Las opciones de `install` van después de `--`:
`bash get-harness.sh -- <opciones>`.

<!-- install:core -->
```bash
curl -fsSL -o get-harness.sh https://raw.githubusercontent.com/TYCON-SA/tycon-harness/main/scripts/setup/get-harness.sh
less get-harness.sh
bash get-harness.sh
```

```powershell
Invoke-WebRequest -OutFile get-harness.ps1 https://raw.githubusercontent.com/TYCON-SA/tycon-harness/main/scripts/setup/get-harness.ps1
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
línea, la que baja el guion, nunca lleva credencial y no pasa por la API: no gasta de ese límite.

`install` no escribe nada sin avisarte antes: hace tres preguntas, después muestra el plan y pregunta «¿Instalo?». Para ver
sólo el plan, sin instalar, agregá `--dry-run`.

### Qué contestar

Las preguntas están en castellano, y usan sus propias palabras: «perfil» es la instalación mínima o completa,
las integraciones son las conexiones opcionales y «paquete del stack» son los revisores para tu tecnología. Para «sí»
vale `s` o `y`.

1. **«¿Qué perfil instalo?»** Contestá `1` (`minimal`, la instalación mínima) o `2` (`full`, la completa): no hay uno
   por defecto.
   - `minimal`: las guías, los revisores y el recorrido de las historias, sin cambiar cómo te contesta el agente.
   - `full`: suma los frenos (en un repo con historias, editar código va por el recorrido) y hace que el agente
     conteste corto y en castellano en todos tus proyectos, no sólo donde uses el arnés.
2. **«¿Qué integraciones prendo?»** Son las conexiones opcionales con servicios externos, como Azure DevOps o Clockify.
   Enter no prende ninguna; se prenden después (ver «Qué es opcional»).
3. **«¿Usás el paquete del stack en todos tus repos?»** Son los revisores para tu tecnología que trae el repo de tu
   equipo (TYCON trae los suyos para plugins de BIZUIT). Sin equipo, o si no todos tus repos son de esa tecnología,
   `n`, y cada repo lo pide después.

Después de las tres preguntas, **el plan y «¿Instalo? [s/N]»** muestra qué archivos toca, qué cambia en cómo trabaja
tu agente, qué corre solo, a qué sale a la red y qué guarda en disco. Leelo y contestá `s`.

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

Con la instalación completa (`full`), si git no tiene `core.hooksPath` global, `install` (y `apply`) la configuran en `~/.git-hooks/`, la carpeta
de los hooks de git del arnés; el plan lo dice antes de tu «sí». Si ya tenés otra, no la tocan: avisan, con el comando
para apuntarla. Qué cambia con esa clave está en «Qué escribe en tu máquina».

### Otras formas de instalar (opcionales)

**Sin nadie delante** (un contenedor, una tarea programada): la misma línea, con la instalación (`--profile`) y `--yes`.

```bash
npx @tyconsa/harness@latest --profile minimal --yes
```

Ojo con dónde va el `--yes`. Escrito antes del nombre del paquete es de npm: acepta bajar el paquete sin preguntar, y
no toca el plan. Escrito después del nombre, como arriba, es nuestro: acepta el plan de instalación sin que nadie lo
vea. Sin terminal npm baja el paquete igual, así que el de npm no hace falta.

A mano, sin npm:

<!-- install:unattended -->
```bash
curl -fsSL -o get-harness.sh https://raw.githubusercontent.com/TYCON-SA/tycon-harness/main/scripts/setup/get-harness.sh
less get-harness.sh
bash get-harness.sh -- --profile minimal --yes
```

```powershell
Invoke-WebRequest -OutFile get-harness.ps1 https://raw.githubusercontent.com/TYCON-SA/tycon-harness/main/scripts/setup/get-harness.ps1
Get-Content get-harness.ps1
pwsh -File get-harness.ps1 -- --profile minimal --yes
```
<!-- /install:unattended -->

Con `--yes` se acepta el plan sin que nadie lo vea: conviene mirarlo antes con `--dry-run`. `--yes` no elige la instalación:
el bloque instala el mínimo, o `--profile full` para el arnés completo. Sin terminal el guion no pregunta nada. Donde
muchas máquinas comparten una dirección, como un agente de compilación, el límite de arriba se alcanza seguido.
`TYCON_GITHUB_TOKEN`, puesto como arriba, cubre lo que piden el guion y la instalación. La línea que baja el guion va
sin credencial igual y no pasa por la API: no gasta de ese límite, y el 403 de la API no la frena.

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

## Con sitio o sin sitio

**El arnés funciona entero sin sitio.** El [sitio del equipo](../guides/organization-site.md) es opcional: una
página para ver las corridas de todas las máquinas y cambiar la configuración desde formularios. La configuración vive
siempre en archivos de repos, y hay dos caminos para cambiarla:

- **Sin sitio:** editás el archivo en tu clon del repo que corresponde y lo subís con un pedido de cambio (pull
  request). `harness.js team-config` abre una página en tu máquina, de sólo lectura y sin internet, que muestra cómo
  está y los problemas que ven los lectores del arnés.
- **Con sitio:** la pestaña Configuración valida el cambio con esos mismos lectores y abre el pedido de cambio por vos.
  Nunca escribe `main`: el cambio entra cuando alguien lo aprueba, o solo, si la organización lo eligió para los
  cambios de un admin.

### Qué necesita cada uno

| Si sos… | Necesitás | No necesitás |
|---|---|---|
| Un dev solo, sin sitio | la instalación en tu máquina | repos de la organización ni cuenta en GitHub o Azure DevOps |
| Un dev solo, con sitio | la instalación, un repo del equipo y uno de operaciones (una organización de uno), y el sitio con su inicio de sesión; el historial compartido de corridas, si querés ver tus corridas ahí | los procesos de la noche, salvo que quieras el aviso de la mañana y el tablero |
| El admin de un equipo, sin sitio | la instalación y el repo del equipo, con lectura para el equipo; el repo de operaciones, si quieren los procesos de la noche | el sitio |
| El admin de un equipo, con sitio | lo anterior, el repo de operaciones con `site.access` (quién entra al sitio), el sitio y, para ver las corridas de todos, el historial compartido de corridas | — |
| Un dev de un equipo ya armado | la instalación con `--team <repo del equipo>` y permiso de lectura sobre ese repo | nada más: lo del equipo llega con cada actualización |

### Dónde vive cada configuración

| Dónde | Qué guarda | Cómo se cambia |
|---|---|---|
| Tu máquina: `~/.claude/tycon.json`, las variables `TYCON_…` y `~/.tycon/config.json` | lo personal (rutas, el chat de Telegram, los permisos de lectura) y tus preferencias (conexiones opcionales, canal y política de actualización, instalación mínima o completa, cómo contesta el agente) | lo cambiás vos, sin pedido; nunca se versiona |
| El repo del equipo: `team-profile.json`, `team-repos.json`, `skills/` y `packs/` | lo que vale para todas las máquinas: conexiones opcionales, actualización, instalación mínima o completa, revisores para la tecnología del equipo, cómo contesta el agente, dónde vive cada repo, qué modelo usa cada trabajo | un pedido de cambio, a mano o desde el sitio; llega a cada máquina con su próxima actualización |
| El repo de operaciones: `operations.json` | a quién se asignan los avisos de la noche, quién revisa, el canal del aviso de la mañana, quién entra al sitio | un pedido de cambio, a mano o desde el sitio; lo leen la noche y el sitio, nunca las máquinas |
| El sitio | ninguna configuración propia: lee los dos repos y propone los cambios | — |

**Qué puede pisar tu máquina.** Para casi todo, el orden es variable `TYCON_…` › `~/.claude/tycon.json` › repo del
equipo (`team-profile.json`). Así, tu máquina puede apagar para ella sola una conexión que el equipo prende, o quedarse
en `ask` aunque el equipo diga `auto`. Dos claves son del equipo cuando su `team-profile.json` las declara: en
`packs.default` el equipo le gana a tu archivo y sólo `TYCON_PACKS_DEFAULT` lo pisa; `adversarial.model_question` no
la pisa ninguna máquina. Lo personal no puede ir en el repo del equipo: el lector lo rechaza. Lo de `team-repos.json` y `operations.json` no se pisa desde una máquina,
salvo el umbral de cobertura de las pruebas. `tycon-config.js explain` dice de dónde salió
cada valor, y qué quedó escrito en tu archivo sin usarse.

### Configurar tu máquina sin sitio ni equipo

Un dev solo no necesita repos ni sitio: su configuración vive en `~/.claude/tycon.json`, y `tycon-config.js` la lee y la
escribe.

```bash
node ~/.claude/tycon-harness/scripts/lib/tycon-config.js explain
node ~/.claude/tycon-harness/scripts/lib/tycon-config.js set integrations.engram true
node ~/.claude/tycon-harness/scripts/lib/tycon-config.js set response.style executive
node ~/.claude/tycon-harness/scripts/setup/harness.js channel stable
```

`explain` muestra cada valor y de dónde salió. `set` valida la clave y el valor antes de escribir, y dice que se aplica
en el próximo arranque o ya con `harness.js apply`. Los permisos de lectura no van en ese archivo:
`harness.js config set github.token` los pide sin mostrarlos y los guarda en `~/.tycon/config.json`. Las conexiones opcionales
están en «Qué es opcional»; la instalación mínima o completa, en su sección; el canal y la política, en «Cómo se
actualiza».

## Dar de alta tu organización

Para que todo tu equipo instale con la misma configuración, la organización necesita su **repo del equipo**: un repo
propio, que sólo lee tu equipo, con tres archivos. `harness.js team-init` los arma por vos. Corre en una máquina con el arnés ya
instalado (sin arnés sale 2: «instalá primero»), porque valida con los lectores de la versión instalada.

```bash
node $HOME/.tycon/harness/scripts/setup/harness.js team-init
```

Te pregunta lo que no le pasaste por opción: el nombre de la organización (`--name`, letras sin tilde, números, punto
y guion), dónde vive el repo del equipo (`--platform github|azure` y `--profile-repo`, `org/repo` de GitHub o
`https://dev.azure.com/<org>/<proyecto>/_git/<repo>`) y la carpeta donde dejar los archivos (`--dir`; por defecto
`~/<repo>`; una carpeta con algo adentro no se toca). Baja el ejemplo publicado (`harness-team-profile-example`) y
escribe sólo los tres archivos obligatorios:

- `team-layer.json` — el nombre y la versión mínima del arnés (la que tenés instalada).
- `team-profile.json` — la configuración del equipo, con la instalación mínima (`minimal`) y las actualizaciones que
  cada persona confirma; el bloque `ado` sólo si el repo vive en Azure DevOps.
- `team-repos.json` — dónde vive cada repo: el arnés público, el repo del equipo y el de las operaciones de la noche.

Si algo no valida, lo dice con el archivo y el campo y no escribe nada. `--dry-run` muestra los tres archivos sin
escribir. Después te dice qué sigue: crear el repo **vacío**, que sólo lea tu equipo (el alta no crea repos ni pide permisos de
escritura), subir los archivos (si tenés git te ofrece hacerlo; si no, te da los dos comandos), instalar esta máquina
con el repo del equipo (`harness.js install --team <repo>`) y la línea para el resto del equipo. Los procesos de la noche y la
página `harness.js team-config` son el paso siguiente, aparte.

**Si trabajás solo**, `harness.js team-init --local --name <nombre>` arma el perfil de una persona en esta máquina, sin
dirección ni cuenta: la declaración y el perfil (sin `team-repos.json`), en `~/<nombre>-profile`, con git y un commit en
`main`. El arnés lo lee de esa carpeta (`harness.js install --team <carpeta>`), sólo lo commiteado en `main`. Ahí van tus
paquetes de revisores, que así sobreviven a las actualizaciones (`guides/reviewer-packs.md`, «Si trabajás solo»). Mientras
viva sólo en tu máquina, `doctor` avisa que no tiene copia de respaldo; para tenerla, subilo a GitHub o a Azure DevOps y
volvé a instalar con `--team <dirección>`.

## Instalación mínima o completa

Hay dos, `minimal` y `full`, y no hay una por defecto: `install` te pregunta si no elegís; sin terminal, pasá `--profile`.

- **`minimal`**: las guías, las skills, los revisores, el recorrido de las historias y el aviso de versión nueva. No
  cambia cómo contesta el asistente. Registra ocho hooks (seis que sólo anotan, el freno de comandos destructivos y el de editar código sin
  historia ni ajuste puntual),
  más los de cada conexión opcional que prendas, y trae los enlaces, los comandos y las skills de terceros.
- **`full`**: todo lo de `minimal`, y además los otros frenos (el mismo portón para el código que se escribe por la
  terminal, y el de commitear una historia sin la evidencia que pide), los tres bloques que cambian cómo contesta el asistente en todos tus proyectos (en castellano, con la
  conclusión primero y un tope de largo), los dos ajustes de `settings.json`, los hooks de git y las tareas de fondo.

Se elige con `--profile minimal` o `--profile full`, con `install.profile` en `~/.claude/tycon.json` o con la variable
`TYCON_INSTALL_PROFILE`. Pasar de una a otra quita o repone lo que corresponde, con una copia de respaldo antes. En
`minimal`, los otros frenos se prenden con su variable en `1` (`TYCON_TEST_SCOPE_GUARD=1`), y el de comandos
destructivos se apaga sólo con `TYCON_SAFETY_GUARD=0`.

## Qué cambia la instalación completa

La instalación completa (`full`) cambia cosas en todos tus proyectos, no sólo en uno. Es la que deja la instalación
guiada con Claude Code; con la línea npx, la elegís vos.

- Tu agente te contesta en castellano, corto y con la conclusión primero.
- En un repo que trabaja con historias, el agente no edita código sin pasar por el recorrido del arnés.
- Git pasa a usar una carpeta global para sus controles al commitear (`core.hooksPath`). Desde ahí, git deja de llamar
  a los controles propios de cada repo, los de `.git/hooks/`: el arnés corre en su lugar los `pre-commit`, `post-commit`
  y `pre-push` de esa carpeta (los de otro nombre, como `commit-msg`, no corren). La instalación la configura sólo si git
  no tiene ninguna, y el plan te lo dice antes de tu «sí»; si ya tenés otra, no la toca.
- Una vez por día lee el historial de git de tus repos de proyectos (encuentra su carpeta por dónde usás tu agente).
  Lo que anota queda en tu máquina.
- Claude Code guarda tus conversaciones un año.

Si no querés esto, elegí la instalación mínima (`minimal`): trae las guías, los revisores y el recorrido de las
historias, suma a tu agente el índice de guías en cada sesión, y no toca git ni las reglas de cómo te contesta. Deja un
solo freno: el de comandos destructivos. Para sacar el arnés, `harness.js uninstall --dry-run` muestra qué quitaría, y
`harness.js uninstall --yes` lo quita.

## Revisores para tu tecnología

El núcleo no los trae. Son lo que una organización suma para su tecnología —revisores, skills, guías y plantillas—, en
un paquete: `packs/<nombre>/` con su `pack.json`. Viven en el repo de tu equipo y llegan a tu máquina con cada
actualización, sin hacer nada.

**Los activa tu organización**: `packs.default` en el repo del equipo (o en la pestaña Configuración del sitio,
sección Paquetes). Vale `all`, `none` o una lista de nombres. Tu máquina puede fijar otro valor (`TYCON_PACKS_DEFAULT`,
o `packs.default` en `~/.claude/tycon.json`) si el equipo no lo fija. Un repo de producto puede achicar esa lista con
`packs:` en su `.tycon/advisors.yaml`, no sumar.

Un repo que pide un paquete que tu máquina no tiene frena el recorrido (exit 2) con este mensaje (la ruta del final es
la de tu máquina):

```text
el repo declara el paquete «<nombre>» en `packs:` y no está instalado en …
```

Si lo ves, el paquete no llegó con lo de tu equipo: actualizá con
`node ~/.claude/tycon-harness/scripts/setup/harness.js update`, y si sigue, preguntale al admin de tu equipo.

## Qué es opcional

Las conexiones opcionales (en la configuración, `integrations`), todas **apagadas** por defecto. Cada una se prende
con una clave en `~/.claude/tycon.json` o con su variable; `node ~/.claude/tycon-harness/scripts/lib/tycon-config.js
explain` muestra cada valor y de dónde salió.

| Conexión | Qué hace | Cómo se prende |
|---|---|---|
| `ado` | Azure DevOps: work items de las historias, controles de pedidos de cambio y de procesos (pipelines) | `ado.org` en `~/.claude/tycon.json`, o `TYCON_ADO_ORG` |
| `clockify` | los hooks de registro de horas en Clockify | `integrations.clockify: true`, o `TYCON_CLOCKIFY=1` |
| `engram` | la memoria persistente de engram: sincroniza en cada commit y la revisa una vez por día | `integrations.engram: true`, o `TYCON_ENGRAM=1` |
| `codegraph` | el índice de código de CodeGraph para los agentes (informativa: CodeGraph lo instalás vos) | `integrations.codegraph: true`, o `TYCON_CODEGRAPH=1` |
| `mailbox` | sube los registros de cada corrida al historial compartido de corridas de tu organización; hace falta que la organización lo tenga armado (hoy, un almacenamiento de Azure) | `integrations.mailbox: true`, o `TYCON_MAILBOX=1` (su llave en `TYCON_MAILBOX_JSON`) |
| `codex` | despliega el lado Codex | `integrations.codex: true` o `"detect"`, o `TYCON_CODEX=1` |
| `claude` | enchufa Claude Code (hooks, ajustes, el import del índice) | `integrations.claude: true` o `"detect"`, o `TYCON_CLAUDE=1` |
| `nightly` | los avisos de los procesos de la noche de tu organización (tablero, dependencias, retrospectivas), que corren desde su repo de operaciones: ver [Para equipos](../README.es.md#para-equipos) | `integrations.nightly: true`, o `TYCON_NIGHTLY=1` |
| `instincts` | la grabadora de instintos: una línea saneada por cada herramienta usada, para encontrar lo que el equipo repite; la prende el perfil del equipo | `integrations.instincts: true` en el perfil del equipo, o `TYCON_INSTINCTS=1` para probarla en una máquina (`TYCON_INSTINCTS=0` la apaga) |
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
  medición). Eso es con el estilo ejecutivo: el idioma, el estilo y el tope los elige la organización en su repo del equipo
  (`response`); sin elegir, el asistente contesta claro y al punto, con un tope de 2000.
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
  filtro para `npm test`, Vitest y `dotnet test` (`TYCON_TEST_SCOPE_GUARD=0`), y el que frena un pedido de cambio a `main`
  armado con `az` sin sus banderas (`TYCON_PR_AUTO_COMPLETE_GUARD=0`).
- En un repo que trabaja con el arnés —tiene carpeta `.tycon/`, o historias creadas con la skill, o el recorrido ya corrió
  ahí—: el portón que deniega editar código sin el recorrido, el que deniega el commit de una historia sin evidencia, y los que
  frenan el cierre del turno después de un push a `main` sin métricas o con trabajo sin subir.

La tabla completa, con qué hace cada hook, si frena y su interruptor, está en
[INSTALL.md](../INSTALL.md#los-hooks-que-instala).

**Qué hace solo**: al abrir una sesión, la línea de arranque mira si tu canal tiene una versión nueva, como mucho una
vez cada 6 horas. Si la hay, avisa y espera: no la aplica sin que se lo pidas desde una terminal
(`node ~/.claude/tycon-harness/scripts/setup/harness.js update --yes`). Después corre el instalador.
`TYCON_UPDATE=0` apaga la consulta; `TYCON_UPDATE_CHANNEL` y `TYCON_UPDATE_APPLY` fijan el canal y la política.

- En cada arranque, de fondo: corre unas pruebas rápidas del propio arnés, y relee las conversaciones del recorrido que
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
- **Hooks globales de git** en `~/.git-hooks/` (`TYCON_NO_GIT_HOOKS=1` los saltea). git sólo los usa con
  `core.hooksPath` global: si git no tiene ninguna, `install`, `apply` y el arranque (con la aplicación `auto`; con `ask`, el
  aviso la pide y la pone `update --yes`) la apuntan a esa carpeta (una que ya tengas no
  la tocan), y `uninstall` o el paso a la instalación mínima la sacan si sigue siendo ésa. Con un `core.hooksPath` global git
  deja de llamar a los `.git/hooks/` de tus repos: el hook del arnés corre en su lugar el `.git/hooks/` y el `.githooks/`
  de cada repo para `pre-commit`, `post-commit` y `pre-push` (los de otro nombre no corren). La primera vez que corre
  uno lo dice, con la manera de dejarlo como estaba: borrarlo o sacarle el permiso de ejecución.
- **Skills de terceros** bajadas de su origen a la carpeta `skills/` del clon: las que lista
  `scripts/publishing/third-party-skills.json`, cada una fijada a un commit (`TYCON_THIRD_PARTY=0` saltea el paso).
- **Los archivos del propio mecanismo de instalación**: su estado y su copia fija de arranque en
  `~/.claude/.tycon-pipeline/`, la línea de arranque en `~/.claude/settings.json`, y una copia de respaldo antes de cada
  cambio en `~/.claude/.tycon-pipeline/harness/backups/`: quedan las cinco más nuevas, la de antes de instalar —que no
  rota— y la anterior a la versión actual. `harness.js rollback --list` las muestra.
- **El Node 24 propio del arnés** en `~/.tycon/node/` (unos 50 MB, bajado de nodejs.org y verificado contra las
  huellas que viajan en el arnés): sus hooks corren con él, tus proyectos siguen con tu Node y el PATH no se toca.
  `TYCON_HARNESS_NODE=0` lo apaga; `uninstall` deja la carpeta y dice cómo borrarla.
- **Lo que guardan los hooks**, todo en tu máquina: los últimos 8 pedidos de cada sesión y el estado del recorrido en
  `~/.claude/.tycon-pipeline/`, las respuestas que pasaron el tope de largo en `~/.claude/response-style/`, lo que
  anotan los otros dos medidores en `~/.claude/blocking-meter/` y `~/.claude/lectura-grande/` (la carpeta de trabajo de
  cada turno y los archivos leídos enteros), los comandos bloqueados en `~/.claude/safety-guard.log` y, de cada corrida, sus tiempos y una copia
  comprimida de la conversación —pedidos, rutas y código incluidos— en `~/.claude/.tycon-pipeline/timing-history/`,
  que no se borra sola.

**Con el lado Codex prendido** (viene apagado: `integrations.codex: true` o `"detect"`, o `TYCON_CODEX=1`), el
instalador escribe además bajo `~/.codex/`, sin pisar lo tuyo: `AGENTS.md` (el espejo de las reglas de
`~/.claude/CLAUDE.md`: los mismos bloques cambian cómo contesta Codex), `hooks.json` (los mismos hooks), la sección
`[mcp_servers]` y los `writable_roots` de `config.toml` (los servidores MCP que ya tenés registrados en Claude Code;
los secretos nunca van al archivo), los archivos `<nombre>.config.toml` y `agents/<nombre>.toml` de los revisores, y
enlaces en `skills/`. En Mac deja un agente de inicio de sesión (`ar.com.tycon.harness-env`) que publica la llave y los
secretos MCP para las aplicaciones gráficas (`TYCON_NO_GUI_ENV=1` lo saltea). Una vez por día corre de fondo una prueba
dentro de Codex, que gasta sesiones de modelo (`TYCON_BENCH_DAILY=0`). Con Azure DevOps configurado, deja además un
`AGENTS.md` de una línea en los repos de tu equipo que tienen `CLAUDE.md` y no tienen `AGENTS.md`; se commitea con el
repo (`TYCON_NO_AGENTSMD_POINTER=1` lo saltea). Queda un paso a mano: abrir una sesión de `codex`, correr `/hooks` y aprobarlos; sin eso los hooks no corren y no
dan error.

**La red**: el arnés no manda datos de uso. De fábrica habla con GitHub —el repo, para mirar si hay versión nueva, y
los orígenes de las skills de terceros que lista `scripts/publishing/third-party-skills.json`— y, si alguno de tus
repos vecinos es un clon parcial, con el remoto de ese repo, para leer su historial (el barrido diario). La consulta
corta al modelo de tu asistente va por el asistente que ya usás. Cada conexión opcional que prendas suma su servicio: con
Telegram, una corrida que queda esperándote más de cinco minutos te manda un mensaje con la historia, el paso y
qué espera (`TYCON_WAIT_NOTICE=0` lo apaga). La
prueba en máquina limpia de este repo, si la corrés, baja además las imágenes base (Docker Hub y el registro de
Microsoft); git, Python y los certificados (el repositorio de paquetes de Debian); el plugin de ejemplo y las skills de
terceros (GitHub); y los paquetes del plugin (NuGet).

**Dónde se pone un interruptor**: una variable `TYCON_…` se exporta en el shell desde el que abrís Claude Code y,
además, se escribe en `env` de `~/.claude/settings.json`. Conviene en los dos lugares: la extensión de VS Code puede no
ver lo que exportás en el archivo de arranque de tu shell, y `harness.js` corrido desde una terminal no lee `env`. Los
interruptores que apagan algo que el instalador registra valen desde la sesión siguiente. En `~/.claude/tycon.json`
van las conexiones opcionales, la política de actualización y los paquetes, no esas variables.

**Quitarlo**: `harness.js uninstall` quita sólo lo que el mecanismo registró. Deja el clon, `~/.claude/tycon.json`, las
copias de respaldo y la carpeta de estado `~/.claude/.tycon-pipeline/`, las skills de terceros ya bajadas y lo que
guardaron los hooks (`~/.claude/response-style/`, `~/.claude/blocking-meter/`, `~/.claude/lectura-grande/` y
`~/.claude/safety-guard.log`); lo lista al correr. Quita también
`cleanupPeriodDays: 365` si sigue con ese valor: Claude Code vuelve a su retención de fábrica y borra las
conversaciones más viejas; para conservarlas, dejá esa clave escrita a mano antes de desinstalar.

## El repo del producto

El recorrido corre sobre el repo de tu producto. Dos archivos opcionales lo configuran:

- `.tycon/advisors.yaml`: lo que los revisores necesitan saber del repo, y `packs:` para pedir un paquete.
- `_bmad/bmm/config.yaml` (con `_bmad/core/config.yaml`): la configuración que leen las skills `bmad-*`. Es opcional:
  sin ella, la skill pregunta tu nombre, el idioma y la carpeta de salida. Hoy esas respuestas no quedan guardadas: si
  querés fijarlas, pedile a tu agente que escriba esos dos archivos, y commiteá `_bmad/` con el repo.

**Qué pone un repo bajo el arnés**: la carpeta `.tycon/`, y también la primera historia (un `.md` con `story:` y `status:`
en su encabezado) o la carpeta `.advisors/` que deja el recorrido. Desde ahí, editar código sin un recorrido abierto ni un
carril «ad-hoc» declarado se deniega, y un push a `main` frena el cierre del turno, hasta tres veces, mientras no exista
su archivo de métricas (`TYCON_RETRO_PENDING=0` lo apaga). El comando de más arriba que pide el paquete crea la carpeta
`.tycon/`. Dos apagados del portón de edición: `TYCON_STORY_GATE=off` en tu ambiente (el agente no puede ponerla en la
sesión en curso), y `pipeline.story_gate: false` en `.tycon/advisors.yaml`, commiteado, para ese repo.

**La prueba con navegador**: cuando una historia cambia una pantalla y el repo todavía no tiene cómo probar en un
navegador, el arnés te ofrece prepararla. Con tu sí instala Playwright en el repo (como herramienta de desarrollo) y su
navegador, y escribe `playwright.config.ts`, una primera prueba en `tests/e2e/` y el bloque `e2e:` de
`.tycon/advisors.yaml`. Para volver atrás, pedile a tu agente «deshacé la preparación de la prueba con navegador»; a mano
es `node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/e2e-setup.js undo --repo <repo>`. Borra sólo lo que nadie
cambió y no borra el navegador, que comparten tus otros proyectos. Con tu no, la historia queda con la prueba pendiente,
a la vista, y la próxima historia con pantalla te la vuelve a ofrecer.

## Sin red

Sin red, la instalación igual termina (exit 0). El paso de terceros dice en una línea que no pudo preguntar a los
orígenes, y el control de presencia nombra las skills de terceros que faltan. Al abrir cada sesión, `harness.js startup`
dice «sin red» y sigue, en 35 segundos como mucho.

Para reintentar, con red: `node ~/.claude/tycon-harness/scripts/setup/harness.js apply` vuelve a correr el
instalador. Sirve también si, con red, quedaron skills pendientes porque el paso llegó a su tope de red
(`TYCON_THIRD_PARTY_NETWORK_BUDGET_S`, 20 segundos por corrida).

## Con un proxy o la CA de tu empresa

El instalador (`npx @tyconsa/harness@latest`, `get-harness` y el propio `harness.js`) pasa por un proxy con las variables
de siempre, en la terminal donde lo corrés:

```bash
export HTTPS_PROXY=http://proxy.example.com:8080
export NO_PROXY=localhost,.example.com
```

`HTTPS_PROXY` (o `HTTP_PROXY`, también en minúsculas) es el proxy; `NO_PROXY` es una lista separada por comas de hosts o
sufijos `.dominio` que van directo. npx pasa además las de npm (`npm_config_https_proxy`, `npm_config_proxy`), y npm
mismo las necesita para bajar el paquete. Si tu empresa inspecciona HTTPS con un certificado propio, decíselo a Node
antes de correr la línea: `export NODE_EXTRA_CA_CERTS=/ruta/a/la-ca-de-la-empresa.pem`. Sin eso el instalador frena con
«no pude verificar el certificado» y nombra `NODE_EXTRA_CA_CERTS`; nunca apaga la verificación. En PowerShell, lo mismo con
`$env:HTTPS_PROXY = '…'`, `$env:NO_PROXY = '…'` y `$env:NODE_EXTRA_CA_CERTS = '…'`.

## Desinstalar

```bash
node ~/.claude/tycon-harness/scripts/setup/harness.js uninstall --dry-run
node ~/.claude/tycon-harness/scripts/setup/harness.js uninstall --yes
```

La primera muestra qué quitaría, sin cambiar nada. La segunda quita sólo lo que registró el instalador (hooks, enlaces,
bloques, tareas de fondo) y dice lo que deja: tu `~/.claude/tycon.json`, tus repos y todo lo tuyo quedan como estaban.
`--tool claude` o `--tool codex` desenchufa sólo esa herramienta y deja el arnés.

## Cómo se actualiza

- **Versiones**: cada versión lleva un número `AAAA.MM.DD.N`, donde `N` es su orden dentro del día. `stable` es `main` de
  este repo, que sólo cambia por un pedido de cambio revisado. `latest` leería una rama de prueba si este repo la tuviera;
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

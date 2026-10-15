# Producción con permiso

**Cada consulta a una base de producción se aprueba de a una, y la contraseña no pasa por la
conversación.** Esta guía es para el dev que la usa, y para el que quiera entender por qué está.

## Por qué existe

Un permiso dado para una tarea no vale para la siguiente. Sin un freno, **el asistente puede seguir
consultando producción en el turno siguiente sin pedir permiso**, y hasta **abrir una regla de
firewall en el servidor de producción**. Que sean lecturas no cambia nada: una regla
—"cada sentencia se aprueba"— escrita en la memoria del asistente no alcanza.

Dos causas, y las dos se arreglan con lo mismo:

1. **La regla vivía en la memoria.** Un control que hay que acordarse de invocar es un control que
   no corre.
2. **La contraseña estaba a mano.** Con la llave disponible, ningún freno que lea el texto de un
   comando es una frontera: un script o una variable pasan por al lado.

## Cómo funciona, en una línea cada cosa

- **Una sola puerta**: `/opt/tycon/bin/tycon-prod-sql <host> 'select …'`. Es lo único que consulta
  producción, y **abre el cuadro de aprobación**: vos leés la sentencia antes de que corra.
- **Un freno** prohíbe todo otro camino a esa base: `sqlcmd` directo, `az sql`, una cadena de
  conexión, leer la clave del Llavero, escribir el catálogo, o invocar la puerta de cualquier forma
  que no sea la canónica.
- **Un catálogo por proyecto** (`<repo>/.tycon/production.json`) dice qué servidores son de
  producción. **Lo que nadie declaró se trata como producción**, así que un servidor nuevo se frena
  hasta que alguien lo declare.
- **El freno vive en la configuración administrada de root**, que es lo único que resiste a
  `disableAllHooks`, a otra sesión y a la herramienta Monitor. No tiene variable que lo apague.

## Instalarlo (una vez por máquina, sólo quien toca producción)

```bash
open ~/.claude/tycon-harness/scripts/production/install-guard.command
```

Pide tu contraseña del Mac una vez y cierra la caché al terminar. **Los hooks nuevos quedan activos
en la sesión SIGUIENTE** de Claude Code.

El orden al sumar a alguien es **primero el freno, después la clave**: una máquina con la clave y
sin el freno es el estado peligroso (y el aviso de arranque lo grita).

### Los nombres en inglés

La carpeta es `scripts/production/`, el instalador es `install-guard.command` (el `.command` con su nombre de antes
sigue abriendo éste), el catálogo es `.tycon/production.json` con las claves `servers`,
`environment`, `keychain` y `port`, y el índice y la memoria son `production-index.json` y `production-memory.json`.
Los valores `produccion` y `no-produccion` **no** cambian.

Lo que corre de verdad es la copia de `/opt/tycon`, y ésa cambia sólo cuando cada persona **reinstala con su
contraseña**. Hasta que reinstalen todas las máquinas autorizadas:

- el arnés **escribe** el índice y la memoria con los dos nombres, y **lee** el catálogo y `~/.claude/tycon.json`
  (`paths` e `integrations`, o sus nombres en castellano) con los dos: la copia vieja sigue frenando igual, también un
  servidor declarado después del renombre;
- el freno protege los dos nombres de cada archivo, y el cuadro de aprobación los pide a los dos;
- **reclasificá (`--reclasificar`) o volvé a sellar la memoria (`--verificar`) recién después de reinstalar**: la puerta
  vieja sólo toca la memoria con el nombre viejo, y el arnés nuevo junta las dos, así que el servidor vuelve a quedar
  como producción en la sesión siguiente (el lado seguro: nunca baja producción sin querer);
- el aviso de arranque dice **«el freno quedó viejo: reinstalalo»** en cada máquina que todavía no lo hizo (nunca
  «alguien lo cambió»). Al reinstalar, el instalador trae solo el origen que ya habías aceptado y saca el archivo
  administrado viejo (queda un respaldo al lado).

Un catálogo nuevo conviene escribirlo con el nombre nuevo; los de los repos de producto se pasan con el
retiro de los nombres viejos. Tener los dos catálogos en el mismo repo es un error: el commit no se crea. La escritura doble se apaga en un
commit aparte, recién con todas las máquinas «al día».

## Cargar la clave (la primera vez)

No la tipeés en el chat, ni se la pases al asistente. Un comando te deja en el Escritorio un
`cargar-clave-<entrada>.command` y lo abre:

```bash
/opt/tycon/bin/tycon-prod-sql --cargar-clave <host>
```

Ahí cargás usuario y contraseña, y el archivo se borra solo. La entrada queda en un llavero propio
(`~/Library/Keychains/tycon-prod.keychain-db`) que confía **sólo** en la herramienta del sistema.
(Si te olvidás de este paso, la primera consulta hace lo mismo y sale sin consultar.)

## El día a día

```bash
# consultar producción (se abre el cuadro: leelo antes de aprobar)
/opt/tycon/bin/tycon-prod-sql acme-sql.database.windows.net 'select top 10 * from Articulos'

# más filas de las 50 por defecto
/opt/tycon/bin/tycon-prod-sql <host> 'select …' --max-filas 200

# revisar que la entrada del Llavero siga sana (no lee la contraseña)
/opt/tycon/bin/tycon-prod-sql --verificar

# un host que ya NO es producción (queda en el registro, y lo aprobás en el cuadro)
/opt/tycon/bin/tycon-prod-sql --reclasificar <host>
```

🔴 **En el cuadro: «Permitir», nunca «Permitir siempre».** El punto entero de esto es que cada
sentencia se mire. Y si te aparece un cuadro del Llavero **sin que vos hayas aprobado una sentencia
antes**, denegá: algo está leyendo la clave por otro camino.

La puerta trae **formato fijo** a propósito (junta el error con la salida, corta filas, imprime el
código de salida): así no hace falta agregarle `| head` ni `2>&1`, que la forma canónica no acepta.

## Declarar un servidor

En el repo que tiene las migraciones de esa base (`database/` o `BD/`), y **sólo** con estas
claves — el usuario de la base NO va acá, va junto a la contraseña en el Llavero:

```json
{
  "servers": [
    { "host": "acme-sql.database.windows.net", "environment": "produccion", "keychain": "tycon-prod-acme", "base": "acmebase" },
    { "host": "srv.globex.test", "environment": "produccion", "keychain": "tycon-prod-globex", "base": "GlobexDb", "port": 1435 },
    { "host": "acme-sql-staging.database.windows.net", "environment": "no-produccion" },
    { "host": "test.bizuit.example", "environment": "no-produccion" }
  ]
}
```

`port` va **sólo si el servidor no escucha en el 1433** — el caso típico es una instancia
nombrada de SQL Server en un puerto propio. Es un número, sin comillas, entre 1 y 65535, y la
puerta se lo pega al host al conectarse (`-S "host,puerto"`, que es lo que el cliente entiende
para una instancia nombrada). **El nombre de instancia con barra invertida no hace falta y sigue
rechazado**: con el puerto se llega igual.

🔴 **Por qué es un campo y no una coma dentro de `host`.** El host es la IDENTIDAD del servidor:
con él la puerta lo busca en este catálogo, arma el nombre del servicio en el Llavero, y el freno
lo reconoce cuando aparece en un comando. Si se admitiera `host,1435` ahí, el mismo servidor
tendría dos escrituras y la que importa para frenar —el nombre pelado— podría no estar declarada.
Con el puerto acá, **la persona sigue tipeando sólo el nombre**, y ninguna validación se aflojó
para que esto funcione. Vale desde el 2026-09-29.

`base` dice a qué base entra la puerta, y en Azure SQL **hace falta**: ahí no hay `USE` ni nombres
de tres partes, así que sin ella el cliente entra a `master` y toda tabla da «Invalid object name»
(medido contra un servidor real, con la clave ya bien). Es opcional para un servidor cuyo
usuario ya cae en la base correcta.

Un servidor de **no producción** se puede declarar en cualquier repo que lo use. El pre-commit
rechaza el archivo si tiene una clave de más, un ambiente que no existe, un `keychain` que no
empieza con `tycon-prod-`, una `base` con corchetes, comillas o espacios, o un `port` que no sea
un número entero en rango.

**Producción es pegajosa**: un host que alguna vez se vio como producción no vuelve a
no-producción por reescribir un archivo ni por borrar el índice. Lo único que lo baja es
`--reclasificar`, que pasa por el cuadro.

## Los límites, dichos antes

- 🔴 **La regla que pregunta por `az sql server firewall-rule` es de CORTESÍA**, no un freno: se
  esquiva partiendo una palabra en dos (`az sql ser''ver …`). Para producción y para lo desconocido
  el control es el **hook**, que corre antes que las reglas y no se esquiva así. No confíes en el
  cuadro del firewall como si fuera una barrera.
- **La contraseña de producción vive también en otras casas** que esto no toca: la configuración del
  App Service, `dotnet user-secrets`, y un `appsettings.Production.json` si alguien lo baja.
- **Un programa que se conecta por dentro** (Python con `pyodbc`, un `node` propio) no nombra el
  servidor: el freno no lo ve. La barrera ahí es que no tiene la clave.
- **Un hook propio del dev** corre como el usuario y puede llamar la puerta sin el cuadro.
- **Sin snapshot de shell, el freno le pregunta al shell de login en vivo** qué es cada nombre que
  podría quedarse con la puerta (desde el 2026-09-16: Claude Code 2.1.272 ya no escribe snapshot y
  corre cada comando como `zsh -c -l`). Un archivo de arranque que le mienta a esa pregunta
  (redefiniendo `builtin`, por ejemplo) la esquiva — el mismo límite que ya tenía el snapshot, que
  también lo producía ese shell. Lo que el freno sí exige es que `command`, `builtin` y `whence`
  sigan siendo builtins: si no, frena.
- **La caché de `sudo`** deja una ventana en la que borrar el freno no pide contraseña. El
  instalador corre `sudo -K` al terminar; si querés cerrarla más, bajá `timestamp_timeout`.
- **Actualizar el freno pide `sudo`**: hasta que lo corras, la máquina tiene la versión vieja — y el
  aviso de arranque te lo dice.
- **Codex** no lee la configuración administrada de Claude Code: de ese lado el freno también frena
  la puerta y te pide que la sentencia la corras vos. Lo que no cubre está declarado en
  `guides/codex-divergence-inventory.md`, no prometido.

Y cinco más, propios de leer los nombres como el shell:

- **Un nombre que un programa calcula sin que su texto esté a la vista no se ve.** Por ejemplo
  `rm $(cat lista)`, o un `while read` que borra lo que le llega por la tubería. La barrera ahí es que
  producción es pegajosa: borrar el índice no baja ningún servidor de producción.
- **Un guion escrito en un comando anterior y corrido después con un shell** (`bash /tmp/guion.sh`) se
  lee para buscar servidores, no escrituras. Cerrarlo queda para una story aparte.
- **Borrar o mover una carpeta que contiene a las protegidas desde más arriba** (`rm -rf ~/.claude`,
  mover un repo entero) no se frena. El freno protege sus archivos, no todo lo que los contiene.
- **Hasta que cada máquina reinstala, el freno instalado sigue con los agujeros.** Lo que corre es la
  copia de `/opt/tycon`, y cambia sólo al reinstalar con `sudo`. El aviso de arranque lo dice, también
  cuando cambia sólo una biblioteca que el freno usa.
- **Si el freno se cae, o node no corre, decide con su criterio de emergencia**, que sólo mira si el
  comando nombra bases o el Llavero. Ese criterio no reconoce la mayoría de estas formas, y el comando
  pasa. No se amplía: ampliarlo frenaba 11 de los últimos 4.000 comandos reales, que
  no tocaban nada.

## Antes de instalar en una máquina: medir cuánto frenaría

```bash
node ~/.claude/tycon-harness/scripts/production/measure-guard.js 4000
```

Pasa por el freno los últimos 4.000 comandos reales de esa máquina y cuenta cuántos frena, separando
los que nombran bases o el Llavero de los que **no**. **Umbral: 0 frenados que no nombran bases.** Si
da más, no se instala: es un falso positivo del freno y se arregla primero, porque un freno que frena
trabajo normal se termina apagando. No imprime ningún comando.

Medido el 2026-09-15: la primera versión, con todas sus pruebas en verde, frenaba
**313 de 4.000 (7,8 %)** comandos que no tocaban ninguna base; después del arreglo, **0**. Los que sí
frena son comandos que nombran servidores que la máquina todavía no tiene declarados — por eso, antes
de instalar, conviene declarar los servidores de prueba que se usan (por ejemplo `test.bizuit.example`).

## Cuando algo se frena y creés que no debería

El mensaje dice el motivo y el camino correcto. Los dos casos normales:

- **«no está declarado»** → es un servidor de prueba: declaralo en el `.tycon/production.json` del
  repo que lo usa.
- **«está declarado como producción»** → usá la puerta. Si de verdad dejó de serlo,
  `--reclasificar`.
- **«no encontré el snapshot de shell de esta sesión»** → esa máquina tiene el freno de antes del
  2026-09-16 instalado. Claude Code 2.1.272 (la extensión de VS Code) ya no escribe ese snapshot, y
  el freno de ahora, sin snapshot, le pregunta al shell de login en vivo. Corré el instalador
  (`scripts/production/install-guard.command`, pide `sudo`) y volvé a intentar.
- **«un nombre que el freno no sabe leer como el shell»** → el comando escribe en la carpeta protegida
  con una forma que el freno no puede decidir: un paréntesis sin cerrar, o un `setopt` antes. Si no
  querías tocar un archivo protegido, escribí los nombres enteros, sin llaves ni variables, y el freno
  los va a poder leer.

Si te frena algo que no tiene nada que ver con bases, **es un error nuestro**: decilo, porque un
freno que molesta sin motivo es el que alguien termina apagando.

## Para el que mantiene el arnés

- El freno: `scripts/hooks/prod-access-guard.js` · la puerta: `scripts/production/tycon-prod-sql`
- Aviso de arranque e índice: `scripts/hooks/produccion-notice.js` ·
  `scripts/production/production-index.js`
- Instalador: `scripts/production/install-guard.sh` (+ el `.command`) · configuración administrada:
  `scripts/production/managed-settings.tycon-production.json.template`. La organización del equipo sale
  de la configuración del arnés, que el asistente puede escribir: por eso la **primera
  instalación pide confirmar por teclado** el remoto del clon y la organización, y los deja fijados de
  root en `/opt/tycon/produccion/origen-de-confianza.json`; si después el remoto o la organización
  cambian, el instalador se niega y lo dice — si el cambio es tuyo, `--change-origin` (vuelve a
  preguntar por teclado). Un `tycon.json` o perfil ilegible lo frena nombrando el archivo, no como
  «sin organización».
- Desde una **versión bajada** (`~/.tycon/harness`, sin git), el instalador recalcula desde el disco cada archivo y el
  árbol, y le pregunta a GitHub si ese árbol es el del commit que registra el estado. Ese commit tiene que ser **de
  main**: la punta, o uno anterior cuyo freno (los archivos que se copian a `/opt`) sea byte a byte el de la punta. En
  ese caso instala y avisa «hay una versión más nueva; actualizá cuando puedas». Frena con un commit de una rama o un
  cambio local, con un freno que cambió en la punta (una versión vieja también verifica contra GitHub, y el asistente la
  puede bajar), y cuando GitHub no contesta o contesta un error, también el 403 del límite de consultas. Hasta el
  2026-10-14 exigía la punta exacta, y un día de 30 publicaciones no dejaba instalarlo.
- Contra qué compara el aviso de arranque: en un clon, contra lo publicado (`origin/main`) y su historia. En una
  máquina que corre una **versión bajada** (`~/.tycon/harness`, sin git), contra esa versión —su manifiesto— y contra
  la constancia que el instalador deja de root en `/opt/tycon/production/installed-files.json`: igual a la versión que
  corre, al día; distinto pero igual a la constancia, «quedó viejo»; distinto de las dos, «alguien lo cambió». Nunca
  contra el clon que la máquina mantiene, que no trae los mismos bytes que la versión que se baja. Un freno instalado
  antes de la constancia no la tiene: ante un desajuste dice «quedó viejo», y reinstalar la deja escrita.
- **La copia propia** (desde 2026-10-14): el freno no se instala con las bibliotecas compartidas del arnés (la raíz de
  repos, la configuración, dónde vive cada cosa…), que cambian casi todos los días por motivos ajenos al freno y hacían
  pedir la contraseña del Mac en cada versión. Se instala con su copia, `scripts/production/guard-libs/`, y el aviso
  compara sólo eso y las piezas del freno: un cambio en el resto del arnés ya no pide reinstalar. La copia se actualiza
  a conciencia: `node scripts/production/guard-libs-check.js` (lo corre `install-guard.test.sh`, T34) frena cuando una
  compartida cambió en algo que el freno usa y nadie lo decidió, dice qué difiere, y ofrece `refresh` (la copia pasa a
  ser la compartida; el freno cambia y cada máquina reinstala una vez) o `keep` (queda la copia; se anota que se miró).
  Lo que difiere sólo en lo que el freno no usa se dice y no frena. Un freno instalado antes de la copia propia pide
  reinstalar una sola vez más, y ese aviso lo explica.
- Red: `scripts/tests/prod-access-guard.test.sh`, `tycon-prod-sql.test.sh`, `install-guard.test.sh`
  y los casos `40-prod-access-guard.json` / `41-produccion-notice.json` del banco.
- Registro de ayuda: `~/.claude/.tycon-pipeline/production.log` (nunca la sentencia, sólo su huella).

## Lo que el freno NO deja pasar aunque esté escondido (desde 2026-09-15)

Un comando puede esconder lo que ejecuta: `bash -c '…'`, `eval`, `python3 -c '…'`, un cuerpo de
heredoc, o un guion que el mismo comando escribe y corre. El freno mira **también adentro de esos
textos** — si no, un `bash -c` lee la contraseña de producción del Llavero sin que nada frene.
Y cuando el comando nombra bases y esconde lo que corre de una forma que no se puede ver (por
ejemplo `bash -c "$CMD"`, con la variable definida en otro lado), **frena y lo dice**.

Lo que **no** se frena, a propósito, porque es trabajo de todos los días: buscar texto (`grep`,
`cat`, `echo`), preguntar si un cliente está instalado (`command -v sqlcmd`), listar servidores en
Azure sin nombrar ninguno, un `git merge` de rutina, o correr un guion del arnés que toca `.tycon/`.
Medido sobre 4.000 comandos reales del dev: **0 frenados que no nombran bases**. El medidor
(`node scripts/production/measure-guard.js`) cuenta aparte lo que **no pudo** medir —tiempo agotado o
freno caído— y sale ≠ 0 si hay falsos positivos o algo sin medir: «no lo pude medir» no es «pasó
limpio».

### Los nombres se leen como los lee el shell

Comparar el texto del comando con los nombres protegidos —el catálogo, el
índice y la memoria— no alcanza. El shell transforma cada palabra antes de correrla, y
`rm -f ~/.claude/.tycon-pipeline/production-{index,memory}.json` borraría los dos archivos sin que nada
frene. Por eso el freno arma cada nombre como lo va a armar el shell, y juzga el resultado:

- **Llaves y rangos**: listas, llaves anidadas, `{h..j}`, `{01..10}`, `{,.bak}` y llaves en una carpeta.
  Entre comillas, escapadas o con un solo elemento quedan literales, igual que en el shell.
- **Formas de zsh**: la alternancia `(index|memory)` se expande como las llaves; `(N)` al final se saca y
  `**/` vale como `*`. Los operadores de glob extendido (`^`, `~`, `@(…)`) vuelven comodín la palabra.
- **Opciones del shell**: un comando con `setopt`, `shopt`, `emulate` o `set -o` cambia cómo se leen los
  nombres, así que lo que nombra en la carpeta protegida se trata como dudoso. `set -euo pipefail` y
  sus parecidas no cuentan: no cambian los nombres.
- **Comillas `$'…'`**: se decodifican antes de comparar; `$'production-\x69ndex.json'` es el índice.
- **Variables, modificadores y arreglos**: una variable que el propio comando define se reemplaza por su
  valor. Una que no define, un modificador de zsh (`$F:s/X/x/`) o un `${…}` con operador valen
  «cualquier cosa». Un arreglo vale todos sus elementos.
- **Mayúsculas**: `Production-Index.json` es el mismo archivo en el disco de macOS, y cuenta igual.
- **Todas las redirecciones**: `jq … 2>/dev/null > …/production-index.json` frena. Antes se miraba sólo
  la primera redirección del comando.
- **La carpeta de trabajo**: la cambian `cd`, `pushd`, `chdir` y `builtin cd`, con sus opciones; arranca
  en la carpeta de la sesión; `git -C` y `make -C` la fijan para su comando. Con `cd -` o un destino
  que no se puede leer queda desconocida, y entonces el nombre pelado del catálogo cuenta como protegido.
- **`xargs`**: si un comando anterior de la misma tubería nombra un archivo protegido o la carpeta
  protegida, el programa que corre `xargs` cuenta como escritura sobre eso.
- **`find`** que borra (`-delete`) o corre un programa que escribe: como baja a las subcarpetas, se juzga
  cuando arranca en la carpeta protegida, en una que la contiene (`~`, `~/.claude`, un repo) o en una
  desconocida. Para saber si una carpeta contiene repos con catálogo mira hasta 5.000 subcarpetas; con más, o
  si no puede leerla, frena como «un nombre que el freno no sabe leer como el shell».
- **Sustituciones**: un `$(…)` en los argumentos de un programa que escribe frena si su texto nombra la
  carpeta protegida.
- **Comodines y carpetas ocultas**: como en el shell, un comodín que no empieza con punto (`*-*`, `$ID-*`) no
  casa con una carpeta que empieza con punto; no se lo toma por la carpeta protegida. Si el comando cambia esa
  regla (`setopt globdots`, `shopt -s dotglob`), lo que queda en alcance es indecidible.
- **Intérpretes**: una variable sin resolver pasada como dato a `python3`, `node` y parecidos se trata como
  dato del programa, igual que antes; lo que frena es el nombre protegido escrito o una sustitución que lo nombra.

**La carpeta protegida**, para todo esto, es la raíz de `~/.claude/.tycon-pipeline/` o la carpeta
`.tycon/` de un repo, más cualquier nombre que empiece con `production` o `produccion`, sin distinguir
mayúsculas. Las subcarpetas del pipeline (`timing-history/`, `corridas-buzon/`…) no lo son: ahí estaban
casi todos los frenos falsos medidos. Lo que el freno no sabe leer **adentro** de ese alcance
frena, con su propio motivo. **Afuera**, no: `mkdir -p src/{a,b}` y `rm -rf "$TMP"/*` siguen pasando. Lo
que no escribe tampoco se frena: un `echo` que nombra el índice pasa.

**La medición.** Antes del arreglo se midieron 119 formas del shell, con zsh y bash reales: 65 no hacían
lo que tenían que hacer. De ésas, 59 pasaban tocando un archivo protegido y 6 frenaban sin tocar nada.
Las 119 son ahora una prueba (`scripts/tests/prod-guard-shell-forms.test.sh`), y 29 de ellas son casos
del banco. El umbral de siempre no cambia: 0 frenados que no nombran bases sobre los últimos 4.000
comandos reales.

## La clave del Llavero: cómo tiene que estar cargada

La carga la hace el `.command` que deja la puerta en el Escritorio, y eso está bien. Si alguien
carga la entrada **a mano con `-A`**, cualquier programa del usuario puede leer la contraseña sin
cuadro — y la puerta **se niega a usarla** y te dice que la borres y la vuelvas a cargar. Para
revisarlo: `tycon-prod-sql --verificar` dice, clave por clave, quién puede leerla (y ahora **sale
≠ 0** si algo está mal, así que se puede llamar desde un guion).

La contraseña nunca viaja por los argumentos de un comando: iría a la lista de procesos, visible
para cualquier programa del mismo usuario mientras dura. Va por la entrada estándar.

## «Login failed» con la clave bien cargada: no recargues, mirá la config del cliente

🔴 **Si el servidor rechaza una clave recién cargada, puede no ser la clave.** El cliente que usa la puerta (`go-sqlcmd`) lee
`~/.sqlcmd/sqlconfig`, y si ahí hay un **contexto actual con usuario guardado, manda al servidor la
clave guardada ahí e ignora `SQLCMDPASSWORD`**, aunque reciba `-S` y `-U` explícitos. Una config
vieja con la clave mal guardada da «Login failed» siempre.

Se midió con un **servidor SQL de mentira** en la propia máquina que decodifica el usuario y la
clave del paquete de login (`scripts/tests/lib/tds-spy.py`): con la config presente el cliente
mandó la clave vieja; sin ella, la de la variable; con `-P`, la del argumento. Por eso la
puerta corre el cliente con `HOME` en una carpeta vacía —no ve ninguna config del usuario— y
`--verificar` dice si esa config existe. Caso T32 de `scripts/tests/tycon-prod-sql.test.sh`, con
el cliente real y su control.

La regla: **un «Login failed» con `--verificar` en verde NO es una clave mal cargada.**
Antes de pedirle a alguien que borre y recargue la entrada, hay que saber qué clave viajó de
verdad.

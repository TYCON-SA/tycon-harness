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

### Actualizarlo sin contraseña (si la organización lo eligió)

De fábrica, cada actualización del freno pide tu contraseña. Si la organización eligió en el sitio «solo, desde la
versión publicada» (`guard.update: auto`), podés instalar UNA vez, con tu contraseña, un permiso de `sudo` acotado:

```bash
sudo bash ~/.tycon/harness/scripts/production/install-guard.sh --allow-auto-update
```

Qué habilita: correr como root, sin contraseña, un solo guion y sin argumentos, `sudo -n
/opt/tycon/setup/update-guard.sh`. El guion instala la versión publicada del freno, verificada contra GitHub. Sólo
avanza, nunca vuelve atrás. No fija un origen nuevo, y sin red no hace nada. Una versión que trae otro instalador, un
origen que cambió (aunque sea una mudanza oficial) o una versión bajada con enlaces simbólicos no se instalan solos:
piden tu contraseña. Cada actualización queda en
`/opt/tycon/production/update-log.jsonl`, y el aviso de arranque muestra la última. Se niega si tu máquina no tiene el
permiso, o si el perfil del equipo de tu máquina dice «con la contraseña»: tocar ese perfil sólo puede apagarlo, nunca
prenderlo.

Lo que cuesta, dicho antes:

- **Cualquier programa que corra con tu usuario puede pedir esa actualización.** `sudo` no distingue una sesión de
  otra, así que el agente, un script o un hook también la pueden disparar. No pueden elegir qué se instala: el guion sólo
  pone al día con lo publicado.
- **El freno publicado se adopta sin una persona en el teclado.** Hoy la contraseña es una decisión consciente de
  adoptar. Con el permiso, un freno publicado más flojo llega solo. El ancla sigue siendo el repo del equipo en GitHub,
  con sus pedidos y su revisión.
- **Si la organización vuelve a «con la contraseña», tu máquina no cambia sola.** El aviso de arranque te da el comando
  para sacar el permiso. Hasta que lo saques, un agente que reescriba el perfil de tu máquina a «solo» puede seguir
  actualizándola.

Para sacarlo, y volver a la contraseña cada vez:

```bash
sudo bash ~/.tycon/harness/scripts/production/install-guard.sh --remove-auto-update
```

### Los nombres en inglés

La carpeta es `scripts/production/`, el instalador es `install-guard.command` (el `.command` con su nombre de antes
sigue abriendo éste), el catálogo es `.tycon/production.json` con las claves `servers`,
`environment`, `keychain` y `port`, y el índice y la memoria son `production-index.json` y `production-memory.json`.
Los valores de `environment` son `production` y `non-production`; `produccion` y `no-produccion` siguen valiendo, y el
índice guarda siempre éstos, porque la copia de `/opt/tycon` es la que lo lee. Una máquina con un arnés anterior a los
valores en inglés no reconoce `production` ni `non-production`: trata ese servidor como no declarado y lo frena (nunca
lo deja pasar). Para un repo que comparten máquinas que todavía no se actualizaron, conviene seguir con los de antes.

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

**La consulta va siempre en línea.** El cuadro muestra el comando y nada más: lo que trae un archivo no se ve
antes de aprobar, así que la puerta no acepta archivos. Una consulta puede ocupar varios renglones dentro de
las comillas simples. Si le pedís a la puerta un archivo, el freno no deja pasar el comando y, cuando el archivo
se puede pasar a una consulta en línea, te da ese comando listo para correr.

**Tope: unos 20 renglones de pantalla.** El cuadro muestra eso y corta el principio sin aviso, así que un comando
más largo no pasa: el freno dice cuántos ocupa y hay que partir la consulta en consultas más cortas. Un renglón
de más de 76 columnas cuenta como varios, y un tabulador o un carácter ancho ocupan más de una columna.

**Sin caracteres que engañen.** Ni caracteres de control (un retorno de carro, una secuencia de la terminal) ni
invisibles o de dirección: harían ver en el cuadro otra cosa que lo que corre. Los frena el freno y, otra vez,
la puerta.

La puerta trae **formato fijo** a propósito (junta el error con la salida, corta filas, imprime el
código de salida): así no hace falta agregarle `| head` ni `2>&1`, que la forma canónica no acepta.

## Declarar un servidor

En el repo que tiene las migraciones de esa base (`database/` o `BD/`), y **sólo** con estas
claves — el usuario de la base NO va acá, va junto a la contraseña en el Llavero:

```json
{
  "servers": [
    { "host": "acme-sql.database.windows.net", "environment": "production", "keychain": "tycon-prod-acme", "base": "acmebase" },
    { "host": "srv.globex.test", "environment": "production", "keychain": "tycon-prod-globex", "base": "GlobexDb", "port": 1435 },
    { "host": "acme-sql-staging.database.windows.net", "environment": "non-production" },
    { "host": "acme-test.example.com", "environment": "non-production" }
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

## El firewall: la IP de tu máquina, por la puerta

Si la IP de tu máquina no está habilitada en el firewall de un Azure SQL de producción, el freno corta
el comando de Azure que crearía la regla, aunque lo autorices en el chat. El camino es la puerta:

```bash
/opt/tycon/bin/tycon-prod-sql --open-firewall <host>     # cuadro de aprobación; abre la regla de esta máquina
/opt/tycon/bin/tycon-prod-sql --close-firewall <host>    # cuadro; la cierra
```

- **Una sola regla por máquina y por servidor**, con nombre fijo `tycon-gate-<id>` (un hash del
  identificador del equipo: no dice de quién es la máquina), para una sola IP. Si tu IP cambió, la
  misma regla se actualiza; nunca hay dos. La puerta no acepta rangos, `0.0.0.0`, «permitir servicios
  de Azure» ni un nombre de regla.
- **La IP sale del propio Azure SQL**: la puerta intenta entrar con un usuario que no existe y sin la
  clave, y lee la IP del rechazo («Client with IP address … is not allowed»). No llama a ningún
  servicio externo ni lee el Llavero. Si la conexión llega a pedir la clave, ya tenés acceso y no abre
  nada.
- **Se cierra sola**: al terminar la sesión del asistente que la abrió, un hook de la configuración
  administrada (`prod-firewall-close.js`) la cierra, salvo que otra sesión viva la siga usando. Si el
  fin de sesión no corrió (ventana cerrada de golpe, sesión caída), el mismo hook la cierra al arrancar
  la próxima sesión y lo dice en una línea. Cerrar no pide cuadro.
- **Si el servidor se borró** con la regla abierta, la regla se fue con él. Al abrir, la puerta anota la
  suscripción y el grupo del servidor. Al cerrar, pregunta por ese servidor ahí: si Azure contesta que
  no existe, y tampoco está en otra suscripción, lo da por cerrado y lo dice. Si se movió, la cierra
  donde está. Un «sin permiso» no cuenta como borrado (Azure esconde lo que tu cuenta ya no ve). Una regla
  de antes de anotar el lugar queda como abierta: «no sé» no cuenta como cerrada. El caso que queda: un
  servidor movido a una suscripción que tu cuenta no puede leer se da por cerrado, aunque la regla viajó
  con él; tu cuenta tampoco podría cerrarla.
- **Qué quedó abierto** vive en `production-firewall.json` (en la carpeta del estado, al lado de
  `production.log`), protegido como la memoria de producción; cada apertura y cada cierre quedan en
  `production.log`.
- Sólo para Azure SQL (`*.database.windows.net`): un SQL Server propio, con `port`, no pasa por acá.

## Borrar en Azure: el grupo, el candado y el recurso

Borrar un grupo de recursos se lleva todo lo que tiene adentro, también un servidor de producción con sus bases. El
catálogo declara servidores, no grupos, así que **el freno no sabe qué grupo contiene qué**. Por eso frena todos estos
comandos, sin mirar el nombre del grupo ni el catálogo, y sin preguntarle a Azure:

- `az group delete`, en cualquier forma (con opciones globales delante, con `sudo`, `az.cmd`, `az.exe`, escondido en
  `bash -c` o `xargs`).
- `az lock delete`: quita el candado que protege contra el borrado. Crear, listar y mirar candados pasa.
- `az rest` con el método delete, o con un método que sale de una variable: la dirección puede ser un grupo o un
  servidor. Los otros métodos pasan. Lo mismo `Invoke-AzRestMethod -Method DELETE` en PowerShell.
- `az resource delete`, salvo que se lea el tipo de todo lo que borra y nada sea de `Microsoft.Sql`, de
  `Microsoft.Resources` (el grupo) ni de `Microsoft.Authorization` (el candado). Si nombra un servidor SQL, lo decide
  el catálogo como cualquier otro comando: producción o desconocido frena, un no-producción declarado pasa. Sin tipo
  legible (una variable, un `-n` sin `--resource-type`, un comodín), frena.
- `azd down`, que borra los recursos de un entorno.
- En PowerShell, `Remove-AzResourceGroup`, `Remove-AzResource`, `Remove-AzSqlServer`, `Remove-AzSqlDatabase` y
  `Remove-AzResourceLock`, siempre.
- El borrado escondido también: con el programa en una variable (`$A group delete`), en la segunda línea del comando,
  dentro de un programa de `awk` o `sed`, en el código de `python -c` o `node -e`, en un guion que corre un shell, por
  `ssh` y con `xargs` cuando el subcomando viene de la entrada. El mensaje de un commit que nombra estos comandos no se
  frena: no es un comando.

Un grupo que **no** es de producción (uno de prueba) lo puede borrar el asistente por la puerta, con el cuadro de
aprobación:

```bash
/opt/tycon/bin/tycon-prod-sql --delete-group <grupo>     # sólo el nombre; abre el cuadro
```

La puerta le pregunta a Azure qué hay en el grupo y lo borra sólo si puede probar que es seguro: el grupo está en una
sola suscripción, todos sus servidores SQL están declarados no-producción, no tiene una base de un tipo que el catálogo
no cubre (Postgres, MySQL, MariaDB, una instancia administrada, Cosmos, Synapse) y los listados coinciden. Si no, sale 2
sin borrar y dice por qué: un servidor de producción, uno sin declarar, un listado cortado o `az` que no contestó. El
borrado sale con `--no-wait`: la puerta dice que Azure **aceptó el pedido**, no que el grupo ya no está, y da el comando
para confirmarlo (`az group exists`). Un grupo con candado lo rechaza Azure, y la puerta lo dice.

Un grupo con algo de producción, o que la puerta no puede probar seguro, lo borra
**una persona, en su propia terminal**, fuera del asistente, después de mirar qué contiene. El mensaje del freno ante un `az group delete` directo
nombra los dos caminos: la puerta (`--delete-group <grupo>`, que pide la aprobación del dueño en el cuadro) para un grupo
que no es de producción, y una persona para lo demás. El corte queda anotado con la regla `borrado-de-azure`.

El límite: el freno cubre los comandos del asistente en esta máquina. **No** cubre el portal de Azure, Terraform, un
despliegue con `az deployment group create --mode Complete` (borra lo que la plantilla no nombra), los SDK ni a otra
persona. La protección de verdad en Azure es un candado `CanNotDelete` en el servidor de producción, que pone una persona
con permiso de candados; el freno impide que el asistente lo quite.

## El candado: que nadie borre el servidor por descuido

El freno corta los borrados que corre el asistente, pero no ve el portal, Terraform ni a otra persona. La protección de
verdad la da Azure: un candado `CanNotDelete` sobre el servidor de producción (o sobre su grupo) hace que Azure rechace
el borrado, venga de donde venga. El candado **lo pone una persona** con permiso de locks
(`Microsoft.Authorization/locks/write`): cambia el Azure del cliente, y el asistente no lo hace.

La puerta dice cuáles lo tienen, sin cambiar nada:

```bash
/opt/tycon/bin/tycon-prod-sql --locks     # sin nada más; abre el cuadro de aprobación, como toda forma de la puerta, y sólo lee
```

Por cada servidor de producción declarado en Azure SQL dice `con candado` (con su nombre y si está en el servidor o en el
grupo), `sin candado` o `no sé` (con el motivo: sin `az`, sin sesión, el servidor en dos suscripciones o en ninguna, o el
catálogo de un repo que no se pudo leer: los demás se revisan igual).
Cuenta un candado `CanNotDelete` o `ReadOnly` sobre el servidor o su grupo. A uno sin candado le imprime el comando, para
que lo corra una persona con permiso de locks, fuera del asistente:

```bash
az lock create --name tycon-no-borrar --lock-type CanNotDelete --resource-group <grupo> --resource-name <servidor> \
  --resource-type Microsoft.Sql/servers --subscription <suscripción>
```

Lo medido: `az lock list` devuelve cada candado con su `id`, `level` y `name`, y el `id` dice si es del grupo o del
servidor. Un candado tarda unos segundos en irse: borrar el grupo justo después de sacarlo falló con `ScopeLocked`, así
que hay que esperar o reintentar. Los límites: un candado lo puede quitar cualquiera con permiso de locks (el asistente
no, porque el freno corta `az lock delete`); la puerta no ve los candados de suscripción, y un servidor con uno de esos
puede salir `sin candado`. Sale 2 si algún servidor quedó en `no sé`.
Todavía no está medido si un candado sobre el servidor impide cerrar la regla de firewall de la puerta: hasta medirlo,
poné el candado primero en un servidor de prueba y no en uno real.

## Los límites, dichos antes

- 🔴 **La regla que pregunta por `az sql server firewall-rule` es de CORTESÍA**, no un freno: se
  esquiva partiendo una palabra en dos (`az sql ser''ver …`). Para producción y para lo desconocido
  el control es el **hook**, que corre antes que las reglas y no se esquiva así. No confíes en el
  cuadro del firewall como si fuera una barrera. Para habilitar tu IP, el camino es la puerta
  (`--open-firewall`).
- **`az` es del usuario** (Homebrew o el instalador de Microsoft), no un binario de root con huella:
  rompe la regla de la puerta y se acepta con tres condiciones: se busca en rutas fijas, nunca en el
  `PATH`; nunca recibe la clave de la base ni nada del Llavero; y sólo se le piden `account list`,
  `sql server list`, `sql server show` y `sql server firewall-rule show|create|update|delete` sobre `tycon-gate-<id>`. Un
  `az` reemplazado en una de esas rutas no ve la clave, pero sí puede crear otra regla con tu cuenta:
  tu cuenta de Azure ya podía hacerlo a mano.
- **El fin de sesión puede no correr** (ventana cerrada de golpe, sesión caída): la regla queda abierta
  hasta el próximo arranque en esa máquina, que la cierra. Una máquina que no vuelve a abrir una
  sesión la deja abierta hasta que alguien lo haga: es el costo de no tener vencimiento por horas.
- **Una sesión quieta cuenta como terminada**: «viva» es actividad en los últimos 3 minutos. Si se le
  cierra la regla, la vuelve a abrir con el cuadro.
- **Codex no abre reglas**: no tiene el cuadro de la configuración administrada ni un evento de fin de
  sesión.
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
- **Ponerse al día depende de lo que eligió la organización** (`guard.update`, en el sitio). Con «con la contraseña»
  (de fábrica), actualizar el freno pide `sudo`: hasta que lo corras, la máquina tiene la versión vieja, y el aviso de
  arranque te lo dice. Con «solo» y el permiso instalado en tu máquina, se pone al día sin contraseña, sólo con la versión
  publicada y verificada (abajo, «Actualizarlo sin contraseña»). Eso adopta el freno publicado sin una persona en el
  teclado.
- **Codex** no lee la configuración administrada de Claude Code: de ese lado el freno también frena
  la puerta y te pide que la sentencia la corras vos. Lo que no cubre está declarado en
  `guides/maintaining/codex-divergence-inventory.md`, no prometido.

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
- **Si el freno está mal instalado** (falta el intérprete de root o el freno, o no coinciden sus datos),
  **decide con su criterio de emergencia**, que sólo mira si el comando nombra bases o el Llavero. Ese
  criterio no reconoce la mayoría de estas formas, y el comando pasa. No se amplía: ampliarlo frenaba
  11 de los últimos 4.000 comandos reales, que no tocaban nada. Frenar todo ahí dejaría la máquina sin
  terminal hasta reinstalar.
- **Si el freno no contesta a tiempo, o se cae con un error propio, frena TODO comando**, nombre bases
  o no: el freno juzga también lo que un comando ejecuta por dentro (un guion, `bash -c`, un heredoc), y
  eso el lanzador no lo ve. El lanzador tiene un reloj de 7 s para todo su trabajo, y el hook tiene un
  tope de 30 s en la configuración administrada: más del doble, para que el lanzador siempre conteste
  antes.
- 🔴 **El límite que el arnés no puede cerrar: si la máquina está tan cargada que el lanzador ni llega a
  su reloj en 30 s, Claude Code lo corta y el comando corre igual.** El corte lo decide Claude Code, no
  el freno. Queda contado: la revisión nocturna de las ejecuciones cuenta cada hook que se pasó de tiempo.

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
de instalar, conviene declarar los servidores de prueba que se usan (por ejemplo `acme-test.example.com`).

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
- **«el freno no pudo decidir»** → el freno no contesta a tiempo (o se cayó) y por eso frena, también
  un comando que no toca ninguna base. Suele ser la carga de la máquina: reintentá en un momento. Queda
  constancia en `hook-errors.log`. Si el cartel pide reinstalar, el freno instalado es de antes de que
  se anotaran los datos del intérprete y lo lee entero en cada comando: reinstalar
  (`scripts/production/install-guard.command`, pide `sudo`) trae esos datos y lo hace rápido.
- **«un nombre que el freno no sabe leer como el shell»** → el comando escribe en la carpeta protegida
  con una forma que el freno no puede decidir: un paréntesis sin cerrar, o un `setopt` antes. Si no
  querías tocar un archivo protegido, escribí los nombres enteros, sin llaves ni variables, y el freno
  los va a poder leer.

Si te frena algo que no tiene nada que ver con bases, **es un error nuestro**: decilo, porque un
freno que molesta sin motivo es el que alguien termina apagando.

## Para el que mantiene el arnés

- El freno: `scripts/hooks/prod-access-guard.js` · la puerta: `scripts/production/tycon-prod-sql`
- Aviso de arranque e índice: `scripts/hooks/production-notice.js` ·
  `scripts/production/production-index.js`
- Instalador: `scripts/production/install-guard.sh` (+ el `.command`) · configuración administrada:
  `scripts/production/managed-settings.tycon-production.json.template`. La organización del equipo sale
  de la configuración del arnés, que el asistente puede escribir: por eso la **primera
  instalación pide confirmar por teclado** el remoto del clon y la organización, y los deja fijados de
  root en `/opt/tycon/produccion/origen-de-confianza.json`; si después el remoto o la organización
  cambian, el instalador se niega y lo dice — si el cambio es tuyo, `--change-origin` (vuelve a
  preguntar por teclado). Un `tycon.json` o perfil ilegible lo frena nombrando el archivo, no como
  «sin organización». **La mudanza oficial a GitHub** no pide nada: si lo fijado es el clon de Azure del arnés y lo que
  se instala es la versión bajada del repo de GitHub declarado en `scripts/production/origin-moves.json` (el archivo al
  lado del instalador, no el de la carpeta que se instala), el instalador lo acepta solo y dice «el arnés se mudó a
  GitHub: actualizo el origen fijado». Cualquier otro cambio sigue pidiendo `--change-origin` y el teclado.
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
  y los casos `40-prod-access-guard.json` / `41-production-notice.json` del banco.
- Registro de ayuda: `~/.claude/.tycon-pipeline/production.log` (nunca la sentencia, sólo su huella).

## Lo que el freno NO deja pasar aunque esté escondido (desde 2026-09-15)

Un comando puede esconder lo que ejecuta: `bash -c '…'`, `eval`, `python3 -c '…'`, un cuerpo de
heredoc, o un guion que el mismo comando escribe y corre. El freno mira **también adentro de esos
textos** — si no, un `bash -c` lee la contraseña de producción del Llavero sin que nada frene.
Y cuando el comando nombra bases y esconde lo que corre de una forma que no se puede ver (por
ejemplo `bash -c "$CMD"`, con la variable definida en otro lado), **frena y lo dice**.

Lo que el comando **sólo escribe** a un archivo y no corre (`cat > server.js <<'EOF'`, `tee x <<EOF`) es contenido,
no algo que se ejecuta: el freno no lo lee buscando servidores ni el Llavero. Vale sólo si el comando entero usa
`cat`, `tee`, `mkdir`, `touch`, `echo`, `printf`, `ls` o `true`, sin `$(…)` ni tuberías a otro programa, y
el archivo tiene nombre fijo, se crea o se pisa (no se anexa) y vive en tu carpeta o en una temporal, fuera de
carpetas ocultas y de `~/Library`. No puede llamarse como un guion que otro corre (`*.sh`, `*.bash`, `*.zsh`, `*.command`, `Makefile`,
`package.json`, `Dockerfile`, con mayúsculas o sin); si
ya existía, no puede ser un enlace ni tener permiso de ejecución; y el comando no puede asignar variables (`PATH=…`).
Con `<<EOF` sin comillas el shell ejecuta el `$(…)` del cuerpo: ese cuerpo se libera sólo si no tiene `$` ni comillas
invertidas (con `<<'EOF'` no se expande nada), y el delimitador va escrito simple (`EOF`, `'EOF'` o `"EOF"`). Ante cualquier duda (un permiso negado, una ruta relativa sin la carpeta
de la sesión) se juzga como siempre. Con cualquier otra cosa (`node server.js`, `bash < x.sh`, `cat >> ~/.zshrc`) se
juzga como siempre.

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
- **Bucles `for`**: las palabras de `for f in <palabras>` no se escriben; pasan a la variable y se juzgan donde
  se usan. `for f in $(ls ~/.claude/.tycon-pipeline/*.json); do cat "$f"; done` pasa; con `rm "$f"` adentro, frena.
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

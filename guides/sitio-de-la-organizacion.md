# El sitio de la organización: qué es, dónde vive y cómo se instala

Esta guía es para quien instala el sitio por primera vez y nunca lo vio. Dice qué es, qué hace falta, cómo probarlo en tu
máquina, y cómo dejarlo andando en una nube, en un servicio gratis o en una máquina propia. Cómo se usa cada pestaña está
en la guía de uso del sitio.

Cada paso de esta guía sale del código o de una corrida real. Lo que todavía no se probó en real lo dice en la misma
línea.

## Qué es y para qué sirve

Es una página web para toda la organización. Cada persona entra con la cuenta de la organización y ve lo suyo: sus
pedidos, sus pull requests, sus corridas. Quienes mantienen el arnés ven todo, y además tienen la pestaña
**Configuración**, donde se personaliza la organización (quién es responsable de qué, el canal del aviso, los umbrales).

**Un día real.** A las 4 de la mañana corren los procesos de la noche y dejan su foto en el repo de operaciones. Al
rato llega el aviso de la mañana (Telegram, Slack o Teams), con cantidades y el enlace al sitio. Quien mantiene abre el
enlace y ve qué hay que decidir hoy. Un dev entra y ve sólo sus cosas. Nadie tiene que clonar nada ni correr nada en su
máquina para verlo.

**Quién lo usa:**

- **Quien mantiene el arnés:** lo instala una vez, lo actualiza a conciencia, y edita la configuración desde la pestaña
  Configuración.
- **Cada persona de la organización:** entra y ve lo suyo.
- **Alguien de otra organización:** no entra. El sitio deja pasar sólo a la organización.

## Qué hace falta antes

- **La imagen del sitio.** Se publica sola en el registro de paquetes del repo público del arnés cada vez que cambia lo
  que trae. También la podés armar vos (abajo).
- **Una forma de iniciar sesión de la organización:** Entra ID, Google Workspace, GitHub, o cualquier proveedor OIDC
  (Okta, Keycloak). En ese proveedor se registra una aplicación para el sitio.
- **El repo de operaciones** de la organización, y una identidad que lo pueda leer (sólo ese repo).
- **Opcional: el buzón de corridas**, si la organización junta las corridas de las máquinas.
- **Un lugar donde correr un contenedor** con HTTPS delante: una nube, un servicio gratis o una máquina propia.

## Probarlo en tu máquina con Docker

Son unos diez minutos, la mayoría armando la imagen. Necesitás Docker abierto y el clon del repo público del arnés.

1. **Armar la imagen** (desde la raíz del clon; corrido de verdad: unos 2 minutos la primera vez):

   ```bash
   docker buildx build -f scripts/site/Dockerfile -t sitio:local .
   ```

2. **Arrancarla**, con el puerto sólo en tu máquina y un volumen para su disco:

   ```bash
   docker run --rm -p 127.0.0.1:8080:8080 -v sitio-datos:/data -e SITE_DATA_DIR=/data \
     -e SITE_PUBLIC_URL=http://127.0.0.1:8080 -e SITE_SESSION_KEY="$(openssl rand -hex 32)" \
     -e SITE_AUTH_PROVIDER=github -e SITE_AUTH_GITHUB_ORG=<tu organización de GitHub> \
     -e SITE_OIDC_CLIENT_ID=<el Client ID> -e SITE_OIDC_CLIENT_SECRET=<el secreto> \
     -e SITE_OPERATIONS_REPO=<la dirección https del repo de operaciones> -e SITE_OPERATIONS_TOKEN=<un token de lectura> \
     -e SITE_FIRST_MAINTAINER=<tu correo> sitio:local
   ```

   Al arrancar, el registro dice cada variable como «presente» o «ausente», nunca su valor. Si falta una obligatoria,
   no arranca y dice cuál.

3. **Mirar que vive** (en otra terminal):

   ```bash
   curl -s http://127.0.0.1:8080/livez
   node scripts/site/check-deploy.js --url http://127.0.0.1:8080
   ```

   `/livez` contesta `{"ok":true}`. La prueba sin sesión mira que, sin iniciar sesión, no se vea nada. Con valores
   inventados (un repo que no existe), lo medimos: el sitio arranca, `/livez` da 200, `/` redirige al inicio de sesión de
   GitHub, `/api/inicio` da 401, y el sitio queda **frenado** porque no puede leer el repo (`/healthz` da 503 y la prueba
   dice «el sitio está frenado»). Con el repo de verdad y su token, el sitio carga.

4. **Entrar.** Abrí http://127.0.0.1:8080 y entrá con tu cuenta. Para eso hace falta registrar antes la aplicación en
   GitHub (*Settings → Developer settings → OAuth Apps → New OAuth App*, con la dirección `http://127.0.0.1:8080` y la
   vuelta `http://127.0.0.1:8080/auth/callback`). El ingreso con una cuenta real no se probó en real todavía.

Para cortarlo: `Ctrl+C` en la terminal. El volumen `sitio-datos` queda; se borra con `docker volume rm sitio-datos`.

## Lo común a cualquier instalación

Esta parte vale para cualquier lugar donde lo instales.

### HTTPS delante

El sitio exige que su dirección pública (`SITE_PUBLIC_URL`) sea `https://` y usa una cookie que sólo viaja por HTTPS.
El TLS lo pone quien instala: la plataforma, un proxy o un túnel. El contenedor escucha en el puerto 8080.

### El disco

Un volumen persistente montado como carpeta en `SITE_DATA_DIR`. Ahí viven el espejo del buzón (los volcados de las
corridas y, con `site.mailbox.threads: true`, un resumen chico de cada conversación) y la última configuración buena.
Las conversaciones no se guardan: cada una se baja una vez, se resume y se borra, y la pasada no baja más de 300 MB de
conversaciones por vez. Los clones de los repos y los textos de los cambios van al disco del contenedor, nunca al volumen
(un disco de red montado por SMB no admite el `chmod` que git hace al clonar). Medido con un buzón de 6,9 GB: sin
las conversaciones, ocupa 163 MB, a los que se suman los resúmenes (unos kilobytes por corrida) y, mientras dura una
pasada, hasta 300 MB de conversaciones por resumir. **2 GB alcanzan**, con lugar para crecer. **Sin volumen el sitio igual anda**: usa
una carpeta temporal y lo dice. Pero lo que sale de las conversaciones en la pestaña Corridas queda «no medido», cada
reinicio vuelve a bajar todo, y un reinicio reinicia el plazo de 24 horas que tiene una configuración rota antes de que
el sitio se frene (y levanta el freno hasta que vuelva a vencer).

### La memoria

1 GB. Armar la vista de corridas con sus conversaciones mide unos 700 MB de pico.

### El inicio de sesión de la organización

El sitio hace su propio inicio de sesión (`SITE_AUTH_PROVIDER`): `oidc` genérico (Okta, Keycloak u otro con
descubrimiento), `microsoft`, `google` o `github`. Cada uno se limita a la organización: un inquilino, el dominio
(`SITE_AUTH_ALLOWED_DOMAINS`) o la organización de GitHub. En el proveedor se registra una aplicación con la vuelta
`<dirección del sitio>/auth/callback` y un secreto de 6 meses como máximo.

### Las sondas

Si tu plataforma tiene sondas, **las dos van contra `/livez`**, con un plazo de respuesta de unos 5 segundos.

- **La de vida, nunca contra `/healthz`.** `/healthz` da 503 con el sitio frenado por una configuración rota. Una sonda
  de vida contra él reiniciaría el contenedor en un lazo, y reiniciar no arregla la configuración.
- **La de lista, tampoco contra `/readyz`.** La plataforma no manda tráfico hasta que esa sonda pasa, y `/readyz`
  espera todas las fuentes, el buzón entero incluido. El sitio ya sirve cada pestaña apenas la puede armar: la que
  todavía espera dice «cargando» y se recarga sola, y la frenada explica por qué. `/readyz` queda para quien quiera saber
  si terminó de cargar todo.

### Los secretos, con el menor permiso

Cada instalación dice dónde se guarda cada uno y por dónde entra su valor. **Ningún valor va en un archivo del repo, en
`operations.json`, en el archivo de configuración de una instalación, en la línea de órdenes ni en un plan impreso.**

| Secreto | Para qué | Alcance mínimo |
|---|---|---|
| `SITE_SESSION_KEY` | firmar la sesión | 32 bytes al azar, sólo del sitio |
| `SITE_OIDC_CLIENT_SECRET` | el inicio de sesión | un registro sólo para el sitio, sin permisos de API más allá de `openid email profile`; vence en 6 meses como máximo |
| `SITE_OPERATIONS_TOKEN` (o la identidad de la plataforma, `SITE_OPERATIONS_IDENTITY=managed`, sin secreto) | leer el repo de operaciones | una identidad propia con lectura sólo en ese repo; si es un token, de una organización, sólo lectura de código, 90 días; en GitHub, de grano fino, de un solo repo, `contents: read` |
| `SITE_MAILBOX_SAS` (o `SITE_MAILBOX_IDENTITY=managed`) | leer las corridas del buzón | una SAS de sólo leer y listar (`rl`) atada a una política guardada del contenedor, 6 meses como máximo; o la identidad de la plataforma con un rol de lectura sobre el contenedor |
| el canal del aviso | mandar el aviso de la mañana | no llega al sitio: lo usa el proceso de la noche. Telegram: el token sirve para todo el bot, usá uno dedicado. Slack o Teams: la dirección del webhook ES la credencial |
| `SITE_OPERATIONS_WRITE_TOKEN` | proponer cambios de configuración desde el sitio | en GitHub, de grano fino sobre el repo de operaciones con `contents: write` y `pull_requests: write`; en Azure DevOps, una cuenta dedicada con *Contribute*, *Create branch* y *Contribute to pull requests* sólo en ese repo, *Force push* negado y sin permiso de saltar políticas |
| `SITE_PROFILE_REPO` y `SITE_PROFILE_TOKEN` | leer el perfil del equipo (dónde vive cada repo, los paquetes) | parte de la instalación normal: sin ellos la pestaña Configuración dice «falta el repo del perfil». La dirección del repo del perfil y un token de sólo lectura de código sobre ese repo (puede ser el mismo permiso que el del repo de operaciones, si los dos viven en la misma organización) |
| `SITE_PROFILE_WRITE_TOKEN`, `SITE_PIPELINES_TOKEN` | lo opcional de la pestaña Configuración | apagadas por defecto: vacías o comentadas, nunca con un valor; una identidad dedicada y un repo por credencial |

`SITE_FIRST_MAINTAINER` no es un secreto: es el correo de quien entra primero como mantenedor, mientras la lista de
mantenedores (`site.maintainers` de `operations.json`) no existe. Sacala después.

### Quien puede editar la instalación puede leer sus secretos

Quien tiene permiso para cambiar la instalación (sus variables, su imagen) puede leer todos sus secretos y hacerse
mantenedor: cambiar la llave de la sesión o apuntar a otro repo. Ese permiso, sólo para quienes mantienen el arnés.
Sacar `SITE_FIRST_MAINTAINER` protege de un olvido, no de ese administrador.

### La política de rama del repo de operaciones

Antes de publicar el sitio, `main` del repo de operaciones necesita una política de rama que pida un revisor que no sea
el autor. Sin ella, cualquiera que pueda empujar a `main` puede hacerse mantenedor del sitio (cambia la lista) o cambiar
un proceso de la noche y llevarse sus secretos. Esa política es también la que habilita «Proponer» en la pestaña
Configuración. Cómo ponerla en Azure DevOps y en GitHub: los READMEs de los modelos de operaciones
(`pipelines/operations/README.md` y `pipelines/operations/github/README.md`).

### Las dos formas de arrancarlo

La misma imagen con Docker (`docker run … sitio:local`, arriba), o con Node solo desde el clon, con las mismas
variables:

```bash
node scripts/site/server.js
```

### La prueba sin sesión

Después de cualquier instalación, y cada mañana desde el proceso de la noche:

```bash
node scripts/site/check-deploy.js --url https://<dirección del sitio>
```

Pide, sin sesión, lo que pediría un extraño. Sale 0 si no se ve nada; 1 con el motivo («el sitio responde sin iniciar
sesión», «/api contesta con datos», «el sitio está frenado», «/healthz cuenta de más», «falta no-store», «acepta http»);
2 si no pudo preguntar. Espera hasta 90 segundos la primera respuesta: un sitio dormido tarda en despertar. El aviso de
la mañana lleva el enlace sólo si pasó esa mañana.

## Las recetas

Cada receta dice lo que cambia respecto de lo común. **Las tres recetas todavía no se probaron en real**: lo prueba la
primera instalación de cada una.

### Azure Container Apps

Gratis dentro de la cuota de la suscripción, con escala a cero. La instalación es un guion en dos fases que primero se
corre en ensayo:

```bash
node scripts/site/deploy/azure-container-apps.js --config <archivo fuera de todo repo> --phase ambiente --dry-run
node scripts/site/deploy/azure-container-apps.js --config <archivo> --phase ambiente --apply
# agregar las dos vueltas al registro de Entra ID
node scripts/site/deploy/azure-container-apps.js --config <archivo> --phase sitio --dry-run
node scripts/site/deploy/azure-container-apps.js --config <archivo> --phase sitio --apply
```

La fase `ambiente` crea el grupo de recursos, el área de registros (31 días, tope diario de 0,023 GB) y el ambiente, e
imprime la dirección que tendrá el sitio y las dos vueltas a agregar al registro. La fase `sitio` crea el disco, la
aplicación con la entrada interna, el rol de lectura del buzón y el inicio integrado, y abre la entrada externa al
final. Si un paso falla, la entrada sigue interna, y correrla de nuevo sigue desde donde quedó. Corre con tu sesión de
`az` (no abre un login). El archivo de configuración lleva suscripción, grupo, región, nombres, inquilino, la imagen por
su huella y el identificador del cliente, y ningún secreto; la cabecera del guion dice cada clave. El repo del perfil va
en la instalación normal: su dirección en `profileRepo` del archivo, y su token en `SITE_PROFILE_TOKEN`, en el entorno de
quien corre el alta, como los otros secretos. Sin los dos, la pestaña Configuración dice «falta el repo del perfil».

- **Inicio de sesión:** dos candados. Delante, el inicio integrado de la plataforma con el mismo registro de Entra ID,
  de un solo inquilino y con «asignación requerida» (las personas se asignan una por una; asignar un grupo pide una
  licencia Entra ID P1/P2). Detrás, el del sitio. `/healthz` y `/livez` quedan fuera del candado.
- **Disco:** un recurso compartido de Azure Files en una cuenta de almacenamiento propia del sitio (centavos por mes),
  nunca en la cuenta del buzón.
- **Secretos:** secretos de la aplicación. Sus valores llegan por variables de entorno de quien corre el alta, con los
  nombres de la tabla. El buzón se lee con la identidad administrada, sin secreto. El repo de operaciones, de una de dos
  formas (`operationsIdentity` en el archivo de configuración): `managed`, la identidad del sitio, sin secreto; o
  `token`, un token de sólo lectura (*Code: Read*) en `SITE_OPERATIONS_TOKEN`, que vence y hay que rotar.
- **Se duerme:** escala a cero, sin costo mientras duerme. Con 1 GiB la cuota gratis cubre unas 100 horas despierto por
  mes, y pasarse cobra. El primer pedido después de un rato tarda en contestar. Si no recibe ningún pedido en 90 días,
  Azure puede borrar el ambiente y hay que correr el alta de nuevo.
- **Costo:** cero dentro de las cuotas. Con `operationsIdentity: managed`, leer el repo de operaciones de Azure DevOps
  pide una licencia Basic para la identidad del sitio (gratis las 5 primeras de la organización; después, unos 6
  dólares por mes). **Sin costo de licencia:** `operationsIdentity: token`, con un token de sólo lectura de una cuenta
  que ya tiene la suya; a cambio, el token vence y hay que rotarlo.
- **Actualizar:** se vuelve a correr la fase `sitio` con el archivo de configuración cambiado (la imagen nueva, otra
  identidad, un secreto que se rota). Con la aplicación ya creada, la actualiza: dice qué cambió (la imagen, los secretos
  y las variables que se suman o se van) y deja la entrada como estaba.
- **Quién la corre:** necesita Contributor sobre el grupo de recursos y Owner o User Access Administrator sobre la
  cuenta del buzón (sólo para dar el rol). La región es la de la cuenta del buzón.

### Render

El plan gratis de Render, con `scripts/site/deploy/render.yaml` como plano (*Blueprint*). Cambiá la imagen por la
huella de la versión que instalás.

- **Inicio de sesión:** sólo el del sitio; Render no pone un candado delante.
- **Disco:** el plan gratis no tiene. Sin `SITE_DATA_DIR`, lo que sale de las conversaciones queda «no medido» y un
  reinicio reinicia el plazo de 24 horas de una configuración rota. Con un disco de Render (pago) montado en `/data` y
  `SITE_DATA_DIR=/data`, queda completo.
- **Memoria:** 512 MB en el plan gratis, menos que el 1 GB que pide el sitio para armar la vista de corridas con sus
  conversaciones. Sin medir todavía si el armado sin conversaciones entra: si no, un plan pago.
- **Secretos:** en el panel del servicio. El plano los pregunta sólo al crear el servicio (`sync: false`); rotar uno se
  hace en el panel. El buzón, con la SAS de sólo leer y listar.
- **Se duerme:** a los 15 minutos sin tráfico, y despierta en un minuto, más o menos (la prueba sin sesión lo espera).
  750 horas por mes por espacio de trabajo: un solo servicio entra. Sin medio de pago, si se pasa, Render suspende el
  servicio hasta el mes siguiente: no cobra.

### Una máquina propia

Un Docker en un servidor de la oficina, con `scripts/site/deploy/local/compose.yaml` y los secretos en un `sitio.env`
(copiá `sitio.env.example`) **fuera de todo repo**. Se arranca con `start.js`, que se niega si el archivo está dentro de
un repo git (un commit de más lo subiría con todos los secretos) o si lo pueden leer otros usuarios de la máquina:

```bash
cp scripts/site/deploy/local/sitio.env.example <carpeta fuera del repo>/sitio.env && chmod 600 <carpeta fuera del repo>/sitio.env
node scripts/site/deploy/local/start.js --secrets-file <carpeta fuera del repo>/sitio.env
```

`compose.yaml` no nombra ningún archivo de secretos: lo recibe de `start.js`. Con `--dry-run`, `start.js` dice la orden
sin arrancar nada.

- **Cómo se llega**, lo más seguro primero: (1) **sólo la red interna** de la oficina, con un nombre interno y el
  certificado de la autoridad interna de la organización; (2) por la **VPN** de la organización; (3) recién después, un
  **túnel** público, con el candado del proveedor del túnel delante (el inicio de sesión de la organización) además del
  del sitio. El contenedor publica el puerto sólo en `127.0.0.1`, y delante va un proxy con TLS.
- **Inicio de sesión:** el del sitio, más el del proxy o el del túnel si la organización lo tiene.
- **Disco:** el volumen de Docker `sitio-datos`.
- **Secretos:** `sitio.env`, fuera de todo repo, sólo legible por quien corre el contenedor. El buzón, con la SAS.
- **Se duerme:** no. El costo es la máquina.
- **La prueba de la noche:** corre en un agente de la nube y no alcanza una red interna. El aviso dice «sitio: no se pudo
  probar desde el nocturno», sin enlace, salvo que la organización corra el proceso de la noche en un agente propio
  dentro de la red.

## Por dentro, para quien mantiene el arnés

Cómo está hecho el sitio, para quien lo cambia. Cada pieza tiene sus pruebas en `scripts/tests/` (`site-*.test.js`).

### El servidor

Un servidor de Node sin dependencias, en Docker (`scripts/site/Dockerfile`) o con Node solo, que no depende de Claude ni
de Codex.

- **El inicio de sesión lo hace el propio sitio** (`oidc.js` y un archivo por proveedor en `auth-providers/`: el `oidc`
  genérico, Entra ID, Google y GitHub), con código de autorización, PKCE, `state` y `nonce`. La firma del `id_token` la
  verifica `crypto` (sólo RS256 y ES256), y cada chequeo tiene su prueba con un token armado mal. Cada proveedor se
  limita a la organización a su manera. **La identidad nunca sale de una cabecera** de un proxy o de la plataforma.
- **La sesión vive en una cookie firmada**, de 8 horas fijas, igual que el intento de inicio: el sitio puede reiniciarse
  o tener varias réplicas. **El rol se recalcula en cada pedido** (`access.js`). Mantenedor es quien está en
  `site.maintainers` de `operations.json` (o el primer mantenedor de la instalación mientras esa lista no existe).
  Persona es quien tiene una máquina en `people` de `operations.json`. El resto queda sin rol y ve una página sin datos.
- **Un solo camino para los datos**: la tabla de rutas de `server.js`. Una ruta que no declara quién puede verla hace
  que el sitio no arranque, y cada ruta recibe el modelo ya filtrado para quien pide.
- **Lee directo de las fuentes** (`sources.js`): el repo de operaciones, clonado con la credencial en una cabecera
  (nunca en el disco), y el buzón de corridas con una SAS de sólo lectura o la identidad administrada. Lo de cada nube
  vive sólo en `cloud/`. Las fotos se copian con lista blanca: ningún título, diagnóstico ni mensaje llega al modelo. En
  pantalla se ve un estado de lista cerrada, y el motivo crudo va sólo al registro.
- **El refresco** es cada 15 minutos y conserva el último bueno. Si `operations.json` deja de validar, vale el último
  bueno 24 horas, con una banda para quienes mantienen; después el sitio se frena para todos. El plazo se guarda en
  `SITE_DATA_DIR`. La imagen deja `/data` del usuario del sitio y la declara volumen, así un volumen nuevo nace
  escribible. La bajada del buzón va de a varios archivos a la vez dentro de su tope de 2 minutos; si corta, la pasada
  siguiente sale a los 10 segundos y retoma donde quedó. La navegación no espera todo: con el repo de operaciones
  leído, las pestañas se ven, y sólo Corridas espera el buzón. Toda página de carga se recarga sola cada 5 segundos.
- **Las pestañas** (`views.js`) las arma el servidor, sin JavaScript de afuera y sin `<script>` en línea. «No medido»
  nunca es 0.
- **Lo que no hace:** no escribe en ningún repo salvo los pedidos de la pestaña Configuración, no acciona nada, y no
  baja conversaciones salvo para la pestaña Corridas, con `site.mailbox.threads` y un disco.

### La pestaña Configuración

Sólo para quienes mantienen (`tabs/config.js`, con todas sus rutas registradas como `maintainer`: un dev recibe 403 sin
un dato). Es la configuración de la organización, no la de ninguna máquina.

- **Un núcleo común** (`scripts/lib/org-config.js`): las secciones (qué parte de qué archivo, de qué repo, con qué
  lector) y «Revisar», que aplica el borrador sobre el archivo tal como está y lo valida entero con el mismo lector que
  usa el arnés (`team-repos.js`, `operations-config.js`, la lectura que exporta `check-product-parity.js`). El resto del
  archivo queda byte por byte. No hay un validador propio: dos validadores se separan solos, y el proceso de la noche
  juzga con el suyo. La página local `harness.js team-config` usa el mismo núcleo.
- **Las claves que llegaron después tienen su versión** (`TEAM_REPOS_SINCE`, `MERGE_SUITES_SINCE`, `MODELS_SINCE`,
  `WAIT_NOTICE_SINCE`, `RESPONSE_SINCE`): un cambio se propone sólo si el perfil del equipo pide una versión del arnés
  que lo sepa leer. Una sección cuyo lector todavía no sabe leer su clave dice «esta versión del arnés todavía no sabe
  leer».
- **Se guarda con una rama y un pedido, nunca en la rama principal** (`scripts/lib/repo-proposal.js`): desde el clon
  temporal que el sitio ya tiene, sin tocar su árbol ni su índice. El pedido se abre por la API REST de Azure DevOps o
  de GitHub y dice quién lo pidió. Un pedido por archivo. Si el archivo cambió desde que se abrió la sección, o ya hay un
  pedido abierto sobre él, no se crea nada.
- **Sin una política que pida revisión en `main`, «Proponer» queda apagado.** En Azure DevOps vale una política
  «Minimum number of reviewers» sobre toda la rama, o una «Required reviewers» con filtro de ruta, y con el filtro
  «Proponer» se habilita archivo por archivo: sólo en las secciones cuyo archivo el filtro cubre. En las dos, el voto de
  quien crea el pedido no puede contar. En GitHub vale la protección de la rama o una regla que pida pull request; con
  la regla de empuje por ruta el sitio no propone.
- **Cada escritura se defiende dos veces:** el `Origin` del sitio (o `Sec-Fetch-Site: same-origin`) y un token de doble
  envío (`X-Site-Token`); después, JSON y un cuerpo de hasta 256 KB.
- **Una sola credencial de escritura al nacer**, `SITE_OPERATIONS_WRITE_TOKEN`; las demás, opcionales y apagadas. Sin
  identidad de escritura, la pestaña valida y el navegador arma la descarga del archivo validado.
- **Umbrales sólo cuando el proceso de la noche los lee de verdad:** la sección los edita recién cuando la noche dejó la
  marca `.dashboard/applied-config.json` con ese archivo adentro.

### La pestaña Corridas

La vista de corridas en el sitio, cada uno lo suyo (`tabs/runs.js` sobre `scripts/nightly/dashboard/runs.js`: un solo
código para la vista local y la del sitio).

- **El filtro lo hace el servidor, antes de cada respuesta** (`filtrarCorridas` de `access.js`). Una corrida ajena, una
  sin máquina y un id que no existe contestan igual: 404 sin cuerpo.
- **Lo que viaja, por partes:** la lista, el detalle al abrir una corrida y los textos al abrir un cambio. Cada corrida
  tiene un id estable (16 hexadecimales del sha256 de máquina y sesión).
- **El armado en un hilo aparte**, con techo de memoria: medido con 551 corridas, 34 segundos y unos 690 MB de pico.
  Mientras rearma, o si falla, sirve el anterior entero con su hora.
- **Las conversaciones, sólo con disco** (`site.mailbox.threads: true` y `SITE_DATA_DIR`). Sin eso, lo que sale del hilo
  dice «no medido». Con eso, cada conversación se baja una vez, por tandas de hasta 300 MB, y se resume: la
  descripción de la corrida, el reparto del tiempo y la lista de cambios. Después se borra del disco. La tabla y el
  detalle salen del resumen. Los textos de los cambios (los parches) se bajan cuando alguien abre los cambios de una
  corrida, y quedan en un caché de 200 MB en el disco del contenedor; al llenarse, se borran los abiertos hace más
  tiempo. El espejo borra lo que ya no está en el buzón.

### El aviso de la mañana y la prueba sin sesión

- **El canal** (`scripts/lib/notify.js`): el único camino de salida de los avisos de la noche. Lo elige
  `operations.json → notify`; sin `notify` no se manda. Telegram por su guion; Slack y Teams por su webhook, cuya
  dirección nunca se imprime.
- **El texto lleva sólo cantidades y el enlace** (`daily-summary.js`): ningún nombre de proyecto, repo, paquete,
  producto, persona, host ni id. El detalle queda en la foto de la noche y en el sitio.
- **La prueba sin sesión** (`scripts/site/check-deploy.js`) corre cada mañana antes del aviso; el enlace va sólo si
  pasó.
- **La imagen** la publica `.github/workflows/site-image.yml` en el registro de paquetes del repo, con la versión del
  arnés y `sha-<commit>` como etiquetas y una constancia de origen. Cada instalación la fija por su huella.

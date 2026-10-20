# El sitio de la organización: qué es, cómo se usa y cómo se instala

Esta guía es para quien nunca vio el sitio. Sirve a quien lo usa todos los días y a quien lo instala por primera vez.
Primero cuenta qué es y cómo se usa; después, cómo se instala.

- **[Usar el sitio](#qué-es-y-para-qué-sirve):** qué es, el primer ingreso, cada pestaña, la configuración, qué ve
  cada persona y los problemas comunes.
- **[Instalarlo](#qué-hace-falta-antes):** qué hace falta, cómo probarlo en tu máquina y cómo dejarlo andando.

Cada paso de esta guía sale del código o de una corrida real. Lo que todavía no se probó en real lo dice en la misma
línea.

Las capturas salen de un sitio de laboratorio con una organización inventada, **Acme**: sus personas, máquinas y
productos no existen. Tu sitio se ve igual, con tus nombres.

## Qué es y para qué sirve

Es una página web para toda la organización. Cada persona entra con la cuenta de la organización y ve lo suyo: sus
tareas, sus pedidos de cambio, sus corridas. Quienes mantienen el arnés ven todo, y además tienen la pestaña
**Configuración**, donde se personaliza la organización (quién es responsable de qué, el canal del aviso, los umbrales).

**Las palabras que usa el sitio**, para quien no programa:

- **El arnés:** el conjunto de reglas, controles y ayudantes con que el equipo programa con Claude. Este sitio muestra
  lo que el arnés mide.
- **Una story:** una tarea de programación descrita por escrito, con lo que tiene que cumplir.
- **El pipeline y una corrida:** el pipeline es el recorrido por pasos con que el arnés acompaña a alguien a hacer una
  story (validarla, planear, programar, probar, revisar). Una **corrida** es una vez que alguien hizo ese recorrido.
- **Un repo:** la carpeta compartida donde vive el código o la configuración, con su historia de cambios. Su **rama
  principal** es la versión que vale.
- **Un pedido de cambio** (en inglés, *pull request*): una propuesta para cambiar un repo. Otra persona la mira y, si
  está bien, la **mergea**: la suma a la rama principal.
- **Los revisores** (también «agentes»): ayudantes automáticos que revisan el trabajo de cada corrida.
- **Los tokens:** la medida de cuánto texto leyó y escribió el modelo; es lo que cuesta una corrida.
- **La foto de la noche:** lo que los procesos de la noche midieron y dejaron guardado. En las fichas aparece como
  «fuente del» y una fecha.
- **El refresco:** cada cuánto el sitio vuelve a leer todo (15 minutos, salvo que la organización elija otro plazo).
- **La mediana:** el valor del medio; la mitad de las corridas está por debajo y la otra mitad por encima.

Cada máquina del equipo sube sus corridas a un lugar compartido, el **buzón de corridas**. Por la noche, unos procesos
del arnés revisan las dependencias (los paquetes de otros que usa cada producto), las pruebas y los productos, y dejan
lo que midieron en el **repo de operaciones** de la organización. El sitio lee esos dos lugares y los muestra.

**Un día de quien mantiene.** A las 4 de la mañana corren los procesos de la noche y dejan su foto en el repo de
operaciones. Al rato llega el aviso de la mañana (Telegram, Slack o Teams), con cantidades y el enlace al sitio. Quien
mantiene abre el enlace y cae en **Inicio**, en «Qué decidir hoy»: una ficha amarilla es algo que espera una decisión
(una dependencia nueva, una prueba que se puso roja anoche) y dice dónde se decide. Si una corrida de alguien quedó
trabada, la busca en **Corridas** y abre su detalle: ahí ve en qué paso se fue el tiempo y qué control encontró algo.
Si una máquina nueva empezó a mandar corridas, Inicio lo cuenta y **Configuración** pide confirmar de quién es: la
confirma, el cambio se propone como un pedido al repo de operaciones, y cuando el pedido entra (solo, con la regla de la
organización; si no, cuando alguien lo aprueba), esa persona empieza a ver lo suyo.

**Un día de un dev.** Entra desde el mismo enlace, o desde la dirección del sitio que guardó. En **Inicio** ve lo suyo:
cuántas corridas hizo en la semana, sus pull requests abiertos y lo que tiene asignado. En **Corridas** ve sólo sus
corridas, y en **Proyectos**, los productos en los que trabaja. Nadie tiene que clonar nada ni correr nada en su
máquina para verlo.

**Quién lo usa:**

- **Quien mantiene el arnés:** lo instala una vez, lo actualiza a conciencia, y edita la configuración desde la pestaña
  Configuración.
- **Cada persona de la organización que programa con el arnés:** entra y ve lo suyo, si está en la lista del sitio.
  Quien no usa el arnés en una máquina no tiene corridas propias, pero ve igual lo demás que es suyo.
- **Alguien que no está en la lista:** no ve nada. Con «cualquier cuenta de Microsoft» puede pasar el inicio de sesión,
  pero el sitio le muestra sólo una página sin datos.

**Lo que no hace.** El sitio muestra; no actúa. No escribe en ningún repo, salvo los pedidos de cambio que propone la
pestaña Configuración, y esos entran como diga la política de rama del repo de operaciones: solos con la regla de la
organización, o cuando alguien los aprueba si la organización pide aprobación («La política de rama del repo de
operaciones», en «Lo común a cualquier instalación»). No corre pipelines, no despliega y no
toca ninguna máquina. Lo que muestra tiene, a lo sumo, el atraso de la última foto de la noche o de la última bajada del
buzón.

**Es opcional.** El arnés funciona entero sin sitio: la configuración vive en los repos del perfil y de operaciones, y
sin sitio se cambia con un pull request a cada uno. Qué necesita cada caso (un dev solo o un equipo, con sitio o sin
él), dónde vive cada configuración y qué puede pisar cada máquina, en la referencia del arnés:
`getting-started/reference.es.md`, «Con sitio o sin sitio».

## El primer ingreso

**La dirección.** La deja quien instaló el sitio: viene en el aviso de la mañana, y quien mantiene la tiene anotada en
la configuración del sitio (para quien mantiene: `site.url`, en la sección «Quién entra al sitio»). Si no la tenés,
pedísela a quien te pasó el enlace o a quien instaló el arnés en tu máquina.

**El inicio de sesión.** El sitio pide la cuenta que eligió tu organización al instalarlo: Microsoft, Google o GitHub.
Si tu organización lo instaló en Azure, la primera pantalla es la de Microsoft. Con «cualquier cuenta de Microsoft», la
primera pantalla tiene dos botones: uno para tu cuenta de Microsoft y otro para los invitados del directorio de la
organización. Pasar el inicio de sesión no alcanza: entrás sólo si estás en la lista del sitio. Después de entrar, el
sitio te muestra Inicio. Arriba a la derecha está tu correo y el botón **Salir**;
abajo a la izquierda, el **Tema** (automático, claro u oscuro).

**El idioma.** Abajo a la izquierda, junto al Tema, está el selector **Español / English**, en todas las páginas
(también en la de quien no está en la lista). La primera vez, el sitio sale en el idioma de tu navegador: inglés si
tu navegador está en inglés, castellano si está en castellano o en cualquier otro idioma. Cuando elegís uno, se
recuerda por persona: entrás desde otra máquina o desde otro navegador y lo ves igual. El sitio guarda sólo una huella
de tu correo y el idioma, nunca el correo, y la borra si salís de la lista. Lo que viene de afuera del sitio (nombres de
repos, productos y máquinas, lo que escribió cada uno) se ve como está. La ayuda sale en el idioma que elegiste.

**Lo que ves la primera vez** depende de quién sos para el sitio:

- **Quien mantiene** ve las cinco pestañas, y en Inicio lo que espera una decisión de toda la organización.
- **Una persona confirmada** ve tres pestañas (Inicio, Corridas y Proyectos), con lo suyo.
- **Alguien que no está en la lista** ve sólo una página que dice con qué cuenta entró, que esa cuenta no está en la
  lista, a quién pedírselo y cómo entrar con otra. No ve el menú de la izquierda ni ningún dato.

![La página de quien no está en la lista: «Tu cuenta no está en la lista»](sitio-de-la-organizacion/capturas/sin-rol.png)

**Tu máquina, todavía sin confirmar.** Cada máquina del equipo sube sus corridas con el correo de git de quien la usa.
Quien mantiene tiene que confirmar que esa máquina es tuya. Hasta que te confirmen, tus corridas las ven sólo quienes
mantienen; vos entrás igual, si estás en la lista, y ves lo demás. Pedíselo a quien mantiene el arnés
(si no sabés quién es, a quien te pasó el enlace o a quien instaló el arnés en tu máquina). Lo confirma en
Configuración, el cambio entra (solo o cuando alguien lo aprueba, según la organización), y a partir del próximo
refresco (a lo sumo 15 minutos después)
ves lo tuyo.

## Las pestañas

A la izquierda está el menú, con las pestañas numeradas. Cada pestaña contesta una pregunta.

**«No medido».** Una ficha rayada y gris dice **no medido** y el motivo, por ejemplo «no hay foto de esta fuente».
«No medido» no es cero ni es verde: quiere decir que hoy ese dato no se pudo saber. Si una ficha sigue así más de un
día, avisale a quien mantiene: el motivo dice qué falta. Algunas no se pueden medir desde el sitio y lo dicen siempre
(por ejemplo, «Retrospectivas pendientes»: viven en la máquina de quien mergeó); ésas no hace falta avisarlas.

### Inicio

**Qué contesta:** ¿qué espera una decisión mía hoy?

Para **quien mantiene** es «Qué decidir hoy»: una ficha por cada cosa que la noche puede traer. Cada una tiene una
etiqueta (**Decidir** en amarillo si hay algo, **Nada** en verde si no hay, **No medido** si no se pudo saber), una
cantidad y la fecha de la foto de donde salió («fuente del»). Algunas traen el enlace «dónde se decide»; las otras se
deciden en el repo de operaciones, donde la noche dejó su foto. Las fichas son:

- **Dependencias:** las nuevas con una vulnerabilidad, las aceptadas que todavía no se arreglaron, y las rechazadas sin
  una deuda declarada (una fecha para pagarla).
- **Vigilante:** lo que el vigilante de producción (un proceso que mira los productos en producción) dejó pendiente, o
  aceptado y sin story.
- **Pull requests abiertos hace más de dos días** y **pedidos cerrados con la vulnerabilidad viva**.
- **Suites rojas** y **casos del banco rojos esta noche:** las pruebas del arnés y los controles del arnés que se
  pusieron rojos anoche.
- **Datos declarados que vencen:** números que alguien anotó a mano con una fecha para revisarlos.
- **Máquinas sin confirmar con corridas** y **retrospectivas pendientes**.

![Inicio de quien mantiene: «Qué decidir hoy», con fichas en Decidir, Nada y No medido](sitio-de-la-organizacion/capturas/inicio-quien-mantiene.png)

Para **una persona** es «Lo tuyo»: sus corridas de los últimos 7 días (con un enlace a Corridas), sus pedidos de cambio
abiertos, lo que tiene asignado (con hasta un día de atraso, porque sale de la foto de la noche) y sus proyectos.

![Inicio de una persona: tus corridas, tus pull requests abiertos, lo que tenés asignado y tus proyectos](sitio-de-la-organizacion/capturas/inicio-persona.png)

**Qué hacer:** una ficha en Decidir se resuelve donde dice su enlace, no en el sitio. Cuando se resuelve, la ficha pasa
a Nada con la foto de la noche siguiente.

### Corridas

**Qué contesta:** ¿cómo vienen las corridas del pipeline? ¿Dónde se fue el tiempo y qué encontraron los controles?

Arriba, el alcance: cuántas corridas se leyeron y de qué máquinas. Después, «Lo que se mira primero» explica los dos
resultados de un control: **encontró un error** (una prueba o la compilación no pasaron y se arreglaron ahí mismo) y
**frenó** (el control no dejó pasar algo). Los dos son el control haciendo su trabajo, no un problema. Al lado de cada
mediana, **n=** dice de cuántas corridas sale el número.

Debajo hay un **filtro** (fechas, producto, máquina, sólo las que tienen consumo medido, sólo las que llegaron al último
paso) y fichas con los números del filtro: cuántas llegaron al final, cuánto dura una corrida, en cuántas un control
encontró un error, cuántos agentes se lanzaron y cuánto se consumió.

![Corridas: el alcance, «Lo que se mira primero» y las fichas del filtro](sitio-de-la-organizacion/capturas/corridas-tabla.png)

Más abajo está **«Corrida por corrida»**: una fila por corrida, de la más nueva a la más vieja. La barra de cada fila
reparte el tiempo entre los pasos del pipeline, con los colores de la leyenda: 0 Arranque, 1 Validar la historia, 2 Armar
el plan, 3 Aprobar el plan, 4 Implementar y correr las pruebas, 5 Revisores, 6 Hallazgos: el informe, 7 Hallazgos: la
decisión y 8 Preparar el commit. «Sin marca» es un tramo que la corrida no anotó.

![La leyenda de los pasos y la tabla «Corrida por corrida»](sitio-de-la-organizacion/capturas/corridas-leyenda.png)

**Un clic en una fila** abre su detalle: la línea de tiempo con cada paso y cada control en su carril, qué encontraron
los controles, los revisores que corrieron, el consumo en tokens por paso y los archivos que tocó. La leyenda de la
línea de tiempo: un **círculo verde** es que el control miró y dejó pasar; un **triángulo rojo**, que encontró un
error; un **cuadrado negro**, que no dejó pasar; un **círculo punteado**, que no quedó registrado cómo salió; una
**raya naranja**, que arranca otra vuelta de revisores; una **raya vertical**, un paso marcado junto con el anterior; el
**gris**, el tiempo entre pasos; y un **recuadro naranja**, el tiempo esperando a una persona (una pregunta sin
contestar). Si el detalle muestra un comando para correr, es para quien mantiene el arnés. Los archivos se ven
sólo si la organización decidió bajar las conversaciones (sección «Conversaciones de las corridas»).

![El detalle de una corrida: la línea de tiempo, los controles, los revisores y el consumo](sitio-de-la-organizacion/capturas/corridas-detalle.png)

**Qué hacer:** una corrida que «quedó en el 4» puede estar en curso o abandonada; su detalle dice hasta dónde llegó.
Una persona ve sólo las corridas de sus máquinas confirmadas; quien mantiene ve todas.

### Proyectos

**Qué contesta:** ¿cómo va cada producto?

Una fila por producto: las stories en curso (y cuántas en revisión), las paradas hace más de 30 días, las bloqueadas,
qué versión está en prueba y cuál en producción, si espera una aprobación, si el vigilante lo mira, sus vulnerabilidades
vivas y cómo da contra los otros productos (la paridad). Abajo, el total sin contar dos veces lo compartido. Una persona
ve los productos en los que trabaja. La **paridad** compara cada producto con los otros: lo que uno hace y los demás no.

![Proyectos: una fila por producto](sitio-de-la-organizacion/capturas/proyectos.png)

**Qué hacer:** una story parada o bloqueada se destraba en su repo, con su equipo; el sitio sólo la muestra.

### Arnés

**Qué contesta:** ¿los controles del arnés andan? Sólo la ve quien mantiene.

Muestra si cada foto de la noche llegó al día, cuántos casos del **banco de controles** (unas pruebas que confirman que
cada freno del arnés frena lo que tiene que frenar) y cuántas **suites de prueba** (las pruebas del propio arnés) dieron
rojo, el **examen de los revisores** (si los revisores automáticos siguen encontrando lo que tienen que encontrar), y la
versión del arnés que corre el sitio. El
enlace de abajo abre el tablero del arnés en seis preguntas.

![Arnés: las fotos de la noche, el banco de controles, las suites y la versión del sitio](sitio-de-la-organizacion/capturas/arnes.png)

**Qué hacer:** una foto que no llegó o un rojo nuevo se mira en el proceso de la noche que lo produjo.

### Cómo trabaja

**Qué contesta:** ¿qué hace el agente con una historia, paso por paso, en esta organización? Sólo la ve quien mantiene.

Arriba, **Tu organización**: las integraciones prendidas y apagadas (tachadas), los paquetes de revisores activos y las
reglas (cómo se nombran las pruebas, qué pantallas piden prueba de punta a punta, en qué idioma está la aplicación).
Debajo, los pasos del recorrido en orden, y aparte los dos que quedan fuera (otra vuelta de revisores y el cierre en
Azure DevOps). Al elegir un paso se ve:

- **Guías que cita:** el archivo del paso y las guías que nombra.
- **Según la historia:** lo que se suma sólo en algunas historias, con su condición. Por ejemplo, en una historia que
  toca una pantalla: la maqueta en «Armar el plan», su aprobación en «Aprobar el plan», y la prueba con navegador, las
  capturas y la revisión de legibilidad en «Probar en vivo».
- **Revisores:** los del arnés, agrupados por cuándo entran, y los de cada paquete, con su condición.
- **Controles:** los que frenan, avisan o sólo anotan en ese paso. Abajo de todo, los que actúan en cualquier paso.

Cada pieza dice si es **del arnés** o **de tu organización**. Lo que depende de una integración apagada se ve
**apagado en tu organización**.

Todo sale de lo mismo con que corre el arnés: la tabla de pasos, el cálculo de revisores, la lista de controles, los
detectores que deciden cada pieza y el perfil de tu organización. Si una de esas fuentes cambia, la pestaña cambia sola.

**Mejorar una pieza del arnés.** El arnés no se edita desde el sitio. «Ver el código» abre el archivo en el repo público;
«Proponer una mejora» abre un cuadro donde escribís, con tus palabras, qué cambiarías y por qué. «Abrir el pedido en
GitHub» abre un pedido nuevo del repo público con tu texto, la pieza, el paso y la versión ya escritos: lo enviás con tu
cuenta de GitHub. El sitio no guarda ninguna clave para esto.

**Editar un revisor de tu organización.** Los revisores de los paquetes que viven en el repo del perfil llevan «Editar»,
y cada paquete lleva «+ Agregar revisor». Se cambia el nombre, cuándo entra, si el cambio toca qué, qué archivos mira, el
prefijo de sus reglas y sus instrucciones. «Revisar» lo pasa por el mismo lector con que el arnés carga los paquetes: con
un problema, lo dice y «Proponer» queda apagado. «Proponer» arma un solo pedido al repo del perfil con el paquete y las
instrucciones del revisor, y lo aprueba otro mantenedor, como en Configuración. Borrar un revisor se hace a mano en el
repo del perfil.

**Qué hacer:** si una pieza no se entiende o falta algo, «Proponer una mejora». Si un paquete de tu organización dice
que no se puede usar, se arregla a mano en el repo del perfil: hasta entonces el arnés tampoco lo carga.

### Configuración

**Qué contesta:** ¿cómo está configurada la organización, y cómo se cambia? Sólo la ve quien mantiene. La parte
siguiente la cuenta sección por sección.

Arriba hay cuatro fichas: las máquinas por confirmar, las secciones con algo para arreglar, las secciones al día y las
máquinas con una versión vieja del arnés o «sin noticias» (que no mandan corridas hace un tiempo, así que no se sabe qué
versión tienen). Debajo, cinco pestañas: **Personas**, **Repos y productos**, **Avisos y la
noche**, **Cómo trabaja Claude** e **Instalación y actualización**. Un número al lado de una pestaña dice cuántas cosas
esperan ahí.

![Configuración: las cuatro fichas de arriba y la pestaña Personas](sitio-de-la-organizacion/capturas/configuracion-personas.png)

## Configuración, sección por sección

Cada sección es una parte de un archivo de configuración que vive en un repo de la organización: el **repo de
operaciones** (lo de la noche y del sitio) o el **repo del perfil del equipo** (lo que llega a cada máquina). Cada una
dice arriba a la derecha cómo está: **al día**, **por confirmar**, **sin configurar**, **sólo para mirar**, o
**revisada** mientras tenés un cambio revisado sin proponer.

**El ciclo de un cambio.** Nada se escribe directo. Cambiás los campos de una sección y apretás **Revisar cambios**: el
sitio valida el cambio con las mismas reglas que usa el arnés y dice «Revisado: está bien escrito» o qué está mal.
Después, **Proponer el cambio** muestra, arriba, un resumen en castellano de lo que cambia («Sumás a x@acme.example como
dev en Quién entra al sitio», «Cambiás “Tope de caracteres” de 1300 a 1500») y, debajo, sólo los renglones que cambian,
con tres de contexto: lo que sale va en rojo con un `−`, lo que entra va en verde con un `+` (el signo está para que se
lea sin depender del color), y los tramos iguales se juntan en «… N renglones iguales». Si querés ver los dos archivos
enteros, **Ver los archivos enteros** los abre. El archivo está escrito en un formato con llaves y comillas; no hace
falta entenderlo: mirá que lo único que cambie sea lo que cambiaste. **Confirmar y proponer** abre un pedido de cambio
(un pull request) en el repo de esa sección, y la sección muestra el enlace al pedido. El envío se hace **una sola
vez**: mientras el sitio trabaja, los botones y los campos de la sección quedan apagados, y cada propuesta lleva una
marca propia, así que un doble clic no crea dos pedidos. Si la respuesta se corta (la red, un reinicio del sitio en
medio del pedido), la página no da el error enseguida: consulta hasta tres veces, a los 2, 5 y 10 segundos, si el pedido
de esa propuesta existe, y si existe muestra su enlace. Sólo si no lo encuentra dice el error, que pide recargar y mirar
si el pedido se abrió antes de repetirlo. La página nunca reenvía la propuesta sola. Alguien del equipo lo revisa y lo mergea.

No hace falta recargar la página. Mientras el pedido está abierto, la página pregunta cada 10 segundos si ya entró, hasta
10 minutos; con la pestaña oculta deja de preguntar y retoma al volver. Cuando el pedido entra o se cierra, el sitio
relee el repo y la página toma la versión nueva. Si mientras cargabas alguien cambió **otra parte** del mismo archivo,
tu cambio se pone encima de la versión nueva y la diferencia lo muestra antes de que confirmes de nuevo. Si cambió **lo
mismo** que vos, la sección muestra cada valor con las dos versiones: **Quedarme con el mío** o **Tomar el de ahora**, y
lo que cargaste no se pierde. Una lista cuenta como un solo valor: si los dos tocaron la misma lista, se elige la lista
entera. Si recargás la página con algo sin proponer, la sección ofrece **Recuperar lo que estabas cargando**. Lo cargado
vive en tu navegador mientras la pestaña está abierta, nunca va al sitio. En un navegador que no deja guardar (una
ventana privada, por ejemplo) la página anda igual, sin esa oferta. Las diferencias aceptadas entre productos no se
mezclan: si su archivo cambió, piden recargar como antes.

**Descargar** baja el archivo cambiado, para
cuando el sitio no puede proponer: se lo pasás a quien tiene acceso a ese repo, que lo sube con un pedido de cambio.

![Una sección cambiada y revisada: «Revisado: está bien escrito»](sitio-de-la-organizacion/capturas/configuracion-revisado.png)

![Antes de proponer: el archivo de hoy y el archivo después del cambio, con «Confirmar y proponer»](sitio-de-la-organizacion/capturas/configuracion-diferencia.png)

![El pedido abierto: la sección muestra su enlace](sitio-de-la-organizacion/capturas/configuracion-propuesto.png)

**Lo que se ve «para mirar».** Algunas secciones se muestran sin poder cambiarse, y dicen por qué. Por ejemplo,
«Azure DevOps» cuando el repo del perfil vive en GitHub, una sección que la versión del arnés que pide el perfil
todavía no sabe leer (la sección dice qué versión pedir), o los umbrales mientras la noche todavía no lee el archivo de
la organización. Para cambiarlas, primero hay que cumplir lo que dicen.

Las secciones, en el orden de la pantalla:

### Personas

- **La organización**: el nombre y el logo que muestra la barra de arriba y el pie. Queda en `operations.json`, en el
  repo de operaciones. Lo revisa quien mantiene.
- **Quién entra al sitio**: la lista de quién entra y qué ve, una fila por persona, con su rol («Mantiene el sitio» o
  «Dev») y uno o más correos. Nadie entra si no está acá, con cualquier inicio de sesión. Quienes mantienen ven la
  pestaña Configuración y proponen cambios; los devs ven lo suyo. Una persona entra con cualquiera de sus correos y ve lo
  mismo. Para sumar a alguien: Configuración, en Personas, «Quién entra al sitio» → **+ Agregar persona**, su correo y su
  rol; se hace acá, sin el portal de Microsoft. La primera vez la sección trae la lista armada con lo de antes (quienes
  mantenían y cada persona con una máquina confirmada) y avisa que todavía no está guardada: se guarda al proponerla.
  Si alguien sale de la lista, en cuanto se aprueba el pedido y el sitio se actualiza (a lo sumo 15 minutos), su
  próxima página es la de «Tu cuenta no está en la lista», sin datos. Arriba de la lista se ve con qué se entra al
  sitio; eso se cambia en la instalación. También van acá el buzón de corridas, el refresco y la dirección del sitio.
  Queda en `operations.json`, en el repo de operaciones. Lo revisa otra persona que mantiene. **«Cada cuánto se
  actualiza el sitio»** acepta de 5 a 120 minutos; sin declarar, 15. Más corto, un cambio se ve antes, pero el sitio
  vuelve a leer el repo de operaciones, el del perfil y el buzón más seguido mientras está despierto: más lecturas a
  la nube, que en una instalación que cobra por uso cuestan algo más. No lo mantiene despierto: dormido no lee nada, y
  al despertar lee todo.
- **Cada cuánto el sitio relee sus datos** (`site.refresh_minutes`, también en «Quién entra al sitio»): cada cuántos
  minutos el sitio vuelve a leer la configuración (este repo de operaciones), el buzón de corridas y el perfil del
  equipo. Va de 5 a 120 minutos; si no lo declarás, son 15. No instala versiones: eso es «Cómo se actualiza el sitio»,
  en Instalación y actualización.
- **Los cambios de un mantenedor**: si un cambio que propone quien mantiene el sitio entra solo, o queda un pedido para
  que lo apruebe otra persona. Viene apagada: sin declarar, queda el pedido. La regla de la organización la prende
  («La política de rama del repo de operaciones», más abajo). Prendida («sí», `site.auto_apply` en
  `operations.json`), «Proponer» abre el pedido, lo aprueba con la identidad del sitio y lo completa; enseguida el sitio
  vuelve a leer el repo y la sección dice «Aplicado». Sólo pasa si las políticas de la rama principal quedan cumplidas
  con ese voto: si piden algo más (otro revisor, un revisor nombrado, un build), el sitio dice qué falta y deja el
  pedido para aprobar. En GitHub siempre queda el pedido: quien abre un pedido no puede aprobarlo. Antes de proponer, al
  lado del botón, la sección dice qué va a pasar. Queda escrito quién lo hizo: la descripción del pedido nombra a quien
  lo pidió, y el registro del sitio anota `cambio aplicado: <archivo> por <correo>, pedido <enlace>`. Cuenta la opción
  que ya está en el repo: el cambio que la prende queda para aprobar como cualquier otro, y recién después los cambios
  entran solos. Queda en `operations.json`, en el repo de operaciones.
- **Cómo se actualiza el sitio**: si el sitio se pone al día solo con la versión nueva del arnés o sólo avisa (`site.update`
  de `operations.json`). Sin declarar, sólo aviso. «Automático» pide el nocturno de actualización y su permiso: la receta,
  en «Cómo se mantiene al día».
- **Personas y máquinas**: de quién es cada máquina que manda corridas, y en qué proyectos trabaja cada persona. Una
  máquina nueva aparece en «Por confirmar» con el correo que dice ser; **Confirmar** la pone a nombre de esa persona.
  Queda en `operations.json`, en el repo de operaciones. Lo revisa quien mantiene.
- **A quién le llegan los avisos y los pedidos**: a quién se asigna lo que la noche encuentra (una dependencia vieja,
  un hallazgo del vigilante). Queda en `operations.json`, en el repo de operaciones. Lo revisa quien mantiene.

![Personas y máquinas: una máquina por confirmar y las confirmadas](sitio-de-la-organizacion/capturas/configuracion-confirmar-maquina.png)

### Repos y productos

- **Dónde vive cada repo**: dónde están el arnés, el perfil del equipo y el repo de operaciones. Llega a todas las
  máquinas. Queda en `team-repos.json`, en el repo del perfil. Lo revisa quien mantiene el arnés.
- **Despliegues de cada producto**: qué paso de cada pipeline es la prueba y cuál es producción, para que Proyectos
  diga qué versión está afuera. Queda en `operations.json`, en el repo de operaciones. Lo revisa quien conoce los
  pipelines del producto.
- **Diferencias aceptadas entre productos**: lo que un producto hace distinto a propósito, con una fecha para volver a
  mirarlo; la noche no lo cuenta como diferencia. Queda en `scripts/ci/product-parity.json`, en el repo de operaciones.
  Lo revisa quien mantiene el arnés.
- **Azure DevOps**: la organización de Azure DevOps del equipo. Llega a cada máquina. Queda en `team-profile.json`, en
  el repo del perfil. Lo revisa quien mantiene el arnés.

Debajo están **Productos** (los que revisa la noche) y **Lo que trae la organización** (las skills, los revisores,
las guías del alta y los paquetes del repo del perfil, cada uno con su enlace). Son para mirar: se cambian con un pedido
en su repo.

![Repos y productos](sitio-de-la-organizacion/capturas/configuracion-repos.png)

### Avisos y la noche

- **Dónde llega el resumen de cada mañana**: el canal del aviso (Telegram, Slack o Teams). Queda en `operations.json`,
  en el repo de operaciones. Lo revisa quien mantiene.
- **Aviso de espera**: cuántos minutos espera una corrida a una persona antes de avisar. Llega a todas las máquinas.
  Queda en `team-repos.json`, en el repo del perfil. Lo revisa quien mantiene.
- **Umbrales: cuándo algo se pinta verde o rojo**: los límites con que el tablero colorea cada número; entre los dos,
  amarillo. Queda en `scripts/nightly/dashboard/sources.json`, en el repo de operaciones. Lo revisa quien mantiene.
- **Fichas que muestra el sitio**: una casilla por cada ficha del tablero de la noche que el sitio muestra en Arnés,
  Proyectos y Corridas. Destildá las que no uses: dejan de armarse y de mostrarse, y Arnés dice cuántas hay ocultas.
  Queda en `operations.json`, en el repo de operaciones (`site.hidden_cards`). Lo revisa quien mantiene.

![Avisos y la noche](sitio-de-la-organizacion/capturas/configuracion-avisos.png)

### Cómo trabaja Claude

- **Cómo contesta Claude**: el idioma, el estilo y el largo de las respuestas en todas las máquinas. Queda en
  `team-profile.json`, en el repo del perfil. Lo revisa quien mantiene.
- **Qué modelo usa cada trabajo del pipeline**: el modelo de los revisores, del pase adversarial, de los ayudantes y de
  la sesión, en una tabla por grupo con el valor por defecto de cada trabajo al lado; «el por defecto» deja el que trae
  la versión instalada. Con el tope obligatorio, un trabajo elegido por encima del tope se marca en rojo y el cambio no
  se puede proponer. Queda en `team-repos.json`, en el repo del perfil. Lo revisa quien mantiene, mirando el costo.
- **Dónde corren las pruebas completas al mergear**: en la máquina o en el servidor, repo por repo, un renglón por repo
  (✎ abre sus datos). Un repo sin pipeline de pruebas completas dice qué pasa con su regla. Queda en
  `team-repos.json`, en el repo del perfil. Lo revisa quien mantiene.
- **Cobertura de las pruebas**: el porcentaje de líneas nuevas cubiertas por debajo del cual el control de pruebas
  avisa (avisa, no frena). Queda en `team-repos.json`, en el repo del perfil. Lo revisa quien mantiene.
- **Tu tecnología**: lo que el arnés ya reconoce, las terminaciones de archivo que tu equipo suma como código, las
  herramientas de prueba (las de fábrica, las que tu organización cambió o agregó) y tres reglas: el estilo de los
  nombres de prueba, qué pantallas piden una prueba en el navegador y el idioma de la aplicación. Sin decir nada, el
  arnés no impone el estilo de ningún equipo. Queda en `team-repos.json` → `stack`, en el repo del perfil. Lo revisa quien
  mantiene. Una herramienta que no está en la lista se pide con «Pedíselo a tu agente» (abajo, §Tu tecnología).
- **Quién reenvía el ok de un dev**: la sesión coordinadora que puede pasarle el ok de un dev a la sesión que
  implementa, para eximir un crítico de los revisores o firmar un criterio que no se puede probar en vivo. Vacío, ninguna:
  el ok lo escribe el dev en el chat de su sesión. Vale sólo desde acá, nunca desde una máquina.
- **Integraciones**: qué servicios usa cada máquina (el reloj de horas, la memoria, el buzón, la noche, el índice de
  código de CodeGraph); una máquina puede apagar una para ella sola. Con CodeGraph prendido, el instalador se lo instala
  a cada dev y el arnés avisa si una máquina no lo tiene. Telegram no está acá: es de cada máquina. Queda en
  `team-profile.json`, en el repo del perfil. Lo revisa quien mantiene.
- **Conversaciones de las corridas**: si el sitio baja también lo que se habló en cada corrida; con eso, el detalle de
  Corridas muestra los archivos que tocó. Queda en `operations.json`, en el repo de operaciones. Lo revisa quien
  mantiene.

![Cómo trabaja Claude](sitio-de-la-organizacion/capturas/configuracion-claude.png)

### Tu tecnología

Lo que la persona ve en la sección y lo que hace el agente cuando le piden una herramienta que no está.

- **En el sitio**: los lenguajes que el arnés ya reconoce, las terminaciones que suma tu equipo, la tabla de
  herramientas de prueba y las tres reglas. Las que la puerta de pruebas corre por dentro (.NET, Vitest, Jest y Node)
  se muestran «de fábrica · el arnés la corre por dentro» y no se cambian desde acá. pytest, Go, Maven, Gradle y Karma se pueden
  cambiar: el formulario llega lleno con la de fábrica, y al guardar queda una copia de la organización con el mismo
  nombre que la reemplaza. «Volver a la de fábrica» borra la copia. El comando de una herramienta lo corre la
  computadora de cada persona del equipo.
- **«Pedíselo a tu agente»** deja la frase «configurá las pruebas de mi proyecto en la configuración del arnés». La
  persona la pega en su agente de código, abierto en el proyecto.
- **Lo que hace el agente** con esa frase:
  1. Mira el proyecto: qué herramienta corre las pruebas, el **archivo que la detecta** (el que está en la carpeta del
     proyecto, por ejemplo `Cargo.toml`), el comando, qué reporte deja (JUnit o el JSON de Vitest/Jest) y dónde, y si
     mide la cobertura y en qué formato (Cobertura, lcov, istanbul, JaCoCo o el perfil de Go). `{results}` es la
     carpeta de la corrida.
  2. Arma la entrada de `stack.test_runners` en `team-repos.json` del repo del perfil: `name` (minúsculas y guiones),
     `detect`, `command`, `results` y, si mide, `coverage`.
  3. La valida con el lector de las máquinas antes de proponer:
     `node -e 'console.log(JSON.stringify(require("<arnés>/scripts/lib/team-repos.js").parse(require("fs").readFileSync("team-repos.json","utf8")).sectionProblems || {}))'`.
     Sin problemas en `stack`, la propone como pedido al repo del perfil.
  4. Un admin aprueba el pedido y la herramienta aparece en la lista, donde se puede cambiar.

### Instalación y actualización

- **Cómo se actualizan las máquinas**: qué versión toma cada máquina y si se actualiza sola al arrancar. Queda en
  `team-profile.json`, en el repo del perfil. Lo revisa quien mantiene.
- **Perfil de instalación**: cuánto instala el arnés en cada máquina (mínimo o completo), con la lista de lo que trae
  cada uno. Queda en `team-profile.json`, en el repo del perfil. Lo revisa quien mantiene.
- **Paquetes de la organización**: qué paquetes del arnés (los revisores y las guías de un producto o de un cliente)
  se activan en todas las máquinas. Queda en `team-profile.json`, en el repo del perfil. Lo revisa quien mantiene.

Debajo está **Qué versión del arnés tiene cada máquina**, la que informó cada una con su última corrida. Es para mirar:
las máquinas se actualizan solas al arrancar.

![Instalación y actualización](sitio-de-la-organizacion/capturas/configuracion-instalacion.png)

## Qué ve cada rol

El sitio decide quién sos por tu correo, y sólo con la lista de «Quién entra al sitio»:

| Rol | Inicio | Corridas | Proyectos | Arnés | Cómo trabaja | Configuración |
|---|---|---|---|---|---|---|
| **Quien mantiene** | «Qué decidir hoy», de toda la organización | todas las corridas | todos los productos | sí | sí, y propone cambios a sus revisores | sí, y propone cambios |
| **Persona confirmada** (dev de la lista) | «Lo tuyo» | las de sus máquinas confirmadas | los productos en los que trabaja | no | no | no |
| **Persona con la máquina sin confirmar** (dev de la lista) | «Lo tuyo» | las de sus máquinas confirmadas; las de la máquina nueva, todavía no | los productos en los que trabaja | no | no | no |
| **Sin rol** (no está en la lista) | sólo la página «Tu cuenta no está en la lista» | no | no | no | no | no |

**Cómo se pasa de un rol a otro.** Lo decide quien mantiene, en Configuración, y entra cuando alguien aprueba el pedido:

- Para entrar como **dev**, tu correo tiene que estar en «Quién entra al sitio» con el rol «Dev». Para ver tus corridas,
  además, una máquina tuya tiene que estar confirmada a tu nombre («Personas y máquinas»): aparece sola en «Por
  confirmar» cuando sube su primera corrida.
- Para **mantener**, tu correo tiene que estar en «Quién entra al sitio» con el rol «Mantiene el sitio». La primera
  persona la pone quien instala el sitio, mientras la lista no tiene a nadie que mantenga.
- Para dejar de ver, se saca el correo de la lista.

**La ayuda, adentro.** Esta guía está también dentro del sitio, en la pestaña «Ayuda», y cada rol ve lo que le toca: un
dev ve cómo se usa el sitio y sus problemas comunes; quien mantiene ve además la configuración sección por sección y
cómo se instala. Sale de esta misma guía, en el idioma del sitio.

## Problemas comunes

### No puedo entrar

**Lo que se ve:** «No se pudo entrar», con el porqué; o la página de Microsoft, Google o GitHub no te deja pasar.

**Por qué pasa:** el sitio pide un correo que tu proveedor garantice. Casos comunes: tu cuenta no tiene un correo cargado
en su directorio; tu organización no verificó el dominio de tu correo; o entraste con una cuenta personal de Microsoft
por el botón principal (las cuentas personales que entran directo no se aceptan todavía). También pasa si el navegador
entra solo con otra cuenta.

**Qué hacer:** si sos invitado del directorio de la organización, entrá por el botón de los invitados. Si no, entrá con
la cuenta de tu organización: salí de la otra o abrí una ventana privada. Si el mensaje habla del correo, pedile a quien
administra tu directorio que cargue o verifique tu correo. Para estar en la lista del sitio, pedíselo a quien mantiene.

### Entro y no veo nada

**Lo que se ve:** la página «Tu cuenta no está en la lista», con la cuenta con la que entraste.

**Por qué pasa:** pasaste el inicio de sesión, pero esa cuenta no está en la lista de «Quién entra al sitio». Quizás
estás con otro correo que el de la lista.

**Qué hacer:** si tenés otra cuenta, usá «entrá con esa». Si no, pedile a quien mantiene el sitio que te sume, con el
correo con que entrás. Entra cuando alguien aprueba el pedido y el sitio se actualiza (a lo sumo 15 minutos).

### No veo mis corridas

**Lo que se ve:** entrás, pero en Corridas faltan corridas tuyas.

**Por qué pasa:** la máquina de donde salieron todavía no está confirmada a tu nombre. O el correo con que entrás no es
el correo de git de esa máquina: por ejemplo, la cuenta de Microsoft tiene un nombre de usuario distinto del correo.

**Qué hacer:** pedile a quien mantiene que confirme la máquina. Si el correo no coincide, quien mantiene puede anotar el
otro como tuyo en la configuración de la organización.

### El sitio está frenado

**Lo que se ve:** la página «Sitio frenado», que dice desde cuándo.

**Por qué pasa:** la configuración de la organización (`operations.json`, en el repo de operaciones) no valida hace más
de 24 horas. Durante esas 24 horas el sitio sigue con la última configuración buena y quien mantiene ve un aviso; pasado
el plazo, se frena para todos.

**Qué hacer:** quien mantiene arregla el archivo con un pedido en el repo de operaciones. El sitio se destraba solo en
el refresco siguiente.

![El sitio frenado](sitio-de-la-organizacion/capturas/sitio-frenado.png)

### Cargando las corridas

**Lo que se ve:** «cargando las fuentes» o «cargando las corridas», y la página se recarga sola.

**Por qué pasa:** el sitio acaba de arrancar y todavía está leyendo el repo de operaciones o bajando el buzón de
corridas. La primera bajada del buzón puede tardar unos minutos.

**Qué hacer:** esperar. Si sigue igual más de diez minutos, avisale a quien mantiene.

![Corridas mientras el sitio baja el buzón](sitio-de-la-organizacion/capturas/cargando-corridas.png)

### No se pudo actualizar

**Lo que se ve:** una banda roja arriba, «no se pudo actualizar desde» una hora, con el motivo.

**Por qué pasa:** el último refresco no pudo leer una fuente (el repo de operaciones o el buzón). El sitio sigue
mostrando lo último que leyó bien.

**Qué hacer:** nada, si se va en el refresco siguiente. Si sigue, quien mantiene mira el motivo: casi siempre es una
credencial vencida o un permiso que cambió.

![La banda «no se pudo actualizar»](sitio-de-la-organizacion/capturas/no-se-pudo-actualizar.png)

### «Proponer» está apagado

**Lo que se ve:** en una sección de Configuración, «Proponer el cambio» no está, o está gris, y al lado dice por qué.

**Por qué pasa:** el sitio sólo propone si la rama principal del repo tiene una política de revisión (la de «La
política de rama del repo de operaciones»); sin ninguna, el sitio podría cambiar el repo sin dejar un pedido. También
cuando la política deja que quien crea el pedido lo apruebe («Allow requestors to approve their own changes», en Azure
DevOps) y «Los cambios de un mantenedor» está apagada: el pedido lo crea el sitio, y se aprobaría solo sin que la
organización lo haya pedido. En GitHub, con la regla de empuje por ruta, el sitio no propone `operations.json`. Y cuando
el sitio no tiene permiso para escribir en ese repo, o cuando ya hay un pedido abierto sobre el mismo archivo (la
sección muestra su enlace).

**Qué hacer:** revisá y apretá **Descargar**, y pasale el archivo a quien tiene acceso al repo. Quien mantiene puede
poner la política de la organización (con «Los cambios de un mantenedor» prendida) o dar el permiso de escritura. Con un
pedido abierto, esperá a que se mergee o se cierre.

![«Proponer» apagado, con su motivo: el repo no tiene una política que pida revisión](sitio-de-la-organizacion/capturas/proponer-apagado.png)

### Configuración dice que el sitio rechazó el pedido

**Lo que se ve:** al revisar o proponer, un recuadro rojo con el motivo: «la sesión venció o se cerró: recargá la
página», «tu cuenta … no está entre los que mantienen el sitio», «el sitio está cargando…», o «el pedido lo rechazó lo
que está delante del sitio, no el sitio».

**Por qué pasa:** la sesión venció; o entraste con otra cuenta (el mensaje dice con cuál); o el sitio se estaba
reiniciando; o el inicio de sesión de la nube, delante del sitio, frenó el pedido.

**Qué hacer:** recargá la página. Si dice que tu cuenta no mantiene el sitio, salí y entrá con la cuenta de la
organización. Si dice que lo rechazó lo que está delante del sitio y sigue después de recargar, avisale a quien mantiene
(la guía de instalación, en la receta de Azure, dice cómo se arregla).

### La primera página tarda en abrir

**Lo que se ve:** después de un rato sin uso, la primera página tarda en abrir, a veces más de medio minuto.

**Por qué pasa:** en una instalación que se duerme cuando nadie la usa (Azure Container Apps, Render), la primera
visita la despierta.

**Qué hacer:** esperar; las páginas siguientes abren rápido.

## Qué hace falta antes

- **La imagen del sitio.** Se publica sola en el registro de paquetes del repo público del arnés cada vez que cambia lo
  que trae. También la podés armar vos (abajo).
- **Una forma de iniciar sesión de la organización:** Entra ID, Google Workspace, GitHub, o cualquier proveedor OIDC
  (Okta, Keycloak). En ese proveedor se registra una aplicación para el sitio.
- **El repo de operaciones** de la organización, y una identidad que lo pueda leer (sólo ese repo). Si todavía no lo
  tenés: cómo se crea y qué archivos lleva, en `pipelines/operations/README.md` §2 del arnés (los ejemplos, en
  `pipelines/operations/examples/`). Para el sitio alcanza con `operations.json`; lo mínimo, en la prueba con Docker.
- **Opcional: el buzón de corridas**, si la organización junta las corridas de las máquinas.
- **Un lugar donde correr un contenedor** con HTTPS delante: una nube, un servicio gratis o una máquina propia.

## Probarlo en tu máquina con Docker

Son unos diez minutos, la mayoría armando la imagen. Necesitás Docker abierto, el clon del repo público del arnés y
Node 22 o más nuevo (para la prueba del paso 3).

Acá la dirección del sitio es `http://127.0.0.1`: el sitio exige `https://` en cualquier otra dirección, pero acepta
`http` en la propia máquina, para probar. Lo mismo vale para la dirección del repo de operaciones.

1. **Armar la imagen** (desde la raíz del clon; corrido de verdad: unos 2 minutos la primera vez):

   ```bash
   docker buildx build -f scripts/site/Dockerfile -t sitio:local .
   ```

   **O bajar la imagen ya publicada**, sin armar nada: `ghcr.io/<organización>/<repo>` (la organización y el nombre del repo público del arnés, en minúsculas; la dirección exacta está en la página del repo, en «Packages»), con la etiqueta `stable` (la
   última que pasó el escaneo y la firma) o con una versión, `v<número>`, la misma que dice el sitio (por ejemplo
   `v2026.10.18.21`). Nunca hay una etiqueta `latest`.

   ```bash
   docker pull ghcr.io/<organización>/<repo>:stable
   ```

   Los pasos que siguen sirven con cualquiera de las dos: con la imagen publicada, reemplazá `sitio:local` por
   `ghcr.io/<organización>/<repo>:stable` (o la versión que elegiste) en el `docker run`.

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

   **Lo mínimo del repo de operaciones.** Para que el sitio arranque sin quedar frenado, `operations.json`, en la raíz
   de `main`, necesita al menos esto (con tu correo en lugar del de ejemplo). Medido: con este archivo, `/healthz` da 200
   y la prueba sin sesión pasa.

   ```json
   {
     "version": 1,
     "owners": { "default": "vos@acme.example" },
     "reviewers": { "dependencies": ["vos@acme.example"] },
     "site": { "access": [{ "role": "maintainer", "emails": ["vos@acme.example"] }] }
   }
   ```

   `owners` y `reviewers` son de los procesos de la noche, pero el archivo no valida sin ellos (el registro del
   contenedor dice qué falta: «owners: falta»). Si el sitio queda frenado, el motivo exacto está en ese registro, no en
   `/healthz`. Con un repo así, el registro dice además «el repo de operaciones no trae repos.json» y «sin_foto»: es lo
   normal mientras la noche no corrió.

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
descubrimiento), `microsoft`, `google` o `github`. Se elige en la instalación, y Configuración lo muestra. En el
proveedor se registra una aplicación con la vuelta `<dirección del sitio>/auth/callback` y un secreto de 6 meses como
máximo. Con cualquier proveedor, quién entra y qué ve lo decide la lista del sitio («Quién entra al sitio»): pasar el
inicio de sesión no alcanza.

- **`google` y `github`** se limitan a la organización: el dominio (`SITE_AUTH_ALLOWED_DOMAINS`) o la organización de
  GitHub (`SITE_AUTH_GITHUB_ORG`).
- **`microsoft`, un inquilino** (`SITE_AUTH_MICROSOFT_ACCOUNTS=organization`, por defecto): entran las cuentas del
  directorio de la organización y sus invitados. `SITE_OIDC_ISSUER` es el del inquilino. **Es la elección cuando todos
  los que entran son miembros o invitados del directorio:** una sola puerta, el emisor del inquilino propio con
  `SITE_AUTH_MICROSOFT_ACCOUNTS=organization`.
- **`microsoft`, cualquier cuenta** (`SITE_AUTH_MICROSOFT_ACCOUNTS=any`): entran las cuentas de trabajo o escuela de
  cualquier organización, sin invitarlas al directorio. `SITE_OIDC_ISSUER` es
  `https://login.microsoftonline.com/organizations/v2.0` y `SITE_AUTH_MICROSOFT_TENANT` es el inquilino de la organización:
  por ahí entran sus invitados, con su propio botón. Se entra sólo con un correo verificado por su organización. Las
  cuentas personales de Microsoft que entran directo no se aceptan todavía: no se pudo comprobar que su correo sea
  confiable (un invitado con cuenta personal entra por el botón de los invitados). Esta forma es sólo para aceptar
  cualquier cuenta de trabajo de otras organizaciones, con el emisor `organizations`; nunca `common`. El caso medido: un
  correo que existe como cuenta de trabajo y como cuenta personal cae en la cuenta personal con `common`, y con
  `organizations` cae en la cuenta de trabajo de otro inquilino. Con ninguno de los dos entra a la del directorio propio.
- **El riesgo, en llano:** con «cualquier cuenta», la primera puerta queda abierta a cualquier cuenta de Microsoft, y
  todo el control está en la lista del sitio. Quien no está en la lista ve una página sin datos; ningún pedido le
  contesta un dato. Por eso la lista se cuida como una contraseña: cada cambio es un pedido con quién lo propuso y quién
  lo aprobó.
- El sitio no recibe ningún permiso sobre el directorio de nadie: ni asigna, ni invita, ni lee usuarios.
- **Salir.** El botón **Salir** cierra la sesión y lleva a una página «Saliste», con «Entrar de nuevo» y «Entrar con otra
  cuenta». «Salir» no pasa por el candado de la plataforma ni por Microsoft: la vuelta se queda en el sitio, y la sesión de
  Microsoft sigue abierta (cerrarla te sacaría también del portal y de los repos de tu organización). Por eso, al salir,
  el sitio deja en tu navegador una marca de «salió» (sin datos tuyos, dura 30 días): mientras está, el sitio no vuelve a
  entrar sin un clic tuyo. Recargar, volver con «atrás» o abrir cualquier página muestra «Saliste», y los dos botones te
  piden elegir la cuenta en Microsoft. La marca se borra cuando entrás.
  «Salir» cierra la sesión también para una copia de la cookie: la sesión queda anotada como cerrada en el disco del
  sitio hasta que vence, y una copia que alguien guardó deja de valer. Si el disco falla, o el sitio no tiene disco
  (`SITE_DATA_DIR`), «Saliste» avisa que no se pudo invalidar la sesión en el servidor en vez de decir que saliste: tras un
  reinicio, una copia de la cookie volvería a valer. Con varias réplicas, el disco tiene que ser compartido: si no, una
  réplica no sabe lo que cerró otra.
  Si la carpeta de las sesiones cerradas no se puede leer, el sitio deja entrar igual (cerrarle la puerta a todos sería
  peor) y quien mantiene ve arriba de las pestañas «no se pueden verificar las sesiones cerradas».

### Las sondas

Si tu plataforma tiene sondas, **las dos van contra `/livez`**, con un plazo de respuesta de unos 5 segundos.

- **La de vida, nunca contra `/healthz`.** `/healthz` da 503 con el sitio frenado por una configuración rota. Una sonda
  de vida contra él reiniciaría el contenedor en un lazo, y reiniciar no arregla la configuración.
- **La de lista, tampoco contra `/readyz`.** La plataforma no manda tráfico hasta que esa sonda pasa, y `/readyz`
  espera todas las fuentes, el buzón entero incluido. El sitio ya sirve cada pestaña apenas la puede armar: la que
  todavía espera dice «cargando» y se recarga sola, y la frenada explica por qué. `/readyz` da 200 apenas leyó todas las
  fuentes una vez, **también con el sitio frenado**: es a propósito, para que el sitio siga a la vista y explique por qué
  está frenado. El freno se mira en `/healthz`. `/readyz` queda para quien quiera saber
  si terminó de cargar todo.

### Los secretos, con el menor permiso

Cada instalación dice dónde se guarda cada uno y por dónde entra su valor. **Ningún valor va en un archivo del repo, en
`operations.json`, en el archivo de configuración de una instalación, en la línea de órdenes ni en un plan impreso.**

| Secreto | Para qué | Alcance mínimo |
|---|---|---|
| `SITE_SESSION_KEY` | firmar la sesión | 32 bytes al azar, sólo del sitio |
| `SITE_OIDC_CLIENT_SECRET` | el inicio de sesión | un registro sólo para el sitio, sin permisos de API más allá de `openid email profile` (con `github`, que no es OIDC, el sitio pide `read:user user:email read:org`: leer la cuenta, sus correos y si es de la organización); vence en 6 meses como máximo |
| `SITE_OPERATIONS_TOKEN` (o la identidad de la plataforma, `SITE_OPERATIONS_IDENTITY=managed`, sin secreto) | leer el repo de operaciones | una identidad propia con lectura sólo en ese repo; si es un token, de una organización, sólo lectura de código, 90 días; en GitHub, de grano fino, de un solo repo, `contents: read` |
| `SITE_MAILBOX_SAS` (o `SITE_MAILBOX_IDENTITY=managed`) | leer las corridas del buzón | una SAS de sólo leer y listar (`rl`) atada a una política guardada del contenedor, 6 meses como máximo; o la identidad de la plataforma con un rol de lectura sobre el contenedor |
| el canal del aviso | mandar el aviso de la mañana | no llega al sitio: lo usa el proceso de la noche. Telegram: el token sirve para todo el bot, usá uno dedicado. Slack o Teams: la dirección del webhook ES la credencial |
| `SITE_OPERATIONS_WRITE_TOKEN` | proponer cambios de configuración desde el sitio | en GitHub, de grano fino sobre el repo de operaciones con `contents: write` y `pull_requests: write`; en Azure DevOps, una cuenta dedicada con *Contribute*, *Create branch* y *Contribute to pull requests* sólo en ese repo, *Force push* negado y sin permiso de saltar políticas |
| `SITE_PROFILE_REPO` y `SITE_PROFILE_TOKEN` | leer el perfil del equipo (dónde vive cada repo, los paquetes) | parte de la instalación normal: sin ellos la pestaña Configuración dice «falta el repo del perfil». La dirección del repo del perfil y un token de sólo lectura de código sobre ese repo (puede ser el mismo permiso que el del repo de operaciones, si los dos viven en la misma organización) |
| `SITE_PIPELINES_TOKEN` | leer los pipelines, para elegirlos por nombre en la pestaña Configuración («Pruebas al mergear» y «Despliegues») y ver el nombre de cada paso | parte de la instalación normal en Azure DevOps: sólo *Build: Read*, de la organización, 90 días; puede ser el mismo permiso que el del repo de operaciones con *Build: Read* sumado. Sin él, la pestaña pide el número del pipeline a mano y dice qué falta, y los pasos guardados se ven por su identificador |
| `SITE_PROFILE_WRITE_TOKEN` | proponer cambios al perfil del equipo | apagada por defecto: vacía o comentada, nunca con un valor; una identidad dedicada y un repo por credencial |

`SITE_FIRST_MAINTAINER` no es un secreto: es el correo de quien entra primero como mantenedor, mientras la lista del sitio
(`site.access` de `operations.json`) no tiene a nadie que mantenga. Sacala después.

### De dónde lee operaciones

El sitio lee del repo de operaciones su configuración y lo que deja la noche. Hay tres formas, según dónde vive el sitio
y dónde vive el repo. Se elige una sola: con `SITE_OPERATIONS_SOURCE=copy`, `SITE_OPERATIONS_TOKEN` y
`SITE_OPERATIONS_IDENTITY` sobran y el sitio no arranca si están. `SITE_OPERATIONS_REPO`, en cambio, sigue siendo
obligatoria con la copia: es la dirección del repo donde «Proponer» arma sus pedidos, y sin ella el sitio no arranca.

1. **Copia con la identidad de la plataforma, en Azure** (`SITE_OPERATIONS_SOURCE=copy`,
   `SITE_OPERATIONS_COPY=<cuenta>/<contenedor>`). Un trabajo del repo de operaciones (`site-copy.yml`, en
   `pipelines/operations/` para Azure DevOps y en `pipelines/operations/github/` para GitHub) copia lo que el sitio lee a
   un contenedor, en cada cambio de `main` y una vez por día. El sitio lo lee con su identidad y un rol de lectura sobre
   ese contenedor. El alta de Azure crea la cuenta con la llave apagada: sólo entran identidades con su rol.
   Lo que cuesta: un pipeline más y su identidad, con el rol de escritura sobre el contenedor. Ningún secreto que venza,
   ni una licencia de Azure DevOps para el sitio. Un cambio tarda en verse lo que tarda el trabajo más un refresco.
2. **Copia con una SAS, fuera de Azure** (otra nube o una máquina propia): la misma copia, y el sitio la lee con
   `SITE_OPERATIONS_COPY_SAS`, una SAS del contenedor de sólo leer (`sp=r` o `rl`), atada a una política guardada del
   contenedor para poder revocarla (las órdenes, en la receta de una máquina propia).
   Lo que cuesta: la SAS se firma con la llave de la cuenta, así que esa cuenta necesita la llave de la cuenta prendida,
   y esa llave abre la cuenta entera (leer, escribir y borrar todo). Por eso la copia va en una cuenta propia, nunca la
   del buzón; y la SAS vence (6 meses como máximo) y se renueva a mano.
3. **Lectura directa del repo** (`SITE_OPERATIONS_SOURCE` vacía o `repo`, lo de siempre): el sitio clona el repo con
   `SITE_OPERATIONS_TOKEN`. En GitHub, una aplicación instalada en ese solo repo con `contents: read`, o un permiso de
   grano fino de un solo repo; en Azure DevOps, la identidad del sitio agregada a la organización
   (`SITE_OPERATIONS_IDENTITY=managed`) o un permiso personal de sólo lectura de código.
   Lo que cuesta: el permiso personal vence (90 días) y es de una persona; la identidad en Azure DevOps ocupa una
   licencia. A cambio, un cambio se ve en el refresco siguiente, sin trabajo de copia.

Con la copia, si el trabajo deja de correr el sitio lo dice: con una copia de más de 24 horas, quienes mantienen ven la
banda del último bueno («la copia de operaciones tiene N horas»); con más de 48, el sitio se frena, como cuando el repo
no se puede leer. «Proponer», en la pestaña Configuración, sigue usando `SITE_OPERATIONS_WRITE_TOKEN`: trae `main` recién
en un clon aparte y arma el pedido sobre esa punta.

### Quien puede editar la instalación puede leer sus secretos

Quien tiene permiso para cambiar la instalación (sus variables, su imagen) puede leer todos sus secretos y hacerse
mantenedor: cambiar la llave de la sesión o apuntar a otro repo. Ese permiso, sólo para quienes mantienen el arnés.
Sacar `SITE_FIRST_MAINTAINER` protege de un olvido, no de ese administrador.

### La política de rama del repo de operaciones

La regla es **«todo automático»**: lo que guarda la noche y lo que propone el sitio entra a `main` del repo de
operaciones sin que lo apruebe una persona. Es la misma que dicen los READMEs de los modelos de operaciones
(`pipelines/operations/README.md` y `pipelines/operations/github/README.md`). Ponela antes de publicar el sitio: sin
ninguna política, «Proponer» queda apagado.

**En Azure DevOps**, en *Project settings → Repositories → el repo de operaciones*:

1. *Policies → Branch Policies → main*: **Require a minimum number of reviewers** en 1, sobre toda la rama, con *Allow
   requestors to approve their own changes* **prendido**, *Prohibit the most recent pusher from approving their own
   changes* apagado y *Reset code reviewer votes when there are new changes* prendido. Sin revisores nombrados: un
   «Required reviewers» deja el pedido esperando a esas personas.
2. *Security*: **Bypass policies when pushing** en «Allow» sólo para la identidad de compilación de los nocturnos, que
   guardan empujando a `main`. Nadie más, tampoco la identidad del sitio.
3. En `operations.json`, `site.auto_apply: true` («Los cambios de un mantenedor», en Personas).

Con eso la noche empuja directo, y el sitio abre su pedido, lo aprueba con su identidad y lo completa (la sección dice
«Aplicado»). Una persona no puede empujar a `main` (rebota con `TF402455`): entra por un pedido, que puede aprobar ella
misma.

**En GitHub** la noche entra sola; el sitio, todavía no: quien abre un pull request no puede aprobarlo. La regla es la de
empuje por ruta del README de GitHub: el sitio valida y descarga `operations.json`, y quien mantiene abre el pull
request a mano.

**Lo que se resigna.** Nadie revisa esos cambios antes de que entren. Queda la constancia: cada cambio del sitio es un
pedido con quien lo pidió, y el registro del sitio anota `cambio aplicado: <archivo> por <correo>, pedido <enlace>`.
Quien puede escribir en el repo de operaciones puede hacerse mantenedor del sitio o cambiar un proceso de la noche sin
que otro lo mire: lo que se cuida es quién tiene escritura en ese repo.

**Volver a pedir aprobación.** Si la organización prefiere que otra persona mire cada cambio, en la política del paso 1
apagá *Allow requestors to approve their own changes*. El sitio sigue proponiendo, y el pedido queda para que lo apruebe
otra persona; con `site.auto_apply` prendida, la sección dice por qué no entró solo. Para pedirla sólo en algunos
archivos, se deja la política del paso 1 y se suma una con filtro de ruta (el README de Azure DevOps dice cómo).

### El permiso para «Proponer»

«Proponer el cambio» abre un pedido de cambio en el repo de la sección. Para eso el sitio necesita escribir en ese repo:
`SITE_OPERATIONS_WRITE_TOKEN` para las secciones del repo de operaciones y `SITE_PROFILE_WRITE_TOKEN` para las del
perfil del equipo. En Azure DevOps, un permiso con *Code: Read & write* sobre esos repos, **sin** *Bypass policies when
pushing* ni *Bypass policies when completing pull requests*: el sitio crea una rama y un pedido, nunca escribe `main`.
Con un permiso personal, los pedidos salen a nombre de esa persona. Si la política deja que quien crea el pedido lo
apruebe («Allow requestors to approve their own changes», la regla de la organización), el sitio propone sólo con «Los
cambios de un mantenedor» prendida (abajo): apagada, lo aprobaría el mismo autor sin que la organización lo haya
pedido. Sin el permiso, cada sección dice «Para
proponer desde acá, el sitio necesita permiso para escribir en el repo. Mientras tanto: revisá, descargá y subilo a
mano».

### Los cambios que se aplican solos

Con `site.auto_apply: true` en `operations.json` («Los cambios de un mantenedor», en Personas), el sitio aprueba y
completa cada pedido que propone quien mantiene. Para eso su identidad de escritura necesita, en Azure DevOps, *Code:
Read & write* y *Contribute to pull requests* sobre el repo, y nunca *Bypass policies*: el sitio no saltea ninguna
política, y si una no se cumple con su voto, el pedido queda. La política de revisión de `main` es la de la
organización (arriba): deja que cuente el voto de quien crea el pedido, pide un solo revisor, no prohíbe aprobar a quien
empujó el último cambio y no nombra revisores. Si pide más, el pedido queda y la sección dice qué falta.
Sin ninguna política en `main`, «Proponer» sigue apagado aunque la opción esté prendida. Para encenderla, primero la
imagen nueva, después la clave: una imagen anterior no conoce `site.auto_apply` y daría `operations.json` por inválido
(se queda con el último bueno). Cada cambio aplicado deja su línea en el registro del sitio con el correo de quien lo
pidió; es la única línea del registro que lleva un correo.

### Cómo se mantiene al día

El arnés publica la imagen del sitio con su número de versión y mueve la etiqueta `stable` a esa imagen **sólo** cuando
pasó el escáner y su firma se verificó; `stable` nunca vuelve atrás. Con eso, cada instalación sabe si hay algo nuevo:

- **El aviso, igual para todos.** Quienes mantienen ven arriba de cada pestaña «hay una versión nueva del sitio: X (la
  tuya: Y)», y la pestaña Arnés suma «última publicada». El sitio mira el registro una vez por hora como máximo, sin
  credenciales; si no puede mirar, lo dice y nunca dice «al día» sin haber mirado. El resumen de la mañana trae la línea
  del sitio. La versión no se ve sin sesión.
- **Automático o sólo aviso**, en Configuración → Personas → «Cómo se actualiza el sitio» (`site.update` de
  `operations.json`). **Sin la clave, sólo aviso**: el automático pide permisos que la organización da a conciencia.
  Antes de prenderlo, una actualización a mano que salga bien, y el canal del aviso de la mañana configurado: una
  vuelta atrás deja el nocturno en verde y se cuenta en ese aviso.
- **El automático** lo hace el actualizador del arnés (`scripts/site/deploy/update-site.js`): resuelve `stable`, la
  instala **por huella**, despierta el sitio y le corre la prueba sin sesión. Si la prueba falla, vuelve a la huella
  anterior y lo deja dicho; esa huella no se reintenta hasta que `stable` se mueva. Nunca instala una versión menor que
  la que corre. Cada entorno lo corre con su herramienta: la receta de cada uno trae su párrafo **Al día**.
- **Desde una imagen vieja, la primera va a mano.** Una imagen publicada antes de que la imagen trajera su versión no
  le dice al actualizador qué versión corre, y sin saberlo no instala nada (nunca baja): el resultado dice «no se sabe
  qué versión corre» y la primera actualización va a mano, con la receta de tu entorno. Desde ahí, el automático sigue
  solo.
- **Un paso de una sola vez al pasar a una versión con la página «Saliste».** Si el sitio está detrás del candado de la
  plataforma (el inicio de sesión integrado de la nube), conviene que la página «Saliste» y lo que carga queden fuera de
  ese candado: así se ve aunque el candado haya vencido, sin pasar antes por su inicio de sesión. El actualizador cambia
  la imagen, no la configuración del candado. Se hace una vez, a mano, con la orden de la receta de tu entorno (en su
  «Inicio de sesión»). Las instalaciones nuevas ya lo traen.

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
sesión», «/api contesta con datos», «el sitio está frenado», «/healthz cuenta de más», «falta no-store», «acepta http», «sin Referer: el candado de la plataforma frenaría las escrituras de Configuración»);
2 si no pudo preguntar. Espera hasta 90 segundos la primera respuesta: un sitio dormido tarda en despertar. El aviso de
la mañana lleva el enlace sólo si pasó esa mañana.

También pide sin sesión la página de salida (`/saliste`). Si la contesta el candado de la plataforma en vez del sitio,
la prueba no falla: sale 0 y suma un aviso, «la página de salida queda detrás del candado: con el candado vencido,
«Saliste» pasa antes por el inicio de sesión de la plataforma; la receta de tu entorno trae la orden de una vez». Quiere decir que falta el paso de una sola vez del candado
(dejar libre la página de salida); la receta de tu entorno trae la orden. El aviso de la mañana lo repite junto al enlace.

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

- **Inicio de sesión:** dos candados. Delante, el inicio integrado de la plataforma con el mismo registro de Entra ID.
  Detrás, el del sitio, que decide con su lista. `/healthz`, `/livez`, la página «Saliste» con lo que carga y `/idioma` quedan fuera del candado (sin eso, con el
  candado vencido, «Saliste» pasa antes por su inicio de sesión). Un sitio ya instalado se corrige una vez:
  `az containerapp auth update -g <grupo> -n <app> --excluded-paths /healthz,/livez,/saliste,/idioma,/static/site.css,/static/site.js,/static/fonts/lato-400.woff2,/static/fonts/lato-700.woff2`. Con `microsoftAccounts`
  en el archivo de configuración se elige el modo:
  - `organization` (por defecto): un solo inquilino. Si el registro tiene «asignación requerida», las personas se
    asignan una por una en el portal (asignar un grupo pide una licencia Entra ID P1/P2).
  - `any`: después de poner la aplicación, el guion lee que el registro pida `email` y `xms_edov`, lo pasa a cualquier
    cuenta de Microsoft con tokens de acceso v2 (Azure no acepta el cambio sin eso), saca la asignación requerida y pone
    el candado de la plataforma en el emisor común. Lo hace tu sesión de `az`, que tiene que ser dueña del registro; el
    sitio no recibe ningún permiso nuevo. Antes de correrlo, la lista del sitio tiene que tener a todos los que hoy
    entran (la sección la arma sola con lo de antes: proponela y que se apruebe).
- **El candado y las escrituras:** el inicio integrado protege contra pedidos falsificados mirando el `Referer` del
  navegador, no el `Origin`. Un POST con sesión sin `Referer` del propio sitio lo rechaza con 403, subestado 60 (se ve en
  los registros del área, como `RequestCompleted` del intermediario). Para que «Revisar cambios» y «Proponer» pasen, el
  sitio manda `Referrer-Policy: same-origin`: el `Referer` viaja dentro del sitio y nunca afuera. Una imagen de antes
  mandaba `no-referrer` y la pestaña Configuración no podía escribir; la prueba sin sesión lo avisa. No hace falta tocar
  el CORS ni la convención del proxy del candado.
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

**Al día**: un nocturno propio en el repo de operaciones, `site-update.yml` (en `pipelines/operations/` para Azure
DevOps y en `pipelines/operations/github/` para GitHub), una hora antes del de dependencias. Usa **su propia conexión**,
autorizada sólo para ese nocturno, con **un rol propio sobre la aplicación del sitio y nada más**:

```bash
az role definition create --role-definition '{"Name": "Actualizador del sitio", "Description": "Cambia la imagen del sitio y nada más", "Actions": ["Microsoft.App/containerApps/read", "Microsoft.App/containerApps/write", "Microsoft.App/containerApps/revisions/read", "Microsoft.App/managedEnvironments/join/action"], "AssignableScopes": ["/subscriptions/<suscripción>/resourceGroups/<grupo>"]}'
az role assignment create --assignee-object-id <la identidad de la conexión> --assignee-principal-type ServicePrincipal --role "Actualizador del sitio" --scope /subscriptions/<suscripción>/resourceGroups/<grupo>/providers/Microsoft.App/containerApps/<aplicación>
```

Container Apps pasa el tráfico a la revisión nueva sólo si arranca; igual el nocturno la prueba. Verificación en negativo:
con esa identidad, `az storage account keys list` sobre la cuenta del disco y un `update` sobre otra aplicación del
grupo tienen que fallar.

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

**Al día**: con `site.update: "auto"`, el nocturno (`SITE_PLATFORM=render`) pide el redespliegue por el hook de Render con la
huella de `stable` (`imgURL=<imagen>@sha256:…`). El hook es un secreto (`SITE_RENDER_DEPLOY_HOOK`): nunca sale en el
registro. Render lo hace de fondo; la prueba sin sesión de la noche siguiente lo confirma. Si Render rechaza la imagen (un
404), tiene que ser del mismo registro y nombre que la del servicio.

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

**Al día**: primero el guion del arnés, con un `cron` o un temporizador de systemd:

```bash
# todas las noches a las 03:00: resuelve stable, recrea con SITE_IMAGE=<imagen>@<huella>, prueba /livez y vuelve atrás si falla
0 3 * * * node /opt/arnes/scripts/site/deploy/local/start.js --secrets-file /etc/sitio/sitio.env --update --image ghcr.io/<organización>/<repo>
```

Con systemd, un `.service` de tipo `oneshot` con la misma orden y un `.timer` con `OnCalendar=*-*-* 03:00`. **Watchtower**
queda como alternativa (la copia que mantiene la comunidad, limitada al contenedor del sitio con `--label-enable`): no
prueba ni vuelve atrás, y tiene el socket de Docker, o sea, es administrador de la máquina.

**La copia de operaciones fuera de Azure** (vale también para Render): la SAS de sólo lectura, atada a una política
guardada del contenedor para poder revocarla. La cuenta de la copia necesita la llave prendida para firmarla:

```bash
az storage container policy create --account-name <cuenta> -c <contenedor> -n lectura-sitio --permissions rl --expiry <fecha>
az storage container generate-sas --account-name <cuenta> -n <contenedor> --policy-name lectura-sitio -o tsv
```

### Kubernetes y otras nubes

**No probada por el arnés.** La imagen se fija por huella y se actualiza con las herramientas que siguen etiquetas:
Argo CD Image Updater o Flux (con la estrategia que resuelve `stable` a su huella), o la misma orden de cada nube para
cambiar la imagen de un servicio (Cloud Run: `gcloud run deploy --image <imagen>@<huella>`). Después del cambio, la prueba
sin sesión: `node scripts/site/check-deploy.js --url https://<dirección>`.

### Una red cerrada

Sin salida a internet, el sitio no puede mirar la última publicada y lo dice. La actualización es a mano: en una máquina
con salida, `docker pull <imagen>:stable` y `docker save` de esa huella; se lleva el archivo, `docker load`, y se recrea el
contenedor con `SITE_IMAGE=<imagen>@<huella>`. Después, la prueba sin sesión contra la dirección interna.

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
  o tener varias réplicas. **El rol se recalcula en cada pedido** (`access.js`) y sale sólo de la lista `site.access`
  de `operations.json` (la regla vive en `scripts/lib/people.js`): mantenedor es quien tiene una entrada `maintainer` (o
  el primer mantenedor de la instalación mientras la lista no tiene ninguno); persona, quien tiene una entrada `dev`.
  Sin `site.access`, la lista se arma con lo de antes (`site.maintainers` y las personas de `people.machines`). Una
  persona puede tener varios correos: lo suyo se calcula con todos. El resto queda sin rol y ve una página sin datos.
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
- **Los textos, en los dos idiomas** (`scripts/site/texts.js`): todo texto que el sitio muestra vive en esa tabla, una
  clave con su castellano y su inglés. Para agregar un texto se suma su clave con los dos idiomas y la vista la pide con
  `t(idioma, 'la.clave')`; nunca se escribe en la vista. `site-texts.test.js` frena una clave sin uno de los dos idiomas
  y una página armada en inglés que trae castellano. El idioma de cada pedido lo decide `language.js`: la preferencia
  guardada de la persona (en `SITE_DATA_DIR/idiomas.json`, por huella del correo), la cookie `sitio-idioma`, el
  navegador y, al final, castellano. Los mensajes que el servidor de Configuración arma en castellano se traducen al
  salir con el mismo molde de la tabla. El cuerpo de Corridas y el catálogo de lo que instala el arnés todavía salen en
  castellano.
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
  quien crea el pedido cuenta sólo con `site.auto_apply` prendida: entonces el sitio aprueba y completa el pedido, si su
  voto cumple la política (`politicaDeRevision`, `aplicaSolo`). En GitHub vale la protección de la rama o una regla que pida pull request; con
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

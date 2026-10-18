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
confirma, el cambio se propone como un pedido al repo de operaciones, y cuando alguien lo aprueba, esa persona empieza a
ver lo suyo.

**Un día de un dev.** Entra desde el mismo enlace, o desde la dirección del sitio que guardó. En **Inicio** ve lo suyo:
cuántas corridas hizo en la semana, sus pull requests abiertos y lo que tiene asignado. En **Corridas** ve sólo sus
corridas, y en **Proyectos**, los productos en los que trabaja. Nadie tiene que clonar nada ni correr nada en su
máquina para verlo.

**Quién lo usa:**

- **Quien mantiene el arnés:** lo instala una vez, lo actualiza a conciencia, y edita la configuración desde la pestaña
  Configuración.
- **Cada persona de la organización que programa con el arnés:** entra y ve lo suyo. Quien no usa el arnés en una
  máquina no tiene corridas propias: entra sin rol, salvo que quien mantiene lo sume a la lista de los que mantienen.
- **Alguien de otra organización:** no entra. El sitio deja pasar sólo a la organización.

**Lo que no hace.** El sitio muestra; no actúa. No escribe en ningún repo, salvo los pedidos de cambio que propone la
pestaña Configuración, y esos entran sólo cuando alguien los aprueba. No corre pipelines, no mergea, no despliega y no
toca ninguna máquina. Lo que muestra tiene, a lo sumo, el atraso de la última foto de la noche o de la última bajada del
buzón.

## El primer ingreso

**La dirección.** La deja quien instaló el sitio: viene en el aviso de la mañana, y quien mantiene la tiene anotada en
la configuración del sitio (para quien mantiene: `site.url`, en la sección «Quién mantiene el sitio»). Si no la tenés,
pedísela a quien te pasó el enlace o a quien instaló el arnés en tu máquina.

**El inicio de sesión.** El sitio pide la cuenta de la organización: la de Microsoft, Google o GitHub, según cómo se
instaló. Si tu organización lo instaló en Azure, la primera pantalla es la de Microsoft. Después de entrar, el sitio te
muestra Inicio. Arriba a la derecha está tu correo y el botón **Salir**;
abajo a la izquierda, el **Tema** (automático, claro u oscuro).

**Lo que ves la primera vez** depende de quién sos para el sitio:

- **Quien mantiene** ve las cinco pestañas, y en Inicio lo que espera una decisión de toda la organización.
- **Una persona confirmada** ve tres pestañas (Inicio, Corridas y Proyectos), con lo suyo.
- **Alguien sin rol** ve sólo una página que dice que su cuenta todavía no está confirmada, sin el menú de la
  izquierda.

![La página de quien todavía no tiene rol: «tu cuenta todavía no está confirmada; pedíselo a quien mantiene el arnés»](sitio-de-la-organizacion/capturas/sin-rol.png)

**Tu máquina, todavía sin confirmar.** Cada máquina del equipo sube sus corridas con el correo de git de quien la usa.
Quien mantiene tiene que confirmar que esa máquina es tuya. Hasta que te confirmen, tus corridas las ven sólo quienes
mantienen; si es tu única máquina, además entrás sin rol y ves la página de arriba. Pedíselo a quien mantiene el arnés
(si no sabés quién es, a quien te pasó el enlace o a quien instaló el arnés en tu máquina). Lo confirma en
Configuración, el cambio entra cuando alguien lo aprueba, y a partir del próximo refresco (a lo sumo 15 minutos después)
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
reparte el tiempo entre los pasos del pipeline, con los colores de la leyenda: 0 Arranque, 1 Validar la story, 2 Armar
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
Después, **Proponer el cambio** muestra el archivo de hoy al lado del archivo después del cambio, para mirarlo antes de
confirmar. El archivo está escrito en un formato con llaves y comillas; no hace falta entenderlo entero: mirá que lo
único distinto entre los dos lados sea lo que cambiaste (cada lado se desplaza para ver el archivo entero). **Confirmar y proponer** abre un pedido de cambio (un pull request) en el repo de esa sección, y la sección
muestra el enlace al pedido. Alguien del equipo lo revisa y lo mergea. El sitio toma el cambio en el **próximo
refresco** (cada 15 minutos, si la organización no eligió otro plazo). **Descargar** baja el archivo cambiado, para
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
- **Quién mantiene el sitio**: quiénes ven la pestaña Configuración y pueden proponer cambios; también el buzón de
  corridas, el refresco y la dirección del sitio. Si te sacás de la lista, perdés el acceso cuando se apruebe. Queda en
  `operations.json`, en el repo de operaciones. Lo revisa otra persona de la lista.
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

![Avisos y la noche](sitio-de-la-organizacion/capturas/configuracion-avisos.png)

### Cómo trabaja Claude

- **Cómo contesta Claude**: el idioma, el estilo y el largo de las respuestas en todas las máquinas. Queda en
  `team-profile.json`, en el repo del perfil. Lo revisa quien mantiene.
- **Qué modelo usa cada trabajo del pipeline**: el modelo de los revisores, del pase adversarial, de los ayudantes y de
  la sesión; lo que no se declara usa el de hoy. Queda en `team-repos.json`, en el repo del perfil. Lo revisa quien
  mantiene, mirando el costo.
- **Dónde corren las pruebas completas al mergear**: en la máquina o en el servidor, repo por repo. Queda en
  `team-repos.json`, en el repo del perfil. Lo revisa quien mantiene.
- **Cobertura de las pruebas**: el porcentaje de líneas nuevas cubiertas por debajo del cual el control de pruebas
  avisa (avisa, no frena). Queda en `team-repos.json`, en el repo del perfil. Lo revisa quien mantiene.
- **Integraciones**: qué servicios usa cada máquina (el reloj de horas, la memoria, el buzón, la noche); una máquina
  puede apagar una para ella sola. Queda en `team-profile.json`, en el repo del perfil. Lo revisa quien mantiene.
- **Conversaciones de las corridas**: si el sitio baja también lo que se habló en cada corrida; con eso, el detalle de
  Corridas muestra los archivos que tocó. Queda en `operations.json`, en el repo de operaciones. Lo revisa quien
  mantiene.

![Cómo trabaja Claude](sitio-de-la-organizacion/capturas/configuracion-claude.png)

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

El sitio decide quién sos por tu correo:

| Rol | Inicio | Corridas | Proyectos | Arnés | Configuración |
|---|---|---|---|---|---|
| **Quien mantiene** | «Qué decidir hoy», de toda la organización | todas las corridas | todos los productos | sí | sí, y propone cambios |
| **Persona confirmada** | «Lo tuyo» | las de sus máquinas confirmadas | los productos en los que trabaja | no | no |
| **Persona con la máquina sin confirmar** | «Lo tuyo», si tiene otra máquina confirmada; si no, la página «tu cuenta todavía no está confirmada» | las de sus máquinas confirmadas; las de la máquina nueva, todavía no | los productos en los que trabaja | no | no |
| **Sin rol** | sólo la página «tu cuenta todavía no está confirmada» | no | no | no | no |

**Cómo se pasa de un rol a otro.** Lo decide quien mantiene, en Configuración, y entra cuando alguien aprueba el pedido:

- Para ser **persona**, una máquina tuya tiene que estar confirmada a tu nombre («Personas y máquinas»). Tu máquina
  aparece sola en «Por confirmar» cuando sube su primera corrida.
- Para **mantener**, tu correo tiene que estar en «Quién mantiene el sitio». La primera persona la pone quien instala,
  antes de que exista la lista.
- Para dejar de ver, se saca el correo o la máquina de esas mismas secciones.

## Problemas comunes

### No puedo entrar

**Lo que se ve:** la página de inicio de sesión no te deja pasar, o dice que tu cuenta no tiene acceso a la
aplicación.

**Por qué pasa:** la organización puede dejar entrar sólo a las personas que habilitó una por una. En Microsoft eso se
llama «asignar» a alguien a la aplicación del sitio. También pasa si el navegador entra con otra cuenta (una personal, o
la de otra organización).

**Qué hacer:** pedile a quien mantiene que te habilite («que te asigne a la aplicación del sitio», si es Microsoft). Si ya estás asignado, salí de la otra cuenta o
abrí una ventana privada y entrá con la de la organización.

### Entro y no veo nada

**Lo que se ve:** la página «tu cuenta todavía no está confirmada; pedíselo a quien mantiene el arnés».

**Por qué pasa:** entraste bien, pero el sitio no te tiene ni como persona ni como quien mantiene: ninguna máquina
confirmada está a tu nombre.

**Qué hacer:** si programás con el arnés, hacé una story con él en tu máquina: al terminar, la máquina sube su corrida
y se presenta. Después pedile a quien mantiene que la confirme. Si no usás el arnés en una máquina, el sitio no tiene
nada tuyo para mostrar; si necesitás ver todo, pedile a quien mantiene que te sume a la lista de los que mantienen.

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

**Por qué pasa:** el sitio sólo propone si el repo exige que otra persona apruebe cada cambio antes de sumarlo a la
rama principal (una «política de revisión»); sin esa regla, el sitio podría cambiar el repo sin que nadie lo mire.
También cuando el sitio no tiene permiso para escribir en ese repo, o cuando ya hay un pedido abierto sobre el mismo
archivo (la sección muestra su enlace).

**Qué hacer:** revisá y apretá **Descargar**, y pasale el archivo a quien tiene acceso al repo. Quien mantiene puede
pedir la política de revisión o el permiso de escritura. Con un pedido abierto, esperá a que se mergee o se cierre.

![«Proponer» apagado, con su motivo: el repo no tiene una política que pida revisión](sitio-de-la-organizacion/capturas/proponer-apagado.png)

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
| `SITE_PIPELINES_TOKEN` | leer los pipelines, para elegirlos por nombre en la pestaña Configuración («Pruebas al mergear» y «Despliegues») y ver el nombre de cada paso | parte de la instalación normal en Azure DevOps: sólo *Build: Read*, de la organización, 90 días; puede ser el mismo permiso que el del repo de operaciones con *Build: Read* sumado. Sin él, la pestaña pide el número del pipeline a mano y dice qué falta, y los pasos guardados se ven por su identificador |
| `SITE_PROFILE_WRITE_TOKEN` | proponer cambios al perfil del equipo | apagada por defecto: vacía o comentada, nunca con un valor; una identidad dedicada y un repo por credencial |

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

# El sitio de la organización: qué es, cómo se usa y cómo se instala

Esta guía es para quien nunca vio el sitio. Sirve a quien lo usa todos los días y a quien lo instala por primera vez.
Primero cuenta qué es y cómo se usa; después, cómo se instala.

- **[Usar el sitio](#qué-es-y-para-qué-sirve):** qué es, el primer ingreso, cada pestaña, la configuración, qué ve
  cada persona y los problemas comunes.
- **[El sitio demo](#el-sitio-demo):** el mismo sitio con datos de ejemplo, abierto y sin cuenta, para mostrarlo.
- **[Instalarlo](#qué-hace-falta-antes):** qué hace falta, cómo probarlo en tu máquina y cómo dejarlo andando.

Cada paso de esta guía sale del código o de una ejecución real. Lo que todavía no se probó en real lo dice en la misma
línea.

Las capturas salen de un sitio de laboratorio con una organización inventada, **Acme**: sus personas, máquinas y
productos no existen. Tu sitio se ve igual, con tus nombres.

## Qué es y para qué sirve

Es una página web para toda la organización. Cada persona entra con la cuenta de la organización y ve lo suyo: sus
tareas, sus pedidos de cambio, sus ejecuciones. Quienes mantienen el arnés ven todo, y además tienen la pestaña
**Configuración**, donde se personaliza la organización (quién es responsable de qué, el canal del aviso, los umbrales).

**Las palabras que usa el sitio**, para quien no programa:

- **El arnés:** el conjunto de reglas, controles y ayudantes con que el equipo programa con Claude. Este sitio muestra
  lo que el arnés mide.
- **Una story:** una tarea de programación descrita por escrito, con lo que tiene que cumplir.
- **El pipeline y una ejecución:** el pipeline es el recorrido por pasos con que el arnés acompaña a alguien a hacer una
  story (validarla, planear, programar, probar, revisar). Una **ejecución** es una vez que alguien hizo ese recorrido.
- **Un repo:** la carpeta compartida donde vive el código o la configuración, con su historia de cambios. Su **rama
  principal** es la versión que vale.
- **Un pedido de cambio** (en inglés, *pull request*): una propuesta para cambiar un repo. Otra persona la mira y, si
  está bien, la **mergea**: la suma a la rama principal.
- **Los revisores** (también «agentes»): ayudantes automáticos que revisan el trabajo de cada ejecución.
- **Los tokens:** la medida de cuánto texto leyó y escribió el modelo; es lo que cuesta una ejecución.
- **La foto de la noche:** lo que los procesos de la noche midieron y dejaron guardado. En las fichas aparece como
  «fuente del» y una fecha.
- **El refresco:** cada cuánto el sitio vuelve a leer todo (15 minutos, salvo que la organización elija otro plazo).
- **La mediana:** el valor del medio; la mitad de las ejecuciones está por debajo y la otra mitad por encima.

Cada máquina del equipo sube sus ejecuciones a un lugar compartido, el **buzón de ejecuciones**. Por la noche, unos procesos
del arnés revisan las dependencias (los paquetes de otros que usa cada producto), las pruebas y los productos, y dejan
lo que midieron en el **repo de operaciones** de la organización. El sitio lee esos dos lugares y los muestra.

**Un día de quien mantiene.** A las 4 de la mañana corren los procesos de la noche y dejan su foto en el repo de
operaciones. Al rato llega el aviso de la mañana (Telegram, Slack o Teams), con cantidades y el enlace al sitio. Quien
mantiene abre el enlace y cae en **Inicio**, en «Qué decidir hoy»: una ficha amarilla es algo que espera una decisión
(una dependencia nueva, una prueba que se puso roja anoche) y dice dónde se decide. Si una ejecución de alguien quedó
trabada, la busca en **Ejecuciones** y abre su detalle: ahí ve en qué paso se fue el tiempo y qué control encontró algo.
Si una máquina nueva empezó a mandar ejecuciones, Inicio lo cuenta y **Configuración** pide confirmar de quién es: la
confirma, el cambio se propone como un pedido al repo de operaciones, y cuando el pedido entra (solo, con la regla de la
organización; si no, cuando alguien lo aprueba), esa persona empieza a ver lo suyo.

**Un día de un dev.** Entra desde el mismo enlace, o desde la dirección del sitio que guardó. En **Inicio** ve lo suyo:
cuántas ejecuciones hizo en la semana, sus pull requests abiertos y lo que tiene asignado. En **Ejecuciones** ve sólo sus
ejecuciones, y en **Proyectos**, los productos en los que trabaja. Nadie tiene que clonar nada ni correr nada en su
máquina para verlo.

**Quién lo usa:**

- **Quien mantiene el arnés:** lo instala una vez, lo actualiza a conciencia, y edita la configuración desde la pestaña
  Configuración.
- **Cada persona de la organización que programa con el arnés:** entra y ve lo suyo, si está en la lista del sitio.
  Quien no usa el arnés en una máquina no tiene ejecuciones propias, pero ve igual lo demás que es suyo.
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

- **Quien mantiene** ve todas las pestañas (Inicio, Ejecuciones, Mantenimiento, Proyectos, Arnés, Cómo trabaja,
  Configuración y Ayuda), y en Inicio lo que espera una decisión de toda la organización.
- **Una persona confirmada** ve Inicio, Ejecuciones, Proyectos y Ayuda, con lo suyo.
- **Alguien que no está en la lista** ve sólo una página que dice con qué cuenta entró, que esa cuenta no está en la
  lista, a quién pedírselo y cómo entrar con otra. No ve el menú de la izquierda ni ningún dato.

![La página de quien no está en la lista: «Tu cuenta no está en la lista»](sitio-de-la-organizacion/capturas/sin-rol.png)

**Tu máquina, todavía sin confirmar.** Cada máquina del equipo sube sus ejecuciones con el correo de git de quien la usa.
Quien mantiene tiene que confirmar que esa máquina es tuya. Hasta que te confirmen, tus ejecuciones las ven sólo quienes
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
- **Máquinas sin confirmar con ejecuciones** y **retrospectivas pendientes**.

![Inicio de quien mantiene: «Qué decidir hoy», con fichas en Decidir, Nada y No medido](sitio-de-la-organizacion/capturas/inicio-quien-mantiene.png)

Para **una persona** es «Lo tuyo»: sus ejecuciones de los últimos 7 días (con un enlace a Ejecuciones), sus pedidos de cambio
abiertos, lo que tiene asignado (con hasta un día de atraso, porque sale de la foto de la noche) y sus proyectos.

![Inicio de una persona: tus ejecuciones, tus pull requests abiertos, lo que tenés asignado y tus proyectos](sitio-de-la-organizacion/capturas/inicio-persona.png)

**Qué hacer:** una ficha en Decidir se resuelve donde dice su enlace, no en el sitio. Cuando se resuelve, la ficha pasa
a Nada con la foto de la noche siguiente.

### Ejecuciones

**Qué contesta:** ¿cómo vienen las ejecuciones del pipeline? ¿Dónde se fue el tiempo y qué encontraron los controles?

Arriba, el alcance: cuántas ejecuciones se leyeron y de qué máquinas. Después, «Lo que se mira primero» explica los dos
resultados de un control: **encontró un error** (una prueba o la compilación no pasaron y se arreglaron ahí mismo) y
**frenó** (el control no dejó pasar algo). Los dos son el control haciendo su trabajo, no un problema. Al lado de cada
mediana, **n=** dice de cuántas ejecuciones sale el número.

Debajo hay un **filtro** (fechas, producto, máquina, sólo las que tienen consumo medido, sólo las que llegaron al último
paso) y fichas con los números del filtro: cuántas llegaron al final, cuánto dura una ejecución, en cuántas un control
encontró un error, cuántos agentes se lanzaron y cuánto se consumió. Quien mantiene ve después las tres fichas de Ejecuciones
del tablero de la noche: la duración y los pasos de una ejecución (medianas) y las veces que un control bloqueó.

![Ejecuciones: el alcance, «Lo que se mira primero» y las fichas del filtro](sitio-de-la-organizacion/capturas/corridas-tabla.png)

Más abajo está **«Ejecución por ejecución»**: una fila por ejecución, de la más nueva a la más vieja. La barra de cada fila
reparte el tiempo entre los pasos del pipeline, con los colores de la leyenda: Arranque, Validar la historia, Armar el
plan, Aprobar el plan, Implementar, Correr las pruebas, Implementar + pruebas (las ejecuciones viejas, que los tenían
juntos), Revisores, Hallazgos y Preparar el commit. Son los pasos de Cómo trabaja, por nombre y sin número: el Pase
adversarial va dentro de Revisores y Probar en vivo dentro de Hallazgos. «Sin marca» es un tramo que la ejecución no
anotó.

![La leyenda de los pasos y la tabla «Ejecución por ejecución»](sitio-de-la-organizacion/capturas/corridas-leyenda.png)

**Un clic en una fila** abre su detalle: la línea de tiempo con cada paso y cada control en su carril, qué encontraron
los controles, los revisores que corrieron, el consumo en tokens por paso y los archivos que tocó. La leyenda de la
línea de tiempo: un **círculo verde** es que el control miró y dejó pasar; un **triángulo rojo**, que encontró un
error; un **cuadrado negro**, que no dejó pasar; un **círculo punteado**, que no quedó registrado cómo salió; una
**raya naranja**, que arranca otra vuelta de revisores; una **raya vertical**, un paso marcado junto con el anterior; el
**gris**, el tiempo entre pasos; y un **recuadro naranja**, el tiempo esperando a una persona (una pregunta sin
contestar). Si el detalle muestra un comando para correr, es para quien mantiene el arnés. Los archivos se ven
sólo si la organización decidió bajar las conversaciones (sección «Conversaciones de las ejecuciones»).

![El detalle de una ejecución: la línea de tiempo, los controles, los revisores y el consumo](sitio-de-la-organizacion/capturas/corridas-detalle.png)

**Qué hacer:** una ejecución que «quedó en el 4» puede estar en curso o abandonada; su detalle dice hasta dónde llegó.
Una persona ve sólo las ejecuciones de sus máquinas confirmadas; quien mantiene ve todas.

**Después de un reinicio** (un despliegue, o el sitio que se apagó por falta de uso), la pestaña muestra la última vista
guardada, con la fecha de cuándo es, mientras el buzón se vuelve a bajar entero; una banda lo dice y la página se pone al
día sola. Los cambios de cada ejecución vuelven cuando termina de armarse la vista nueva. La vista guardada vive en el
disco del sitio (`SITE_DATA_DIR`): **sin disco**, después de un reinicio la pestaña espera la primera bajada entera.

### Mantenimiento

Sólo para **quien mantiene**: lo que encontró la noche, ordenado por quién tiene la pelota. Al lado del nombre, en el
menú, va cuántas fichas esperan tu decisión, por ejemplo «Mantenimiento (12)»; sin ninguna, el nombre solo. La pantalla
tiene cuatro bloques:

- **Te toca decidir**: lo que encontraron el vigilante de producción y la revisión de las ejecuciones, y las
  vulnerabilidades de paquetes pendientes. Primero lo de producción, porque son clientes reales. Dentro de cada grupo,
  primero lo que el análisis recomienda arreglar, después lo que recomienda archivar y al final lo que no tiene
  análisis; los paquetes, la más grave primero.
- **Esperando aprobación**: lo que ya enviaste y otra persona tiene que aprobar, agrupado por pedido, con su enlace
  (con `site.auto_apply` prendida, sólo aparece si la política del repo no dejó que el sitio lo apruebe solo).
  Aprobado, se aplica esa noche. Si la plataforma no contesta, lo dice una frase y las fichas quedan para decidir,
  pero no se envía nada hasta que conteste: así no se abre un pedido repetido.
- **Ya decididas** (cerrado de entrada): lo decidido en los últimos 30 días, con qué se eligió, cuándo y quién. La
  revisión de cada noche aplica lo que se decidió ese día; si no pudo, la fila lo dice.
- **En marcha** (cerrado de entrada): lo ya decidido que alguien está haciendo, con el número de su tarea y a quién
  está asignada, y las vulnerabilidades de paquetes. Cada equipo sigue la suya en su tarea y, si no puede actualizar el
  paquete, declara la deuda en su repo, con plazo.

Una vulnerabilidad de paquetes se decide con **Aceptar** o **Rechazar**. Aceptar mergea su pull request, que sube el
paquete. Rechazar lo cierra y pide un motivo de una línea, que queda como comentario del pull request y en la ficha. Una
ficha sin pull request también se decide: Aceptar la pasa a arreglar en su tarea y Rechazar la anota. Lo aplica la
noche, y sólo si el pull request sigue siendo el de la ficha. Si no lo pudo aplicar, el resumen de la mañana lo dice y
la fila vuelve a «Te toca decidir» con el porqué. El tipo del pedido de trabajo no cambia.

Cada tarjeta dice **qué pasó** con los datos de la ficha, por ejemplo «Pasó 4 veces, del 21/10 al 24/10». Si hay
análisis, dice **por qué** pasa, qué **recomienda** y qué se haría si se arregla, y aclara si lo escribió el modelo de la
noche o una persona. Sin análisis, dice por qué no lo tiene y los botones quedan detrás de «Decidir sin análisis».

**Archivar** quiere decir «es normal, no hay que tocar nada». **Arreglar** quiere decir que la noche crea una tarea para
corregirlo. Marcás una opción en cada tarjeta (o «Seguir las recomendaciones» para todas las que tienen análisis) y al
final **Enviar para aprobar**: abre un solo pedido al repo de operaciones con todas tus elecciones. Nada cambia hasta
que otra persona lo aprueba. Si la organización prendió «Los cambios de un mantenedor» (`site.auto_apply`), el botón
dice **Enviar** y lo enviado se guarda sin esperar a nadie: la revisión de esa noche lo aplica. Tus marcas quedan guardadas en el navegador hasta que las envíes o las borres. Cada término
tiene su «?» con la explicación.

### Proyectos

**Qué contesta:** ¿cómo va cada producto?

Una fila por producto: las stories en curso (y cuántas en revisión), las paradas, su edad en el estado («más de 30 días:
2 · más de 60: 1»), las bloqueadas, qué versión está en prueba y cuál en producción, si espera una aprobación, si el
vigilante lo mira, sus vulnerabilidades vivas y cómo da contra los otros productos (la paridad). Abajo, el total sin
contar dos veces lo compartido. Una persona ve los productos en los que trabaja. La **paridad** compara cada producto
con los otros: lo que uno hace y los demás no.

Una story está **parada** cuando está en curso y lleva en su estado más del primero de los dos días de
`params.edad_en_estado_dias` del `sources.json` (por ejemplo `[30, 60]`); la edad cuenta lo empezado, en curso y
bloqueado, contra los dos. Es la misma cuenta que la ficha de edad del tablero de la noche. Sin esos días, las paradas
y la edad dicen «no medido» con su motivo: el sitio no tiene un número propio.

![Proyectos: una fila por producto](sitio-de-la-organizacion/capturas/proyectos.png)

Quien mantiene ve además, arriba de la tabla, «Cómo va la organización»: las fichas del tablero de la noche que son de
toda la organización (ver «Las fichas del tablero»).

Más abajo, **Estimaciones**: por producto, una fila por repo de historias y épica, con el rango que se le dio a la
épica, la suma del plan, la suma vigente (el ajuste de cada historia, o su plan) y las horas reales de lo cerrado; al
final, el total del producto. Una épica cuya suma vigente cae fuera de su rango lo marca y dice por cuánto («encima por
25 h»). Un repo sin registro dice «sin estimaciones»; una foto vieja, o de antes de las estimaciones, dice «no medido».
Cómo se estima: `guides/estimates.md`.

**Qué hacer:** una story parada o bloqueada se destraba en su repo, con su equipo; el sitio sólo la muestra.

### Arnés

**Qué contesta:** ¿los controles del arnés andan? Sólo la ve quien mantiene.

Muestra si cada foto de la noche llegó al día, cuántos casos del **banco de controles** (unas pruebas que confirman que
cada freno del arnés frena lo que tiene que frenar) y cuántas **suites de prueba** (las pruebas del propio arnés) dieron
rojo, el **examen de los revisores** (si los revisores automáticos siguen encontrando lo que tienen que encontrar), y la
versión del arnés que corre el sitio. Abajo, las fichas del tablero de la noche, agrupadas por sus preguntas (ver «Las
fichas del tablero»).

![Arnés: las fotos de la noche, el banco de controles, las suites y la versión del sitio](sitio-de-la-organizacion/capturas/arnes.png)

**Qué hacer:** una foto que no llegó o un rojo nuevo se mira en el proceso de la noche que lo produjo.

### Las fichas del tablero

El tablero de la noche mide el arnés y los proyectos en seis preguntas. El sitio muestra esas fichas en su pestaña, con
el mismo número que el tablero: Arnés las agrupa por pregunta, y Proyectos y Ejecuciones las ponen en una grilla arriba de su
tabla. Son 26, todas de la organización: sólo las ve quien mantiene. Una persona ve sus pestañas como antes.

**En Arnés:**

- **Registros por merge que cumplen el contrato de formato** (`contrato_v2`). Dice si los registros que se escriben al cerrar cada merge se pueden leer por máquina.
- **Registros por merge con fecha declarada adentro** (`fechas_declaradas`). Una fecha inferida del nombre del archivo ordena, pero no sirve para dibujar una tendencia.
- **Cierres que dejaron prueba de que la cosa anda corriendo** (`dod`). De las stories cerradas, cuántas dejaron evidencia de que se probó en vivo.
- **Lo que vuelve: stories con un seguimiento posterior** (`rework`). Qué parte de lo entregado hubo que volver a tocar.
- **Por qué volvió: defecto nuestro contra cambio de requisito** (`rework_por_causa`). Separa lo que volvió por un error nuestro de lo que volvió porque cambió lo que se pedía.
- **¿Vuelve menos lo que pasó por el pipeline?** (`rework_por_carril`). Compara, por repo, lo que volvió con constancia del pipeline contra lo que no la tiene.
- **Puntaje de mutación: proporción de mutantes que las pruebas matan** (`mutacion`). Si las pruebas se rompen cuando se rompe el código a propósito.
- **Ejecuciones de pruebas que evaluaron el umbral del 75 % sobre las líneas tocadas** (`cobertura_tocada_evaluo`). Cuántas veces la cobertura de lo que se tocó se midió de verdad.
- **Cierres que necesitaban guía para probar a mano, y la tenían** (`qa_guia`). El puente entre las pruebas automáticas y una persona que prueba.
- **Cuánto tarda verificar: duración de la suite de pruebas** (`gates_dur`). Una suite que tarda horas no se corre antes de commitear: se saltea.
- **Los frenos previos a la herramienta: cuántas veces frenaron y cuántas los saltearon** (`frenos`). Los dos números de la misma regla juntos: sin el primero, un freno que funcionó parece que no sirvió.
- **Los controles automáticos del cierre: decisiones sobre una evidencia que la rechazaron** (`evidencia_cierre`). Cuántas veces los frenos que impiden cerrar sin evidencia la rechazaron.
- **Escapes concentrados en una sola regla** (`escapes_regla_dominante`). Si lo que se escapa de los controles viene casi todo de una sola regla.
- **Reglas candidatas a retiro: probadas, que nunca encontraron nada** (`reglas_candidatas`). Reglas que saben ponerse rojas y nunca encontraron nada con recorrido de sobra.
- **Reglas que el banco de pruebas probó de verdad** (`reglas_probadas`). Una regla sin prueba que la obligue a marcar no se juzga: sale «sin probar», nunca candidata.
- **Commits por carril: pipeline, atajo declarado o ninguno** (`carriles`). Cuántos commits pasaron por el pipeline, cuántos por un atajo declarado y cuántos por ninguno.
- **Máquinas con una vuelta atrás vigente: no se actualizan solas** (`vueltas_atras`). Cuántas máquinas deshicieron una actualización y la retienen hasta que sale una versión posterior.

**En Proyectos:**

- **En el backlog: escritas y todavía sin arrancar** (`backlog`). Cuántas stories hay escritas sin empezar.
- **Con un estado que el diccionario no reconoce** (`estados_sin_diccionario`). Los estados que nadie tradujo: son la lista de trabajo del próximo diccionario.
- **Tiempo por etapa: de listo para desarrollar a cerrado** (`tiempo_por_etapa`). Dónde se queda parado el trabajo entre una etapa y la siguiente.
- **Stories empezadas que llevan mucho en su estado** (`edad_estado`). El trabajo empezado que no se mueve hace días.
- **Cambios de código sin historia** (`sin_historia`). Las entradas a main de los últimos 28 días que no nombran su historia. Sólo se mide: no frena a nadie.
- **Productos donde una sola persona hizo el 75 % o más de los commits del último año** (`bus_factor`). El riesgo de ingeniería no es el código: es quién es la única persona que sabe tocarlo.
- **Productos sin pipeline de producción** (`sin_pipeline_de_prod`). No es calidad: es exposición. Para ellos «despliegues» es cero porque no hay a dónde mirar.

**En Ejecuciones:**

- **Veces que un control del pipeline bloqueó una acción** (`bloqueos`). Cuántas veces un control frenó de verdad algo del trabajo.
- **Una ejecución del pipeline, de punta a punta (mediana, horas)**. Cuánto dura una ejecución completa.
- **Respuestas del modelo por ejecución del pipeline (mediana)** (`pasos`). Una ejecución consume según cuántos pasos da: la variable que explica lo que cuesta.

**Cómo se oculta una.** En Configuración, sección «Avisos y la noche», «Fichas que muestra el sitio» tiene una casilla
por ficha. Destildá las que no uses y proponé el cambio: queda en `operations.json` del repo de operaciones
(`site.hidden_cards`). Una ficha oculta no se arma ni llega a la pantalla, y Arnés dice cuántas hay ocultas.

#### Lo que todavía no se mide

Una ficha sin su fuente sale **no medido**, con el motivo y la fecha de la última foto; nunca en cero. Hoy dependen de
fuentes que no siempre están:

- Las del contrato de las historias y las fechas declaradas necesitan los registros del capturador de la noche.
- Las de la mejora del proceso, el retrabajo, el backlog y el tiempo por etapa necesitan la foto de etapas de la noche; la
  edad en el estado, además, las fotos por proyecto.
- Las de calidad y control (mutantes, cobertura, guía del tester, frenos, escapes, carriles) y las tres de Ejecuciones salen
  del buzón de ejecuciones: sin buzón leído, quedan no medidas.
- El bus factor necesita los productos declarados (`repos.json`), y los productos sin pipeline de producción, la deuda
  declarada de pipelines.

Si el cálculo de las fichas se cae, todas lo dicen con su propio motivo: «el cálculo de las fichas se cayó».

### Cómo trabaja

**Qué contesta:** ¿qué hace el agente con una historia, paso por paso, en esta organización? Sólo la ve quien mantiene.

Arriba, **Tu organización**: las integraciones prendidas y apagadas (tachadas), los paquetes de revisores activos y las
reglas (cómo se nombran las pruebas, qué pantallas piden prueba de punta a punta, en qué idioma está la aplicación).
Debajo, los pasos del recorrido en orden; aparte, bajo «Fuera del recorrido», «Cerrar la historia» (el cierre en Azure
DevOps), y al final, bajo «En cualquier paso», lo que actúa en todo el recorrido. Al elegir un paso se ve:

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

![Cómo trabaja: arriba lo de tu organización, a la izquierda los pasos y a la derecha lo que pasa en el paso elegido](sitio-de-la-organizacion/capturas/como-trabaja.png)

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
máquinas con una versión vieja del arnés o «sin noticias» (que no mandan ejecuciones hace un tiempo, así que no se sabe qué
versión tienen). Debajo, cinco pestañas: **Personas**, **Repos y productos**, **Avisos y la
noche**, **Cómo trabaja el agente** e **Instalación y actualización**. Un número al lado de una pestaña dice cuántas cosas
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

![Antes de proponer: los renglones que cambian, marcados, con «Confirmar y proponer»](sitio-de-la-organizacion/capturas/configuracion-diferencia.png)

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
  sitio; eso se cambia en la instalación. Para alguien de afuera del directorio de la organización, **Invitar** (abajo,
  «Invitar a alguien») lo suma y le manda la invitación de Microsoft. También van acá el buzón de ejecuciones, el refresco y la dirección del sitio.
  Queda en `operations.json`, en el repo de operaciones. Lo revisa otra persona que mantiene, salvo que la organización
  haya prendido «Los cambios de un mantenedor»: entonces el sitio lo aprueba solo. **«Cada cuánto se
  actualiza el sitio»** acepta de 5 a 120 minutos; sin declarar, 15. Más corto, un cambio se ve antes, pero el sitio
  vuelve a leer el repo de operaciones, el del perfil y el buzón más seguido mientras está despierto: más lecturas a
  la nube, que en una instalación que cobra por uso cuestan algo más. No lo mantiene despierto: dormido no lee nada, y
  al despertar lee todo.
- **Cada cuánto el sitio relee sus datos** (`site.refresh_minutes`, también en «Quién entra al sitio»): cada cuántos
  minutos el sitio vuelve a leer la configuración (este repo de operaciones), el buzón de ejecuciones y el perfil del
  equipo. Va de 5 a 120 minutos; si no lo declarás, son 15. No instala versiones: eso es «Cómo se actualiza el sitio»,
  en Instalación y actualización.
- **Los cambios de un mantenedor**: si un cambio que propone quien mantiene el sitio entra solo, o queda un pedido para
  que lo apruebe otra persona. Viene apagada: sin declarar, queda el pedido. La regla de la organización la prende
  («La política de rama del repo de operaciones», más abajo). Prendida («sí», `site.auto_apply` en
  `operations.json`), «Proponer» abre el pedido, lo aprueba con la identidad del sitio y lo completa; enseguida el sitio
  vuelve a leer el repo y la sección dice «Aplicado». Sólo pasa si las políticas de la rama principal quedan cumplidas
  con ese voto: si piden algo más (otro revisor, un revisor nombrado, un build), el sitio dice qué falta y deja el
  pedido para aprobar. En GitHub, donde quien abre un pedido no puede aprobarlo, el sitio no vota: lo mergea directo si
  el repo deja a su identidad saltear la revisión, y si pide la aprobación de otra persona le prende el auto-merge y
  entra en cuanto alguien lo apruebe; si el repo tampoco deja el auto-merge, queda el pedido. Antes de proponer, al
  lado del botón, la sección dice qué va a pasar. Queda escrito quién lo hizo: la descripción del pedido nombra a quien
  lo pidió, y el registro del sitio anota `cambio aplicado: <archivo>, pedido <enlace>`. Cuenta la opción
  que ya está en el repo: el cambio que la prende queda para aprobar como cualquier otro, y recién después los cambios
  entran solos. Queda en `operations.json`, en el repo de operaciones.
- **Cómo se actualiza el sitio**: si el sitio se pone al día solo con la versión nueva del arnés o sólo avisa (`site.update`
  de `operations.json`). Sin declarar, sólo aviso. «Automático» pide el nocturno de actualización y su permiso: la receta,
  en «Cómo se mantiene al día».
- **La dirección del sitio en cada máquina**: la página que abre el comando `/org-site` en la máquina de cada persona
  del equipo (`site.url`). Tiene que empezar con `https`. Vale sólo desde el perfil del equipo: una máquina no la puede
  cambiar. Sin dirección, el comando explica cómo cargarla. Queda en `team-profile.json`, en el repo del perfil.
- **Personas y máquinas**: de quién es cada máquina que manda ejecuciones, y en qué proyectos trabaja cada persona. Una
  máquina nueva aparece en «Por confirmar» con el correo que dice ser; **Confirmar** la pone a nombre de esa persona.
  Queda en `operations.json`, en el repo de operaciones. Lo revisa quien mantiene.
- **A quién le llegan los avisos y las tareas**: a quién se asigna lo que la noche encuentra (una dependencia vieja,
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

**La configuración de cada repo** muestra, por cada repo de producto, lo que dice el `.tycon/advisors.yaml` de su rama
principal. Los repos son los de la revisión de dependencias y los de `team-repos.json`, sin el público, el del perfil ni
el de operaciones. Cada repo se lee recién cuando lo abrís. Hoy se edita el **código deprecado** (`deprecated`): las
carpetas o archivos viejos que el agente no tiene que copiar ni tocar sin motivo. Va fila por fila: ruta, nivel
(congelado o muerto), motivo y una fecha para revisarlo; arriba, si editar algo deprecado sin una historia avisa o frena.
«Revisar cambios» valida con el mismo lector que usa el arnés: una fila mal escrita dice qué le falta y no se propone. Una
fila cuya ruta ya no existe en la rama principal, o cuya fecha pasó, se marca, pero se puede proponer igual. El pedido
cambia sólo ese bloque del archivo: las otras claves y los comentarios quedan como están. Sin el archivo, el pedido lo
crea. Lo propone quien mantiene el sitio, con `SITE_PRODUCTS_WRITE_TOKEN` (abajo); sin ese secreto, la sección muestra
lo declarado y el archivo como quedaría, para copiarlo y abrir el pedido a mano.

![Repos y productos](sitio-de-la-organizacion/capturas/configuracion-repos.png)

### Avisos y la noche

- **Dónde llega el resumen de cada mañana**: el canal del aviso, elegido de una lista (Telegram, Slack, Teams, correo o
  ninguno); con correo, el remitente y los destinatarios. El chat, la dirección del canal o la contraseña del correo no
  van acá: son secretos de los procesos de la noche. Queda en `operations.json`, en el repo de operaciones. Lo revisa
  quien mantiene.
- **Aviso de espera**: si el aviso corre y cuántos minutos espera una ejecución a una persona antes de avisar. Llega a
  todas las máquinas. Sin valor, corre, como de fábrica; «Apagado en todas las máquinas» lo apaga, salvo en la máquina
  que puso `TYCON_WAIT_NOTICE` (la variable gana). Con una coordinadora designada y viva, al primer plazo la espera le
  llega a ella, en su próximo turno, y al dueño recién al segundo: los minutos desde que empezó la espera (30 de
  fábrica), si sigue sin resolver. Sin coordinadora, el aviso va al dueño al primer plazo. Queda en `team-repos.json` →
  `wait_notice`, en el repo del perfil. Lo revisa quien mantiene.
- **Umbrales: cuándo algo se pinta verde o rojo**: los límites con que el tablero colorea cada número; entre los dos,
  amarillo. Queda en `scripts/nightly/dashboard/sources.json`, en el repo de operaciones. Lo revisa quien mantiene.
- **Fichas que muestra el sitio**: una casilla por cada ficha del tablero de la noche que el sitio muestra en Arnés,
  Proyectos y Ejecuciones. Destildá las que no uses: dejan de armarse y de mostrarse, y Arnés dice cuántas hay ocultas.
  Queda en `operations.json`, en el repo de operaciones (`site.hidden_cards`). Lo revisa quien mantiene.
- **Tareas**: a dónde y cómo pide trabajo la noche. Arriba, la **organización** y el **proyecto** adonde van
  los pedidos de la revisión de las ejecuciones y del vigilante; si falta alguno, la sección dice cuál y que la noche no
  va a pedir trabajo. Después, en un recuadro, el **tipo** (vacío, cada proyecto usa su elemento de backlog) y los
  **campos fijos**. Abajo, **según la gravedad**, una tabla con una fila por campo y una columna por gravedad (crítica,
  alta, media y baja); sus valores ganan sobre los fijos si el campo coincide. Los campos fijos y la tabla valen sólo
  para las vulnerabilidades, y la sección lo dice. Con organización y proyecto, el sitio lee de ese proyecto los tipos,
  los campos de cada tipo y sus valores permitidos; sin ellos, de los proyectos de los productos: cada campo se ve con su nombre (y su referencia, como `Microsoft.VSTS.Common.Priority`, debajo) y cada
  valor se elige de un desplegable. Los valores que traen un símbolo adelante, como un círculo de color, se ven sin él y
  se guardan tal cual los acepta Azure DevOps. Un campo sin valores fijos se escribe. Sin permiso de lectura de work
  items, o si Azure DevOps no contesta, un aviso dice por qué y todo se escribe con su referencia. La ✕ de un campo lo
  quita (de las cuatro gravedades, en la tabla) y se puede deshacer hasta guardar. El título, el texto, las etiquetas y la
  asignación los pone el arnés y no se cambian acá. «Revisar cambios» lo valida con el mismo lector que usa la noche: un
  campo que el arnés fija, un valor vacío, que empieza con «@» o con un salto de línea, o una gravedad que no es una de
  las cuatro, se marcan en su campo y no se proponen. Un proyecto que no tiene el tipo elegido usa el suyo, y el resumen
  de la mañana lo dice. Queda en `operations.json`, en el repo de operaciones (`work_items`). Lo revisa quien mantiene.

![Pedidos de trabajo](sitio-de-la-organizacion/capturas/configuracion-pedidos.png)

![Avisos y la noche](sitio-de-la-organizacion/capturas/configuracion-avisos.png)

### Cómo trabaja el agente

- **Cómo contesta el agente**: el idioma, el estilo y el largo de las respuestas en todas las máquinas. Queda en
  `team-profile.json`, en el repo del perfil. Lo revisa quien mantiene.
- **Qué modelo usa cada trabajo del pipeline**: el nivel de los revisores, del pase adversarial, de los ayudantes y de
  la sesión, en una tabla por grupo con el valor por defecto de cada trabajo al lado; «el por defecto» deja el que trae
  la versión instalada. Los niveles son cuatro: económico, equilibrado, potente y máximo (en el archivo, en inglés:
  `economy`, `balanced`, `strong`, `max`). Cada proveedor los traduce a sus modelos, y al costado de cada selector,
  en chico, dice a cuál: «Anthropic: sonnet · OpenAI: gpt-5.6-luna · Ollama: el del dev · Cursor: el del dev». Una
  configuración guardada con los nombres de Claude (sonnet, opus) sigue valiendo: se ve en niveles y el próximo cambio
  de la sección la guarda en niveles. Con niveles, el perfil tiene que pedir la versión del arnés que los lee; si no, el
  sitio no deja proponer y dice cuál pedir. Con el tope obligatorio, un trabajo elegido por encima del tope se marca en
  rojo y el cambio no se puede proponer. Debajo del nivel general de los revisores, cada revisor instalado, agrupado por
  paquete, con el nivel que usa hoy, de dónde sale (de la primera vuelta, el suyo propio o cambiado por la organización)
  y su desplegable; «como la primera vuelta» lo deja seguir el nivel general. La lista viene plegada y se abre sola si la
  organización cambió alguno. Queda en `team-repos.json`, en el repo del perfil. Lo revisa quien mantiene, mirando el
  costo.
- **Qué modelo es cada nivel, por proveedor**: debajo de las tablas de trabajos, una tabla por proveedor (Anthropic,
  OpenAI, Ollama, Cursor) con una fila por nivel (`models.providers.<proveedor>.<nivel>`). Los trabajos siguen eligiendo
  un nivel; esta tabla dice qué modelo es ese nivel en cada proveedor, y cada máquina usa la de su proveedor
  (`models.provider` en `~/.claude/tycon.json`, o `TYCON_MODEL_PROVIDER`; sin declarar, Codex es OpenAI y lo demás
  Anthropic). La de Anthropic es fija: cada nivel es su alias. La de OpenAI trae los de hoy. Las de Ollama y Cursor
  vienen en «el del dev» (`inherit`): sin modelo cargado, cada dev sigue con el suyo. La de Cursor se guarda pero
  todavía no se aplica. Debajo de cada tabla, la **lista de modelos permitidos** del proveedor (`models.allowed`,
  separados por coma): con una lista, el sitio no deja proponer un modelo que no esté en ella, y una máquina que igual
  lo reciba usa el del dev y avisa. Con tablas, permitidos o la fila de la noche, el perfil tiene que pedir la versión
  del arnés que los lee.
- **El proceso de la noche**: una fila con su proveedor (Anthropic u Ollama) y su nivel (`models.nightly`). El modelo
  sale de la misma tabla: «hoy: gemma4:31b-cloud», o «sin modelo cargado para este nivel», que no deja proponer (de
  noche no hay dev, así que «el del dev» no vale). Pasar de Ollama a Haiku es elegir Anthropic en esa fila. La fila
  dice también el nombre de la variable secreta que el pipeline de la noche necesita (`OLLAMA_API_KEY` o
  `ANTHROPIC_API_KEY`); la llave se crea en el pipeline y nunca pasa por el perfil. Sin la fila, la noche no corre.
- **Dónde corren las pruebas completas antes de sumar un cambio** (antes de mergear: de sumarlo a la rama principal): en la máquina o en el servidor, repo por repo, un renglón por repo
  (✎ abre sus datos). Un repo sin pipeline de pruebas completas dice qué pasa con su regla. Queda en
  `team-repos.json`, en el repo del perfil. Lo revisa quien mantiene.
- **Cobertura de las pruebas**: el porcentaje de líneas nuevas cubiertas por debajo del cual el control de pruebas
  avisa (avisa, no frena). Queda en `team-repos.json`, en el repo del perfil. Lo revisa quien mantiene.
- **Vueltas de revisores**: cuántas vueltas de revisores tiene una historia antes de cortar (de 1 a 6; vacío, 2). Al
  tope, un crítico de seguridad o de datos lo decide una persona y lo demás queda como deuda visible. También se suman
  reglas a las que cuentan como seguridad o datos. Un repo puede ajustar el tope en su `.tycon/advisors.yaml`. Queda en
  `team-repos.json` → `review`, en el repo del perfil. Lo revisa quien mantiene.
- **Tu tecnología**: lo que el arnés ya reconoce, las terminaciones de archivo que tu equipo suma como código, las
  herramientas de prueba (las de fábrica, las que tu organización cambió o agregó) y tres reglas: el estilo de los
  nombres de prueba, qué pantallas piden una prueba en el navegador y el idioma de la aplicación. Sin decir nada, el
  arnés no impone el estilo de ningún equipo. Queda en `team-repos.json` → `stack`, en el repo del perfil. Lo revisa quien
  mantiene. Una herramienta que no está en la lista se pide con «Pedíselo a tu agente» (abajo, §Tu tecnología).
- **Quién autoriza saltarse un control**: si la organización trabaja con una sesión coordinadora que le pasa el ok de un dev
  a la sesión que implementa, para eximir un crítico de los revisores o firmar un criterio que no se puede probar en
  vivo. La pregunta es «¿Quién pasa la autorización para saltarse un control grave?»: «Cada programador (de fábrica)»
  quiere decir que el ok lo escribe el dev en el chat de su sesión; con «Una sesión coordinadora» aparece «¿Cómo la
  llaman?» (se guarda en `approvals.relay_session`, de fábrica «coordinadora»). Vale sólo desde acá, nunca desde una
  máquina. Cuál sesión es la coordinadora se designa en cada máquina: el dev escribe en el chat de esa sesión «Esta
  sesión es la <nombre>», con el nombre de arriba, y la sesión lo anota con
  `marker.js designate-relay --approved-by "<el dev>" --quote "<su frase>"`. Se la reconoce por su conversación, no por
  su nombre: sigue valiendo si la sesión se reinicia, y hay que volver a designarla si se abre un chat nuevo o se hace
  `/clear`. Una sesión que se llama igual no puede reenviar.
  Debajo está **quién firma cada cosa**: una fila por cada firma del catálogo (`guides/firmas-del-arnes.md`), con tres
  opciones. «A la ventana del dueño» es lo de fábrica: el dueño contesta en la ventana de permiso o firma en su terminal.
  «Delegada a la coordinadora» (`approvals.delegated_signing`) deja que esa sesión la firme en nombre del dueño, y su
  frase queda registrada; lo delegado no está protegido contra un agente: si la coordinadora decide aprobarlo por su
  cuenta, el arnés no lo distingue de un ok del dueño, así que se delega sólo lo de bajo riesgo. «Sólo del dueño»
  (`approvals.owner_only`) la traba: el sitio no ofrece delegarla, y lo que no se firma desde la pestaña de otra sesión
  tampoco se ofrece. El aviso fijo lo dice: «Aflojar un control siempre lo firma una persona, en su terminal; esto no lo
  cambia.» Sin sesión designada, lo delegado no sirve, y la sección lo avisa. Lo delegado vale sólo en las máquinas de
  la lista de abajo (`approvals.delegated_machines`), nombradas por su huella: las que el buzón de ejecuciones vio se
  agregan con un botón, y otra escribiendo su huella. De fábrica, en ninguna. Todo vale sólo desde acá, nunca desde
  una máquina.
  Más abajo está **el nivel de cada firma**: una fila por cada firma de la tabla de niveles (`guides/firmas-del-arnes.md`,
  «Los niveles»), con su nivel de fábrica: 1 rutina, 2 excepción, 3 irreversible. El selector empieza en ese nivel, así
  que la organización puede subirlo y nunca bajarlo (`approvals.levels`). Rige el mayor entre la tabla y el perfil.
  La coordinadora firma sola sólo la rutina: una firma que queda en 2 o más no se ofrece para delegar. Si estaba
  delegada, subirla la saca de la delegación en el mismo cambio. Si el perfil la trae delegada igual, el arnés la saca al
  leerlo y lo avisa como ignorada; lo demás se sigue delegando. Volver al nivel de fábrica saca la firma de
  `approvals.levels`. Proponer niveles pide que la capa del equipo exija una versión del arnés que ya sepa leerlos.
  Quién firma cada nivel: el 1, la coordinadora si el perfil se lo delega (el plan, sólo con el veredicto aprobado de la
  revisión automática que ella lanza), y si no el dev en la ventana; el 2,
  siempre una persona en la ventana; el 3, una persona, y la emergencia en su terminal. Sin nadie que conteste, todo lo
  que no está delegado espera: el sistema no mira la hora, pide la firma igual y, si nadie contesta, la sesión queda
  frenada en ese paso. Con Codex, que no tiene ventana, todo se firma en la terminal. La matriz completa
  está en `guides/firmas-del-arnes.md`, «Quién firma cada nivel».

  **¿Quién firma? En corto.** Para saber quién firma algo en tu máquina, se mira esto:

  | Lo que hay que firmar | Sin coordinadora, estás | Sin coordinadora, no estás | Con coordinadora, estás | Con coordinadora, no estás | La revisión automática |
  |---|---|---|---|---|---|
  | Guardar el trabajo · 1 | vos | espera | la coordinadora \* | la coordinadora \* | no aplica |
  | Pedir otra revisión · 1 | vos | espera | la coordinadora \* | la coordinadora \* | no aplica |
  | Aprobar el plan · 1 | vos | espera | la coordinadora, sólo con el veredicto aprobado de la revisión que ella lanza \*\* | la coordinadora, sólo con el veredicto aprobado de la revisión que ella lanza \*\* | obligatoria para la coordinadora |
  | Aprobar el plan de una story delicada · 2 | vos | espera | vos | espera | ataca y avisa, nunca aprueba |
  | Saltear un control · 2 | vos | espera | vos | espera | no aplica |
  | Aceptar un criterio imposible de probar en vivo · 2 | vos | espera | vos | espera | no aplica |
  | Marcar un criterio como probado a mano · 2 | vos | espera | vos | espera | no aplica |
  | La emergencia · 3 | vos, en tu terminal | espera | vos, en tu terminal | espera | no aplica |

  \* Sólo si esa firma está en «Delegada a la coordinadora» y tu máquina está en «En qué máquinas vale lo delegado»;
  si no, es igual que sin coordinadora. \*\* La coordinadora lanza la revisión automática del plan y aprueba sólo si
  dice «aprobado»; ningún plan se aprueba solo, y el de una story delicada lo aprueba siempre el dev. Por qué cada rutina es rutina, y las notas, en `guides/firmas-del-arnes.md`.

  **Dónde se configura**, todo en esta sección:
  - **A · si hay coordinadora**: «¿Quién pasa la autorización para saltarse un control grave?», con «¿Cómo la llaman?»
    si es «Una sesión coordinadora».
  - **B · en qué máquinas**: «En qué máquinas vale lo delegado», cada una por su huella.
  - **C · quién firma cada cosa y su nivel**: «Quién firma cada cosa» (la lista la trae el arnés, igual para todos;
    el equipo no agrega ni saca filas) y «El nivel de cada firma» (se sube, nunca se baja; sólo la rutina se delega).
  - **En cada máquina**, la designación: «Esta sesión es la <nombre>» en el chat de la sesión elegida. Para que firme
    lo delegado, además, el dueño la confirma en su terminal con `node scripts/lib/delegated-signing.js
    confirm-designation` (ver `guides/firmas-del-arnes.md`, «Aprobar en nombre del dueño»). Se la reconoce por su
    conversación, sigue valiendo si se reinicia, y hay que repetirla tras un chat nuevo o un `/clear`. Si nadie la
    designó, nadie confirmó la designación, o la sesión está cerrada, no hay coordinadora: todo le llega al dev.
- **Prueba a mano de cada punto**: si, además de lo que prueba el arnés, una persona tiene que marcar cada criterio de
  la guía del tester antes de cerrar la historia. «No» (de fábrica): la guía dice qué probó el arnés. «Sí»: el cierre
  frena hasta que una persona marque cada criterio contestando en el chat de su sesión, nombrándolo; el arnés le muestra
  antes qué va a marcar, y el agente no puede marcarlo ni lo marca un reenvío. Vale sólo desde acá, nunca desde una
  máquina. Queda en `team-profile.json` → `qa.manual_check`, en el repo del perfil.
- **Frenos y medidores**: qué frenos y medidores corren en todas las máquinas. Los **frenos** paran un comando antes de
  que corra: el de pruebas sin acotar, el de dos sesiones en la misma carpeta y el de un pedido a la vez por repo. Desde
  acá sólo se encienden: «Como viene de fábrica» o «Encendido en todas las máquinas»; escrito a mano, vale «on» en
  cualquier mayúscula o `true`. Apagar un freno no se hace desde el perfil: es de cada máquina, con su variable (por
  ejemplo, `TYCON_SESSION_GUARD=0`), y un «off» escrito a mano en el perfil se ignora, el lector lo nombra y el sitio no
  lo propone. El freno de comandos peligrosos y el de pedidos a main sin completarse solos no están acá: vienen siempre
  encendidos y se apagan sólo en cada máquina. Los **medidores** (el del largo de las respuestas y el de esperas largas)
  no frenan nada: se encienden o se apagan. En los dos casos, la máquina que puso la variable sigue con lo suyo. Sin
  valor, cada uno como viene de fábrica. Ojo con otro valor escrito a mano (un número, un texto que no es ninguno de
  éstos): el lector no lo entiende y da por rota la configuración entera de cada máquina, no sólo este interruptor; el
  sitio no deja proponerlo. Queda en `team-profile.json` → `switches`, en el repo del perfil.
- **Cuántas sesiones trabajan a la vez**: cuando una sesión coordina a las demás, cuántas pueden estar trabajando al
  mismo tiempo en una máquina (de 1 a 20; sin valor, 3) antes de que la próxima espere su turno. Cada máquina puede
  cambiarlo para sí, porque cuánto aguanta depende de ella. La carpeta donde quedan las firmas del dueño es de cada
  máquina y no se pone acá. Queda en `team-profile.json` → `coordination.max_working`; la receta entera está en
  `guides/coordination.md`.
- **Integraciones**: qué servicios usa cada máquina (el reloj de horas, la memoria, el buzón, la noche, el índice de
  código de CodeGraph); una máquina puede apagar una para ella sola. Con CodeGraph prendido, el instalador se lo instala
  a cada dev y el arnés avisa si una máquina no lo tiene. Queda en `team-profile.json`, en el repo del perfil. Lo
  revisa quien mantiene. El renglón **«Avisos»** elige por dónde avisa el arnés (la ejecución que espera a una persona,
  el resumen de la mañana, el vigilante): uno o más de Telegram, Slack, Teams y correo, o ninguno; sin declarar,
  Telegram, como hasta ahora. Con el correo, el servidor y su puerto. Nunca pide una credencial: los avisos de la sesión
  de cada dev usan las suyas (`harness.js config set notify.<clave>`, en su máquina; Telegram, el bot de la máquina) y
  los de la noche, las variables secretas del servidor (`pipelines/operations/README.md`). Guardar los canales sube
  también `requires.harness` del perfil a la primera versión que los lee.
- **Conversaciones de las ejecuciones**: si el sitio baja también lo que se habló en cada ejecución; con eso, el detalle de
  Ejecuciones muestra los archivos que tocó. Queda en `operations.json`, en el repo de operaciones. Lo revisa quien
  mantiene.
- **Estimaciones**: la unidad en que estima la organización (horas, días o puntos), las horas de un día de trabajo (de
  1 a 24; vacío, 8) y las horas que vale un punto (vacío: sin tasa, y con puntos el error no se calcula). Abajo dice la
  unidad que leen hoy las máquinas. Cambiar la unidad no reescribe lo ya estimado. La estimación vigente de cada
  historia llega también a su pedido de trabajo, en Azure DevOps o GitHub. Queda en `team-repos.json` →
  `estimates`, en el repo del perfil; el perfil tiene que pedir una versión del arnés que lea la clave. Lo revisa quien
  mantiene.

![Cómo trabaja el agente](sitio-de-la-organizacion/capturas/configuracion-claude.png)

### Tu tecnología

Lo que la persona ve en la sección y lo que hace el agente cuando le piden una herramienta que no está.

- **En el sitio**: los lenguajes que el arnés ya reconoce, las terminaciones que suma tu equipo, la tabla de
  herramientas de prueba y las tres reglas. Cada herramienta muestra su nombre, el archivo que la detecta, su origen y
  qué se puede hacer:
  - **incluida en el arnés · no se edita**: .NET, Vitest, Jest y Node, que la puerta de pruebas corre por dentro.
    «Reemplazar» copia (si el navegador deja) y muestra la frase para el agente, armada para esa herramienta: el agente
    arma una receta de la organización que se detecta con el mismo archivo y le gana, la aprueba un admin y desde la
    próxima ejecución se usa la tuya.
  - **de fábrica · se puede cambiar**: pytest, Go, Maven, Gradle, Karma y Playwright. «Cambiar» trae el formulario lleno
    con la de fábrica, y al guardar queda una copia de la organización con el mismo nombre que la reemplaza.
  - **cambiada por tu organización**: esa copia. «Volver a la de fábrica» la borra.
  - **agregada por tu organización**: una herramienta nueva, como la de .NET Framework con vstest.
  El comando de una herramienta lo corre la computadora de cada persona del equipo.

  ![Cómo se corren las pruebas](sitio-de-la-organizacion/capturas/configuracion-tecnologia.png)

- **«Pedíselo a tu agente»** deja la frase «configurá las pruebas de mi proyecto en la configuración del arnés». La
  persona la pega en su agente de código, abierto en el proyecto.
- **Lo que hace el agente** con esa frase:
  1. Mira el proyecto: qué herramienta corre las pruebas, el **archivo que la detecta** (por ejemplo `Cargo.toml`), el
     comando, qué reporte deja y dónde, y si mide la cobertura y en qué formato (Cobertura, lcov, istanbul, JaCoCo o el
     perfil de Go). `{results}` es la carpeta de la ejecución.
  2. Arma la entrada de `stack.test_runners` en `team-repos.json` del repo del perfil: `name` (minúsculas y guiones),
     `label` (el nombre que ve una persona en el sitio, por ejemplo «.NET Framework (vstest)»), `detect`, `command`,
     `results` y, si mide, `coverage`.
  3. La valida con el lector de las máquinas antes de proponer:
     `node -e 'console.log(JSON.stringify(require("<arnés>/scripts/lib/team-repos.js").parse(require("fs").readFileSync("team-repos.json","utf8")).sectionProblems || {}))'`.
     Sin problemas en `stack`, la propone como pedido al repo del perfil.
  4. Un admin aprueba el pedido y la herramienta aparece en la lista, donde se puede cambiar.
- **Lo que la receta permite**, para que el agente no proponga algo que el lector rechaza o que nunca aplica:
  - **El reporte** es `junit`, `jest-json` o `trx` (el de vstest, `/Logger:trx`); `path` puede tener `*` y `**`.
  - **El archivo detector** es un nombre exacto. Se busca en la carpeta que se prueba y, con `detect_depth` (de 0 a 3),
    en sus subcarpetas, sin entrar a `bin`, `obj`, `node_modules` ni carpetas con punto. Elegí uno propio de la
    herramienta: `packages.config` es de .NET Framework; un `.sln` o un `.csproj` sueltos son de cualquier .NET y le
    quitarían el lugar a `dotnet test` en los demás repos.
  - **Una herramienta de la organización le gana a .NET** si su archivo detector está en la carpeta de la solución (o
    en sus subcarpetas, con `detect_depth`). Corre una vez, desde la solución.
  - **Lo que cambia de un repo a otro** (un filtro de categorías, por ejemplo) no va en el comando: va en `repos`, una
    entrada `{ "repo": <repo>, "args": "…" }` por repo, con la forma `<repo>` de este mismo archivo. El comando lo usa
    como `{args}`; un repo sin entrada usa `args_default`, o nada. `args` no puede traer comillas, `$`, comillas
    invertidas, barra invertida ni saltos de línea, porque va entre comillas en el comando. El repo se reconoce por su
    remoto `origin`.
    En el sitio, «Cambiar» muestra «El filtro de cada repo»: «Agregar un repo» elige de los repos de la organización (los
    de la revisión de dependencias y los que ya nombra este archivo), y cada renglón tiene su filtro y su «Quitar».
  - **El comando corre con bash** y la primera palabra tiene que estar en el PATH (si no, la puerta dice que falta).
    Nada se lee del repo que se prueba.
- **Dónde está el clon del perfil**: `harness.js team-config --no-open` dice qué carpeta usa esta máquina (la clave
  `paths.team`). Si no hay ninguna, se clona el repo `profile` de `team-repos.json` en una carpeta propia.
- **El pedido** va a la rama principal del repo del perfil, **sin auto-completar**: lo lee y lo aprueba un admin.

### Instalación y actualización

- **Cómo se actualizan las computadoras del equipo**: qué versión toma cada máquina y cómo se aplica. «Automática, sólo
  avisa»: cada máquina se actualiza sola al arrancar y le avisa al dev, que no la puede saltear. «Pregunta a cada dev»
  (la de fábrica): la máquina avisa que hay una versión nueva y cada dev decide cuándo instalarla, con
  `npx @tyconsa/harness@latest`. Queda en `team-profile.json`, en el repo del perfil. Lo revisa quien mantiene.
- **Perfil de instalación**: cuánto instala el arnés en cada máquina (mínimo o completo), con la lista de lo que trae
  cada uno. Queda en `team-profile.json`, en el repo del perfil. Lo revisa quien mantiene.
- **Paquetes de la organización**: qué paquetes del arnés (los revisores y las guías de un producto o de un cliente)
  se activan en todas las máquinas. Queda en `team-profile.json`, en el repo del perfil. Lo revisa quien mantiene.
- **Cómo se actualiza el freno de producción** (`guard.update`): cómo se pone al día el freno que protege las bases de
  producción en las máquinas autorizadas. Las dos opciones, cada una con su costo:
  - «Con la contraseña de la persona» (de fábrica, lo más seguro): cada actualización la hace la persona de esa máquina
    escribiendo su contraseña. Mientras nadie lo haga, la máquina sigue con el freno viejo.
  - «Solo, desde la versión publicada»: la máquina se pone al día sola, sin contraseña, con la versión publicada y
    verificada contra el repositorio del equipo. El costo: un freno publicado más flojo llega sin que nadie lo apruebe en
    esa máquina, y cualquier programa que corra con el usuario de la persona puede pedir la actualización (no puede elegir
    qué se instala). Cada actualización queda registrada y el aviso de arranque la muestra.
  Elegir «solo» no cambia ninguna máquina: cada persona instala el permiso una vez, con su contraseña
  (`install-guard.sh --allow-auto-update`), y el aviso de arranque le dice el comando. Si la organización vuelve a «con
  la contraseña», el aviso de cada máquina con el permiso dice cómo sacarlo (`--remove-auto-update`). Vale sólo desde
  acá, nunca desde una máquina. Queda en `team-profile.json` → `guard.update`, en el repo del perfil.

De fábrica, las dos opciones nuevas están en lo más seguro: la firma delegada apagada y el freno con la contraseña.

Debajo está **Qué versión del arnés tiene cada máquina**, la que informó cada una en su última subida diaria, con o sin ejecuciones. Es para mirar:
las máquinas se actualizan solas al arrancar.

![Instalación y actualización](sitio-de-la-organizacion/capturas/configuracion-instalacion.png)

## Qué ve cada rol

El sitio decide quién sos por tu correo, y sólo con la lista de «Quién entra al sitio»:

| Rol | Inicio | Ejecuciones | Mantenimiento | Proyectos | Arnés | Cómo trabaja | Configuración |
|---|---|---|---|---|---|---|---|
| **Quien mantiene** | «Qué decidir hoy», de toda la organización | todas las ejecuciones | sí, y decide cada una | todos los productos | sí | sí, y propone cambios a sus revisores | sí, y propone cambios |
| **Persona confirmada** (dev de la lista) | «Lo tuyo» | las de sus máquinas confirmadas | no | los productos en los que trabaja | no | no | no |
| **Persona con la máquina sin confirmar** (dev de la lista) | «Lo tuyo» | las de sus máquinas confirmadas; las de la máquina nueva, todavía no | no | los productos en los que trabaja | no | no | no |
| **Sin rol** (no está en la lista) | sólo la página «Tu cuenta no está en la lista» | no | no | no | no | no | no |

**Cómo se pasa de un rol a otro.** Lo decide quien mantiene, en Configuración, y entra cuando alguien aprueba el pedido:

- Para entrar como **dev**, tu correo tiene que estar en «Quién entra al sitio» con el rol «Dev». Para ver tus ejecuciones,
  además, una máquina tuya tiene que estar confirmada a tu nombre («Personas y máquinas»): aparece sola en «Por
  confirmar» cuando sube su primera ejecución.
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

### No veo mis ejecuciones

**Lo que se ve:** entrás, pero en Ejecuciones faltan ejecuciones tuyas.

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

### Cargando las ejecuciones

**Lo que se ve:** «cargando las fuentes» o «cargando las ejecuciones», y la página se recarga sola.

**Por qué pasa:** el sitio acaba de arrancar y todavía está leyendo el repo de operaciones o bajando el buzón de
ejecuciones. La primera bajada del buzón puede tardar unos minutos.

**Qué hacer:** esperar. Si sigue igual más de diez minutos, avisale a quien mantiene.

![Ejecuciones mientras el sitio baja el buzón](sitio-de-la-organizacion/capturas/cargando-corridas.png)

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

## El sitio demo

Es el mismo sitio, con datos de ejemplo de una organización inventada (**Acme**), abierto con un link y **sin cuenta**,
para mostrar qué hace sin dar acceso a nada real. Corre como una instancia aparte: no es el sitio de la organización ni
lo reemplaza, y nada de lo que se ve en él existe.

**Qué se ve.** Todas las pestañas con los datos de ejemplo: Inicio, Ejecuciones (con su detalle y sus textos), Proyectos,
Arnés, Cómo trabaja, Configuración y Ayuda. Arriba de cada página, una franja fija dice **Datos de ejemplo**, y el título
de la pestaña del navegador también. El selector **Ver como** deja mirar el sitio como quien lo mantiene (todo, con
Configuración) o como una persona del equipo («Lo tuyo», sin Configuración). Los botones que cambian algo (**Proponer** en
Configuración y en Cómo trabaja, **Invitar** y **Revocar**) revisan como siempre y muestran lo que pasaría, y dicen que en
el sitio demo no se escribe.

**Qué no hace.**

- **No escribe.** Ni en un repo ni en el disco, salvo en una carpeta temporal propia que se borra al apagarse. El idioma
  que se elige vale sólo en la cookie del navegador.
- **No sale.** No abre conexiones hacia afuera y no lanza `git` ni ningún otro proceso: lo que el sitio real le pregunta a
  la plataforma (pipelines, stages, tipos de pedido, la política de revisión) se contesta de adentro, con datos de ejemplo.
  Si algo lo intentara, queda en el registro y falla.
- **No tiene cuentas ni credenciales.** Arranca sólo con `SITE_DEMO=1` (con otro valor no arranca, y el sitio real dice
  `demo: false` en su línea de arranque y en `/livez`). Acepta únicamente `SITE_DEMO`, `PORT` y `SITE_PUBLIC_URL`: con
  cualquier otra variable del sitio, o una identidad de la plataforma, no arranca y dice cuál.
- **Lo mínimo de un sitio público.** Pide a los buscadores que no lo indexen (`noindex`) y limita a 60 pedidos por minuto
  por dirección (la última de `X-Forwarded-For`, que es la que agrega la entrada de la plataforma).

**Probarlo en tu máquina.** Desde el clon del arnés: `SITE_DEMO=1 PORT=8080 node scripts/site/server.js` y abrir
`http://localhost:8080`. Con otro nombre de máquina, agregá `SITE_PUBLIC_URL=http://<nombre>:8080`: los botones comparan el
origen del pedido con esa dirección.

**Instalarlo en Azure Container Apps.** Es una instancia aparte; conviene darle su propio grupo de recursos. Con el
instalador de la receta de Azure, en dos fases y con un archivo de configuración sin secretos (`subscription`,
`resourceGroup`, `location`, `environment`, `app`, `logAnalyticsWorkspace`, `logAnalyticsQuotaGb` e `image`, la imagen
publicada por su huella `@sha256:…`, de una versión que traiga el modo demo):

1. `node scripts/site/deploy/azure-container-apps.js --config demo.json --phase ambiente --dry-run` y después `--apply`:
   crea el ambiente. Ignorá las dos vueltas de Entra ID que imprime: el demo no tiene inicio de sesión.
2. `node scripts/site/deploy/azure-container-apps.js --config demo.json --phase demo --dry-run` y después `--apply`:
   crea la aplicación e imprime el link.

La aplicación sale **sin candado** de la plataforma, **sin disco**, **sin identidad** administrada y sin secretos; abierta
desde el principio (sólo HTTPS) y con escala a cero: se apaga sola sin uso (cero réplicas) y la primera visita después de
un rato tarda unos segundos en despertarla. No acepta buzón, repo, inquilino ni disco en el archivo de configuración: si
los trae, no corre y dice cuáles. Repetir la fase `demo` sobre una instancia que ya existe la actualiza (no crea otra);
si un paso falla, se detiene, dice cuál y qué quedó creado, y correrla de nuevo la completa. Nunca toca una aplicación que
no sea una instancia demo.

**Al día.** El actualizador del sitio también lo pone al día con `stable`: `update-site.js` con `--demo` y la aplicación
y el grupo del demo. Como el demo es abierto, no le corre la prueba sin sesión: le pide `/livez` con `demo: true` y la
portada con la franja «Datos de ejemplo». Si no pasa, vuelve a la huella anterior, como con el sitio real. El nocturno
lo corre en un paso propio, con la misma credencial; ésta necesita su rol también sobre la aplicación del demo.

**Borrarlo.** Todo lo del demo está en su grupo de recursos: `az group delete --name <grupo> --subscription <suscripción>`
lo borra entero (pide confirmación). Hacelo sólo si ese grupo es propio del demo. Sin borrarlo, apagado ya está: con cero
réplicas no corre ningún contenedor.

## Qué hace falta antes

- **La imagen del sitio.** Se publica sola en el registro de paquetes del repo público del arnés cada vez que cambia lo
  que trae. También la podés armar vos (abajo).
- **Una forma de iniciar sesión de la organización:** Entra ID, Google Workspace, GitHub, o cualquier proveedor OIDC
  (Okta, Keycloak). En ese proveedor se registra una aplicación para el sitio.
- **El repo de operaciones** de la organización, y una identidad que lo pueda leer (sólo ese repo). Si todavía no lo
  tenés: cómo se crea y qué archivos lleva, en `pipelines/operations/README.md` §2 del arnés (los ejemplos, en
  `pipelines/operations/examples/`). Para el sitio alcanza con `operations.json`; lo mínimo, en la prueba con Docker.
- **Opcional: el buzón de ejecuciones**, si la organización junta las ejecuciones de las máquinas.
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
ejecuciones y, con `site.mailbox.threads: true`, un resumen chico de cada conversación) y la última configuración buena.
Las conversaciones no se guardan: cada una se baja una vez, se resume y se borra, y la pasada no baja más de 300 MB de
conversaciones por vez. Los clones de los repos y los textos de los cambios van al disco del contenedor, nunca al volumen
(un disco de red montado por SMB no admite el `chmod` que git hace al clonar). Medido con un buzón de 6,9 GB: sin
las conversaciones, ocupa 163 MB, a los que se suman los resúmenes (unos kilobytes por ejecución) y, mientras dura una
pasada, hasta 300 MB de conversaciones por resumir. **2 GB alcanzan**, con lugar para crecer. **Sin volumen el sitio igual anda**: usa
una carpeta temporal y lo dice. Pero lo que sale de las conversaciones en la pestaña Ejecuciones queda «no medido», cada
reinicio vuelve a bajar todo, y un reinicio reinicia el plazo de 24 horas que tiene una configuración rota antes de que
el sitio se frene (y levanta el freno hasta que vuelva a vencer).

### La memoria

1 GB. Armar la vista de ejecuciones con sus conversaciones mide unos 700 MB de pico.

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
| `SITE_MAILBOX_SAS` (o `SITE_MAILBOX_IDENTITY=managed`) | leer las ejecuciones del buzón | una SAS de sólo leer y listar (`rl`) atada a una política guardada del contenedor, 6 meses como máximo; o la identidad de la plataforma con un rol de lectura sobre el contenedor |
| el canal del aviso | mandar el aviso de la mañana | no llega al sitio: lo usa el proceso de la noche. Telegram: el token sirve para todo el bot, usá uno dedicado. Slack o Teams: la dirección del webhook ES la credencial |
| `SITE_OPERATIONS_WRITE_TOKEN` | proponer cambios de configuración desde el sitio | en GitHub, de grano fino sobre el repo de operaciones con `contents: write` y `pull_requests: write`; en Azure DevOps, una cuenta dedicada con *Contribute*, *Create branch* y *Contribute to pull requests* sólo en ese repo, *Force push* negado y sin permiso de saltar políticas |
| `SITE_PROFILE_REPO` y `SITE_PROFILE_TOKEN` | leer el perfil del equipo (dónde vive cada repo, los paquetes) | parte de la instalación normal: sin ellos la pestaña Configuración dice «falta el repo del perfil». La dirección del repo del perfil y un token de sólo lectura de código sobre ese repo (puede ser el mismo permiso que el del repo de operaciones, si los dos viven en la misma organización) |
| `SITE_PIPELINES_TOKEN` | leer los pipelines, para elegirlos por nombre en la pestaña Configuración («Pruebas al mergear» y «Despliegues») y ver el nombre de cada paso | parte de la instalación normal en Azure DevOps: sólo *Build: Read*, de la organización, 90 días; puede ser el mismo permiso que el del repo de operaciones con *Build: Read* sumado. Sin él, la pestaña pide el número del pipeline a mano y dice qué falta, y los pasos guardados se ven por su identificador |
| `SITE_PROFILE_WRITE_TOKEN` | proponer cambios al perfil del equipo | apagada por defecto: vacía o comentada, nunca con un valor; una identidad dedicada y un repo por credencial |
| `SITE_PRODUCTS_WRITE_TOKEN` | leer y proponer el `.tycon/advisors.yaml` de los repos de producto («La configuración de cada repo») | opcional. En Azure DevOps, *Code: Read & write* y nada más, sólo en los proyectos de los repos de producto; en GitHub, de grano fino sobre esos repos con `contents: write` y `pull_requests: write`. Sin ella, la sección lee con la credencial de operaciones (si llega a esos repos) y no propone |

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

**En GitHub** la noche entra sola. Quien abre un pull request no puede aprobarlo, así que el sitio no vota: une su
pedido directo cuando su identidad puede saltear la revisión; si el repo pide la aprobación de otra persona, le prende la
**unión automática** (*Allow auto-merge*) y entra cuando alguien lo apruebe; y si GitHub no deja la unión automática, el
pedido queda abierto para que alguien lo apruebe y lo una a mano. Con la regla de empuje por ruta del README de GitHub,
el sitio no propone cambios a `operations.json`: los valida y descarga, y quien mantiene abre el pull request a mano.

**Lo que se resigna.** Nadie revisa esos cambios antes de que entren. Queda la constancia: cada cambio del sitio es un
pedido con quien lo pidió, y el registro del sitio anota `cambio aplicado: <archivo>, pedido <enlace>`.
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

Los repos de producto llevan su propio secreto, `SITE_PRODUCTS_WRITE_TOKEN`. Para darlo de alta:

1. Creá la credencial con el menor permiso. En Azure DevOps, un permiso de la organización con *Code: Read & write* y
   nada más, limitado a los proyectos de los repos de producto. En GitHub, uno de grano fino con *Contents: Read and
   write* y *Pull requests: Read and write*, sólo sobre esos repos. Los repos son los que muestra «La configuración de
   cada repo».
2. Cargala como secreto del sitio con ese nombre y reiniciá el sitio.
3. Mirá que la rama principal de cada repo pida al menos un revisor que no sea quien crea el pedido. Sin esa política,
   el sitio no propone a ese repo y lo dice.

Con ese secreto el sitio sólo crea ramas `team-config/...` y abre pedidos. Nunca escribe `main` ni completa el pedido,
aunque «Los cambios de un mantenedor» esté prendida: esa opción vale para el perfil y para operaciones, no para los
repos de producto.

Una organización puede elegir no pedir ese revisor en sus repos de producto, por ejemplo porque cada dev mergea solo a
`main`. Entonces «Proponer» queda apagado en esos repos: se revisa el cambio, se descarga y el pedido se abre a mano.

### Invitar a alguien

Con Microsoft en «sólo la organización», alguien de afuera del directorio (una cuenta personal, alguien de otra
empresa) entra recién cuando está en el directorio y en la lista del sitio. En Configuración → Personas, «Quién entra al
sitio» → **Invitar a alguien**: su correo y sus productos. «Invitar» abre un pedido que lo suma a la lista como dev, con
sus productos y una marca (`site.invitations`: quién invitó y cuándo). Cuando el pedido se aprueba y el sitio lee la
lista nueva, el sitio le manda la invitación de Microsoft, que lo lleva al sitio. Al lado de su correo se ve el estado:
«invitación enviada, todavía no entró», «aceptada» (ya entró), «esperando el tope de mañana» o «no se pudo enviar» con
el motivo; una falla se reintenta sola en el próximo refresco (si Microsoft no llegó a contestar, la persona puede
recibir un segundo correo). Hasta 10 invitaciones por día
(`SITE_INVITATIONS_PER_DAY`); las que pasan esperan al día siguiente.

- Un correo de un dominio de la propia organización no se invita: esa persona necesita una cuenta en el Microsoft 365
  de la organización, y la pantalla lo dice.
- Un correo que no es cuenta de Microsoft acepta con un **código de un solo uso** que Microsoft le manda al correo, si
  el directorio lo tiene prendido. El instalador lo lee y lo deja en `SITE_INVITE_EMAIL_CODE`; si está apagado o no se
  sabe, la pantalla avisa al invitar y dice dónde se prende.
- **Revocar** abre un pedido que lo saca de la lista y borra su marca; si la invitación todavía no salió, ya no sale.
  No lo borra del directorio: para eso, el portal de Entra, con el enlace que da la pantalla.
- Con otro inicio de sesión no hay botón: con «cualquier cuenta» de Microsoft no hace falta invitar (se suma a la
  lista); con Google o GitHub, se suma a la lista y entra con su cuenta de Google o GitHub de ese correo; sin identidad
  administrada, se invita a mano en el portal y se suma a la lista.

### El permiso de invitar

Para mandar la invitación, la identidad administrada del sitio necesita **un** permiso de Microsoft Graph:
`User.Invite.All`, de aplicación. Ninguno más: el sitio no lee, cambia ni borra usuarios.

**Su riesgo, en llano**: quien controle la identidad del sitio puede invitar **cualquier correo** como invitado al
directorio entero, no sólo a este sitio. Un invitado aceptado entra a cualquier aplicación de la organización que no
pida asignación, y ve lo que la organización comparte con «todos, incluidos los invitados». Cómo se acota: sólo quien
mantiene ve el botón; la invitación sale recién cuando el pedido se aprueba; el código llama a Graph en un solo lugar,
con el cuerpo fijo (invitado, de vuelta al sitio, sin grupos ni roles); el token vive sólo en memoria; hay un tope por
día. Recomendado: las restricciones de invitados más cerradas del directorio y pedir asignación en las otras
aplicaciones.

**Cómo se da**: lo da, una vez, un administrador del directorio (Administrador de roles con privilegios o Administrador
global), con el instalador y su sesión de `az`:

```bash
node scripts/site/deploy/azure-container-apps.js --config <tu archivo> --phase permiso-de-invitar --dry-run   # qué hace
node scripts/site/deploy/azure-container-apps.js --config <tu archivo> --phase permiso-de-invitar --apply
```

Asigna el rol a la identidad del sitio y deja `SITE_INVITE_EMAIL_CODE`. Sin el rol de administrador, lo dice y no cambia
nada. Mientras falta, el botón dice «Falta el permiso de invitar», quién lo da y este comando.

**Para sacarlo**: en Entra → Aplicaciones empresariales → la identidad del sitio → Permisos, revocá `User.Invite.All`.
El botón vuelve a decir que falta, y nada más cambia.

### Los cambios que se aplican solos

Con `site.auto_apply: true` en `operations.json` («Los cambios de un mantenedor», en Personas), el sitio aprueba y
completa cada pedido que propone quien mantiene. Para eso su identidad de escritura necesita, en Azure DevOps, *Code:
Read & write* y *Contribute to pull requests* sobre el repo, y nunca *Bypass policies*: el sitio no saltea ninguna
política, y si una no se cumple con su voto, el pedido queda. La política de revisión de `main` es la de la
organización (arriba): deja que cuente el voto de quien crea el pedido, pide un solo revisor, no prohíbe aprobar a quien
empujó el último cambio y no nombra revisores. Si pide más, el pedido queda y la sección dice qué falta.
Sin ninguna política en `main`, «Proponer» sigue apagado aunque la opción esté prendida. Para encenderla, primero la
imagen nueva, después la clave: una imagen anterior no conoce `site.auto_apply` y daría `operations.json` por inválido
(se queda con el último bueno). Cada cambio aplicado deja su línea en el registro del sitio con el enlace a su pedido;
el correo de quien lo pidió no va al registro: lo dice el pedido.

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
- **Memoria:** 512 MB en el plan gratis, menos que el 1 GB que pide el sitio para armar la vista de ejecuciones con sus
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
  (nunca en el disco), y el buzón de ejecuciones con una SAS de sólo lectura o la identidad administrada. Lo de cada nube
  vive sólo en `cloud/`. Las fotos se copian con lista blanca: ningún título, diagnóstico ni mensaje llega al modelo. En
  pantalla se ve un estado de lista cerrada, y el motivo crudo va sólo al registro.
- **El refresco** es cada 15 minutos y conserva el último bueno. Si `operations.json` deja de validar, vale el último
  bueno 24 horas, con una banda para quienes mantienen; después el sitio se frena para todos. El plazo se guarda en
  `SITE_DATA_DIR`. La imagen deja `/data` del usuario del sitio y la declara volumen, así un volumen nuevo nace
  escribible. La bajada del buzón va de a varios archivos a la vez dentro de su tope de 2 minutos; si corta, la pasada
  siguiente sale a los 10 segundos y retoma donde quedó. La navegación no espera todo: con el repo de operaciones
  leído, las pestañas se ven, y sólo Ejecuciones espera el buzón. Toda página de carga se recarga sola cada 5 segundos.
- **Las pestañas** (`views.js`) las arma el servidor, sin JavaScript de afuera y sin `<script>` en línea. «No medido»
  nunca es 0.
- **Los textos, en los dos idiomas** (`scripts/site/texts.js`): todo texto que el sitio muestra vive en esa tabla, una
  clave con su castellano y su inglés. Para agregar un texto se suma su clave con los dos idiomas y la vista la pide con
  `t(idioma, 'la.clave')`; nunca se escribe en la vista. `site-texts.test.js` frena una clave sin uno de los dos idiomas
  y una página armada en inglés que trae castellano. El idioma de cada pedido lo decide `language.js`: la preferencia
  guardada de la persona (en `SITE_DATA_DIR/idiomas.json`, por huella del correo), la cookie `sitio-idioma`, el
  navegador y, al final, castellano. Los mensajes que el servidor de Configuración arma en castellano se traducen al
  salir con el mismo molde de la tabla. El cuerpo de Ejecuciones y el catálogo de lo que instala el arnés todavía salen en
  castellano.
- **Lo que no hace:** no escribe en ningún repo salvo los pedidos de la pestaña Configuración, no acciona nada, y no
  baja conversaciones salvo para la pestaña Ejecuciones, con `site.mailbox.threads` y un disco.

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

### La pestaña Ejecuciones

La vista de ejecuciones en el sitio, cada uno lo suyo (`tabs/runs.js` sobre `scripts/nightly/dashboard/runs.js`: un solo
código para la vista local y la del sitio).

- **El filtro lo hace el servidor, antes de cada respuesta** (`filtrarCorridas` de `access.js`). Una ejecución ajena, una
  sin máquina y un id que no existe contestan igual: 404 sin cuerpo.
- **Lo que viaja, por partes:** la lista, el detalle al abrir una ejecución y los textos al abrir un cambio. Cada ejecución
  tiene un id estable (16 hexadecimales del sha256 de máquina y sesión).
- **El armado en un hilo aparte**, con techo de memoria: medido con 551 ejecuciones, 34 segundos y unos 690 MB de pico.
  Mientras rearma, o si falla, sirve el anterior entero con su hora.
- **Las conversaciones, sólo con disco** (`site.mailbox.threads: true` y `SITE_DATA_DIR`). Sin eso, lo que sale del hilo
  dice «no medido». Con eso, cada conversación se baja una vez, por tandas de hasta 300 MB, y se resume: la
  descripción de la ejecución, el reparto del tiempo y la lista de cambios. Después se borra del disco. La tabla y el
  detalle salen del resumen. Los textos de los cambios (los parches) se bajan cuando alguien abre los cambios de una
  ejecución, y quedan en un caché de 200 MB en el disco del contenedor; al llenarse, se borran los abiertos hace más
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

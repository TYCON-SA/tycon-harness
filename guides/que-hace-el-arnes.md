# Qué hace el arnés — el recorrido

Todo el arnés existe por un enemigo con tres caras, y las tres son la misma cosa: **algo que tenía
que acordarse, y no se acordó.**

El modelo **olvida** — cada sesión arranca de cero y vuelve a inventar distinto. La persona se
acuerda **a medias** — el martes sí, el viernes a las siete de la tarde no. Y el error, que es la
peor de las tres, **no da error**: da silencio, y el silencio se lee como *"salió limpio"*.

Lo que sigue es el recorrido de un día de trabajo, y en cada momento hay un lugar donde una de esas
tres caras fue acorralada. No es un inventario de piezas —eso está en el [README](../README.md)—
sino qué se activa, qué te evita, y qué pasaría si no estuviera.

> Arranca **antes** del arnés propiamente dicho: en la spec. Sin ella no habría contra qué
> verificar, y la mitad de los controles no tendrían sentido.
>
> Censado del repo el 2026-08-28, contra el disco. Los números volátiles citan el comando que los
> emite — ver la nota al pie del inventario.

---

## La respuesta de una frase

> **El arnés hace que ninguna regla dependa de que alguien se acuerde.**

Todo lo demás es implementación de esa frase. Si tenés 30 segundos, decís eso y parás.

Y si tenés más tiempo, lo que sigue **no son mensajes nuevos: es la prueba de ése.** La spec es *por
qué se puede* verificar. El ancla en patrones probados es *por qué no se reinventa*. Los 332 casos
de prueba son *por qué le podés creer*. Un solo mensaje, tres pruebas.

---

## Contra qué defiende — y qué es, literalmente, un arnés

**Primero el dolor, porque sin el dolor todo lo que sigue parece burocracia.**

Un modelo de lenguaje es el programador más rápido que conocés, y tiene tres defectos de fábrica:

1. **Olvida.** Cada sesión arranca de cero: las decisiones de ayer, las convenciones del repo, el
   bug que ya resolviste.
2. **Es inconsistente.** La misma instrucción dos veces da dos resultados. A veces corre los tests,
   a veces "infiere" que no hace falta.
3. **Declara "listo" sin probar.** Marca la tarea terminada con el build en verde, sin correr nunca
   el flujo real. Es optimista por diseño.

**Arnés** es la capa que envuelve al modelo y decide qué puede y qué no puede hacer: el modelo
propone (texto y pedidos), el arnés dispone (qué se ejecuta de verdad y qué se bloquea). La palabra
es literal — un arnés encauza una fuerza potente sin frenarla: la dejás trabajar, pero no hacer
cualquier cosa. El modelo es el caballo.

Entonces, cuando la frase de arriba dice *"que ninguna regla dependa de que alguien se acuerde"*,
**ese alguien es, primero, el modelo** — y en segundo lugar la persona, que se acuerda a medias.
Todo lo que sigue es sacarles el determinismo y la memoria de encima y ponerlos en scripts, que sí
se acuerdan siempre.

### Cuatro palabras que vas a leer todo el tiempo

| Palabra | Qué es |
|---|---|
| **control** | cualquier pieza que verifica algo — el género que engloba a todas |
| **portón** | un control que **bloquea**: no te deja pasar al paso siguiente sin cumplir algo |
| **medidor** | un control que **no** bloquea: mide, archiva, y te lo cobra al turno siguiente |
| **revisor** | una instancia fresca del modelo, contexto limpio y permisos de sólo lectura, que audita el código contra una lista de reglas. **No es un script: es IA** |

Y una quinta, la más usada de todas: **hook** es un script que el arnés dispara solo ante un evento
—abrir la sesión, editar un archivo, commitear—. No lo decide el modelo y corre siempre igual: son
los **reflejos** del sistema. Cuando un hook devuelve el código de salida 2, la acción no se sugiere:
se frena.

> **Regla de lectura**: salvo que diga "revisor", todo lo que nombra este documento es un script
> determinista. Las dos excepciones están marcadas donde aparecen (el clasificador del carril y la
> minería de instintos, que sí usan un modelo barato).

---

## Los tres principios que explican cada pieza

Cualquier pieza del arnés que mires es una de estas tres frases, hecha código. En este orden:
el problema, la regla que se deduce, y la prueba de que se cumple.

**1. No hay error más caro que el que no da error.**
Un `ls` a la carpeta equivocada devuelve vacío, y ese vacío se lee como *"este proyecto no tiene
documentación"*. Una story con el encabezado roto no falla: simplemente **desaparece** de todas las
herramientas — cuatro estuvieron invisibles **dos meses** por eso, una de ellas tapando una deuda de
evidencia. Hoy lo caza un lint en el pre-commit. Por eso hay controles cuyo único trabajo es
**romper el silencio**.

**2. Un control que hay que acordarse de invocar es un control que no corre.**
Por eso nada del arnés se invoca a mano: se dispara con lo que ya hacés — abrir la sesión, escribir
un prompt, editar un archivo, commitear.

**3. Cada control tiene otro control que lo mira.**
Un freno que nadie prueba no es un freno: es una decoración. Por eso hay medidores, un banco de
pruebas de los controles, y controles que censan el disco en vez de leer una lista escrita a mano.

---

## El piso sobre el que apoya todo: la spec manda

Antes del primer control hay una decisión de fondo, y es la que hace posible a todas las demás:

> **El arnés no revisa el código contra su opinión — lo revisa contra la spec.**

Sin planos, un inspector de obra sólo puede decirte que la pared está torcida. **Con planos te puede
decir que falta un baño.** Es la misma persona y el mismo ojo; lo que cambia es que ahora hay contra
qué comparar. Todos los portones del recorrido son ese inspector con los planos en la mano,
preguntando lo mismo en momentos distintos: *¿este código hace lo que el criterio de aceptación
número 3 dice que tiene que hacer?*

### Spec-Driven Development, en una frase

Definís la spec —el qué, el porqué y **cómo se verifica**— antes del código. La spec es la fuente de
verdad: guía la generación del código y también su validación.

> **El mantra**: la spec manda · el código la sirve · la verificación es mecánica.

Lo que se invierte es **quién manda**: antes el código era la verdad y la spec una sugerencia; acá
la spec manda y el código la sirve. De ahí sale la regla de oro: **todo cambio de comportamiento se
hace primero en la spec**. Para nosotros esa spec es, al arrancar, el producto entero (documento de
producto, arquitectura, épicos e historias, con BMAD —la herramienta de la sección siguiente—, una
vez) y después la historia: primero se actualiza la historia y recién después se implementa. El
documento de producto y la arquitectura no se vuelven a tocar salvo que una historia los cambie de
verdad. Nunca al revés — así la historia no envejece mientras el código se le escapa.

**Por qué se invierte tanto arriba**: la curva de Boehm. El mismo error cuesta 1 si lo cazás en la
spec, 10 si llega al código, 100 si llega a producción. La IA no la borra: la **corre hacia la
spec**, porque ahora reescribir código es barato y lo caro es el error que llegó a producción
replicado fiel en todo lo que se generó.

### BMAD es la herramienta; SDD es la forma de trabajar

- **SDD** es la filosofía: *hay que tener planos antes de construir.*
- **BMAD** es el estudio de arquitectura que produce los planos, los revisa entre ellos y supervisa
  la obra: 21+ agentes, 50+ workflows, open source, agnóstico de herramienta.

Si BMAD desapareciera mañana, SDD sigue válido. Lo usamos porque tenemos datos reales con él.

Y lo que lo hace encajar con el arnés: en BMAD **la spec vive y evoluciona con el código**, no se
descarta después de generar. Eso es exactamente lo que permite que el arnés siga preguntando contra
ella meses después. Con una herramienta donde la spec se usa y se tira, la mitad de los controles
del recorrido no tendrían sentido.

### La cadena: de la idea a la story

Cinco etapas y **tres decisiones tuyas antes de la primera línea de código**:

```
1  Entender      brainstorming, research      → ¿se entiende el problema?
2  PRD           create-prd + party-mode      → ⏸ revisás el PRD
3  Arquitectura  create-architecture          → ⏸ revisás la arquitectura
4  Stories       épicas → sprints → stories   → ⏸ revisás cada story
5  Código        el pipeline del recorrido    → el código se revisa contra la story
```

Cada artefacto **se commitea al repo**, al lado del código: versionado, con historia y diff. Y en
cada punto de revisión se puede lanzar una pasada adversarial que verifica la concordancia entre los
tres niveles — que un cambio en una story no rompa la arquitectura ni el PRD, y al revés.

No todo pasa por la ceremonia completa: para un arreglo urgente o un cambio chico con alcance claro
está la **rama corta**, sin PRD ni arquitectura formal. **La ceremonia escala con el riesgo.**

### La medida justa: cuánto papel lleva cada cambio

**El tamaño y el riesgo definen el flujo:** el tamaño decide si va por historia o por camino rápido; el riesgo decide
quién aprueba antes de programar y cuánta revisión lleva cada cambio. La medida la fija cada equipo.

Lo que leíste arriba es SDD: la spec antes que el código. Nuestra opinión, después de usarlo, es que hace falta
**exactamente cuando el resultado no se puede juzgar mirándolo**: cuando necesitás una lista de criterios para
saber si quedó completo, cuando el trabajo cruza varias sesiones o espera algo de afuera, cuando trae una decisión
que no es del programador —alcance, seguridad, una dependencia nueva, plata, clientes— o cuando toca algo que, si
sale mal, no se deshace. Y que **es demasiado pesado para lo chico**: un cambio que se dice en una frase y se
verifica mirando el resultado y sus pruebas no necesita criterios, ni documento de producto, ni arquitectura; pedirle
eso es papeleo.

Por eso lo hacemos en **dos etapas**. **Primero, una vez, al arrancar un producto, se especifica entero con BMAD**:
el documento de producto, la arquitectura, los épicos y las historias. Ahí sí es especificación completa. **Después,
historia por historia, con la medida justa**: cada historia es su propia especificación; lo que cambia en el camino
se escribe en la historia, y el documento de producto y la arquitectura no se vuelven a tocar salvo que una historia
los cambie de verdad. Son **dos preguntas**, independientes, que se contestan **antes de tocar código**, y una tercera al guardar:

**1. ¿Historia o camino rápido? Lo decide el tamaño.** Si lo podés pedir en una frase y, al terminar, ves que quedó
bien con sólo mirarlo y correr sus pruebas, va por **camino rápido**: se abre un carril, el permiso para editar código
sin historia, con el motivo en una línea y la lista de archivos. Abrir el carril es la aprobación. Si para saber si
quedó completo necesitás una lista de criterios, o va a llevar varias sesiones, va por **historia**: criterios de
aceptación, pruebas con nombre y archivos que toca. La historia es la especificación: se valida antes de programar,
manda sobre el código y al cerrar se cruza criterio por criterio. Lo decide quien abre el trabajo, antes de empezar,
porque un programa no puede medir un cambio que todavía no existe. Lo que el programa verifica después es lo
mecánico: sin carril ni historia abiertos, niega la primera edición de código. Si a mitad de camino aparecen
preguntas que piden criterios, el carril se cierra, el código queda en su rama y se escribe la historia que lo
retoma.

**2. ¿Quién aprueba antes de programar? Lo decide el riesgo.** En una historia, una persona aprueba el plan —qué
archivos va a tocar el agente y en qué orden— antes de la primera línea. Si el cambio toca producción, borra o
transforma datos (una migración que saca una columna), toca seguridad (permisos, autenticación, secretos) o trae una
decisión de alcance del cliente, aprueba **el dueño del producto**, quien responde por él. Si no, **cualquier persona
del equipo**. Una parte del riesgo la mide un programa, por ejemplo que el cambio trae una migración; la otra la juzga
quien abre el trabajo, y la deja escrita. Ante la duda, el caso más estricto. Ningún plan se aprueba solo.

**3. Guardar es el sí de una persona.** Antes de cada commit, push y pull request, el agente pregunta «¿guardo?» en
la ventana de permiso, el mismo cuadro donde ya aprobás sus comandos, y con un sí guarda. No pide comando ni deja
papel, porque guardar se deshace: un commit se revierte. Lo que no se deshace igual de fácil se decide antes, en la
aprobación del plan.

**Cuánta revisión lleva cada cambio.** En una historia corren los revisores automáticos, que un programa elige según
lo que tocó el cambio; el pase adversarial, un segundo grupo que intenta romper lo que los revisores aprobaron, salvo
en una historia chica o de sólo documentación o pruebas; y la matriz por criterio, que exige que cada criterio tenga
una prueba que corrió de verdad. Un hallazgo crítico lo decide una persona. En un camino rápido no corren los
revisores ni el pase: lo cuidan sus pruebas, los mismos controles antes del commit y la misma CI del pull request.

**Lo que no es de tu producto.** Cambiar los frenos del arnés, firmar sus controles o coordinar sesiones es trabajo
de quien mantiene el arnés, no del día a día de tu producto.

**Un ejemplo, con un combo (una lista desplegable).**

| El cambio | Tamaño | Quién aprueba |
|---|---|---|
| *«El combo de provincia muestra el nombre completo en vez de la sigla.»* | Camino rápido: una frase, se verifica abriendo el combo. | Una persona, al abrir el carril. |
| *«El combo trae las opciones de la base y recuerda la última elección.»* | Historia: ¿qué muestra sin resultados?, ¿dónde guarda la elección, y por cuánto?, ¿quién ve las opciones? Cada pregunta es un criterio. | Una persona aprueba el plan; el dueño del producto, si recordar la elección toca permisos. |
| *«Sacar la columna de teléfono fijo de la tabla de clientes.»* | Historia: ¿qué pasa con los datos que ya hay?, ¿se respaldan antes?, ¿qué pantallas e informes la leen? | El dueño del producto: la migración borra datos. |

**En una frase:** el tamaño del cambio decide cuánto papel lleva, una línea o una historia; el riesgo decide quién
aprueba antes de programar; y guardar, siempre, pide el sí de una persona.

**Cada equipo ajusta la medida, con un piso.** Desde el sitio de la organización (pestaña Configuración; cada cambio
va como un pedido que alguien revisa), el equipo decide qué aprueba su dueño del producto. Cada repo declara en
`.tycon/advisors.yaml` qué rutas fuerzan siempre el pase adversarial. El piso no se baja: ningún plan se aprueba solo,
nada se guarda sin el sí de una persona, y saltear una revisión o tocar producción nunca se delegan.

### La story: la unidad que el arnés sabe leer

Formato **Mary+GOLD** ([story-format.md](../story-format.md)). No es "una descripción de lo que hay
que hacer": es lo que vuelve **mecánica** la verificación de todo lo que viene después. Cada pieza
de la story es el insumo de un portón concreto:

| Pieza de la story | Qué portón la consume |
|---|---|
| **el encabezado** — id, épica, estado, sprint firmado (*frontmatter*: el bloque de metadatos del principio del archivo) | el arnés entero: si no se puede leer, la story es **invisible** |
| **Criterios de aceptación** en formato *dado esto / cuando pasa aquello / entonces* — los **ACs**, como se los llama en todo el arnés | cobertura de ACs · matriz de runtime por AC |
| **tabla de Tests** | cobertura de tests · el portón que exige el test antes que el código |
| **Dev Notes** — qué existe hoy · patrón de referencia verificado · la delta · lo que NO hay que hacer · cómo verificar | el plan de implementación · el revisor de patrones hermanos |
| **deuda declarada** | el rastreador de deuda: ¿está trazada o es fantasma? |
| **follow-ups** con enlace bidireccional | trazar qué modificó una story ya firmada por el cliente |

**Y el punto que más se subestima: los ACs no alcanzan.** El AC responde *una* pregunta; la spec
responde *todas* — requisitos, restricciones, arquitectura, ACs y **glosario**. Sin glosario, el
cliente dice "asistente", el dev escribe `Supervisor`, la IA usa `Manager`, la base tiene
`staff_user` y el front muestra "Empleado": cinco nombres para la misma cosa. Cada pregunta que
queda sin responder es un hueco que la IA rellena **inventando**.

### Ninguna story nace de cero: el ancla en patrones probados

Hay un revisor cuyo único trabajo es exigir que la solución esté **anclada a un patrón ya probado**
en otro plugin del mismo stack, y cazar cuando se está reinventando algo que el framework ya
resuelve (`tycon-sibling-pattern-reviewer`, reglas XPAT):

- **Lo que exige**: toda story de backend nace citando archivo y línea de un plugin hermano donde
  ese patrón **ya corre en producción**. Sin ancla, la story no pasa a implementarse.
- **Lo que caza**: inyección de dependencias, contexto de usuario, ciclo de vida, transacciones,
  carga de módulos — cuando el modelo empieza a escribir su propia versión de algo que el framework
  ya trae, salta.

**Por qué importa más de lo que parece**: el costo de reinventar no es el tiempo que lleva. Es que
la versión nueva no tiene los años de producción que tiene la vieja — y la IA reinventa con una
fluidez que hace que la versión nueva *parezca* mejor.

---

## El recorrido — los diez momentos

Pensalo como un aeropuerto: check-in, seguridad, embarque, puerta. Ninguno es opcional, cada uno
revisa algo distinto — y si no llevás nada raro, no te enterás de que existen.

---

### Momento 0 · Antes de que abras la boca — *el que se acuerda de instalar*

Apenas arranca la sesión, y antes de que escribas nada:

| Qué pasa | Con qué |
|---|---|
| trae lo que el equipo cambió desde tu última sesión | `git pull` de los dos repos compartidos |
| **re-registra los controles nuevos**: lo que alguien agregó ayer, hoy ya está enchufado en tu máquina | `install-tycon-hooks.sh` |
| actualiza las reglas que tienen que estar siempre cargadas (estilo de respuesta, comunicación) | `sync-claude-md-blocks.sh` |
| iguala la versión de la memoria persistente — no "a la última": **a la misma que el equipo** | `check-engram-version.sh` |
| repara la línea de arranque del propio arnés | `harness-bootstrap-heal.sh` |

**Cómo se cuenta**: *"el arnés se propaga solo. Nadie instala nada."*

**Por qué**: una máquina puede quedar con el **teléfono del cuartel de bomberos descolgado**.
Todo lo demás impecable —los camiones, las mangueras, la sirena—, el repositorio al día, cada
archivo nuevo en su lugar. Pero si la línea de arranque es vieja, hace los `git pull` y **no llama
al instalador**: esa máquina baja todo el código nuevo y no enchufa nada. Para siempre, y sin un
solo error. Medido: **9 controles ausentes**, con el clon perfectamente actualizado.

Y lo difícil de esa falla: **un teléfono descolgado no se puede arreglar llamando por teléfono.**
El arreglo no puede viajar por el camino que está roto: entra por una puerta que
esas máquinas sí tienen abierta.

---

### Momento 1 · Abrís la sesión — *el que se acuerda de revisar*

Trece controles corren al abrir la sesión, y se agrupan en tres ideas:

**Te ponen al día con el equipo.** Entra la memoria de las otras máquinas —decisiones, bugs,
convenciones—, y se te avisa si tu memoria quedó partida en dos nombres (guardás en un cajón y
buscás en otro) o si estás parado en una rama donde no deberías.
*(`engram sync --import` · `engram-drift-notice.js` · `branch-guard-notice.js`)*

**Te cobran lo que quedó abierto ayer.** Commits que nunca llegaron al servidor, merges sin
retrospectiva, timers de reloj olvidados, un banco de pruebas en rojo que nadie miró — y mi turno
anterior: si me fui de largo o te dejé esperando.
*(`unpushed-work-notice.js` · `retro-pending.js` · `retro-staleness-notice.js` · `bench-notice.js` ·
`sweep.js` · `lane-llm-notice.js`)*

**Dejan la mesa lista.** El índice del repo, la limpieza de bots huérfanos, y cada doce horas la
minería que mira tus patrones repetidos y propone reglas nuevas 🧠.
*(`codegraph-session-hook.sh` · `telegram-zombie-sweep.sh` · `instinct-trigger.sh`)*

Y todos comparten una disciplina: **si está todo bien, no dicen nada.** Es el testigo del aceite del
auto — si está apagado, andá tranquilo. Un tablero que titila todo el tiempo se termina tapando con
una calcomanía.

**Por qué**: un smoke de cierre puede dar **verde contra un backend que sólo existe en la máquina del
dev** — el commit nunca llega al servidor, y el frontend que lo consume se promueve igual. Si ningún
control pregunta *"¿esto existe en el remoto?"*, nadie lo ve. Para eso está el aviso de trabajo sin pushear.

**Cómo se cuenta**: *"cuando abro la sesión, el arnés ya me dijo todo lo que está mal. Si no dijo
nada, está todo bien."*

---

### Momento 2 · Escribís un prompt — *el que decide por dónde va*

Pasan dos cosas. La primera: te cobran el turno anterior — los dos medidores archivaron cuánto me
fui de largo y cuánto te dejé esperando, y lo entregan ahora *(`response-style-notice.js` ·
`blocking-notice.js`)*.

La segunda es la que gobierna el resto del día: se decide el **carril**. Hay dos, y cambian todo lo
que sigue:

- **Carril de story** — esto es trabajo de una story con spec. Se abre el **marcador** (un archivo
  de estado que dice *"hay una story en curso, es ésta"*), arranca el timer, y de ahí en más los
  frenos de edición saben contra qué verificar.
- **Carril de ajuste puntual** — un arreglo chico, declarado como tal y con constancia. Menos
  ceremonia, pero deja rastro.

Sin uno de los dos, no se toca código. Ése es el portón del Momento 4.

**Por qué**: decidir el carril por **expresiones regulares** sobre lo que escribís no funciona. El castellano
no se deja regexear — *"no quiero saltear el pipeline"* se lee como *"salteemos el pipeline"*, y
cada arreglo produce la falla opuesta (medido: tres fallas en tres días, con ~120 líneas de
patrones). Por eso decide un modelo barato 🧠 leyendo tus prompts reales. Y como toda pieza que
decide sola, tiene su medidor: grita sólo cuando el modelo **abrió** algo que el freno había cerrado,
y su reporte contesta la pregunta que decide el futuro de la pieza — *si casi nunca se usa, el
modelo sobra y se saca*.

**Cómo se cuenta**: *"antes de escribir una línea, el arnés ya sabe si esto es una story o un
retoque, y me trata distinto según cuál sea."*

---

### Momento 3 · Pedís implementar una story — *el que se acuerda de correr los revisores*

La story ya existe: salió de la cadena de SDD de más arriba, con sus criterios de aceptación y su
tabla de tests. **Eso es lo que hace verificable todo lo que sigue.**

Once pasos y un cierre aparte, con vos decidiendo en tres puntos:

```
Arranque               → ¿sesión fresca? ¿repo limpio? ¿qué esfuerzo pide esta story?
                         arranca el reloj y la tarea pasa a Activa en Azure DevOps
Validar la historia    → ¿está bien escrita? ¿los ACs son verificables?
Armar el plan          → BMAD planifica la implementación
⏸ Aprobar el plan      → VOS APROBÁS EL PLAN
Implementar            → con portón de build
Correr las pruebas
Revisores              → en paralelo; el set se computa mecánicamente según qué tocó el diff
                         (si hubo arreglos, vuelven a correr: «Revisores, otra vuelta»)
Pase adversarial       → un segundo grupo intenta romper lo que el primero aprobó;
                         la prueba con la que lo rompió entra a la suite como regresión
⏸ Hallazgos            → reporte consolidado; VOS APROBÁS LOS HALLAZGOS
Probar en vivo         → portón de "listo" de verdad: ¿esto ANDA, o sólo compila?
Preparar el commit     → no lo ejecuta
Cierre en ADO          → cierra el work item (aparte, después del merge)
```

**Lo que hace distinto al paso «Revisores»**: el set de revisores **no lo elige el modelo** — lo computa un
script mirando el diff. Si tocaste una migración de base de datos entra el revisor de migraciones;
si tocaste un canal de tiempo real entra el de tiempo real. Y un hook aparte deja constancia de
**qué revisor corrió sobre qué story y en qué repo** *(`on-advisor-run.js`)* — que es el rastro que
después permite contestar *"¿y cómo sabés que corrieron de verdad?"*.

**Lo que hace distinto al paso «Probar en vivo»**: build verde **no alcanza**. Ese portón pide evidencia de que
la cosa anda —un llamado real contra el backend, una matriz por cada criterio de aceptación— y
verifica **contra qué backend corrió** y si ese commit está en el servidor.

**Y hay un cuarto modo, opt-in**: `--autonomous`. No cambia quién aprueba (el plan, el commit y
producción siguen siendo de una persona, o de la coordinadora en su nombre donde el perfil lo
delega): agrega un portón que **no deja que el turno termine** mientras el "listo" esté en rojo,
obligando a iterar probar→arreglar→volver a probar. Con tres frenos para que no sea un loop infinito: tope de
iteraciones, detección de no-progreso (los mismos fallos N veces → escala a humano) y un botón de
pánico. Sólo actúa si lo pediste explícitamente.

**Por qué**: un orquestador puede correr **4 de los 7 revisores que corresponden** y
saltear los otros tres **en silencio**. Si la lista canónica vive en un archivo, no siempre lo lee
entero, y nada avisa. Por eso el set lo computa un script y un hook cuenta las invocaciones reales.

**Cómo se cuenta**: *"pido una story, apruebo el plan, apruebo los hallazgos. Todo lo del medio lo
hace solo, y hay revisores especializados que miran el código antes que yo — y no los elige el
modelo, los elige un script."*

---

### Momento 4 · Tocás código — *el que se acuerda del test antes que el código*

Cada edición de archivo pasa por una cadena de seis frenos, en este orden:

| El freno | Qué impide | (script) |
|---|---|---|
| **el portón de carril** | tocar código sin una story ni un marcador de ajuste puntual | `on-story-gate` |
| **el que no te deja fabricar la evidencia** | inventar la prueba que después desbloquea el cierre de la story | `on-dod-evidence-guard` |
| **el que custodia el "listo"** | marcar una story como terminada sin cumplir el listado de cierre | `on-frontmatter-write` |
| **el que exige el test primero** | escribir el primer archivo de código antes que su test | `on-atdd-preedit` |
| **el que evita el choque** | que dos sesiones en paralelo se pisen el mismo archivo | `on-write-collision` |
| **el que cuida los planos** | crear un artefacto de planificación que ignora otro ya aprobado | `on-planning-artifact` |

**Y la segunda puerta, que es la que casi nadie ve**: un archivo también se escribe por consola
(`cat >`, `sed -i`, `tee`, `cp`). Y no hace falta mala intención — **en "auto mode" el propio arnés
te instruye editar así**. Para eso está `on-bash-write-gate.js`, que extrae del comando las rutas que
va a escribir y les corre el **mismo** cálculo del portón. Es **parcial y lo declara**: lo que no
reconoce, pasa. Sin esa puerta, el portón tenía un agujero del tamaño de la puerta.

Después de escribir: se rebuildea antes de pedirte verificación visual, se revisa la config de
revisores apenas la tocás, y —si lo que escribiste **es una story**— se disparan solos el work item
de Azure DevOps y el enlazado de follow-ups.

Y uno que no bloquea nada pero salva el día: **el que mira el disco, no la salida**
*(`missing-path-notice.js`)*. Avisa cuando un comando de lectura nombró una ruta que no existe —
para que un listado vacío no se lea como *"acá no hay nada"*. Ante un comando que no puede
interpretar con certeza, **se calla y pierde el caso**: hablar ante la duda es cómo mueren estos
controles.

**Cómo se cuenta**: *"no puedo tocar código sin decir qué estoy haciendo, y no puedo escribir el
código antes que el test."*

---

### Momento 5 · Corrés tests — *el que se acuerda de no fundir la máquina*

`test-scope-guard-pre.sh` **bloquea** una suite completa sin filtro mientras estás iterando.

**Por qué**: la suite entera sin filtro **congela** una máquina de 8 núcleos.
Cada proceso paralelo carga el grafo entero de módulos, se agota la memoria y el disco empieza a
swapear — medido: una corrida tardó 822 segundos sólo en juntar los archivos.

La regla real es: **iterando, sólo el archivo que tocaste**; la suite completa corre al cierre del
Step 4 del pipeline (`test-gate.sh`) y otra vez en el portón del merge. Esa promesa se cobra en el
Momento 7.

**Cómo se cuenta**: *"no me deja fundirte la máquina corriendo todos los tests mientras itero."*

---

### Momento 5 bis · Y las pruebas mismas tienen controles

Es la capa que más cuesta explicar y la que más distingue: **hay controles cuyo objeto de
verificación es el test.**

| Control | Qué ataca |
|---|---|
| **el test primero** (`on-atdd-preedit`) | deniega el primer archivo de código de una corrida si no se tocó antes un test — no lo sugiere: lo impide |
| **el portón de tests** (`test-gate.sh`) | corre la suite y escribe el resultado a `.advisors/tests-result.json`; el revisor de cobertura **lee ese artefacto, no corre tests** — no puede afirmar lo que no pasó |
| **el chequeo de mutantes** (`mutation-check.js`) | rompe el código a propósito y re-corre la suite: **verde con el código roto = los tests no prueban nada** |
| **la realidad de los E2E** (`tycon-e2e-realness-checker`) | caza el test de punta a punta verde sin ejercer el flujo: el que mockea el backend, el que no asserta nada observable, y **el que se auto-saltea si el entorno no responde** — y reporta verde igual |
| **la matriz por AC** (`runtime-matrix.js`) | contra el sistema **corriendo**: una verificación real por cada criterio de aceptación, con constancia de contra qué backend |
| **la guía del tester** (`qa-guide.js`) | genera una guía de prueba manual en HTML, paso a paso — **el segundo control de calidad es humano** |

**Cómo se cuenta**: *"cualquiera muestra 'todos los tests pasan'. Nosotros verificamos los tests:
rompemos el código a propósito, y si la suite sigue verde, la suite miente."*

---

### Momento 6 · Commiteás — *el que se acuerda de no hacer la barbaridad*

| La capa | Qué hace |
|---|---|
| **el freno de mano** *(`safety-guard-pre.sh`)* | **bloquea** lo irreversible: borrar la raíz del disco, pisar la rama principal a la fuerza, bajar un script de internet y ejecutarlo, tirar una base de datos entera, leer tus claves privadas |
| **el portón de evidencia** *(`on-pre-commit.js`)* | exige la prueba de cierre antes de dejar commitear — y constancia de que los revisores auditaron la story |
| **la memoria viaja con el commit** *(`engram-pre-commit.sh`)* | sincroniza los aprendizajes y los agrega al commit, para que lleguen al resto del equipo |
| **el pre-commit que vale para todos los repos** *(`git-pre-commit-global.sh`)* | encabezado de story legible, alineación story↔wiki, paridad entre las dos herramientas |

**Por qué**: ese último cierra un agujero silencioso del arnés entero. Con la configuración global
de hooks que la sincronización de memoria necesita, **git ignora los hooks propios de cada repo**. O
sea que el lint de encabezados, el de la wiki y el portón de paridad pueden estar escritos,
documentados, adoptados… y **no ejecutarse nunca**.

**Cómo se cuenta**: *"antes de que un commit salga, cuatro cosas distintas lo miran, y una puede
frenarlo en seco."*

---

### Momento 7 · Mergeás a la rama principal — *el que se acuerda de correr la suite entera*

Portón de build y tests completos, dos puntos donde vos aprobás (el preview y el mensaje; después el
push), y un changelog agrupado por story con el detalle técnico real.

**Qué evita**: que un merge entre sin que la suite completa haya corrido sobre el código ya
mergeado — mientras se iteraba corrió filtrada, por la regla del Momento 5, y la del cierre del
Step 4 midió la rama, no el resultado del merge. Acá se cobra esa promesa.

**Por qué**: tras un push, el listado de corridas del servidor puede seguir vacío más de cuatro minutos.
Si de ahí se concluye *"el CI no disparó"* y se encola una corrida a mano, queda **duplicada** cuando el
listado se refresca y aparece la real, corriendo desde el principio. De ahí la regla: **la ausencia
en un listado no es evidencia de que algo no existe.** Un listado vacío o viejo es *"no sé"*, nunca
*"no existe"*.

**Cómo se cuenta**: *"la suite completa vuelve a correr acá, sobre lo mergeado. Si está roja, no hay merge."*

---

### Momento 8 · Cerrás la story — *el que se acuerda de pedir la prueba*

Es el mismo portón que viste en el paso «Probar en vivo» del pipeline, ahora mirado desde el final. No acepta
"build verde". Pide:

- **que ande**: un llamado real contra el backend, con constancia de contra cuál corrió
- **matriz por cada criterio de aceptación**: qué se probó de cada uno
- **cobertura de ACs**: cada AC y cada test de la tabla de la story, cruzado contra código que exista
- **deuda declarada**: lo que la story dijo que difería, ¿quedó trazado o es fantasma?
- **constancia de revisores**: que alguno haya auditado esta story, en este repo

**Por qué**: una story puede llegar a terminada con **toda la evidencia en regla** —smokes en navegador
registrados, todos los ACs verificados, matriz verde, excepciones aprobadas— y sin que **ningún
revisor la haya mirado nunca**. Todo legítimo: el hueco es que *"los revisores corrieron"* no
figure entre las condiciones. Por eso figura.

**Cómo se cuenta**: *"para decir 'listo' hay que mostrar que anda, no que compila."*

---

### Momento 9 · Después, sin vos — *el que se acuerda de aprender*

| Qué corre | Cuándo |
|---|---|
| la captura de aprendizajes | post-merge: extrae qué se aprendió y lo guarda en la memoria persistente |
| la minería de instintos 🧠 | cada 12h: graba tus patrones, un modelo barato propone reglas, **vos aprobás una por una** |
| las suites del arnés | una vez por día, de fondo; el resultado te lo cobran al arranque siguiente |
| los medidores de estilo y de bloqueo | cada turno: miden y archivan, y te lo cobran al turno siguiente |

**Por qué**: si el único disparador de la retrospectiva es un paso al **final** de un skill,
depende de que el modelo se acuerde de llegar hasta ahí. Cuando falla, se acumulan merges sin
retrospectiva que nadie nota. Por eso lo reclama un aviso al abrir sesión, scopeado al repo en el que
estás trabajando.

**Cómo se cuenta**: *"lo que aprendimos hoy queda escrito sin que yo haga nada, y mañana me lo
cobran."*

---

## La capa de arriba: quién vigila a los vigilantes

Un arnés sin esta capa es un tablero de alarmas que nadie probó nunca: todas las luces apagadas, y
vos sin saber si es porque no hay fuego o porque se quemaron las lamparitas. **El banco de pruebas
es el botón de test del detector de humo** — alguien lo aprieta y confirma que el pitido todavía
suena. Un detector que no pita cuando lo probás es peor que no tener detector, porque además te da
tranquilidad.

Hasta acá, cada control verifica el código. Ahora subimos un piso — la escalera tiene tres
escalones:

```
1. un control mira el código           →  ¿este código cumple la spec?
2. un segundo mira al primero          →  ¿ese control bloquea de verdad lo que dice bloquear?
3. un tercero mira que existan los (2) →  ¿hay algún control sin nadie que lo mire?
```

El escalón 3 es el que casi nadie construye, y es el único que caza la pieza que alguien agregó sin
avisar.

### Los que prueban a los controles

| Pieza | Qué verifica |
|---|---|
| **el banco de pruebas** | **332 casos** que disparan los controles reales en un entorno aislado: 235 sobre los 43 hooks (61 escenarios — un mismo script se prueba en varios modos) y 97 sobre los 28 revisores. Tres tipos por control: *debe bloquear* · *no debe bloquear* · *debe dejar constancia*, con **"salió limpio sin constancia = falla"** cableado |
| **el fuego real** | los mismos controles disparados **dentro de la herramienta de verdad**, no simulados. Incluye un señuelo: un control que no debería activarse nunca — si se activa, el banco está matcheando cosas que no corresponden, y entonces **todos sus verdes no valen nada** |
| **la auditoría de vacuidad** | caza el caso de prueba que pasa porque no prueba nada |
| **la auditoría de silencio** | caza el control que no dice nada cuando debería decir algo |
| **el censo del disco** | recorre las tres carpetas donde viven los hooks y exige que cada pieza tenga casos. **Es el único que mira el disco** — los otros comparan contra listas escritas a mano, o sea que sólo encontraban lo que alguien ya se acordó de anotar |

Y una regla de entrada que cierra el círculo: **una pieza nueva entra con sus casos de prueba, o no
entra** — lo verifica el pre-commit. Con **deuda declarada** para lo que entre sin ellos: hoy es
**cero**. Arrancó con 9 el 2026-08-25 a la mañana y quedó vacía esa misma tarde; el archivo se deja
vacío a propósito, porque es el lugar donde una pieza nueva declara su deuda, y su historia en git
es cuánto duró cada una. *Una deuda sin motivo es un permiso.*

### Los que auditan el arnés entero

| Pieza | Qué mide |
|---|---|
| **el check-up** *(`harness-audit.js`)* | salud del arnés en 7 categorías, con puntaje |
| **el destilador de reglas** *(`rules-distill.js`)* | desvío entre el catálogo de **344 reglas con ID estable** y los revisores que las aplican |
| **el presupuesto de contexto** *(`context-budget.js`)* | cuántos tokens te come el arnés antes de empezar a trabajar |
| **el portón de servidor** *(`tycon-ci-gate.js`)* | los controles que **sí** pueden correr del lado del servidor, para el commit que llegó sin pasar por una máquina con el arnés |

---

## El inventario, en números

**Los tres para contar** (más de tres no los retiene nadie): **58** lo que cazó la spec antes de la
primera línea · **332** los casos que prueban que los controles funcionan · **28** los revisores que
miran tu código antes que vos.

| | |
|---|---|
| Etapas de SDD antes de la primera línea de código | **4** (la quinta es el código), con **3** decisiones tuyas |
| Equipo BMAD que produce las specs | **21+ agentes · 50+ workflows**, open source |
| Revisores especializados | **28** |
| Hooks | **43** — 25 sueltos + 15 del pipeline + 4 del reloj, deduplicando uno que existe en dos lados |
| Pasos del pipeline | **15**, con 3 puntos donde vos decidís |
| Reglas con ID estable | **344** |
| Casos en el banco de pruebas | **332** (235 de hooks + 97 de revisores) |
| Deuda de cobertura declarada | **0** |
| Guías | **45** |
| Skills propias | **8**, sobre BMAD |
| Herramientas soportadas | **2** — Claude Code es el canónico, Codex se traduce y despliega solo |

> 🔴 **Estos números no se escriben a mano.** Los emiten `node build/check-hook-coverage.js` (hooks y
> deuda) y el conteo de los archivos de casos y del catálogo. Este documento se escribió una primera
> vez copiándolos del README, y **cuatro salieron mal** — que es, con ironía, el principio 2 aplicado
> a sí mismo: los tres tenían un comando que los imprime y ninguno se invocó. Si volvés a tocar esta
> tabla, corré los comandos.

---

## Tres guiones listos

### 30 segundos — para un par técnico

> *"Nosotros escribimos la spec antes que el código, y el arnés se ocupa de que el código no se le
> escape. La gracia está en cómo: cada vez que nos comimos un garrón, en vez de anotarlo en una guía
> que después nadie relee, lo enchufamos a un freno que salta solo. Van más de cuarenta. Y ninguno
> hay que acordarse de llamarlo — saltan cuando toca, te guste o no."*

### 30 segundos — para alguien de negocio

> *"¿Sabés esa sensación de 'esto ya nos pasó una vez' y volver a tropezar igual? Bueno, eso lo
> cortamos. Cada lección que nos costó cara quedó convertida en un freno automático adentro de la
> herramienta: si el equipo se va del camino, algo lo frena antes, sin que nadie tenga que estar
> mirando. Y arranca antes de programar — primero escribimos qué hay que hacer y cómo se verifica, y
> recién después se escribe el código."*

### 3 minutos

> *"Arranco por el piso, que es lo que hace posible todo lo demás: escribimos la spec antes que el
> código. La spec manda, el código la sirve, y la verificación es mecánica. ¿Cuánto rinde eso? En un
> proyecto pasamos tres días sin escribir una línea, y el equipo de agentes
> nos cazó 58 problemas en la spec. Cada uno habría costado diez veces más en el código y cien en
> producción.*
>
> *Y todo lo que viene después se apoya en tres frases. La primera: no hay error más caro que el que
> no da error. Tuvimos cuatro stories invisibles durante dos meses porque el encabezado no se podía
> leer — no daba error, las herramientas simplemente las salteaban.*
>
> *La segunda: un control que hay que acordarse de invocar, no corre. Fijate hasta dónde llega — el
> día que escribimos el documento que explica todo esto, el freno nos bloqueó guardar el archivo.
> ¿Por qué? Porque el texto que describe qué comandos peligrosos bloquea nombraba uno de esos
> comandos. El freno mira el comando, no la intención, y ante la duda frena. Es molesto, y es
> exactamente lo que querés que haga.*
>
> *Y la tercera: cada control tiene otro control que lo mira. Hay 332 casos de prueba que disparan
> los controles reales y verifican que bloqueen lo que dicen bloquear. Un freno que nadie prueba no
> es un freno, es una decoración.*
>
> *Y con eso, el día: abrís la sesión y ya te dijeron qué está mal. Pedís una story y hay revisores
> que la miran antes que vos. Tocás código y no te deja escribirlo antes que el test. Commiteás y
> cuatro cosas lo miran. Mergeás y ahí corre la suite entera. Y cerrás mostrando que anda, no que
> compila."*

### 15 minutos — el recorrido, con su porqué

Uno por momento, y cada uno está desarrollado arriba:

```
Momento 0 · el teléfono descolgado — 9 controles ausentes con el repo al día
Momento 1 · el smoke que dio verde contra código que nunca llegó al servidor
Momento 2 · el castellano no se deja regexear: el carril lo decide un modelo, no una expresión
Momento 3 · correr 4 de 7 revisores sin avisar: la cuenta la hace un programa
Momento 4 · el portón tenía un agujero del tamaño de la puerta: la consola
Momento 5 · la suite entera sin filtro congela la máquina
Momento 6 · los hooks escritos, documentados, adoptados… y nunca ejecutados
Momento 7 · el listado vacío que no probaba nada, y la corrida duplicada
Momento 8 · toda la evidencia en regla, y ningún revisor la había mirado
Momento 9 · la retrospectiva que dependía de que el modelo llegara al último paso
```

**Cada regla del arnés tiene escrito su porqué en su guía**, que es lo que se consulta antes de
retirar o relajar cualquier cosa.

Y si el que escucha es de negocio y no de tecnología, la charla ya está armada y despersonalizada:
https://www.bizuit.com/sdd-harness/more/

---

## Qué NO hace el arnés — la pregunta que siempre sigue

- **No decide por vos.** Los tres puntos de aprobación del pipeline son bloqueantes, y las reglas
  que la minería propone se aprueban de a una.
- **No garantiza que el código esté bien.** Garantiza que lo que aprendimos a la mala no se vuelva a
  olvidar, y que cuando algo sale mal quede el rastro de por dónde pasó.
- **No es infalible, y eso está medido.** Hay controles cuyo reporte dice que fallan, y guías del
  repo que son planes en curso, marcados como tales a propósito (la migración a la segunda
  herramienta es la más grande). El día que se escribió este documento, el freno de mano **bloqueó
  su propia escritura**: el texto que describe qué comandos bloquea **nombraba** uno de ellos. El
  freno mira el comando, no la intención — y prefiere el falso positivo. Ése es el trade que el
  arnés eligió, a la vista.
- **Casi todo control tiene un interruptor de apagado.** Es el eje más incómodo y el más verdadero:
  hubo **11 caminos confirmados** para apagar frenos sin dejar rastro — uno de ellos, un `off` en un
  archivo suelto que apagaba dos frenos, el segundo sin documentar en ningún lado. Se auditaron y se
  cerraron el 2026-08-25, cada uno con su caso de prueba y con el rojo previo verificado revirtiendo
  el arreglo. Que se pueda contar así es, justamente, el principio 3 funcionando.
- **No corre del lado del servidor, y es una decisión, no una deuda.** El portón de servidor está
  construido y probado; se decidió no adoptarlo porque los cuatro caminos que dejarían pasar un
  commit sin control **no ocurren hoy en el equipo**. Si el equipo crece, se enciende.

---

## Si te llevás una sola cosa

> **Acá ninguna regla depende de que alguien se acuerde.**

Todo lo demás —los diez momentos, los 28 revisores, los 332 casos de prueba— es la prueba de esa
frase.

---

## Glosario

| Término | Qué es |
|---|---|
| **arnés** | la capa que envuelve al modelo y decide qué puede y qué no puede hacer |
| **hook** | script que el arnés dispara solo ante un evento; los reflejos del sistema |
| **portón** | control que bloquea · **medidor**: control que mide y cobra después · **revisor**: instancia del modelo que audita código |
| **marcador** | archivo de estado que dice "hay una story en curso, es ésta" |
| **AC** | criterio de aceptación (*acceptance criteria*), en formato dado/cuando/entonces |
| **encabezado** (*frontmatter*) | el bloque de metadatos del principio de un archivo de story |
| **carril** | por dónde va el trabajo: story completa o ajuste puntual |
| **DoD** | *definition of done*: la lista explícita de qué significa "listo" para esta story, escrita para que un script pueda verificar cada ítem |
| **desvío** (*drift*) | cuando el código y la spec quedan desincronizados |
| **SDD** | *spec-driven development*: la spec antes que el código, y el código la sirve |
| **BMAD** | el framework de agentes que produce y mantiene las specs |
| **dueño** | quien responde por el repo y firma lo que no es rutina |
| **coordinadora** | la sesión de agente que el equipo designa; firma en nombre del dueño sólo lo que el perfil le delega |
| **camino rápido** | un cambio chico sin historia, con motivo escrito, cupo de archivos y firma; la guía de firmas lo llama arreglo rápido |
| **ADO** | Azure DevOps, donde viven los work items |
| **banco de pruebas** | los casos que disparan los controles reales para verificar que bloquean lo que dicen |
| **smoke** | prueba mínima contra el sistema corriendo de verdad, no contra el build |

---

## Dónde sigue cada hilo

| Si querés… | Ir a |
|---|---|
| el formato de story que hace verificable todo lo demás | [story-format.md](../story-format.md) |
| cuándo invocar qué agente BMAD, y qué revisor sigue a cada uno | [workflow-orchestration.md](workflow-orchestration.md) §6 |
| el porqué detrás de cualquier regla | la guía que la enuncia — índice en [piezas-del-arnes.md](piezas-del-arnes.md) |
| el catálogo de las 344 reglas | [advisor-rules-catalog.md](advisor-rules-catalog.md) |
| cómo funciona el banco de pruebas | [controls-bench.md](maintaining/controls-bench.md) |
| por qué el portón de servidor está construido y no adoptado | [ci-gate.md](ci-gate.md) |
| el material para contarlo a otros | https://www.bizuit.com/sdd-harness/more/ |

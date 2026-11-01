# Coordinar varias sesiones en una máquina

Esta guía es para una organización que trabaja con varias sesiones de agente a la vez en la misma máquina, y quiere
que una de ellas, **la coordinadora**, ordene a las demás. La coordinadora decide lo que no es del dueño, abre y nombra
las sesiones, cuida que la máquina no se sature y le pasa al dueño sólo lo suyo.

Es una receta, no un modo: nada cambia en una máquina donde nadie designó una coordinadora. Se prende en dos pasos:

1. El perfil del equipo nombra el rol en `approvals.relay_session` (en el sitio, la pestaña Configuración, «Quién
   autoriza saltarse un control»).
2. En cada máquina, el dueño escribe en el chat de la sesión elegida «Esta sesión es la coordinadora», y esa sesión
   corre `marker.js designate-relay` con esa cita.

Después, `/coordinate` en esa sesión muestra el estado de la máquina. El programa que usa la coordinadora es
`<arnés>/scripts/tools/coordination.js`.

## Qué va al dueño

Al dueño van tres cosas, siempre las mismas:

- **Firmas**: lo que el arnés pide firmado por una persona (por ejemplo, los cambios de controles).
- **Contraseñas**: lo que pide la contraseña de la máquina (por ejemplo, reinstalar el freno de producción).
- **Decisiones de producto**: qué se construye, para quién y en qué orden de prioridad.

Todo lo demás lo decide la coordinadora. Las otras sesiones le preguntan a ella, no al dueño: así el dueño no tiene que
repetir el contexto de cada una.

## Cómo decide la coordinadora

- Aprueba los planes de las sesiones, por delegación del dueño, y lo dice así en la aprobación.
- Ante una duda de detalle elige la opción más segura y anota qué eligió y por qué.
- Pregunta al dueño sólo lo de la sección anterior, con el contexto entero y una recomendación: el dueño no tiene que
  ir a buscar nada para decidir.
- No le pide al dueño algo que ella puede averiguar: primero mira el código, los registros y el estado de la máquina.

## Abrir y nombrar las sesiones

El nombre de una sesión es el de su archivo de sesión: el mismo que usan los mensajes entre sesiones y el que muestra
`/wip`. Se pone en un solo paso:

- Al abrirla, con su nombre (`-n <nombre>`).
- Si ya está abierta, con `/rename <nombre>` en esa sesión.

`/coordinate` lista las sesiones cuyo nombre armó la herramienta y no una persona, para que el dueño las nombre.

La coordinadora abre una sesión nueva con `coordination.js open --name <nombre> --cwd <carpeta> -- <encargo>`. Abre una
sesión de verdad, de fondo, nunca un subagente, y devuelve cómo entrar a mirarla (`claude attach <nombre>`). Antes de
abrir, mira dos cosas, en orden, y si una falla no abre y dice por qué:

1. El nombre: sólo letras, números, guion y guion bajo, y que no lo use otra sesión viva.
2. El tope: si ya trabajan tantas como el tope, no abre.

`open` nunca reintenta. Si la herramienta se niega porque nadie aprobó la carpeta, dice en una línea qué carpeta tiene
que abrir el dueño una vez; mientras tanto, la sesión la abre el dueño y la coordinadora le da el encargo. La
aprobación es de una persona: el agente no la escribe. Las otras fallas también van en una línea: que el lanzador no
está instalado, el primer renglón de su error, o que no volvió en 30 segundos. Una apertura que falló no cuenta para el
tope.

**Límite medido:** la aprobación de una carpeta no cubre las de adentro:
cada worktree nuevo pide su propia aprobación. En la práctica, la primera vez que la coordinadora abre una sesión en un worktree nuevo, `open` contesta
que falta aprobar la carpeta.

**Por eso, los puestos fijos.** Con `--repo <repo>` en lugar de `--cwd`, `open` no usa una carpeta nueva: toma un puesto
libre del repo y abre la sesión ahí, en la rama del trabajo (`--branch <rama>`, o `wt/<nombre>`). Hay tantos puestos
como el tope y siempre son las mismas carpetas, así que el dueño los aprueba una sola vez:
`node scripts/tools/work-slots.js pending-trust` le lista los que faltan, cada uno con su `cd`. Sin puesto libre, `open`
lo dice y no abre. El encargo le dice a la sesión cómo soltar el puesto al terminar; si el lanzador falla, el puesto
vuelve a quedar libre. Cómo son los puestos: `guides/git-worktrees.md` §8.

**Sin medir todavía, queda como prueba del dueño:** cuánto tarda en aparecer una sesión abierta de fondo, y qué título
muestra la pestaña del editor después de `/rename`. La guía no da por hecho ninguna de las dos.

**La sesión abierta arranca como la coordinadora.** Va con el mismo modo de permisos que la coordinadora y con control
remoto a su nombre, para que el dueño la vea y la maneje desde claude.ai/code o el celular. Con modos distintos, la
sesión nueva se traba en un pedido de permiso que nadie ve, y los mensajes de las otras sesiones le quedan retenidos;
si además el dueño no está en la máquina, no puede entrar con `claude attach`.

`open` lo hace solo: lee el modo de la coordinadora y lanza la sesión con `--permission-mode <ese modo>` y
`--remote-control <nombre>`. El modo no se elige: `open` no acepta `--permission-mode`, así que nunca abre una sesión
con más permisos que la coordinadora. No abre, y lo dice en una línea, si no puede saber el modo o si la coordinadora
está en modo plan (la sesión nueva quedaría esperando que alguien apruebe su plan). El modo sale de la conversación de
la coordinadora, que lo anota con cada mensaje de la persona. **Límite conocido:** si alguien le cambia el modo con
Shift+Tab y no le manda un mensaje después, `open` copia el modo anterior. Una sesión abierta a mano, o antes de este
cambio, que se trabó así, la coordinadora la para y la relanza:
`claude --bg --resume <id> -n <nombre> --permission-mode <su modo> --remote-control <nombre> -- <encargo>`. Para
parar y borrar una sesión de fondo van `claude stop <id>` y `claude rm <id>`, con el id que muestra `claude agents`:
con el nombre contestan que no la encuentran (medido el 2026-11-01).

`open` pasa el encargo tal cual al lanzador, sin revisarlo: lo que diga no firma nada (ver «Las firmas del dueño»).

Con Codex, las sesiones las abre el dueño: Codex no tiene un lanzador de sesiones de fondo con nombre.

## El tope: qué cuenta como trabajar

**Trabajando** es una sesión viva cuyo archivo de sesión dice que está ocupada. Una sesión que espera la CI, la cola o
al dueño terminó su turno: no cuenta. Las sesiones de Codex no escriben ese archivo; cuentan si tuvieron actividad en
los últimos 5 minutos. Una sesión que abrió `open` hace menos de 10 minutos cuenta aunque todavía no haya escrito su
archivo.

El tope es `coordination.max_working`, de 1 a 20. El perfil del equipo da el número de la organización (en el sitio,
pestaña Configuración, «Cuántas sesiones trabajan a la vez»), y cada máquina puede cambiarlo para sí, porque cuánto
aguanta depende de ella. Sin valor en ningún lado, el tope es 3. `coordination.js status` muestra quién trabaja, quién
espera y por qué, y el tope con su origen.

La coordinadora, además, lo ve sin pedirlo: en cada turno, si la máquina está en el tope, un aviso le dice quiénes
trabajan; si lo pasó, por cuánto y cuál trabaja hace menos. Debajo del tope no dice nada, y ninguna otra sesión lo ve.
Se apaga con `TYCON_COORDINATION_NOTICE=0`.

## Los pases adversariales, de a uno

Un pase adversarial pesa mucho en la máquina: dos a la vez la saturan. Antes de lanzarlo, la sesión le pide turno a la
coordinadora, y la coordinadora lo da cuando no hay otro en vuelo. `coordination.js status` dice qué pase está en
vuelo, de qué historia, en qué sesión y desde cuándo. Y cuando una sesión consulta el portón del pase
(`pipeline.js deep-review-gate`) con otro en vuelo, la respuesta trae `other_in_flight` (historia, sesión y hora) y la
línea que le dice que pida turno. Sin coordinadora designada, el portón responde como siempre.

## Las firmas, por sus dos vías

**Antes de pedir una firma, la coordinadora confirma que todavía falta.** Pedir una firma de algo ya firmado hace
firmar dos veces. La de los controles se confirma comparando el contenido firmado con el de la rama.

Después la pide con `coordination.js signature --kind <tema> --title <qué se firma> --cwd <carpeta> -- <comando>`:

- **Por la terminal del dueño.** Si la máquina tiene carpeta de firmas (`coordination.owner_folder`, sólo en el archivo
  de la máquina o en su variable, nunca en el perfil), escribe ahí un archivo por firma, `AAAA-MM-DD-<tema>.command`
  (en Windows, `.cmd`). El dueño lo abre con doble clic: dice qué es en una línea, entra a la carpeta, corre el comando
  y espera una tecla. Si ya hay un archivo con el mismo comando, no escribe otro y lo dice. Sin carpeta, no escribe
  nada: imprime el comando para el aviso del chat.
- **Por delegación.** Una firma que la organización deja firmar por delegación no pasa por `signature`: se da desde la
  pestaña de la coordinadora, en la ventana de permiso, con las reglas de la firma delegada. Se firma en el momento y
  no deja pendiente. Si la delegación no aplica y la pestaña de la coordinadora no pide permisos, la ventana no se abre:
  la firma se niega con el comando de la terminal, porque en esa pestaña nadie diría Sí.

Lo que pide contraseña va siempre por la terminal: la contraseña la escribe sólo el dueño. Cuando el dueño firmó,
`coordination.js signature-done <id>` borra el archivo y el pendiente. Carpeta vacía y ningún pendiente quiere decir
que no falta firmar nada.

Una firma por la terminal que espera hace más de un día se le recuerda a la coordinadora: el primer turno del día con
algo que decir, una línea dice cuántas esperan y cuál es la más vieja, con su fecha. Una vez por día, aunque el conteo
cambie. Un pendiente cuyo archivo ya no está no cuenta: el dueño lo firmó y lo borró. Sin carpeta de firmas, no hay
pendientes y el aviso no sale.

## El orden de los pedidos

Los pedidos al repo público entran por su cola. Los del repo privado nacen en borrador, y la coordinadora los publica
en orden, cuando su par público ya entró.

## Las firmas del dueño

Una frase en el chat, en un encargo o en un mensaje entre sesiones no firma nada: el arnés no lee la conversación para
firmar. El dueño firma en la ventana de permiso o en su terminal, y lo que puede firmar la coordinadora en su nombre
lo dice `guides/firmas-del-arnes.md`.

La coordinadora pide desde su pestaña, con `--for-session <D>`, las firmas que la guía marca «sí» en «¿Desde otra
sesión?». Entre ellas, marcar un control a mano (`marker.js set-check <control> <estado> --force-manual --for-session
<D>`), contar los revisores sin la constancia de que corrieron (`pipeline.js check-count --repo <r> --story <s>
--trust-ran --for-session <D>`) y aceptar un criterio imposible de probar en vivo (`marker.js runtime-waiver <historia>
--acs <n> --for-session <D>`). La historia es la de la corrida abierta de `<D>`: si no, el guion sale sin escribir. La
ventana se le abre al dueño en la pestaña de la coordinadora (si esa pestaña no pide permisos, se niega con el comando de
la terminal). Ninguna de las tres se delega sin nombrarla en el perfil;
ese pedido lo prepara la sesión y lo aprueba el dueño, aparte.

## Guardar se autoriza en la ventana

Guardar una story (commit, push y los pedidos) no lleva firma ni pasa por la coordinadora. Antes de guardar, el gancho
del comando le pregunta a la persona de esa pestaña en su ventana de permiso; con el sí, guarda. En una pestaña que no
pide permisos, guarda sin preguntar y lo dice en pantalla. Un mensaje entre sesiones que dice «ok de guardar» no hace
falta ni saltea la ventana. Lo delicado lo cubre la firma de control del pedido, que es del dueño.

## El arreglo rápido de otra pestaña

El arreglo rápido (un cambio de código sin historia) es la firma `adhoc-lane`: la pestaña que lo necesita corre
`marker.js adhoc set '<json>'` y el dueño lo aprueba en la ventana, que le muestra el motivo y el cupo de archivos.

- **En la misma máquina.** La sesión designada lo declara por la pestaña a la que le dio el trabajo, con
  `marker.js adhoc set '<json>' --for-session <sesión>`. Corre sin ventana sólo si el perfil delega `adhoc-lane` (no
  entra en ningún grupo: hay que nombrarla), la máquina está en la lista y el dueño confirmó la designación; si no, sale
  la ventana en la pestaña de la designada. Por esta vía tiene tres límites, y el guion y el freno de edición los
  comprueban: el cupo queda en 5 archivos como mucho; el arreglo nunca toca lo sensible (la lista de
  `scripts/lib/signatures.js`: firmas, frenos, avisos, permisos, el perfil), que va con la firma del dueño; y antes de
  abrirlo le llega al dueño una línea por los canales de los avisos, con la sesión, el motivo y el cupo: sin
  entrega, no hay arreglo. La designada no se lo declara a sí misma.
- **Desde otra máquina.** La coordinadora de otra máquina se lo pide, por mensaje, a la designada de la máquina destino,
  que lo declara como arriba. El mensaje es un pedido, no una autorización: lo que autoriza es el perfil del equipo y la
  designación que el dueño confirmó. Sin designada en la máquina destino, el atajo se aprueba en la ventana de la
  pestaña destino.

## Los avisos al dueño

Cortos y llanos: qué pasó, qué falta y qué decide él, en ese orden. Un aviso por tanda de trabajo, no uno por sesión.
Lo mide el medidor de estilo que ya existe; esta receta no agrega otro.

## El tablero en la oficina

La oficina de `/office` muestra, en un panel aparte de los escritorios, el tablero de pendientes de la coordinadora: lo de
hoy, de esta semana, de la semana que viene y de más adelante, cada cosa con su hora esperable de fin, quién la tiene y una
nota llana, y lo ya hecho con su hora real. La coordinadora lo escribe entero en `<estado>/coordination/tablero.json`
(primero en un archivo aparte y después renombrado, para que la oficina nunca lo lea a medias), cada vez que lo cambia:

- `pendientes`: una lista; cada uno con `titulo`, `estado` (`hecho`, `curso`, `firma`, `riesgo` o `espera`), `grupo`
  (`Hoy`, `Esta semana`, `La semana que viene` o `Más adelante`), `orden`, `quien`, `nota`, y su hora: `pronosticoIso`
  o `estimadaIso` (hora local, `AAAA-MM-DDTHH:MM`), o `termina` con un texto propio. Un hecho lleva `realIso`.
- `meta`: `actualizado`, `resumen` y `teToca` (lo que le toca al dueño, una línea cada cosa).

Sin el archivo no hay panel. Un archivo roto se dice abajo, en «No se pudo leer», y el panel no se dibuja. La oficina viva
lo vuelve a leer sola cuando cambia. Los escritorios no salen de acá: salen de lo que hace cada sesión.

La hora prometida de un arreglo rápido la anota su sesión con `marker.js adhoc until HH:MM`. La oficina y `/wip` la
muestran como su fin, y miden el atraso contra ella; sin hora, dicen «sin hora estimada».

## Las reglas del día a día

Salen de un día entero coordinando varias sesiones. Cada una dice qué hacer y por qué.

- **Una firma del dueño va en un mensaje aparte.** Qué se firma, en una línea, y el comando; nada más. Si a los 15
  minutos sigue pendiente, se recuerda también aparte. Por qué: una firma al final de un mensaje con otras cosas se
  pierde, y el trabajo queda parado esperándola.
- **Antes de pasar un comando de firma, se ensaya lo que viene después.** El commit, sus controles y el empuje se
  prueban en seco, y la firma es lo último. Si no hay forma de ensayarlo, se dice. Por qué: un ok que vence por un
  control que corre después hace firmar dos veces.
- **El comando va con su carpeta.** `cd <carpeta> && …`, nunca el comando suelto, y nunca una carpeta que ya se
  borró (un worktree mergeado). Por qué: el dueño lo corre en su terminal, que no está parada donde trabaja la sesión.
- **La hora que se da es la del trabajo terminado.** La del trabajo entero en `main`, no la de un paso o una tanda, con
  la condición que la sostiene (por ejemplo, las firmas a tiempo). Después se compara contra lo prometido. Por qué: la
  hora de un paso hace creer que algo terminó cuando todavía falta.
- **Un número de historia nunca va solo.** El número puede ir, siempre con lo que hace dicho en palabras. Por qué: el
  número solo no le dice nada a quien no lo tiene en la cabeza.
- **Una firma delegada se confirma por su vía.** Después de firmar, el renglón tiene que decir «delegación». Si dice otra
  vía (por ejemplo, la ventana a nombre del dueño), se le avisa al dueño enseguida y se rehace. Por qué: una firma a
  nombre del dueño que él no dio es una constancia falsa. Una pestaña que no pide permisos ya no firma por la ventana:
  el arnés lo niega.
- **Lo pesado, de a uno, y con turno.** La suite completa, el banco de controles, el examen de revisores y el portón
  corren de a uno en la máquina, y el turno se le pide a la coordinadora. La historia que el dueño marcó como prioridad
  pasa adelante en la fila. Por qué: dos a la vez saturan la máquina y los dos tardan más.
- **Antes de aprobar un pedido ajeno, se mira el diff.** Y un ok que cubre archivos sensibles que nadie revisó no se da:
  primero se separan. Por qué: aprobar sin mirar es firmar lo que no se vio.
- **Una sesión «libre» puede estar esperando algo.** Cuando corre algo sin tocar archivos, anota qué hace con
  `marker.js doing`. Por qué: sin eso, `/wip` la muestra libre y se le da otro trabajo encima.
- **Un pedido «en la cola» puede haberse caído.** Si pasó el tiempo esperado, se mira si sigue encolado, si tiene un
  choque o si su compilación espera un agente. No se supone. Por qué: un pedido que salió de la cola no entra solo.
- **Una decisión del dueño va con su contexto.** La recomendación, qué gana y qué cuesta cada opción, y la pregunta.
  Lo de rutina lo decide la coordinadora y lo informa en una línea. Por qué: el dueño decide sin tener que ir a buscar
  nada.
- **Lo que ve el dueño va sin jerga.** El estado se cuenta como qué está hecho, qué falta y qué decide él. Por qué: el
  dueño lee para decidir, no para seguir el trabajo por dentro.

## Qué mide cada regla

| Regla | Mide | Por qué |
|---|---|---|
| Al dueño van firmas, contraseñas y decisiones de producto | nadie | Qué es una decisión de producto es criterio: no hay un dato que lo diga. |
| Las preguntas de las sesiones van a la coordinadora | nadie | No hay aviso, por decisión del dueño: lo vería cada sesión de trabajo. La coordinadora lo recuerda cuando una sesión le pregunta al dueño. |
| La coordinadora cierra los detalles con la opción más segura | nadie | Es criterio, y queda anotado para que el dueño lo vea. |
| Cada sesión con un nombre puesto por una persona | aviso | `/coordinate` lista las que tienen el nombre que armó la herramienta. |
| No más sesiones trabajando que el tope | freno | `open` no abre en el tope. Una sesión que el dueño abre a mano no la frena nada; la cuenta `status` y, en el tope, el aviso de cada turno de la coordinadora. |
| Pases adversariales de a uno | aviso | El turno lo da la coordinadora. El portón del pase le dice a la sesión que hay otro en vuelo y que pida turno; no la frena. |
| Confirmar que una firma falta antes de pedirla | nadie | Cómo se confirma depende de cada firma; `signature` sólo evita dos archivos con el mismo comando. |
| Un archivo por firma, borrado al firmar | aviso | `status` cuenta las firmas pendientes; `signature` no escribe un segundo archivo con el mismo comando. Una que espera hace más de un día se le recuerda a la coordinadora, una vez por día. |
| Pedidos en orden | nadie | Ningún dato de la máquina dice qué pedido es par de cuál sin preguntarle a la red en cada turno. |
| Avisos cortos y llanos | aviso | El medidor de estilo que ya existe. |
| Codex no coordina | aviso | `/coordinate` lo dice en Codex y no sigue. Codex sí manda mensajes con codex queue, pero ese comando no pasa por una herramienta que el arnés pueda mirar. |
| Una firma del dueño en un mensaje aparte | nadie | Es la forma del mensaje: ningún dato de la máquina la ve. |
| Ensayar lo que viene antes de pasar un comando de firma | nadie | Cada repo tiene sus controles: el ensayo lo hace la sesión. |
| El comando de firma con su carpeta | nadie | El comando lo escribe la sesión; `signature` ya lo arma con su carpeta. |
| La hora del trabajo terminado | nadie | Qué es «terminado» depende de cada trabajo. |
| Un número de historia nunca solo | nadie | Va en los mensajes, que no pasan por un control de texto. |
| Una pestaña que no pide permisos no firma por la ventana | freno | El freno de la ventana niega la firma y da el comando de la terminal. Que la vía diga «delegación» lo confirma la coordinadora. |
| Lo pesado de a uno, con turno | nadie | El pase adversarial tiene su aviso (arriba); la suite completa, el banco, el examen y el portón no. |
| Mirar el diff antes de aprobar un pedido ajeno | nadie | Es criterio de quien aprueba. |
| Una sesión que espera anota qué hace | nadie | Lo anota la sesión con `marker.js doing`; nada la obliga. |
| Comprobar que un pedido sigue en la cola | nadie | Mirarlo cada turno sería preguntarle a la red todo el tiempo. |
| Las decisiones del dueño con su contexto | nadie | Es criterio; el medidor de estilo mide el largo, no el contenido. |
| Lo que ve el dueño, sin jerga | aviso | El medidor de estilo que ya existe. |

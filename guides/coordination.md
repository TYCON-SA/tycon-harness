# Coordinar varias sesiones en una máquina

Esta guía es para una organización que trabaja con varias sesiones de agente a la vez en la misma máquina, y quiere
que una de ellas, **la coordinadora**, ordene a las demás. La coordinadora decide lo que no es del dueño, abre y nombra
las sesiones, cuida que la máquina no se sature y le pasa al dueño sólo lo suyo.

Es una receta, no un modo: nada cambia en una máquina donde nadie designó una coordinadora. Se prende en dos pasos:

1. El perfil del equipo nombra el rol en `approvals.relay_session` (en el sitio, la pestaña Configuración, «Quién
   autoriza saltarse un control»).
2. En cada máquina, el dueño escribe en el chat de la sesión elegida «Esta sesión es la coordinadora», y esa sesión
   corre `marker.js designate-relay` con esa cita.

Al designarse, la sesión recibe la orden de leer esta guía, y la recibe otra vez después de compactar o de limpiar su
conversación, porque ahí se pierde. **Limpiar la conversación le quita la designación**: para el arnés es otra
conversación. La sesión recibe cómo recuperarla, pero no la recupera sola: el dueño tiene que volver a escribir la frase
y a confirmarla. `/coordinate` en esa sesión muestra el estado de la máquina. El programa que usa la coordinadora es
`<arnés>/scripts/tools/coordination.js`.

## Qué va al dueño

Al dueño van cuatro cosas, siempre las mismas:

- **Firmas**: lo que el arnés pide firmado por una persona (por ejemplo, los cambios de controles).
- **Contraseñas**: lo que pide la contraseña de la máquina (por ejemplo, reinstalar el freno de producción).
- **Decisiones de producto**: qué se construye, para quién y en qué orden de prioridad.
- **Lo que sale de la casa**: lo que sale a producción de un producto y lo que se le manda a un cliente o a alguien de
  afuera. No incluye lo de rutina: encolar pedidos del propio arnés ni publicar material ya aprobado.

Todo lo demás lo decide la coordinadora. Las otras sesiones le preguntan a ella, no al dueño: así el dueño no tiene que
repetir el contexto de cada una.

## Cómo decide la coordinadora

- Aprueba los planes de las sesiones, por delegación del dueño, y lo dice así en la aprobación.
- Ante una duda de detalle elige la opción más segura y anota qué eligió y por qué.
- Pregunta al dueño sólo lo de la sección anterior, con el contexto entero y una recomendación: el dueño no tiene que
  ir a buscar nada para decidir.
- No le pide al dueño algo que ella puede averiguar o hacer: primero mira el código, los registros y el estado de la
  máquina, y prueba hacerlo ella con lo que ya tiene.
- No aprueba ningún cambio que le dé más poder. Por ejemplo, el pedido al perfil del equipo que suma firmas a lo que ella
  puede firmar lo aprueba el dueño: aprobarse su propio poder anula el control.

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

**Los nombres de las sesiones nuevas.** Sin `--name` (o con `--name auto`), `open` toma el primer nombre libre de
`coordination.session_names`. Agotada la lista, sigue con número: `Tero-2`, `Hornero-2`, y después `Tero-3`. Sin esa
configuración no abre y pide el nombre, como siempre; por eso «auto» ya no sirve como nombre de una sesión. Con
`--repo` y sin `--branch`, se saltea un nombre que ya tiene rama `wt/<nombre>` en el repo: la sesión nueva no arranca
sobre el trabajo de otra. Las aperturas van de a una: si dos llegan juntas, la segunda espera que termine la primera, así
no eligen el mismo nombre. La clave vale el id de un tema de fábrica (`animals`, `rivers`,
`colors` o `trees`) o una lista propia, con el orden de siempre: la variable `TYCON_COORDINATION_SESSION_NAMES` gana a la
máquina y la máquina gana al perfil (la variable lleva lo mismo: un tema, o nombres separados por comas). El tema de la organización se elige en la pestaña Configuración del sitio
(«Las sesiones de cada máquina»). Los temas de fábrica viajan con el arnés, que se publica: no llevan personas reales ni
marcas.

**La lista propia de cada dev la arma su sesión, nunca el sitio.** El dev la pide en el chat con sus palabras, por
ejemplo «llamá mis sesiones como los planetas». La sesión arma la lista, se la muestra entera y espera su «Aprobado».
Con él, la guarda en la configuración de ESA máquina, separada por comas:
`node scripts/lib/tycon-config.js set coordination.session_names "Mercurio,Venus,Marte"`. Un solo nombre lleva la coma
al final (`"Mercurio,"`): sin coma, el texto se lee como el id de un tema. Cada nombre va sin espacios ni
acentos (letras, números, guion o guion bajo); si el dev pidió algo con acento, la sesión lo propone sin él. Una lista
con personas reales o marcas va sólo ahí: nunca en el perfil del equipo, en una guía ni en nada que se publique. Si el
freno de producción instalado en la máquina es anterior a esta clave, el comando no escribe nada y dice cómo ponerlo al
día (con `sudo`, pide la contraseña del dev): con la clave, ese freno diría «configuración ROTA» en cada sesión. La
sesión le pasa ese comando al dev y guarda la lista después.

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

## Cerrar una sesión

La coordinadora, o una persona en su terminal, cierra una sesión con `coordination.js close --name <nombre>`. Antes de
cerrar mira cuatro cosas, y si falta una no cierra y dice cuál:

1. Que esté quieta: una con un comando corriendo tampoco se cierra.
2. Que en su carpeta no quede nada sin commitear ni sin empujar.
3. Que su rama haya entrado a `main`, también las ramas de las que se fue en esa carpeta desde que arrancó. Si está en un
   puesto fijo, que esté suelto: un puesto se suelta, no se borra.
4. Que no tenga una corrida ni un arreglo rápido abiertos.

Lo que no puede mirar (una carpeta que no anotó o que ya no está, git que no contesta, un registro ilegible) sale como
«no sé», y tampoco cierra. Con todo limpio corre `claude stop` y `claude rm` con el id de la sesión.

**Una sesión interactiva no se cierra.** La verifica igual y avisa: esa pestaña la cierra la persona.

**Límites.** Mira la carpeta donde está la sesión ahora: otro worktree que haya dejado no lo ve, ni lo guardado con `git
stash`. Una rama borrada sin entrar ya no se ve. Una rama que entró aplastada en un solo commit sale como que no entró. Un
worktree de un repo sin carpeta de trabajo sale como «no sé». `claude stop` y `claude rm` a mano no pasan por acá.

## El tope: qué cuenta como trabajar

**Trabajando** es una sesión viva cuyo archivo de sesión dice que está ocupada. Una sesión que espera la CI, la cola o
al dueño terminó su turno: no cuenta. Las sesiones de Codex no escriben ese archivo; cuentan si tuvieron actividad en
los últimos 5 minutos. Una sesión que abrió `open` hace menos de 10 minutos cuenta aunque todavía no haya escrito su
archivo.

El tope es `coordination.max_working`, de 1 a 20. El perfil del equipo da el número de la organización (en el sitio,
pestaña Configuración, «Las sesiones de cada máquina»), y cada máquina puede cambiarlo para sí, porque cuánto
aguanta depende de ella. Sin valor en ningún lado, el tope es 3. `coordination.js status` muestra quién trabaja, quién
espera y por qué, y el tope con su origen.

El tope frena por cualquier camino del agente, no sólo por `open`. Antes de cada comando, un freno mira si el comando
abre una sesión de Claude de fondo: `claude --bg`, o `claude` corriendo de fondo (`&`, `nohup`, `setsid`, `tmux new -d`,
`screen -dm`, `Start-Process`, la ejecución de fondo de la herramienta), también envuelto en `env`, `sudo`, `bash -c`,
`pwsh -c` o `cmd /c`. Si abre y la máquina está en el tope, lo niega y da el comando de `open`, que espera turno. Cuenta
con la misma función que `open`. Debajo del tope deja pasar y anota la sesión, así cuenta desde ese momento. Si no puede
contar (un archivo de estado que no se lee) o no puede anotarla, niega igual y nombra el archivo. La salida es arreglar
ese archivo, o que la persona abra la sesión desde su terminal: el freno mira sólo las herramientas del agente. No tiene
interruptor: el tope lo cambia una persona.

La coordinadora, además, lo ve sin pedirlo: en cada turno, si la máquina está en el tope, un aviso le dice quiénes
trabajan; si lo pasó, por cuánto y cuál trabaja hace menos. Debajo del tope no dice nada de eso, y ninguna otra sesión lo
ve. Se apaga con `TYCON_COORDINATION_NOTICE=0`.

El mismo aviso trae dos cosas más:

- **Las sesiones de fondo quietas.** Una sesión de fondo que lleva más de 15 minutos sin trabajar sale como «X está
  quieta hace N min: cerrala o dale trabajo». No sale la que espera su pase adversarial, la que anotó hace poco qué hace
  (`marker.js doing`) ni la que tiene la suite completa de la máquina.
- **Los pedidos listos que nadie encoló, en GitHub.** Un pedido abierto y limpio (sin choque ni controles obligatorios
  pendientes), sin auto-merge y fuera de la cola, igual por más de 10 minutos, sale con el comando para encolarlo. Por qué:
  nadie lo va a mergear, y todos creen que ya entró. Sale de la última lectura guardada, de menos de una hora: el aviso no
  va a la red. Los pedidos de un bot no salen. En Azure no sale: sin leer sus controles, «limpio» sólo dice que no choca.
- **La sesión que espera lugar para su pase.** Tiene que lanzarlo y otra tiene el lugar: sale con quién lo tiene, y cuando
  se libera, con «puede lanzar». Nada la despierta sola: le avisa la coordinadora.
- **La fila de la suite completa, parada.** Si no corre ninguna suite completa y alguna sesión anotó que espera turno
  (`marker.js doing --waiting-for` con «suite», «portón» o «turno»), sale «no corre ninguna suite completa y hay N
  esperando turno: dale el «arrancá» a X», con X la que espera hace más. Sin esa nota no sale: una sesión quieta no está
  esperando turno. `status` muestra la fila entera.

## Lo pesado, con turno: la suite completa y los pases adversariales

En la máquina puede correr a la vez **una suite completa y un pase adversarial o una tanda de revisores de otra sesión**:
el pase y los revisores corren en la nube y casi no usan la máquina. **Nunca dos ejecuciones grandes de pruebas ni dos pases a la vez.**
Lo controla el arnés, no la memoria de nadie:

- **La segunda ejecución grande no arranca.** Piden el turno (`scripts/tools/heavy-turn.js`) el corredor de las suites, cuando
  va a correr 100 suites o más, esté acotado o no, y las portables enteras. Con el turno de otro proceso vivo no corren (el
  portón de pruebas sale 75, su «esperá») y dicen quién lo tiene, cuántas suites corre, desde cuándo y cómo destrabarlo. Con
  menos de 100 suites no se pide. El turno de un proceso muerto, o de más de tres horas, se libera solo.
- **El segundo pase no se lanza.** Con otro en vuelo, el portón del pase (`pipeline.js deep-review-gate`) sale 3, y
  `pipeline.js next` pide esperar en vez de lanzar. La respuesta trae `other_in_flight` (historia, sesión y hora) y la línea
  que dice quién tiene el lugar. El pase de una sesión cerrada no cuenta.
- **Cuánto puede tardar el lugar en liberarse.** Hasta una hora de más: el arnés sabe que un pase terminó cuando su sesión
  lo recoge, no cuando termina en la nube. Pasada esa hora ya no frena, porque puede estar terminado o colgado, y se dice.

`coordination.js status` muestra la suite y el pase en curso. Sin coordinadora designada, todo responde como siempre: en la
CI y en la nube no hay turno. `TYCON_SUITE_TURN=0` apaga el de la suite, y `TYCON_SUITE_TURN=1` lo pide aunque no haya
coordinadora: sólo puede frenar de más.

## Las firmas, por sus tres vías

**Antes de pedir una firma, la coordinadora confirma que todavía falta.** Pedir una firma de algo ya firmado hace
firmar dos veces. La de los controles se confirma comparando el contenido firmado con el de la rama.

Después la pide por la vía que corresponde:

- **Con un click o un «aprobado» del dueño.** Donde la ventana no llega, es lo primero para toda firma que los acepta. La
  coordinadora le muestra el cuadro de opciones en su pestaña, con una sola pregunta: qué se aprueba, «firma <id>» y, si
  firma otra sesión, «sesión <id>». No deja pendiente. Las reglas están en `guides/firmas-del-arnes.md`, «Aprobar sin
  terminal».
- **Por la terminal del dueño**, sólo lo que no acepta el click: con `coordination.js signature --kind <tema> --title
  <qué se firma> --cwd <carpeta> -- <comando>`. Si la máquina tiene carpeta de firmas (`coordination.owner_folder`, sólo en el archivo
  de la máquina o en su variable, nunca en el perfil), escribe ahí un archivo por firma, `AAAA-MM-DD-<tema>.command`
  (en Windows, `.cmd`). El dueño lo abre con doble clic: dice qué es en una línea, entra a la carpeta, corre el comando
  y espera una tecla. Si ya hay un archivo con el mismo comando, no escribe otro y lo dice. Sin carpeta, no escribe
  nada: imprime el comando para el aviso del chat.
- **Por delegación.** Una firma que la organización deja firmar por delegación no pasa por `signature`: se da desde la
  pestaña de la coordinadora, en la ventana de permiso, con las reglas de la firma delegada. Se firma en el momento y
  no deja pendiente. Si la delegación no aplica y la pestaña de la coordinadora no pide permisos, la ventana no se abre,
  porque en esa pestaña nadie diría Sí: la firma se niega y la negativa dice cómo pedir el click o el «aprobado».

Lo que pide contraseña va siempre por la terminal: la contraseña la escribe sólo el dueño. Cuando el dueño firmó,
`coordination.js signature-done <id>` borra el archivo y el pendiente. Carpeta vacía y ningún pendiente quiere decir
que no falta firmar nada.

Una firma por la terminal que espera hace más de un día se le recuerda a la coordinadora: el primer turno del día con
algo que decir, una línea dice cuántas esperan y cuál es la más vieja, con su fecha. Una vez por día, aunque el conteo
cambie. Un pendiente cuyo archivo ya no está no cuenta: el dueño lo firmó y lo borró. Sin carpeta de firmas, no hay
pendientes y el aviso no sale.

### La lista de firmas: anotadas y, al volver, de a una

Con `approvals.signature_list` en `on`, lo que espera a la persona queda anotado en un solo registro, y `/office` lo cuenta en
«Tu firma». **La lista no firma nada:** un click sigue valiendo para una firma y un comando. Sin firmar en lote: cada renglón
pasa por su cuadro. Con `off`, o sin la llave, todo es como si no existiera. Se enciende en el perfil, o en la máquina para
probarla.

- **Qué se anota.** El freno anota la firma que niega con su cuadro a la propia sesión destino. No dejan renglón el pedido que
  corre otra sesión, lo delegado, lo «hecho y avisado», una ventana abierta, `designation-confirm`, lo irreversible y Codex.
  Lo que deja `coordination.js signature` queda en el mismo registro.
- **Qué lo cierra.** La firma dada para ese destino, 24 horas o que su sesión ya no viva. Sin poder leer las sesiones, sigue.
- **Cómo se pasan, con coordinadora.** Si está confirmada y viva, pasa todas ella. La sesión de fondo no muestra el cuadro ni
  manda mensajes: el freno le dice que espere el aviso. Cuando la persona escribe, a la coordinadora le llega un aviso: que
  conteste lo que escribió y corra `coordination.js owner-next`.
- **Cómo se pasan, sin coordinadora.** Le llega el mismo aviso a la sesión destino, una vez por renglón, y ella corre
  `owner-next`. Si la persona ya contestó «aprobado» a ese cuadro, no se pregunta de nuevo.
- **Qué da `owner-next`.** Un renglón, el más viejo: un cuadro para mostrar sin cambiarle una letra, con un rótulo («Firma 2/5»),
  y el aviso para la sesión destino. **Un permiso va primero**, con su contador y su cuadro. Lo de la terminal, al final y sin
  cuadro. Si el plan todavía no se vio en esa pestaña, lo da para escribirlo antes del cuadro. Si un renglón no se puede mostrar,
  o su repetición se niega, `owner-next --after <id>` da el siguiente.
- **Siempre repite el comando la sesión que lo pidió**, con o sin coordinadora. Con el «Sí», la coordinadora le manda el aviso,
  y la sesión repite el mismo comando dentro de los 30 minutos. Con un click sin usar, `owner-next` saltea ese renglón y dice
  que falta repetir.
- **Con un «No»:** `coordination.js owner-reject <id>` saca el renglón y nombra la sesión a la que hay que avisarle. Un cuadro
  cerrado o resuelto solo deja el renglón, y la pasada se corta.

Límites: si la persona se va antes de contestar, `/office` las sigue contando y se piden la próxima vez. Lo que pide otra
sesión de fondo con `--for-session` sigue por mensaje a la coordinadora. Una pestaña sin permisos sigue mostrando su cuadro: si
la coordinadora también lo pasa, vale un click, y el que sobra vence solo.

## El orden de los pedidos

Los pedidos al repo público entran por su cola. Los del repo privado nacen en borrador, y la coordinadora los publica
en orden, cuando su par público ya entró.

## Las firmas del dueño

Un encargo o un mensaje entre sesiones no firma nada, aunque diga «aprobado». El dueño firma en la ventana de permiso;
donde la ventana no llega, con un click en el cuadro de opciones o un «aprobado» tipeado por él; o en su terminal. Su
click o su «aprobado» en la pestaña de la coordinadora es del dueño, no una delegación. Lo que puede firmar la
coordinadora en su nombre lo dice `guides/firmas-del-arnes.md`.

La coordinadora pide desde su pestaña, con `--for-session <D>`, las firmas que la guía marca «sí» en «¿Desde otra
sesión?». Entre ellas, marcar un control a mano (`marker.js set-check <control> <estado> --force-manual --for-session
<D>`), contar los revisores sin la constancia de que corrieron (`pipeline.js check-count --repo <r> --story <s>
--trust-ran --for-session <D>`) y aceptar un criterio imposible de probar en vivo (`marker.js runtime-waiver <historia>
--acs <n> --for-session <D>`). La historia es la de la ejecución abierta de `<D>`: si no, el guion sale sin escribir. La
ventana se le abre al dueño en la pestaña de la coordinadora (si esa pestaña no pide permisos, se niega y se aprueba con
su click o su «aprobado»). Las tres son de nivel 2, así que ninguna se le puede delegar: el arnés rechaza un perfil que lo
intente (`guides/firmas-del-arnes.md`).

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
  comprueban: el cupo es de 5 archivos como mucho (pedir más se niega, y el freno da el cuadro para el dueño); el arreglo nunca toca lo sensible (la lista de
  `scripts/lib/signatures.js`: firmas, frenos, avisos, permisos, el perfil), que va con la firma del dueño; y antes de
  abrirlo le llega al dueño una línea por los canales de los avisos, con la sesión, el motivo y el cupo: sin
  entrega, no hay arreglo. La designada no se lo declara a sí misma.
- **Desde otra máquina.** La coordinadora de otra máquina se lo pide, por mensaje, a la designada de la máquina destino,
  que lo declara como arriba. El mensaje es un pedido, no una autorización: lo que autoriza es el perfil del equipo y la
  designación que el dueño confirmó. Sin designada en la máquina destino, el atajo se aprueba en la ventana de la
  pestaña destino.

**Pasar el tope no pasa por vos.** Pedir más de 8 archivos es la firma `adhoc-lane:sobre-cupo`, y la elige el dev: con su
click en el cuadro de la pestaña que hace el trabajo, o en su terminal. Un click en tu pestaña no vale, ni un «aprobado»
reenviado, ni la delegación; por eso una sesión de fondo sin nadie mirando sólo puede hacerlo por la terminal. Cuentan sólo
los archivos de implementación que el arreglo cambió: lo traído de `main`, las pruebas, las guías y las sondas no suman. Al
pasar el cupo, el arreglo frena al editar y no guarda, y el mensaje recomienda la historia. Límite: mide la rama en la que se
trabaja y lo que ya está en el disco. Trabajo armado en otra rama y empujado por su nombre, o creado en el mismo comando que
empuja, no suma. Eso no lo deja entrar a `main`, porque el pedido sigue con su control y su revisión: esquiva el aviso, y hay
que hacerlo a propósito. Al revés, en `dev` con `main` traído y sin empujar, lo ya integrado suma de más: se empuja, o se elige
con el click. Un empuje con algo más en el comando (`| cat`, `&& echo`), o escrito con un alias o una variable delante, cuenta también lo que git no sigue, aunque sea de otra
sesión: se repite el empuje solo. Una ruta real llamada `tests`, `e2e`, `cypress` o `playwright` cuenta como prueba, sin pedir
maqueta. Con un carril sin nada anotado, un guardado en otra carpeta cobra el tope de la rama de la sesión: si de verdad no es de
ese arreglo, se elige con el click. Y en un repo sin commits, un archivo con `git add -N` que sube con `git commit -a` no lleva
la marca de riesgo.

**Con la maqueta y la captura, lo construido se compara con la maqueta.** Compara textos, no el dibujo: si un texto de la
maqueta no está en las pantallas del carril ni en las demás de sus repos, no guarda. Un texto que ya existe en otra pantalla
pasa, aunque el arreglo no lo haya construido. Una diferencia se declara en `<maqueta>-diferencias.md`, con
`- «<texto>» — differs: <por qué>`, o `mockup-compare: no — <motivo>` si no se puede comparar. Lo declara el agente, sin
firma: queda a la vista en la pregunta de guardar y en `gates.log`.

**Si el arreglo toca una pantalla, no guarda sin tres cosas.** Qué es una pantalla lo dice el mismo criterio del pipeline
(`lib/ui-signal.js`, con la regla `screen_test` de la organización), archivo por archivo. Una prueba no cuenta.

1. La maqueta, que pase `mockup.js check`.
2. Su aprobación: `marker.js adhoc set '{"reason":"…","mockup":"<ruta>","mockupApproved":"<quién y por qué vía>"}'`, con
   la firma de siempre. La ventana muestra la maqueta y quién la aprobó. Si la maqueta cambia, hay que volver a aprobarla.
3. La captura, más nueva que el último cambio de los archivos del carril: `marker.js adhoc capture <imagen>`. No pide
   firma: no aprueba nada, y el freno la mide. Un cambio de código después la vence.

La ventana de guardar muestra juntas las rutas de la maqueta y de la captura. Si el freno no puede medir si el arreglo
toca una pantalla, tampoco guarda: sin medir no hay verde.

**Límites.** El freno mira la fecha de la captura: no comprueba que muestre esa pantalla ni la compara con la maqueta. Un
arreglo rápido cerrado (`adhoc clear`) o vencido ya no frena nada al guardar, igual que el freno de riesgo alto. Una
pantalla anotada en un worktree anidado que ya se borró sigue pidiendo maqueta y captura: la salida es `adhoc clear`.

## Una sesión trabada, al instante

**Al designarse, y cada vez que termina, la coordinadora lanza `node scripts/tools/coordination.js owner-wait` de
fondo.** Mira cada 2 segundos y termina con una línea por novedad, y terminar la despierta:

- «<sesión> espera un permiso desde las HH:MM: <herramienta> <qué pide>. Para entrar: claude attach <sesión>»: se lo
  pasa al dueño con la sesión, qué pide y su recomendación. El permiso lo contesta una persona, en la pestaña de la
  sesión o con `claude attach`.
- «<sesión> siguió: el permiso ya no está abierto» o «<sesión> se cerró con un permiso abierto»: se le avisa al dueño si
  se lo había pedido.
- «<sesión>: la cerró Claude Code a las HH:MM por falta de memoria, quieta N min. Para levantarla: claude respawn <id>»:
  Claude Code cierra solo las sesiones de fondo quietas cuando la máquina se queda sin memoria, y no se puede evitar
  desde el arnés. La coordinadora decide si la levanta: levantarla vuelve a ocupar memoria y cuenta para el tope.

Hay uno por máquina, y sin coordinadora confirmada sale enseguida. Si no está corriendo, el aviso de cada turno lo dice
con el comando. `coordination.js status` muestra las «Trabadas» y las «Cerradas por Claude Code».

**En cada chequeo, y antes de decir «no hay nada para vos», la coordinadora mira las esperas de la oficina** («Tu firma» y
el estado de cada sesión), no sólo los mensajes que le llegan: el aviso puede fallar.

**El modo automático no evita el cuadro.** Según la documentación de Claude Code, en `auto` el cuadro se abre igual con
reglas `ask`, con un `rm` sobre rutas críticas, en la primera lectura fuera de la carpeta de trabajo, y después de 3
bloqueos seguidos o 20 en total.

Límite conocido: con un permiso abierto, terminar otra herramienta no lo cierra, pero dos usos a la vez de la misma
herramienta lo pueden cerrar antes de tiempo.

Una sesión que espera un turno lo anota con `marker.js doing "<qué hago>" --waiting-for "<qué espera>"`: esa espera le
llega a la coordinadora y al dueño recién a las 2 horas, no a los 30 minutos, aunque el freno del cierre haya escalado.
Esa espera anotada también protege a su ejecución de la poda por vieja durante 24 h desde que empezó a esperar.

**Una ejecución podada se recupera.** Si igual se podó («abandonada: más de N h sin tocarse»), su marcador quedó
guardado: la sesión que la retoma corre `marker.js restore <sesión>` (la sesión podada), con la firma del dueño de
siempre, y vuelve con sus pasos hechos y pendientes, sin repetir firmas.

## Los avisos al dueño

Cortos y llanos: qué pasó, qué falta y qué decide él, en ese orden. Un aviso por tanda de trabajo, no uno por sesión.
Lo mide el medidor de estilo que ya existe; esta receta no agrega otro.

## Cómo habla la coordinadora

**Cuando dice que algo «termina», es funcionando de verdad: entró a main y está instalado.** Si todavía no, lo aclara:
«en la cola», «en main, sin instalar», «programado, sin pedido». Por qué: el dueño decide con esa palabra, y un «ya está»
que todavía no funciona le hace dar por resuelto algo que sigue roto. Una hora de fin dice también a qué estado se refiere.

## El tablero en la oficina

La oficina de `/office` muestra los pendientes en un kanban de cinco columnas: **Sin sesión, En curso, Tu firma, Esperan
entrar y Terminados**. En curso, Tu firma y Esperan entrar se arman solas de lo que hace cada sesión. El tablero de la coordinadora suma lo que
la máquina no sabe. La coordinadora lo escribe entero en `<estado>/coordination/tablero.json` (primero en un archivo
aparte y después renombrado, para que la oficina nunca lo lea a medias), cada vez que lo cambia:

- `pendientes`: una lista; cada uno con `titulo`, `estado` (`hecho`, `curso`, `firma`, `riesgo`, `entrando`, `sin-empezar`
  o `espera`, que va a «Sin sesión»; «curso» y «riesgo» van a «En curso» sólo si una sesión viva lo hace, y si no, también a «Sin sesión»), `grupo` (`Hoy`, `Esta semana`, `La semana que viene` o `Más adelante`), `orden`,
  `quien`, `nota`, y su hora: `pronosticoIso` o `estimadaIso` (hora local, `AAAA-MM-DDTHH:MM`), o `termina` con un texto
  propio. Un hecho lleva `realIso`.
- `historia` (por ejemplo `"2.81"`) y `pedido` (`{ "repo": "tycon-harness", "numero": 885 }`), opcionales. Con `historia` y
  una ejecución de esa historia en esta máquina, la fila no aporta estado ni hora: salen de la ejecución, y la fila aporta
  su `nota`. Con `pedido`, el estado sale de consultarlo, a lo sumo una vez por minuto: abierto, «Esperan entrar», con el
  motivo si está en borrador o fuera de la cola; entró, «Terminados» con su hora de entrada. Si la consulta falla, la fila queda donde dice
  `estado` y el motivo va a «No se pudo leer». `repo` es el nombre de un repo de una ejecución de esta máquina o de los que
  declara `team-repos.json`. `estado` vale sólo cuando no hay de dónde sacarlo.
- `meta`: `actualizado`, `resumen` y `teToca` (lo que le toca al dueño, una línea cada cosa). «Te toca» sale de las firmas, de
  las preguntas abiertas y de esta lista: las notas no se leen, así que lo que le toca al dueño va acá.

«Terminados» es lo hecho hoy, con su hora; lo anterior, o sin `realIso`, va a la tabla «Hechos».

### Las tablas «Hoy» y «Pendientes»

Las dos tablas se arman solas de las mismas tarjetas que el kanban, y nadie las escribe: ni la coordinadora ni una sesión.
Una clave `tablas` en el tablero se ignora, y `office.js --write-tables` contesta que ya no existe. «Hoy» trae «En curso»,
«Tu firma», «Esperan entrar» y «Terminados»; «Pendientes», lo que no tiene sesión y lo que quedó a medio camino. Hay una fila
por tema, con hasta dos trabajos nombrados y una línea contada de las tarjetas: «5 en curso, el próximo termina a las 23:30 ·
2 esperan entrar · 6 terminados hoy». Al tocar la fila se abren sus trabajos.

El tema de un trabajo lo elige una vez un modelo, de fondo, y queda guardado: no cambia si el trabajo cambia de hora o de
sesión. Es el modelo de la noche de la organización (`models.nightly`), o el mismo por el servicio local si la máquina no
tiene su llave. Se le manda sólo el título de los trabajos nuevos y los temas ya usados. El título de otro proyecto no se
manda: va a «Otro proyecto». Tampoco el que nombra a una persona de la lista privada, si está en la máquina: va a «Otros». Sin
modelo, el tema sale de los títulos de los pedidos recientes, y la tabla lo dice. El gasto tiene un tope por día; `node
scripts/tools/office/topics.js --report` dice cuánto va.

Si un tema quedó mal, se corrige con `tema` en la fila del tablero: gana sobre el modelo. Una fila no puede escribir la línea
de estado. Una fila abierta que nombra en `quien` a una sesión viva, y es la única que la nombra, recuerda el pedido de su
rama: cuando entra, pasa a «Terminados» con su hora, aunque la sesión ya esté cerrada.

Sin el archivo el kanban sale igual, con las columnas del estado real. Un archivo roto se dice abajo, en «No se pudo leer».
La oficina viva lo vuelve a leer sola cuando cambia, y el kanban dice «Tablero escrito a las HH:MM», con «(vieja)» si pasó
más que el umbral de la sesión callada (también un tablero al día y sin cambios: se escribe sólo cuando cambia). La fila de
una persona que ya tiene tarjeta del estado real no se duplica. Los escritorios no salen de acá: salen de lo que hace cada
sesión.

Una ejecución dejada a propósito se marca con `marker.js park <historia> --queue` («En fila para pruebas») o
`--until AAAA-MM-DD` («En pausa hasta…»), aunque su sesión esté cerrada. Con dos ejecuciones de la misma historia hay que
decir cuál, con `--session <id>`. Una ejecución marcada no dice hora ni atraso, nunca dice «limpiar», y
`marker.js clear-session` se niega. La marca sale con `marker.js unpark <historia>`, al adoptar la ejecución o con la salida
que firma el dueño. Ninguna de las dos pide firma: la marca no autoriza nada. Por qué: limpiar una de ésas pierde el trabajo.

La hora prometida de un arreglo rápido la anota su sesión con `marker.js adhoc until HH:MM`. La oficina y `/wip` la
muestran como su fin, y miden el atraso contra ella; sin hora, dicen «sin hora estimada».

## Las reglas del día a día

Salen de un día entero coordinando varias sesiones. Cada una dice qué hacer y por qué.

- **Una firma del dueño va en un mensaje aparte.** Qué se firma, en una línea, en un cuadro de opciones con una sola
  firma; lo que va por la terminal, con su comando. Nada más. Si a los 15 minutos sigue pendiente, se recuerda también
  aparte. Por qué: una firma al final de un mensaje con otras cosas se pierde, y el trabajo queda parado esperándola.
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
  el arnés lo niega. Un click o un «aprobado» que no anotó el gancho tampoco vale.
- **Lo pesado, con turno.** La suite completa, el banco de controles, el examen de revisores y el portón corren de a uno
  en la máquina, y el turno se le pide a la coordinadora. La suite completa y el pase además los frena el arnés (arriba, «Lo
  pesado, con turno»). La historia que el dueño marcó como prioridad pasa adelante en la fila. Por qué: dos a la vez
  saturan la máquina y los dos tardan más.
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
- **Las sesiones no se escriben entre sí.** Lo que una le quiere decir a otra se lo manda a la coordinadora con el texto
  listo, y ella lo reenvía. Por qué: si no, reparte dos veces lo mismo y pierde el hilo.
- **Una sesión no abre un cuadro en su propia pestaña.** Lo que necesita a una persona se lo pasa a la coordinadora y sigue
  con otra cosa. Si es una firma del dueño: se le avisa, y si no contesta, se sigue. Por qué: un cuadro deja la sesión
  parada hasta que alguien lo vea, y eso pueden ser horas.
- **Una sesión trabada esperando al dueño se le avisa ya.** Cuál es, qué tiene que contestar y la respuesta recomendada.
  Por qué: una sesión parada sin que nadie lo sepa pierde el tiempo de todos.
- **Antes de decir «te toca», se le pregunta a la sesión.** El dueño escribe en las pestañas sin pasar por la coordinadora.
  Por qué: reclamarle algo que ya hizo le hace perder tiempo y confianza.
- **«Te toca» es sólo para lo que puede hacer ahora.** Lo que va a necesitar después se dice con su hora y su condición.
  Por qué: el dueño lee «te toca» como algo para hacer en ese momento.
- **Cada pedido al dueño viene completo.** La pestaña, los pasos y el comando entero, nunca «lo que te pasé». Por qué: en un
  día con muchas sesiones, lo que se mandó antes queda enterrado.
- **Si el dueño pregunta cómo va algo, se le pregunta a esa sesión en el momento.** No se contesta con el último dato. Por
  qué: ese dato ya puede ser viejo.
- **Una sesión que dijo «tarda N» y pasó el doble se mira sin esperar su aviso.** Por qué: un proceso colgado no avisa.
- **Antes de asignar, se dimensiona.** Una línea que dice si el trabajo es liviano o completo y cuánto tarda, y antes se mira
  si ya existe. Por qué: ir por el camino largo sin analizarlo es el error que más se repite.
- **Una sesión que termina recibe lo siguiente de lo aprobado en ese turno, o se cierra.** Siempre dentro del tope. Por qué:
  una sesión libre es tiempo de máquina perdido, y el dueño no tiene que mirar el tablero para asignar.
- **Un rojo no se deja, aunque no sea del cambio propio.** Se avisa y se arregla antes de seguir. Por qué: los rojos
  tolerados tapan a los nuevos.
- **Lo que afloja una revisión no va, aunque ahorre tiempo; lo que es sólo papeleo no se hace.** Si el código ya entró y
  el uso real lo prueba, se cierra citando esa evidencia. La excepción es el código que decide cosas y nunca se revisó. Esto no
  saltea una firma ni una constancia que pida el arnés. Por qué: la calidad vale más que los minutos, y una constancia que
  no encuentra nada cuesta horas.
- **Un mensaje para el equipo se comprueba frase por frase antes de pasarlo.** Y a los devs se los molesta lo menos posible:
  un arreglo les llega solo; un paso a mano es el último recurso. Por qué: una promesa falsa llega a todas las máquinas.

## Qué mide cada regla

| Regla | Mide | Por qué |
|---|---|---|
| Al dueño van firmas, contraseñas, decisiones de producto y lo que sale de la casa | nadie | Qué es una decisión de producto o una salida de rutina es criterio: no hay un dato que lo diga. |
| Las preguntas de las sesiones van a la coordinadora | nadie | No hay aviso, por decisión del dueño: lo vería cada sesión de trabajo. La coordinadora lo recuerda cuando una sesión le pregunta al dueño. |
| La coordinadora cierra los detalles con la opción más segura | nadie | Es criterio, y queda anotado para que el dueño lo vea. |
| Cada sesión con un nombre puesto por una persona | aviso | `/coordinate` lista las que tienen el nombre que armó la herramienta. |
| No más sesiones trabajando que el tope | freno | `open` no abre en el tope. Una sesión que el dueño abre a mano no la frena nada; la cuenta `status` y, en el tope, el aviso de cada turno de la coordinadora. |
| Una suite completa por vez | freno | El corredor de las suites y las portables enteras no arrancan con el turno de otro proceso vivo, y dicen quién lo tiene. Una suite que alguien corre por otro camino no la ve. |
| Pases adversariales de a uno | freno | El portón del pase sale 3 y `next` pide esperar con otro en vuelo. Lanzar el pase sin consultar el portón no lo frena nada, y el de un arreglo rápido no queda anotado como en vuelo. Pasada una hora, sólo avisa. |
| Las sesiones de fondo quietas se cierran o reciben trabajo | aviso | El aviso de cada turno de la coordinadora, pasados 15 minutos. |
| Una sesión se cierra sin nada pendiente | freno | `close` no cierra si falta algo o si no pudo mirarlo. `claude stop` y `claude rm` a mano no pasan por él, y otro worktree que haya dejado la sesión no lo ve. |
| Un pedido listo no queda sin encolar | aviso | El aviso de cada turno de la coordinadora, pasados 10 minutos, y el del arranque. Sólo en GitHub. |
| «Termina» quiere decir funcionando | nadie | Es la palabra que elige: ningún dato de la máquina la ve. |
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
| Una pestaña que no pide permisos no firma por la ventana | freno | El freno de la ventana niega la firma y dice cómo aprobarla con un click o un «aprobado»; lo que no los acepta, con el comando de la terminal. Que la vía diga «delegación» lo confirma la coordinadora. |
| Un arreglo rápido con pantalla lleva maqueta y captura | freno | El freno de guardar no pasa sin las tres cosas, ni si no pudo medir. Mira la fecha de la captura, no qué muestra. |
| Lo pesado de a uno, con turno | nadie | La suite completa y el pase adversarial tienen su freno (arriba); el banco, el examen y el portón no. |
| Mirar el diff antes de aprobar un pedido ajeno | nadie | Es criterio de quien aprueba. |
| Una sesión que espera anota qué hace | nadie | Lo anota la sesión con `marker.js doing --waiting-for`; un aviso se lo recuerda, y nada la obliga. |
| Comprobar que un pedido sigue en la cola | nadie | Mirarlo cada turno sería preguntarle a la red todo el tiempo. |
| Las decisiones del dueño con su contexto | nadie | Es criterio; el medidor de estilo mide el largo, no el contenido. |
| Lo que ve el dueño, sin jerga | aviso | El medidor de estilo que ya existe. |
| La guía llega sola a la coordinadora | aviso | Al designarse, y al compactar o limpiar la conversación. Que la lea no lo mide nadie. |
| La coordinadora no aprueba lo que le da más poder | nadie | El control del perfil mira el nivel de lo que se delega, no quién aprobó el pedido. |
| Las sesiones no se escriben entre sí | nadie | Un mensaje entre sesiones no pasa por un control. |
| Una sesión no abre un cuadro en su pestaña | nadie | Lo decide la sesión al preguntar. |
| Una sesión trabada se avisa con la respuesta recomendada | aviso | Un permiso, al instante, con `owner-wait`; las demás esperas, a los 5 y a los 30 minutos; la recomendación la escribe la coordinadora. |
| Preguntarle a la sesión antes de decir «te toca» | nadie | Lo que el dueño escribe en otra pestaña no le llega a ella. |
| «Te toca» sólo para lo que se puede hacer ahora | nadie | Es la forma del mensaje. |
| Cada pedido al dueño viene completo | nadie | Es la forma del mensaje. |
| Preguntarle a la sesión cuando el dueño pregunta cómo va | nadie | Es criterio de la coordinadora. |
| Mirar la sesión que pasó el doble de lo que dijo | nadie | La duración la dijo en un mensaje, no en un dato. |
| Dimensionar antes de asignar | nadie | Es criterio de la coordinadora. |
| Una sesión que termina recibe trabajo o se cierra | aviso | El aviso de las sesiones de fondo quietas, pasados 15 minutos. |
| Un rojo no se deja | nadie | Los controles frenan lo propio; un rojo ajeno lo ve quien lo encuentra. |
| No aflojar una revisión, no hacer papeleo | nadie | Es criterio: ningún dato separa una revisión de un papeleo. |
| Comprobar un mensaje para el equipo | nadie | El mensaje sale por fuera de la máquina. |

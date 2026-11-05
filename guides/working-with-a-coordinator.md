# Trabajar con una coordinadora

En inglés: [working-with-a-coordinator.en.md](working-with-a-coordinator.en.md).

Esta página es para el dev que nunca usó una. Las reglas con las que decide ella están en
[Coordinar varias sesiones en una máquina](coordination.md); no hace falta leerlas para trabajar con ella.

## Qué es y cuándo conviene

La coordinadora es una sesión de tu agente que ordena a las demás sesiones de tu máquina. No es una persona. Le pedís el
trabajo a ella: abre las sesiones, contesta sus dudas, cuida que la máquina no se sature y te pasa sólo lo que es tuyo.

**Conviene** si trabajás con varias sesiones a la vez, sobre todo si las dejás corriendo mientras hacés otra cosa. Te
ahorra repetirle el contexto a cada una.

**No hace falta** si trabajás con una o dos sesiones que seguís vos. Sin coordinadora, el arnés funciona igual: aprobás
vos lo que te toca, y nada cambia en tu máquina.

La coordinadora va en Claude Code. Con Codex no se puede coordinar.

## Cómo se arranca

**Para que ordene no hace falta configurar nada.** En la instalación mínima, sin perfil del equipo, la coordinadora
ordena las sesiones (el tope, los turnos, los avisos, `/coordinate`) y se llama «coordinadora». Sin perfil, ordena y no
firma: todo lo que firma va a tu ventana, como sin coordinadora.

**Para que firme por vos, la organización la configura una sola vez.** En el [sitio de la organización](organization-site.md),
pestaña Configuración, «Quién autoriza saltarse un control», elige «Una sesión coordinadora» y le pone nombre en «¿Cómo
la llaman?». De fábrica se llama «coordinadora». Sin sitio, va en `approvals.relay_session` del perfil del equipo. Si la
organización saca esa clave después, la confirmación que diste deja de valer.

También puede decidir qué firmas de rutina le delega y en qué máquinas. Si no decide nada, no firma ninguna.

**Lo que hacés vos, en cada máquina:**

1. Abrí la sesión que va a ser la coordinadora y escribile, con el nombre que usa tu organización:

   > Esta sesión es la coordinadora

2. La sesión lo anota y recibe la orden de leer sus reglas. Con el rol en el perfil, te pide que lo confirmes, con un
   click o desde tu terminal. Sin confirmar, o sin perfil, ordena a las demás, pero no firma nada ni recibe tus firmas
   para otra sesión.

Con eso ya está. `/coordinate` te muestra el estado de la máquina cuando quieras verlo.

Hay una sola coordinadora por máquina. Si designás otra, reemplaza a la anterior.

## Un día de trabajo

1. **Le pedís algo a ella**, en su pestaña y con tus palabras: «arreglá el combo de provincias», «seguí la historia de los feriados».
2. **Ella abre las sesiones**, de fondo y con nombre, con los mismos permisos que tiene ella. De fábrica trabajan hasta 3
   a la vez: si ya están, espera a que se libere un lugar y te lo dice. La primera vez en una carpeta puede pedirte que
   la abras una vez, para aprobarla.
3. **Las sesiones le preguntan a ella**, no a vos. Ella resuelve los detalles con la opción más segura y anota cuál
   eligió.
4. **Te pasa sólo lo tuyo**, en su pestaña, con el contexto y una recomendación, para que decidas sin ir a buscar nada.
5. **Si querés entrar a una sesión**, `claude attach <nombre>` en una terminal. También la ves desde claude.ai/code o
   desde el celular.
6. **Al terminar, ella cierra la sesión**, si no le queda nada sin guardar. Una pestaña abierta por vos la cerrás vos.

Si una ejecución queda esperando a una persona, a los 5 minutos le avisa a ella. Si a los 30 minutos sigue igual, te
llega a vos por los canales de aviso de tu organización, si tiene alguno.

## Qué te llega a vos y qué no

| Te llega | No te llega |
|---|---|
| **Firmas:** lo que el arnés pide firmado por una persona | Las dudas de detalle de cada sesión |
| **Contraseñas:** lo que pide la contraseña de tu máquina | Los turnos: quién corre primero lo que carga la máquina |
| **Decisiones de producto:** qué se construye, para quién y en qué orden | El estado de cada sesión, salvo que lo pidas |
| **Lo que sale de la casa:** lo que sale a producción de un producto y lo que se le manda a un cliente o a alguien de afuera | Lo de rutina: encolar pedidos del arnés o publicar material ya aprobado |

Esto es una regla que sigue ella, no un freno. Si te llega otra cosa, o algo tuyo no te llega, decíselo.

### Cómo se contesta un cuadro de firma

Una firma te llega en un mensaje aparte: qué se aprueba, el detalle y qué pasa si sale mal, con dos opciones, **Sí,
aprobar** y **No**.

- **Con «Sí, aprobar»**, se firma eso solo. La aprobación sirve para una firma y vence a los 30 minutos.
- **Con «No»**, el trabajo queda frenado en ese paso y no se rompe nada.
- **Si tu pestaña pide permisos**, en lugar del cuadro te aparece la ventana de permiso. Contestás «Sí».
- **También podés escribir** «aprobado», si lo tipeás vos en la consola o en la extensión del editor. Por Telegram o desde
  otra sesión no vale: ahí, usá el click.

Lo que no acepta el click, como apagar un freno de seguridad, te llega como un comando para correr en tu terminal. Las
contraseñas también se escriben ahí: la escribís vos, y ella nunca la ve.

Un mensaje entre sesiones que diga «aprobado» no firma nada.

## Qué no puede hacer ella

- **Firmar por vos, salvo la rutina que tu organización le delegó.** Esa rutina es lo que se deshace: por ejemplo,
  aprobar un plan común, cuando la revisión automática dio «aprobado». Vale sólo en las máquinas que nombra la
  organización, con tu confirmación del arranque, y nunca en Windows. Lo que no esté delegado te llega a vos.
- **Lo irreversible o lo que afloja un control.** Saltear un control, aceptar un problema grave sin arreglarlo o marcar
  algo como probado a mano no se le puede delegar: el arnés rechaza un perfil que lo intente. Cambiar un control es
  sólo del dueño.
- **Saltearse los frenos.** Los frenos del arnés la paran igual que a cualquier otra sesión.

## Cómo verla trabajar

Los tres comandos sólo miran, no cambian nada.

- **`/coordinate`**, en su pestaña: quién trabaja contra el tope, quién espera, las firmas pendientes y las sesiones sin
  nombre. En cualquier otra sesión te dice que esa sesión no coordina.
- **`/office`**, en cualquier sesión: la oficina en 3D, con una persona por sesión, su estado y su hora de fin. Si ella
  lleva su tablero de pendientes, aparece en un panel aparte.
- **`/wip`**, en cualquier sesión: lo mismo, en una tabla.

## Si se traba, o después de un `/clear`

- **No contesta.** Mirá con `/wip` si está ocupada: lee los mensajes cuando termina el paso que está haciendo. Si esa
  pestaña se cerró, las otras sesiones siguen trabajando, y lo que esperaba a una persona te llega a vos.
- **Se compactó su conversación.** Sigue siendo la coordinadora, porque es la misma conversación, y recibe la orden de leer
  sus reglas otra vez.
- **Se reinició.** También sigue siéndolo. Acá no recibe esa orden: si notás que olvidó las reglas, escribí `/coordinate`.
- **Hiciste `/clear` o abriste un chat nuevo.** Dejó de ser la coordinadora: para el arnés es otra conversación, aunque
  conserve el nombre. Las otras sesiones siguen. Después de un `/clear`, si la sesión tiene nombre, ella te dice cómo
  recuperarlo. Hasta que vuelvas a designarla, las firmas te llegan en la pestaña de cada sesión. Se arregla repitiendo los
  pasos de «Lo que hacés vos». La organización no tiene que configurar nada.
- **`/coordinate` dice que esta sesión no coordina.** La misma salida dice qué falta: la configuración de la organización
  o tu frase.
- **No acepta tu frase.** La frase tiene que traer el nombre exacto que puso tu organización.

# El modo autónomo de la coordinadora

En inglés: [autonomous-mode.en.md](autonomous-mode.en.md).

Esta página es para quien trabaja con una coordinadora y quiere dejarla trabajando sola: de noche, un fin de semana o
mientras está en otra cosa. Qué es la coordinadora y cómo se arranca está en
[Trabajar con una coordinadora](working-with-a-coordinator.md); sus reglas completas, en
[Coordinar varias sesiones en una máquina](coordination.md).

## Qué es

El modo autónomo es la coordinadora trabajando **con el dueño ausente**. El dueño se va, y la máquina sigue: las
sesiones terminan lo que tienen, lo que no necesita al dueño entra a `main`, y lo que sí lo necesita lo espera
juntado.

No es otra herramienta ni otra configuración. Es la misma coordinadora, con una marca que dice «el dueño no está».

## Para qué sirve

- **La noche rinde.** Lo ya aprobado avanza solo: pruebas, revisiones, pedidos de cambio que entran a `main` con la CI
  en verde.
- **El dueño no vuelve a un desorden.** Lo que necesita su firma lo espera en una lista, de a uno, con su contexto.
- **Nadie queda parado esperando una respuesta.** Una sesión que necesita al dueño deja la pregunta escrita y sigue con
  otra cosa.

## Cómo se invoca

El dueño se lo dice a la coordinadora con sus palabras, en su pestaña: «seguí en autónomo», «me voy», «hasta mañana».

- **Qué pasa por dentro.** La coordinadora pone la **marca de ausente**:
  `marker.js owner-away set --phrase "<lo que dijo el dueño>"`. La frase tiene que estar en un mensaje que el dueño
  tipeó en su pestaña en los últimos 30 minutos: el agente no se pone la marca solo, ni por un mensaje de otra sesión.
- **Cómo se ve.** La oficina (`/office`) la muestra mientras está puesta.
- **Cómo se levanta.** Sola, cuando el dueño vuelve: un mensaje suyo, un mensaje suyo desde la oficina, una firma suya, o
  a las 24 horas.

Sin la marca, el dueño cuenta como ausente igual después de un rato sin contestar (lo configura cada organización); la
marca sólo adelanta lo que pasaría solo.

## Sus reglas, y qué gana cada una

| Regla | Qué gana |
|---|---|
| **La marca.** El dueño dice que se va y la coordinadora la pone; se levanta sola cuando vuelve. | Todas las sesiones saben, sin preguntar, que no hay a quién preguntarle. |
| **Sin cuadro de opciones.** Con la marca puesta, nadie abre un cuadro de preguntas: la decisión queda escrita, con su recomendación, y la sesión sigue con lo demás. | Un cuadro abierto de madrugada dejaba una sesión parada horas, esperando a alguien que no estaba. |
| **Las firmas se juntan para la vuelta.** Lo que pide la firma del dueño queda en su lista; cuando vuelve, la coordinadora se lo pasa de a uno, por click. Las firmas que tocan los mismos archivos van en un solo pedido. | El dueño firma todo junto, en un rato, y una firma no vence a otra. |
| **La coordinadora da lo que puede.** Lo de rutina que la organización le delegó (por ejemplo, aprobar un plan común cuando la revisión automática dio «aprobado») lo firma ella. | Lo que se deshace no espera al dueño. |
| **Nada a mano en la carpeta de Claude.** Con el dueño ausente, no se escribe a mano dentro de la carpeta de configuración de Claude Code: se usan los guiones del arnés, o se deja para la vuelta. | Claude Code pide confirmación para escribir ahí aun sin permisos, y con el dueño ausente nadie la da: la sesión quedaba parada. |
| **Avisos según el perfil.** Con el dueño ausente, la organización elige qué le llega por los canales de aviso (Telegram, Slack, Teams o correo): ver abajo. | Cada organización decide si quiere enterarse de noche o recién a la mañana. |

### Los avisos con el dueño ausente

La opción `coordination.away_notify` del perfil del equipo dice qué le llega al dueño mientras está ausente:

| Valor | Qué le llega |
|---|---|
| `signatures` (de fábrica) | Un aviso por cada firma o permiso que queda esperándolo. Lo espera igual en su lista: el aviso sólo le cuenta que está ahí. |
| `broken-only` | Sólo lo que se rompió de verdad: un control que no corre, una caída. Las firmas esperan en silencio. |
| `never` | Nada. Todo lo espera en su lista para cuando vuelva. |

Se cambia desde el perfil del equipo, como cualquier otra opción de la coordinadora.

## Qué NO hace

El modo autónomo no le da a la coordinadora nada que no tuviera. Con el dueño ausente:

- **No firma lo del dueño.** Un plan delicado, un cambio a un control, lo que pide una contraseña y lo irreversible
  esperan su vuelta, siempre.
- **No se saltea los frenos.** La paran igual que a cualquier sesión.
- **No decide el producto.** Qué se construye y en qué orden lo decide el dueño; de noche se avanza con lo ya decidido.

## Un ejemplo de una noche

Inventado, para mostrar la forma.

A las 23, el dueño le dice a la coordinadora «me voy, seguí en autónomo» y cierra la computadora. La coordinadora pone la
marca.

Durante la noche:

- Tres sesiones terminan arreglos chicos que ya estaban aprobados. Sus pedidos pasan la CI y entran a `main`.
- Una sesión necesita decidir entre dos formas de un arreglo. No abre un cuadro: deja escrito cuál recomienda y por qué,
  y la coordinadora le da otro trabajo de la fila.
- Otra sesión termina un cambio a un control. Pide su firma, que queda en la lista del dueño; como el perfil dice
  `signatures`, al dueño le llega un aviso de una línea. La sesión sigue con lo demás.
- La coordinadora aprueba dos planes de rutina, porque la organización se los delegó.

A las 8, el dueño escribe «buen día». La marca se levanta sola. La coordinadora le pasa lo que lo esperaba: la firma del
control, por click, y la decisión que quedó escrita, con su recomendación. Todo lo demás ya está en `main`.

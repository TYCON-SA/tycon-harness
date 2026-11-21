# El modo autónomo de la coordinadora

En inglés: [autonomous-mode.en.md](autonomous-mode.en.md).

Esta página es para quien nunca lo usó. Si todavía no trabajaste con una coordinadora, empezá por
[Trabajar con una coordinadora](working-with-a-coordinator.md). Las reglas completas con las que decide ella están en
[Coordinar varias sesiones en una máquina](coordination.md).

## Qué es

El dueño de la máquina se va (a dormir, a una reunión larga, el fin de semana) y la máquina sigue trabajando sola. La
coordinadora sigue abriendo sesiones, dándoles trabajo y cerrando lo que se puede cerrar sin él. Lo que necesita al
dueño no se pierde ni traba a nadie: queda juntado para cuando vuelve.

## Para qué sirve

- **La noche o un fin de semana rinden.** Lo que no necesita al dueño avanza hasta entrar a main solo: una historia de
  rutina, un arreglo chico, una prueba roja de la noche.
- **Nada queda esperando una respuesta que no va a llegar.** Las sesiones no se frenan a preguntar: dejan la decisión
  escrita y siguen con lo demás.
- **A la vuelta, el dueño encuentra todo junto.** Una sola tanda de firmas, de a una y con su contexto, en lugar de
  avisos sueltos a toda hora.

## Cómo se invoca

El dueño se lo dice a la coordinadora con sus palabras: «seguí en autónomo», «me voy», «hasta mañana». No hay una lista
de frases: lo juzga ella.

Por dentro, la coordinadora pone **la marca del dueño ausente**:

```bash
node marker.js owner-away set --phrase "<lo que dijo el dueño>"
```

La marca es de la máquina, no de una sesión: todas las sesiones la ven. Queda anotada en el registro, con quién la puso,
la hora y la frase.

**Se levanta sola cuando el dueño vuelve.** No hace falta acordarse de sacarla. La borra cualquiera de estas cosas:

- un mensaje que el dueño escribe en cualquier sesión;
- un mensaje suyo desde la oficina (`/office`), verificado;
- una firma suya posterior a la marca, por ventana, terminal, click o mensaje (una firma por delegación no cuenta);
- el vencimiento, a las 24 horas.

## Las reglas, y qué gana cada una

1. **La marca.** Con ella, las revisiones automáticas siguen enseguida la regla de «dueño ausente» de la organización,
   sin esperar los minutos sin respuesta. *Gana:* nadie espera media hora para darse cuenta de que el dueño no está.
2. **Sin cuadro de opciones.** Con la marca puesta, el arnés niega el cuadro de preguntas en cualquier sesión, y le dice
   qué hacer: dejar la decisión escrita, con su recomendación, y seguir con lo demás. Si el dueño está y pidió el cuadro,
   alcanza con que escriba que volvió. *Gana:* una pregunta ya no deja una sesión parada horas (pasó: una sesión quedó
   5 horas esperando de noche).
3. **Las firmas, juntas para cuando vuelve.** Las firmas que salen mientras no está se juntan en una sola tanda, para
   que las dé por click y de a una. Las que tocan los mismos archivos van en un solo pedido, para que la firma de una no
   venza a la otra. *Gana:* el dueño firma todo de una vez, sin repetir. Es una preferencia de la organización (ver
   abajo).
4. **La coordinadora da lo que puede.** Lo que la organización le delegó (por ejemplo, las firmas de rutina de nivel 1)
   lo firma ella, sin esperar. *Gana:* lo de rutina no espera a la mañana. Qué puede firmar está en
   [Las firmas del arnés](firmas-del-arnes.md).
5. **Nada a mano en la carpeta de Claude Code.** Claude Code pide confirmación para escribir en su carpeta aun sin
   permisos, y con el dueño ausente nadie la da. Con la marca puesta, el arnés frena esa edición antes y dice qué hacer:
   usar el guion del arnés que la escribe, o dejarla para la vuelta. Las subcarpetas donde Claude Code no pregunta (la de
   trabajo de cada sesión de fondo y la de las memorias) quedan libres. *Gana:* ninguna sesión queda esperando una
   confirmación invisible.
6. **Avisos según el perfil.** Por mensajería, con el dueño ausente, se avisa sólo si algo se rompe de verdad, o nunca.
   *Gana:* el dueño descansa; si la organización quiere, se entera de lo grave.

### Las dos preferencias de la organización

Van en el perfil del equipo, en `coordination`. Cada máquina puede cambiarlas para sí, como las demás de la coordinadora.

| Clave | Valores | De fábrica |
|---|---|---|
| `away_signatures` | `on-return`: una sola tanda para cuando vuelve · `hourly`: la tanda de cada hora | `on-return` |
| `away_notify` | `broken-only`: sólo si algo se rompe de verdad · `never`: nunca | `never` |

La coordinadora las ve una vez por cada marca, en su aviso de cada turno.

## Qué NO hace

El modo autónomo no firma lo que es del dueño. Eso espera a la mañana, siempre:

- los planes delicados;
- los cambios a los controles del arnés (sus constancias);
- todo lo que pida una contraseña o un acceso;
- lo que no se puede deshacer: producción, borrar datos, publicar afuera.

## Un ejemplo de una noche

A las 23:10 el dueño le escribe a la coordinadora «me voy, seguí en autónomo». Ella pone la marca y sigue.

Durante la noche:

- Termina dos historias de rutina que estaban en revisión. Sus revisiones automáticas corren con la regla de dueño
  ausente, y las dos entran a main solas.
- Una prueba de la noche sale roja. Abre una sesión, que encuentra la causa, la arregla con su prueba y abre el pedido.
  Como toca un control, la constancia queda para la mañana.
- Una sesión tiene una duda de diseño. El cuadro se niega solo: la sesión escribe la duda en un archivo con su
  recomendación, se la pasa a la coordinadora y sigue con la parte que no depende de eso.
- Otra sesión necesita ajustar un archivo de la carpeta de Claude Code. El arnés la frena: lo deja anotado para la
  vuelta.
- No se manda ningún aviso: la organización tiene `away_notify: never`.

A las 8:30 el dueño escribe «buen día» y la marca se borra. Encuentra:

- una tanda de tres firmas, una por click: la constancia del arreglo, un plan delicado y la duda de diseño, con la
  recomendación;
- las dos historias ya en main;
- la nota de la carpeta de Claude Code, para hacerla él.

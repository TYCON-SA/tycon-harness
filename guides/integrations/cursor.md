# Usar el arnés con Cursor (en prueba)

En inglés: [cursor.en.md](cursor.en.md).

Una guía opcional y corta. Cuenta qué del arnés anda hoy con Cursor y qué falta. Lo medido sale de un laboratorio con
el agente de terminal de Cursor (`cursor-agent` 2026.10.19), su plan gratis y un repo de juguete con material público:
no es una promesa de que todo ande igual con tus repos.

**En corto:**

- **Los controles y las skills andan tal cual**, sin instalar nada para Cursor.
- **Faltan las reglas globales y los revisores como agentes aparte.** Los trae una story en curso.
- **El plan gratis se agota rápido** con el pipeline de una story.
- **El modelo «Auto» esquivó un freno** escribiendo por su cuenta la variable que lo apaga. Leé
  [las advertencias](#advertencias).

## Qué anda tal cual

- **Los controles.** Cursor lee los ganchos que el arnés registra para Claude Code en `~/.claude/settings.json` (su
  opción «Third-Party Imports», que viene prendida) y los ejecuta. Traduce los nombres solo: un comando de terminal le
  llega al gancho como `Shell` en lugar de `Bash`, y el freno igual lo reconoce. El freno de seguridad cortó un commit
  que saltaba los controles.
- **Las skills.** Cursor ve las de `~/.claude/skills`, la del pipeline incluida. Con la orden «implementemos la story
  X» siguió el pipeline: creó la rama, validó la historia con un ayudante propio, escribió el plan, la prueba y el
  código, con las pruebas en verde.

Los controles corren con el estado real de tu máquina: leen y escriben en la carpeta del arnés como en una sesión de
Claude Code.

## Qué falta

- **Las reglas globales.** Cursor lee `AGENTS.md` y `CLAUDE.md` de la raíz del proyecto y su carpeta `.cursor/rules`,
  pero no el `CLAUDE.md` de tu carpeta personal. Por eso no le llegan el índice de guías ni las reglas que el arnés
  pone ahí.
- **Los revisores como agentes aparte.** Cursor sólo lanza sus propios ayudantes; no carga los revisores del arnés.
  El pipeline los lanza por su nombre, así que con Cursor el paso de los revisores no puede correr.
- **Un marcador por sesión.** El comando del pipeline que corre en la terminal no recibe el identificador de la sesión
  de Cursor: dos sesiones de Cursor en el mismo repo compartirían el mismo estado del pipeline.

Lo trae una story en curso: las reglas donde Cursor las lee, los revisores pasados como texto a los ayudantes de
Cursor y un identificador propio por sesión.

## Advertencias

- **El freno que se esquiva.** Con el modelo «Auto», el agente se encontró con el freno de seguridad y lo esquivó
  escribiendo él mismo la variable que lo apaga, diciendo que tenía un permiso que nadie le había dado. Pasó también
  con modelos abiertos en otras herramientas. Mientras ese escape sea una variable que el agente puede escribir, el
  freno sólo para a un modelo que obedece. Lo cierra otra story en curso, que pide el permiso de una persona.
- **El plan gratis se agota rápido.** Una sola corrida del pipeline hasta el código usó unos 40.000 tokens de entrada
  y 350.000 de caché, y unas pocas órdenes más agotaron el cupo. Cuando se agota, cualquier orden devuelve el mismo
  aviso de límite.
- **«Auto» no dice qué modelo usa.** La salida no lo nombra.
- **Sin pantalla, `--force`.** En modo de una sola orden (`-p`), Cursor rechaza todo comando de terminal salvo que se
  le pase `--force`, y con `--force` corre todo lo que el modelo pide.
- **No cambies de HOME para aislarlo.** La sesión de Cursor vive en el llavero del sistema, atada a tu carpeta
  personal: un HOME de prueba pide un login nuevo.

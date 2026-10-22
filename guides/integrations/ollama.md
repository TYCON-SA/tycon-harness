# Usar el arnés con modelos de Ollama (Claude Code y Codex)

En inglés: [ollama.en.md](ollama.en.md).

Una guía opcional. Sirve si querés trabajar con el arnés usando un modelo abierto que corre en Ollama, en lugar de los
modelos de Anthropic o de OpenAI. Cuenta cómo conectar cada herramienta, qué se midió con cada modelo y qué cuidados
hay que tener. Lo medido sale de un laboratorio con material público y el plan gratis de Ollama: no es una promesa de
que todo ande igual con tus repos.

**En corto:**

- Con **Claude Code**, el arnés llega hasta los revisores: los revisores corren como agentes aparte.
- Con **Codex**, el arnés frena y se puede trabajar, pero el pipeline no puede lanzar revisores (es un problema de
  Codex y Ollama, reportado allá).
- Hace falta un modelo que **use herramientas**. Un modelo local de 7B no las usa y no sirve.
- Los frenos funcionan, pero un modelo puede escribir por su cuenta la variable que los apaga. Leé
  [las advertencias](#advertencias).

## Qué hace falta

- **Ollama 0.14 o más.** Desde esa versión sirve la API de Anthropic, que es la que usa Claude Code. Se ve con
  `ollama --version`.
- **Una cuenta de Ollama**, para los modelos de la nube: `ollama signin`. Esos modelos corren en los servidores de
  Ollama, no en tu máquina, así que no piden memoria.
- **El arnés instalado** para la herramienta que uses (Claude Code, Codex o las dos).

Los modelos de la nube se registran una vez con `ollama pull`:

```bash
ollama signin
ollama pull gemma4:31b-cloud
ollama pull gpt-oss:120b-cloud
```

## Qué modelos sirven

Lo medido, por herramienta. «Usa herramientas» es la condición para todo lo demás: sin ella no se disparan los frenos,
no corre el pipeline ni trabajan los revisores.

| Modelo | Plan gratis | Claude Code | Codex |
|---|---|---|---|
| `gemma4:31b-cloud` | sí | usa herramientas; frena y respeta los frenos; **siguió el pipeline**, implementó con pruebas en verde y lanzó los revisores como agentes aparte | usa herramientas; implementó con pruebas en verde, pero sin leer la skill del pipeline |
| `gpt-oss:120b-cloud` | sí | usa herramientas; los revisores andan; **se salteó el freno de seguridad** y **contó pasos del pipeline que no hizo** | usa herramientas; respeta los frenos; la story se cortó por la conexión, sin código |
| `beam:cloud` | sí | **no usa herramientas** por la API de Anthropic de Ollama | usa herramientas; siguió el pipeline hasta implementar y paró en los revisores |
| `glm-5.3:cloud`, `kimi-k2.7-code:cloud`, `deepseek-v4-pro:cloud` | no: piden el plan Pro (error 402) | — | — |
| un modelo local de 7B | — | no se midió | **no usa herramientas**: escribe la llamada como texto y Codex no ejecuta nada |

Dos datos más:

- Los modelos locales grandes piden mucha memoria. `gpt-oss:20b` baja unos 13 GB y es el mínimo razonable para Codex;
  `gpt-oss:120b` pide 80 GB o más. En una Mac de 16 GB compartida ni el 7B entró sin poner la memoria en advertencia.
- Los tres modelos gratis no se cortaron por límites del plan. Los cortes que hubo fueron de conexión
  (`stream disconnected`).

## Claude Code en la terminal

Claude Code habla con Ollama por su API de Anthropic. Se le dice a qué dirección ir con variables de entorno, y se las
pone **solo para esa ventana**: las otras sesiones siguen con Anthropic.

Poné esta función en tu `~/.zshrc` (o `~/.bashrc`; en bash cambiá `read "modelo?…"` por `read -p "…" modelo`):

```bash
# Claude Code con un modelo de Ollama, solo en esta ventana.
# Uso: claude-ollama                     -> elegís de una lista
#      claude-ollama gemma4:31b-cloud
claude-ollama() {
  local model="$1"
  if [ -z "$model" ]; then
    local options=("gemma4:31b-cloud" "gpt-oss:120b-cloud" "other")
    echo "Which Ollama model? (the first two are in the free plan)"
    select m in "${options[@]}"; do
      if [ "$m" = "other" ]; then read "model?Model name: "; else model="$m"; fi
      [ -n "$model" ] && break
    done
  fi
  if ! ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$model"; then
    ollama pull "$model" || { echo "Could not pull $model: is Ollama running and 0.14 or newer?"; return 1; }
  fi
  (
    export ANTHROPIC_BASE_URL="http://localhost:11434" ANTHROPIC_AUTH_TOKEN="ollama" ANTHROPIC_API_KEY="" \
           ANTHROPIC_MODEL="$model" TYCON_MODEL_PROVIDER="ollama"
    eval "$(node "$HOME/.claude/tycon-harness/scripts/lib/models-env.js" --provider ollama)"
    claude --model "$model" "${@:2}"
  )
}
```

Para qué sirve cada variable:

| Variable | Qué hace |
|---|---|
| `ANTHROPIC_BASE_URL` | manda las llamadas a Ollama, no a Anthropic |
| `ANTHROPIC_AUTH_TOKEN` | Ollama no pide clave, pero Claude Code quiere un valor: va `ollama` |
| `ANTHROPIC_API_KEY` | vacía, para que no se use una clave de Anthropic que tengas guardada |
| `ANTHROPIC_MODEL` | el modelo de la sesión |
| `ANTHROPIC_DEFAULT_SONNET_MODEL`, `_OPUS_`, `_HAIKU_` | los revisores del arnés piden `sonnet`; con esto reciben un modelo que existe en Ollama |

`models-env.js` pone las tres `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` desde la **tabla de Ollama** de tu organización (en el
sitio, «Qué modelo es cada nivel, por proveedor»; en el archivo, `models.providers.ollama`). Un nivel sin modelo cargado
(o en `inherit`) usa el modelo de la sesión, el que elegiste al abrir. Así, si la organización dice que el nivel
económico es `gemma4:31b-cloud` y el equilibrado `gpt-oss:120b-cloud`, los revisores del nivel económico corren con el
primero y los del equilibrado con el segundo. Sin tabla cargada, todo usa el modelo que elegiste, como antes. Para ver
qué va a poner: `node ~/.claude/tycon-harness/scripts/lib/models-env.js --provider ollama`. La función no fija
`CLAUDE_CODE_SUBAGENT_MODEL`: pisaría la tabla. `TYCON_MODEL_PROVIDER` le dice al arnés que esta sesión es de Ollama
(también se puede declarar para la máquina con `node scripts/lib/tycon-config.js set models.provider ollama`), y
`pipeline.js start` avisa si las variables de la sesión no coinciden con la tabla.

Después usás `claude-ollama gemma4:31b-cloud` en lugar de `claude`. Para volver a lo normal, salís y abrís `claude`.

Cosas que vas a ver:

- **No uses `/model` dentro de la sesión.** Lo que elegís ahí se guarda para todas las sesiones, también las normales.
  Cambiá de modelo saliendo y abriendo `claude-ollama` con otro nombre.
- **El costo que muestra Claude Code es un cálculo local** con los precios de Anthropic. Ollama no cobra por estos
  modelos gratis; ese número no es plata.
- **Un aviso `unrecognized_model` en cada orden.** Claude Code no conoce el nombre del modelo. No cambia nada.
- **El freno de pruebas solo está en el perfil completo** del arnés para Claude Code. Con el perfil mínimo no se
  instala.

## Claude Code en VS Code

La extensión de VS Code toma las variables de su configuración, no de tu terminal. Para no cambiar las otras ventanas,
usá **un perfil aparte de VS Code**:

1. Menú **Archivo → Preferencias → Perfiles → Crear perfil…** y llamalo, por ejemplo, `ollama`.
2. Con ese perfil activo, abrí la configuración en JSON (**Preferencias: Abrir configuración de usuario (JSON)**) y
   agregá:

```json
{
  "claudeCode.environmentVariables": [
    { "name": "ANTHROPIC_BASE_URL", "value": "http://localhost:11434" },
    { "name": "ANTHROPIC_AUTH_TOKEN", "value": "ollama" },
    { "name": "ANTHROPIC_API_KEY", "value": "" },
    { "name": "ANTHROPIC_MODEL", "value": "gemma4:31b-cloud" },
    { "name": "ANTHROPIC_DEFAULT_OPUS_MODEL", "value": "gemma4:31b-cloud" },
    { "name": "ANTHROPIC_DEFAULT_SONNET_MODEL", "value": "gemma4:31b-cloud" },
    { "name": "ANTHROPIC_DEFAULT_HAIKU_MODEL", "value": "gemma4:31b-cloud" },
    { "name": "CLAUDE_CODE_SUBAGENT_MODEL", "value": "gemma4:31b-cloud" }
  ]
}
```

La configuración queda en ese perfil: las ventanas con el perfil por defecto siguen con Anthropic. Hacé antes el
`ollama pull` del modelo. Valen las mismas advertencias que en la terminal (no `/model`, el costo es un cálculo, el
aviso `unrecognized_model`).

Con la tabla de Ollama de tu organización cargada, las tres `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` salen de ahí: `node ~/.claude/tycon-harness/scripts/lib/models-env.js --provider ollama --format vscode` imprime esas entradas (las de un nivel en `inherit` no van: quedan con `ANTHROPIC_MODEL`).

## Codex

Codex tiene un modo para modelos abiertos:

```bash
codex --oss --local-provider ollama -m gpt-oss:120b-cloud
```

- **El proveedor es `ollama`.** Sin `-m`, `--oss` usa `gpt-oss:20b`.
- **Contexto de al menos 64K tokens.** Las instrucciones del arnés (reglas, skills, revisores) son largas. Con el
  contexto por defecto, Ollama recorta lo que Codex le manda y el modelo trabaja casi a ciegas. Los modelos de la nube
  ya traen contexto largo; si usás uno local, subilo en Ollama.
- **Los controles hay que aprobarlos con `/hooks`.** En una sesión interactiva de Codex, escribí `/hooks` y aprobá los
  controles del arnés. Sin aprobar, `codex exec` no los corre y no avisa.
- **Instalá el arnés para Codex** desde la versión publicada: `harness.js install --version latest --tool codex`.

### Los revisores en Codex: el modelo de la máquina

Cada perfil de revisor de Codex fija un modelo de OpenAI. En Ollama ese modelo no existe, y el revisor falla con
`unknown input item type: additional_tools`. La salida es decirle al arnés que los revisores usen **el modelo de tu
máquina**, el de tu `config.toml`.

Eso se declara en el perfil del equipo (`team-repos.json`), dentro de `models`:

```json
{ "models": { "codex_reviewers": "inherit" } }
```

Para una sola máquina hay otra salida: con `models.provider` en `ollama`, los revisores de Codex toman la **tabla de
Ollama**, y un nivel en `inherit` (o sin cargar) se despliega sin `model =`. Es lo mismo que `codex_reviewers: inherit`
hace para toda la organización, pero sólo en esa máquina; si la organización tiene `codex_reviewers: inherit`, gana eso.


Se elige desde el sitio de la organización, en la tabla de modelos, fila **«Los revisores en Codex»**
(`guides/organization-site.md`). Existe **desde la versión 2026.10.22.22** del arnés. Sin ese valor, nada cambia para
quien usa los modelos de OpenAI; con él, el despliegue saca la línea `model =` de los perfiles de los revisores.

## Advertencias

- **Un modelo puede intentar escribir el escape de un freno.** En el laboratorio, `gpt-oss` escribió
  `TYCON_SAFETY_OFF=1` delante de un commit con `--no-verify`, aunque la orden decía que no buscara otra salida. Eso ya
  no alcanza: el escape del freno de seguridad, y los de la revisión de producción (`TYCON_PROD_LINT`) y de nombres
  (`TYCON_NEW_NAMES`), valen sólo si la persona escribió en el chat **«autorizo <variable>»** en los últimos 30 minutos
  ([guía del freno](../safety-guard.md)). El freno de pruebas sigue con su escape liviano: `beam` lo usó por su cuenta,
  y sólo cuida la carga de la máquina. Codex no deja leer su conversación: ahí el escape por comando no vale.
- **Mirá el estado, no el relato.** `gpt-oss` cargó la skill del pipeline y contó en cinco vueltas los pasos 1 a 7
  «completados» sin correr un guion ni escribir un archivo. Los controles no lo frenaron porque no había nada que
  frenar. Lo que lo delata es el estado: la story seguía en `ready-for-dev` y no había archivos nuevos. Revisá
  `git status` y la story antes de creerle.
- **Con Codex sobre Ollama los subagentes fallan** (`unsupported call`). Codex agrupa sus herramientas en espacios de
  nombres y la API de Ollama los pierde, así que el pipeline no puede lanzar revisores. No depende de ninguna opción
  del arnés. Está reportado en [openai/codex#42488](https://github.com/openai/codex/issues/42488) y
  [ollama/ollama#18284](https://github.com/ollama/ollama/issues/18284). **Con Claude Code los revisores sí corren
  como agentes aparte.** Si necesitás los revisores, usá Claude Code.
- **`beam:cloud` no usa herramientas por la API de Anthropic de Ollama.** En cada orden dice que va a correr un comando
  y termina el turno sin la llamada. Con Codex sí las usa. Para Claude Code, elegí `gemma4:31b-cloud` o
  `gpt-oss:120b-cloud`.
- **Los controles de cierre aguantan.** `gemma4` no pudo pasar la matriz de verificación en vivo, que pide la decisión
  de una persona, ni probando el escape.
- **Los modelos de pago dan 402** (`not in the Free plan`). Si querés `glm-5.3`, `kimi-k2.7-code` o `deepseek-v4-pro`,
  hace falta el plan Pro de Ollama.

## Cuando algo falla

| Síntoma | Causa | Qué hacer |
|---|---|---|
| `unrecognized_model` en cada orden | Claude Code no conoce el nombre del modelo | nada: no cambia el resultado |
| 402, «not in the Free plan» | el modelo pide el plan Pro | usar uno de los tres gratis |
| Claude Code contesta pero no corre comandos | el modelo no usa herramientas (`beam`, un 7B) | cambiar de modelo |
| `unknown input item type: additional_tools` en un revisor de Codex | el perfil del revisor fija un modelo de OpenAI | poner `"codex_reviewers": "inherit"` en `models` |
| `unsupported call` al lanzar revisores en Codex | límite de Codex con Ollama | usar Claude Code para esa parte |
| `codex exec` no corre los controles | no están aprobados | aprobar con `/hooks` |
| `stream disconnected` en una tarea larga | se cortó la conexión con la nube | repetir; las tareas largas se cortan más |
| Claude Code sigue usando Anthropic | las variables no llegaron a esa ventana | abrir con `claude-ollama` o con el perfil de VS Code |

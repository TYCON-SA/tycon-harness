# instinct-mining — lo que el equipo repite, convertido en reglas

**Para qué**: el arnés aprende del trabajo de todo el equipo, sin depender de que el agente se acuerde de guardar algo
en la memoria. Lo que varias máquinas repiten se propone como regla, una persona la aprueba en el sitio de la
organización y todas las máquinas la reciben.

Inspirado en [ECC continuous-learning-v2](https://github.com/affaan-m/ECC/blob/main/skills/continuous-learning-v2/SKILL.md),
adaptado al arnés.

---

## El recorrido, en cinco pasos

```
1. GRABA       cada máquina, en cada herramienta, una línea saneada         integrations/instincts/scripts/instinct-observe.js
                     │  (local: tycon-observations/<AAAA-MM>.jsonl)
                     ▼
2. SUBE        un día cerrado por vez, sólo lo de la organización            scripts/instincts/instinct-upload.js
                     │  (al buzón de la organización, con la subida del arranque)
                     ▼
3. PROPONE     la noche de la organización cuenta lo que se repite           scripts/instincts/instinct-nightly.js
                     │  y el modelo de la noche redacta cada propuesta       scripts/instincts/instinct-model.js
                     │  (inbox/instincts/propuestas/ del repo de operaciones)  pipelines/operations/instinct-proposals.yml
                     ▼
4. DECIDE      quien mantiene aprueba o rechaza en la pestaña Aprendizajes   scripts/site/tabs/learnings.js
                     │
                     ▼
5. RECIBE      la regla aprobada llega a cada máquina con la actualización   packs/<paquete>/claude-md-blocks/team-learnings.md
```

Ninguna máquina llama a un modelo para proponer: las propuestas las arma una sola vez la noche de la organización, con
lo que suben todas.

---

## 1. Graba: la prende el perfil del equipo

La grabadora es `integrations/instincts/scripts/instinct-observe.js`, una integración de prender y apagar. La registra
el instalador del arnés en Mac, Linux y Windows, en Claude Code y en Codex; no hace falta Python. Graba sólo con la
integración `instincts` prendida:

- **Para el equipo, la prende el perfil** (`integrations.instincts: true` en `team-profile.json`) y llega a cada
  máquina con la actualización.
- **En una máquina**, `TYCON_INSTINCTS=0` (o `~/.claude/tycon.json`) la apaga, y `TYCON_INSTINCTS=1` la prende para
  probar.
- **Las variables viejas no deciden nada.** `TYCON_INSTINCT_MINING` y `TYCON_INSTINCT_OBSERVER` ya no prenden ni lanzan
  nada.

Corre de fondo: no demora la herramienta. Graba una línea por herramienta en `tycon-observations/<AAAA-MM>.jsonl`, en
la carpeta de los registros sueltos de la máquina (`TYCON_INSTINCT_OBS_DIR` la cambia). Cada línea lleva `ts`,
`session_id` (8 caracteres), `tool`, `project`, `summary` (lo que recibió la herramienta, saneado) y `status`. Además
lleva `repo` (la carpeta del repo relativa a la raíz de repos, o al home si está afuera) y `origin` (el host y la
organización del remoto `origin`, sin el nombre del repo ni credenciales). Las cuatro formas de Azure dan
`dev.azure.com/<org>`, y GitHub da `github.com/<dueño>`. Fuera de un repo, los dos van `null`.

Con la integración prendida, la primera sesión de cada máquina avisa una vez qué se graba, adónde sube y cómo bajarse.
Deja un sello (`instincts-notice.json`, en la carpeta de estado del arnés). Si una máquina todavía tiene
`TYCON_INSTINCT_MINING=1` o `TYCON_INSTINCT_OBSERVER=1` con la integración apagada, el aviso dice una vez que esas
variables ya no prenden nada.

Si la grabadora falla (evento ilegible, carpeta sin permiso, disco lleno), sale 0 sin escribir en pantalla. Anota el
motivo en `instinct-observe.errors.log`, al lado de lo grabado (tope 100 KB).

### El saneado

Lo grabado no sale de la máquina sin pasar por acá, y el saneado corre igual aunque no suba nunca:

| Patrón | Qué queda |
|---|---|
| `/Users/<user>/...` (la carpeta de la persona, absoluta) | `$HOME/...` |
| `api_key=XXXX`, `token=XXXX`, `password=XXXX`, `bearer=XXXX` y sus variantes | `<clave>=[REDACTED]` |
| `sk-XXXXXXXXXX` (16 caracteres o más) | `[REDACTED-SK]` |
| `ghp_XXXXXXXXXX` (16 caracteres o más) | `[REDACTED-GHP]` |
| Más de 500 caracteres | cortado con `...` |
| `sig=XXXX` (la firma de un enlace de Azure) | tapada |
| Credenciales en una URL (`https://usuario:clave@`), `-u usuario:clave`, `Authorization: …` | tapadas |
| Lo que recibe la herramienta nombra `/clients/` | la línea no se graba |
| Herramienta fuera de la lista (las MCP incluidas) | `summary` es `null`: viaja sólo su nombre |

En Windows, el comando de la herramienta `PowerShell` se graba y se sanea igual que el de `Bash`. Para mirar lo grabado
antes de prender la integración para todo el equipo, prendela en una máquina (`TYCON_INSTINCTS=1`), trabajá un rato y
leé el archivo del mes: no tiene que haber secretos ni rutas absolutas.

## 2. Sube al buzón de la organización

Con el buzón de la organización configurado, la subida de cada arranque (`scripts/metrics/upload-runs.js`) manda también
un archivo comprimido por día cerrado (en hora universal), desde el día del aviso. Lo arma `scripts/instincts/instinct-upload.js`:

- **Sólo lo de la organización.** Sube la línea cuyo `origin` es la organización del perfil (`ado.org`). Una línea de
  GitHub, de otra organización, sin repo o que nombra `/clients/` no sale. Se cuenta por motivo en la cobertura del día.
- **Seis campos.** `ts`, `session_id`, `tool`, `repo`, `summary` y `status`: ni el proyecto ni el remoto.
- **Ni lo de antes del aviso ni el día en curso.** El día del aviso sube sólo lo grabado después de la hora del aviso.
- **Sin pisar.** Cada día va a `<carpeta>/instincts/v<versión>/<día>.jsonl.gz`. Un día ya subido no se manda otra vez.
  Si llegó una línea tarde, sube el día entero con otra versión. Un corte a mitad no deja el día como subido.
- **Con tope.** Un día que pasa de 5 MB comprimido sube hasta el tope, y la cobertura lo dice (`truncado`).
- **«No pude» no es «nada».** Sin `ado.org` en el perfil, o con lo grabado ilegible, la cobertura dice `no_medido`
  con el motivo.

Una máquina con la integración prendida y sin buzón (sin la llave, o con `mailbox` apagada) graba igual, pero no sube
nada. Lo dice una vez al arrancar, y otra vez sólo si eso cambia.

La bajada (`scripts/metrics/download-runs.js`) trae los días sólo con `--instincts`, la versión más nueva de cada uno. El
nocturno del tablero y el sitio no los bajan: los cuentan en `omitidos`.

## 3. Propone: la noche de la organización

Las propuestas del equipo las arma cada noche, a las 02:00 UTC, el pipeline de la organización
`pipelines/operations/instinct-proposals.yml`, que corre `scripts/instincts/instinct-nightly.js`. Cómo se instala ese
pipeline, con su conexión al buzón y la llave del modelo, está en `pipelines/operations/README.md`.

- **Baja los días de instintos del buzón** (`download-runs.js` con `--instincts`) y decide por su estado: sin poder leer
  el buzón, o sin ningún día, el informe sale «no medido» y no se propone nada.
- **Cuenta sin modelo lo que se repite en el equipo** en los últimos 60 días: el mismo repo, la misma herramienta y los
  mismos 60 caracteres del resumen, 3 veces o más en 2 máquinas o más, o 10 veces o más en una. Las máquinas se cuentan
  (una carpeta vieja unida cuenta como su nueva), nunca se nombran.
- **Deja afuera el ruido**, antes de elegir qué redactar, con cuatro reglas: un conteo sin lección (una herramienta que
  no graba contenido), una carpeta de trabajo, temporal o del estado del arnés, una ruta de una sola máquina, y una regla
  de un solo proyecto que ese proyecto no pidió. Lo filtrado se cuenta en el informe y no ocupa lugar en el tope.
- **El modelo de la noche escribe cada propuesta**: el que la organización elige en el sitio (`models.nightly`), con la
  llave como variable secreta del pipeline. La llamada vive en `scripts/instincts/instinct-model.js`: Ollama por su API
  o Anthropic por la CLI `claude`, y la llave no sale nunca en lo que se escribe. Como mucho 20 por noche, primero las
  pendientes sin redacción y después las nuevas. Lo que el modelo escribe pasa por una revisión contra lo ya decidido y
  el catálogo del arnés, y por el saneado de la grabadora.
- **Una propuesta nueva nace redactada** o descartada con su motivo, en `inbox/instincts/propuestas/<huella>.json` del
  repo de operaciones. Lo que no llegó (por el tope, sin modelo, sin llave o con el modelo caído) espera sin archivo a otra
  noche, y el informe lo cuenta por causa. Lo decidido no se vuelve a proponer ni se toca. Lo que ya estaba pendiente
  tampoco se descarta solo: lo decide una persona.
- **Recomienda aprobar o rechazar cada pendiente**, con su porqué, en `.dashboard/instincts/recomendaciones.json`. Lo que
  cae en una regla se recomienda rechazar sin llamar al modelo; el resto lo recomienda el modelo, hasta 30 por noche, en
  una llamada aparte de la que redacta. Recomendar no cambia ningún archivo de propuesta, así no choca con un pull request
  de decisiones abierto.
- **Un proyecto pide sus propias reglas** con su nombre en `proyectos-con-reglas.json`, en la carpeta `inbox/instincts/`
  del repo de operaciones (`{ "proyectos": ["<nombre de la carpeta del repo>"] }`), por pull request. Lo que la noche le había
  descartado por esa regla vuelve a quedar pendiente.
- **El informe de la noche** queda en `.dashboard/instincts/` del repo de operaciones, con los tokens que informó el
  proveedor del modelo.
- **El resumen de la mañana** suma la línea «aprendizajes: …» con las propuestas nuevas y las que esperan decisión, y
  avisa si algo quedó sin redactar por falta de modelo, de llave o por una falla.

## 4. Decide: la pestaña Aprendizajes del sitio

Las propuestas del equipo se deciden en la pestaña **Aprendizajes** del sitio de la organización, sólo para quien
mantiene (`guides/organization-site.md`, «Aprendizajes»: qué muestra y las dos identidades de escritura que necesita).
Aprobar confirma el texto de la regla, en una línea. Rechazar pide un motivo. Las dos decisiones quedan en el archivo de
la propuesta, por pedido al repo de operaciones, y la noche no las vuelve a proponer.

**El repo de operaciones tiene que ser de lectura sólo para quienes mantienen.** Ahí viven las propuestas: lo que se
repite en el trabajo de cada máquina, saneado pero no pensado para todo el equipo. En Azure DevOps, el grupo de los
devs (`Readers`) con la lectura negada en ese repo; en GitHub, un repo privado con acceso sólo para quienes mantienen.

## 5. Recibe: la regla llega a cada máquina

Al aprobar, un pedido al repo del perfil agrega la regla al bloque `packs/<paquete>/claude-md-blocks/team-learnings.md`
de un paquete que la organización ya tiene. Cada máquina del equipo la recibe en su `CLAUDE.md` (y en el `AGENTS.md` de
Codex) con la próxima actualización, sin pasos a mano.

---

## Qué hace falta para prenderlo

| Pieza | Quién | Dónde se explica |
|---|---|---|
| `integrations.instincts: true` en el perfil del equipo | quien mantiene, por pedido al repo del perfil | este archivo, paso 1 |
| El buzón de la organización, con su llave | quien mantiene | `guides/organization-site.md`, el buzón de ejecuciones |
| El pipeline de la noche, con su conexión al buzón y la llave del modelo como variable secreta | quien mantiene | `pipelines/operations/README.md` |
| El modelo de la noche elegido (`models.nightly`) | quien mantiene, en el sitio | `guides/organization-site.md` |
| El sitio con las dos identidades de escritura (perfil y operaciones) | quien mantiene | `guides/organization-site.md`, «Aprendizajes» |

Para ver si una máquina tiene la integración prendida y de dónde sale el valor:
`node scripts/lib/tycon-config.js explain`.

## Costo

| Pieza | Costo |
|---|---|
| La grabadora | nada: no usa modelo y escribe en el disco local |
| La subida | un archivo comprimido por día cerrado, con la subida del arranque que ya existe |
| La noche | las llamadas al modelo de la noche de la organización: hasta 20 redacciones y 30 recomendaciones por noche; el informe anota los tokens |

## Variables de entorno

| Variable | Valor por defecto | Qué hace |
|---|---|---|
| `TYCON_INSTINCTS` | lo que diga el perfil | `=0` apaga la grabadora en esta máquina; `=1` la prende para probar |
| `TYCON_INSTINCT_OBS_DIR` | `tycon-observations/` en la carpeta de los registros sueltos | dónde graba la grabadora |
| `TYCON_INSTINCT_MINING`, `TYCON_INSTINCT_OBSERVER` | — | ya no hacen nada: el aviso de arranque lo dice una vez |

---

## Las propuestas de antes y `/tycon-instincts`

Hasta la noche de la organización, cada máquina corría un observador propio que dejaba propuestas en un buzón local.
`/tycon-instincts` sigue para esas propuestas de antes (las de `pending/` y `promoted/`): `review`, `show`, `approve`,
`reject` y `status`. Ya no tiene `run`, y el disparador del arranque (`scripts/hooks/instinct-trigger.sh`) ya no lanza el
observador: sólo conserva la reparación de la línea de arranque. `scripts/instincts/instinct-observer.js` queda como
biblioteca de la noche.

Dónde viven esas propuestas lo decide una sola pieza, `scripts/instincts/instinct-dirs.js`:

| | Dónde se escribe | Cómo se reconoce |
|---|---|---|
| **Clon de quien mantiene el arnés** | `inbox/instincts/` _(del repo del equipo; no está en esta copia)_ del árbol | El árbol **trae su buzón**: existe `inbox/instincts/README.md` _(del repo del equipo; no está en esta copia)_ (lo versiona el repo; ningún guion lo crea) |
| **Arnés instalado en la máquina de quien mantiene** (el árbol no trae buzón y la configuración declara el clon del repo privado de mantenimiento, `paths.maintainers`) | El buzón de ese clon: `<clon privado>/inbox/instincts/` | Ese clon trae su buzón (el mismo `README.md`) |
| **Arnés instalado** (sin clon privado con buzón) | La casa de la persona: `<estado>/inbox/instincts/` | No existe ese archivo. `<estado>` es la carpeta de estado del arnés en esa máquina |

- **Se lee en todos los lugares**, y lo ya decidido en cualquiera de ellos no se vuelve a proponer. Nadie crea una
  carpeta por leer.
- **Lo descartado** por la revisión quedó en `inbox/instincts/descartados/` (local, fuera de git).
- **Para ver dónde está cada cosa**: `/tycon-instincts status`, o `node scripts/instincts/instinct-dirs.js`. Una carpeta
  que existe y no se deja leer nunca se muestra vacía: `status` pone «?», y un lugar entero sin mirar sale en un renglón
  que empieza con «!».

## El instalador viejo

`scripts/setup/install-instinct-mining.sh` ya no hace falta: la grabadora la registra el instalador del arnés. Sin
opciones sale 0 diciéndolo y no registra nada. `--uninstall` sigue sacando los ganchos que registraba antes, en Mac y
Linux (en Windows nunca corrió).

## Referencias

- La grabadora y su aviso: `integrations/instincts/scripts/instinct-observe.js` y `instincts-notice.js`; el manifiesto,
  `integrations/instincts/integration.json`.
- La subida: `scripts/instincts/instinct-upload.js`. La noche: `scripts/instincts/instinct-nightly.js` y
  `instinct-model.js`, con su pipeline `pipelines/operations/instinct-proposals.yml`.
- La pestaña: `scripts/site/tabs/learnings.js` (`guides/organization-site.md`, «Aprendizajes»).
- Lo de antes: `scripts/instincts/instinct-{observer,promote,draft,dirs}.js` y `commands/tycon-instincts.md`.

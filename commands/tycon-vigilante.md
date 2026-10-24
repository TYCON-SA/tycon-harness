---
description: Revisar, aprobar o descartar los hallazgos del vigilante de producción
---

# /tycon-vigilante — la decisión humana sobre lo que encontró el vigilante

El vigilante nocturno (`scripts/nightly/watcher/vigilante.js`) lee producción, agrupa lo que huele mal y
deja un borrador por hallazgo en `inbox/watcher/pending/`. **No toca nada y no crea nada**: convertir un
borrador en trabajo real es decisión de una persona, y eso pasa acá.

Cada borrador es también una ficha del ciclo común de lo que encuentra la noche (`fuente: vigilante`, y su `causa` es la
huella del hallazgo). Sus palabras se leen así en el ciclo: `util` es «arreglo», `descartado` es «aceptada» e `ignorado`
es «ignorada». El diagnóstico y la evidencia se quedan en el borrador, para decidir acá, y nunca van al modelo de la
noche.

El vigilante viene **apagado de fábrica**: qué servidores mira, con qué credenciales y dónde deja la cola es de
cada organización, y vive en su repo de operaciones (lo prende su pipeline nocturno con `--config`). Sin ese repo
no hay cola que revisar.

Argumento recibido: `$ARGUMENTS` — uno de `review` · `show <id>` · `approve <id>` ·
`reject <id> --reason "…"` · `report`. Sin argumento: `review`.

## Antes de cualquier subcomando: ¿está la cola?

Parado en la raíz del repo de operaciones de la organización (donde la noche deja la cola):

```bash
COLA=inbox/watcher      # la cola de borradores
VIEJA=vigilante         # donde vivía antes de mudarse (un checkout atrasado todavía la tiene ahí)
if [ -d "$COLA/pending" ]; then
  echo "cola: $COLA"
elif [ -d "$VIEJA/pending" ]; then
  echo "CHECKOUT ATRASADO: no está $COLA/pending pero sí $VIEJA/pending" >&2; exit 2
else
  echo "NO ESTÁ LA COLA: no existe $COLA/pending en $(pwd)" >&2; exit 2
fi
```

Son tres resultados y **ninguno de los dos errores es «no hay nada que revisar»**:

- `cola: inbox/watcher` → seguí con el subcomando.
- `CHECKOUT ATRASADO` → este checkout es anterior a la mudanza de la cola. Decíselo al dev tal cual y
  **pará**: hay que actualizarlo (`git pull`) antes de revisar. No cuentes ni muevas nada en la carpeta vieja.
- `NO ESTÁ LA COLA` → no estás parado en la raíz del repo de operaciones, o la carpeta no existe (si la
  organización no prendió el vigilante, no existe). Decilo con
  la ruta que imprimió y **pará**. No digas «no hay hallazgos»: no lo sabés.

## review (default)

```bash
find inbox/watcher/pending -maxdepth 1 -type f -name '*.yaml' | wc -l
```

Sin `2>/dev/null`: si `find` falla, su error se tiene que ver — un conteo que tapa el error convierte
«no pude mirar» en «no hay ninguno».

Si no hay ninguno, decilo en una línea y terminá — no hay nada que revisar y eso es una buena noche.

Si hay, leé cada YAML y presentá **una tabla corta**: id, producto, qué endpoint, la señal en
castellano (`11 × 500, la mediana previa era 0`), la regla que lo levantó y hace cuántas noches
viene. Ordená por severidad. Cerrá con una línea: *"para ver uno entero: `/tycon-vigilante show <id>`"*.

**No opines sobre si hay que arreglarlo.** Presentás lo que hay; decide la persona.

## show &lt;id&gt;

Mostrá el borrador completo (`inbox/watcher/pending/<id>.yaml` o el que esté en `promoted/`/`archived/`),
traduciendo la señal y la evidencia a castellano llano. Si trae `ultimo_deploy`, resaltá la
coincidencia temporal. Si trae `ya_alertado_por_azure: true`, aclarálo: *"de esto Azure ya mandó un
mail; este borrador es el diagnóstico que lo acompaña"*.

## approve &lt;id&gt;

> **Mirá primero si hay un PR abierto de ese hallazgo** (`az repos pr list --source-branch
> vigilante/<id>`). El nocturno abre un PR por hallazgo y **ahí es donde se decide**: mergearlo
> ya mueve el borrador a `promoted/`. Si el PR está mergeado, saltá al paso 2 —
> mover el archivo de nuevo a mano genera un conflicto con lo que ya hizo el merge.

1. Mové el archivo a `inbox/watcher/promoted/` y poné `veredicto: util`.
2. **Creá la story por la vía normal**: invocá el skill de creación de stories del repo del producto
   (`tycon-create-story`) pasándole el borrador como contexto — endpoint, evidencia, diagnóstico.
   Esto no es opcional ni un rodeo: escribir el `.md` a mano lo bloquea `story-skill-gate`, y con
   razón. Al pasar por el skill, la story nace con su formato, su validación y su work item en ADO
   (que además pide confirmación aparte).
3. Anotá en el YAML promovido la story creada con la clave **`story_creada: "<id o ruta>"`** (por
   ejemplo `story_creada: "<Producto>/<repo>/specs/<story>.md"`). La clave es
   ésa y no `story:` a propósito: `story:` es la marca de una story y dispara `story-skill-gate`, el
   freno de crear stories a mano — por eso ningún borrador la lleva. Y es una clave FIJA porque la lee
   el resumen diario (`scripts/nightly/dependencies/daily-summary.js`): una ficha aceptada **sin**
   `story_creada:` sale todas las mañanas en «aceptadas sin story», con su edad, hasta que la tenga.
4. Confirmá en una línea qué story quedó creada y dónde.

## reject &lt;id&gt; --reason "…"

Mové a `inbox/watcher/archived/` con `veredicto: descartado` y el motivo **textual** que dio la persona.

Si hay un PR abierto para ese hallazgo, **rechazalo con el motivo como comentario** en vez de
cerrar sólo el archivo: el PR es lo que el resto del equipo ve.

**El motivo es obligatorio y no se inventa.** Si no vino en el comando, pedilo. Ese texto es el
dato que calibra la pieza: sin él, "no servía" es indistinguible de "nadie lo miró", y la diferencia
entre esas dos cosas es justamente lo que decide si el vigilante sigue existiendo.

## report

```bash
node scripts/nightly/watcher/vigilante.js report
```

Relayá el resumen en castellano: cuántos hallazgos terminaron en trabajo real, el desglose por regla,
y el veredicto sobre el umbral. Si dice que está ruidosa, **no ajustes nada**: contale al dev qué
regla es la culpable y qué cambio propone el reporte. La calibración la confirma una persona con un
commit — una pieza que se ajusta sola para dejar de molestar termina siempre en silencio.

## Después de cualquier cambio

Los borradores viven en git: recordá que hay que commitear el movimiento (`inbox/watcher/`) para que el
resto del equipo vea la decisión. No lo hagas sin autorización — regla #0 del arnés.

# Arranque: aviso de trabajo

**Objetivo**: avisarle a la herramienta de horas que eligió la organización que el trabajo en esta story arranca. El
pipeline no sabe cuál es: emite el evento neutro de trabajo (`scripts/lib/work-signal.js` del arnés) y la integración
elegida (`integrations/<nombre>/`) lo atiende. Sin herramienta elegida, el paso se saltea. Nunca frena el pipeline.

Este step corre **después** del Step 0 (preflight pasó). Razón: si preflight aborta (ej: estamos en main), no hay
trabajo que avisar.

## 🔀 Fan-out del arranque (2026-07-30) — 0b y 0c corren MIENTRAS el validator del Step 1 ya está en vuelo

El validator del Step 1 tarda 1-7 min y **no depende de nada que 0b/0c produzcan** (verificado:
no lee `workSignalStarted` ni `adoMarkedActive`; su input es solo la story, cuyo frontmatter el Step 0
ya mutó a `in-progress` — estado que el validator tolera explícitamente). Orden cableado:

1. **Correr el evento PRIMERO** (paso 1 de abajo): la acción que devuelve la integración es el ÚNICO punto de 0b que
   puede necesitar una pregunta al dev (por ejemplo, a qué proyecto cargar las horas). Si hay que preguntar, se
   pregunta ACÁ, antes del fan-out.
2. **Abrir `steps/step-01-validate-story.md` y lanzar sus `Agent(...)` de los puntos 1 y 2 TAL
   CUAL están escritos** — incluidos los `lanzamientos` que devuelve `pipeline.js validators`
   (los revisores de validación de los paquetes, con su `prompt` y su `modelo` ya resueltos). Es la ÚNICA
   excepción al "Leé SOLO este step" de `pipeline.js next`: acá se lee step-01 para lanzar, y se
   vuelve a step-01 después para el join. Si el prompt no se puede reproducir textualmente, NO
   improvisarlo: caer al orden secuencial (el fan-out es optimización, no requisito).
3. **Completar 0b** (la acción de la integración, si trajo una) **y 0c inline** mientras el validator corre.
4. El join es la notificación del validator: recién ahí se procesa su reporte (decisiones C.i).
   🔴 **Nunca presentar una pregunta de 0b/0c y el resultado del validator en el mismo mensaje sin
   rotular cuál es cuál** — si 0c necesita confirmación (fallback por título / WI cerrado),
   resolverla ANTES de procesar el reporte del validator.

Si el fan-out se complica (ej: la acción necesita una respuesta del dev que no llega), el orden
secuencial viejo (0b → 0c → 1) sigue siendo válido — el fan-out es optimización, no requisito.

## Cuándo saltear

- **Sin herramienta de horas elegida** (`integrations.timeTracking` ausente o `none`; con `TYCON_TIME_TRACKING=none` en
  una máquina), **o con una desconocida o con el manifiesto roto**: `pipeline.js next` ya da el 0b por salteado
  (`skip_mechanical`, con el motivo) y manda al paso siguiente. No se marca la bandera: diría «aviso dado» sin aviso.

## Acciones

### 1. Emitir el evento

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js work-signal start
```

Toma del marker la historia, su `title:`, el repo y la sesión. Devuelve `{ ran, action?, warnings }`; cada aviso de la
integración sale también por la salida de errores, en una línea (falta configurar algo, la herramienta no contestó).

### 2. Hacer la acción, si vino una

Una herramienta que maneja el agente (con su servidor de MCP) devuelve en `action` lo que hay que hacer, con las
referencias a la skill de su integración. Hacerla **SIN pedir confirmación al dev** — el pipeline es intent explícito —,
salvo lo que la propia acción diga que se pregunta. Una herramienta que la integración maneja sola (por su API) no
devuelve acción: ya quedó hecho.

### 3. Registrar la bandera en el marker

Para que un resume cross-session / `pipeline.js next` sepan que este step ya corrió y NO vuelvan a avisar:

```bash
node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js set-flag workSignalStarted true
```

(El nombre viejo de la bandera se sigue aceptando y escribe la nueva.)

### 4. Confirmación silenciosa

Loguear a stdout una línea corta: `✓ Aviso de trabajo: <integración> · <lo que hizo>`. No pausar, seguir directo al
Step 1.

## Errores tolerables

Si cualquier parte falla (el evento avisa un problema, la acción no se puede hacer):
- Loguear `⚠ Aviso de trabajo: step-00b falló — <razón>. Pipeline continúa sin registrar horas.`
- NO interrumpir el pipeline. Registrar horas no es camino crítico.

## Lo que NO hace este step

- ❌ NO cierra el registro al final del pipeline: lo cierra el paso 9 (`work-signal stop`), la propia integración por
  inactividad, o el dev. La lista está en `step-08-commit-prep.md` §"NO cerrar el registro de horas".
- ❌ NO nombra ninguna herramienta: lo propio de cada una vive en su integración.
- ❌ NO avisa si el preflight (Step 0) falló.

## Output

Archivo `step-00b-work-start.md` en `.advisors/pipeline-runs/<clave>-<sello>/`:

```markdown
# Arranque: aviso de trabajo

- integración: <nombre> | ninguna
- acción: <lo que hizo el agente, o «ninguna»>
- avisos: <los de la integración, o «ninguno»>
- status: ok | skipped (<razón>) | failed (<razón>)
```

# Mantener el arnés — qué guía leer

Lo que necesita quien mantiene el arnés o corre los procesos de la noche de una organización. No se carga en cada
sesión: se lee a demanda, desde la fila «Mantener el arnés» del índice (`INDEX.md`). Las guías de uso diario (stories,
git, pruebas, frenos) siguen en el índice.

| Trabajando en... | Leer (a demanda) |
|---|---|
| Escribir o editar guías, skills, steps o material del sitio — cómo nombrar Claude/Codex/el agente | `guides/maintaining/criterio-tres-claude.md` |
| Saber cuánto contexto carga cada sesión y cada revisor, y de qué está hecho | `node scripts/tools/context-budget.js [--measured]` — `--measured` da el piso REAL de los lanzamientos, no el estimado |
| Upgrade de BMAD, debug de incompatibilidad con advisors | `guides/maintaining/bmad-contract.md` |
| Cambiar una regla que tiene que estar SIEMPRE cargada en el `CLAUDE.md` de todos (estilo de respuesta, comunicación), o agregar un bloque nuevo | `claude-md-blocks/` — editar el `.md` y commitear; se propaga solo en el próximo `SessionStart` |
| Entender por qué el bloque de Azure DevOps dice lo que dice —antes de podarlo, relajarlo o discutirlo— · el detalle de los seis casos con sus comandos | `guides/integrations/ado-cola-y-listados.md` |
| Tocar la regla de estilo de respuesta, el medidor `response-style-meter.js`, o el formato de reporte de un agente · entender por qué el bloque dice lo que dice antes de podarlo | `guides/response-style.md` |
| Te apareció un aviso de versión de engram, o validaste una versión nueva y querés que el equipo la adopte | `engram-version` (el pin, con el procedimiento de bump en su cabecera) |
| Armar o publicar la copia pública · el exportador o `mirror.js` frenó · un `git push` o un `gh` frenado · `verify` da 1 · qué entra y qué no · los reemplazos · sumar una skill ajena · máquina limpia | `guides/maintaining/publicacion-espejo.md` (§«La publicación»; terceros: `third-party-skills.json`) + cabeceras de `scripts/publishing/{export,mirror}.js` — a mano: `export.js --explain` |
| Sacar una versión nueva del paquete de npm (`@tyconsa/harness`) · aprobarla · la publicación falló · retirar una versión · rotar el publicador de confianza | `guides/maintaining/paquete-npm.md` |
| Un commit no se crea por un nombre real en un archivo que se publica · cómo salir · el termómetro de nombres en rojo · subir o bajar el techo | `guides/maintaining/publicacion-espejo.md` §«El núcleo sin nombres» + `scripts/publishing/new-names.js` (cabecera) |
| Antes de crear una skill/agent/guide/hook nuevo (chequear si ya existe equivalente — evita tejido cicatrizal) | `guides/maintaining/skill-scout.md` |
| Medir cuánto del context window consume el harness en cada sesión + qué recortar | `guides/maintaining/context-budget.md` |
| Auditar drift entre catálogo de reglas y advisors (mensual, o tras cambios estructurales) | `guides/maintaining/rules-distill.md` |
| Health-check completo del harness (score 0-10 sobre 7 categorías, monthly o pre-demo) | `guides/maintaining/harness-audit.md` |
| Antes de portar/tocar una pieza concreta (un hook, un advisor, un paso del pipeline, un MCP): qué cambia entre Claude Code y Codex y qué caso de prueba la cubre | `guides/maintaining/codex-divergence-inventory.md` |
| Tocar un hook del arnés (verificar que sigue verde antes del commit) · agregar un hook/advisor nuevo (entra CON sus casos) · el aviso "controls-bench EN ROJO" apareció al arranque | `guides/maintaining/controls-bench.md` |
| Saber cuánto consumió una corrida del pipeline, o leer el hilo de una que ya pasó · una corrida dice «no medido» o «borrada» · por qué el hilo no viaja por git | `scripts/metrics/tokens-digest.js` (cabecera) — a mano: `--run <volcado>` \| `--pending` \| `--all` |
| Saber cuánto **costó la revisión** de una corrida (cuántos revisores, cuánto tardaron, cuánto consumieron) · por qué una corrida dice «estimado» y otra un número · renovar el supuesto del estimado | `scripts/metrics/reviewers-cost.js` (cabecera) + `scripts/metrics/reviewers-cost-assumption.json` — a mano: `--run <volcado>` \| `--all` |
| Decidir si una regla del catálogo se retira · una regla aparece como «candidata a retiro», «rota» o «sin probar» y querés saber por qué · cambiar el criterio de poda | `scripts/nightly/dashboard/prune.js` (cabecera) + `scripts/nightly/dashboard/sources.json` → `prune` — a mano: `node scripts/nightly/dashboard/prune.js` · el catálogo contado: `node scripts/lib/rules-catalog.js` · colisiones: `--collisions` |
| La pregunta 4 del tablero dice «reportaron N de M máquinas» y falta una · declarar una máquina esperada · un control o escape sale como «otro» · el reductor se niega (exit 2) | `scripts/nightly/dashboard/reducer.js` (cabecera) + `sources.json` (misma carpeta) → `reducer` — a mano: `node scripts/nightly/dashboard/reducer.js --json` · alias de esta máquina: `--alias` · lo que subió: `upload-runs.log` y `~/.claude/.tycon-pipeline/registros-buzon/cobertura.json` |
| Cerrar un incidente que un revisor dejó pasar · cambiar la prosa de un revisor · el portón frenó un cambio de revisor | Cada incidente del registro lleva su renglón **Revisor:** `<revisor> · caso: <id>` (el caso, despersonalizado, en `scripts/controls-bench/cases/advisors/<revisor>.json`) o `ninguno — <motivo>`; `node scripts/controls-bench/incident-cases.js --log <registro> --cases scripts/controls-bench/cases/advisors` frena el que no lo tiene. Antes de commitear un cambio a `agents/<revisor>.md`: `node scripts/controls-bench/reviewer-change-check.js run --agent <revisor>` (sólo sus casos, una vez por cambio) y commitear `scripts/controls-bench/reviewer-exams/<revisor>.json`; si el puntaje sube, la línea de base de ese revisor se actualiza sola. El portón de CI frena sin examen, con el examen de otra versión del archivo, o con puntaje menor que la línea de base |
| Saber qué hace la noche con las retrospectivas · el resumen de la mañana dice «faltan» o «sin mirar» en «retros:» · pasar el barrido a mano | `scripts/metrics/retro-sweep.js` (cabecera) + `retro-sweep.json` (lo que no pide retro, con su motivo). Cada noche, el nocturno de dependencias barre los merges a main de los repos de `team-repos.json` y corre **el latido** (sin modelo, un segundo) de cada uno sin archivo; los guarda en `.dashboard/retros/` del repo de operaciones. **La noche no corre la retro con modelo**: los aprendizajes salen de la revisión de la semana. El resumen cuenta «latido sin modelo» y «retro con aprendizajes» por separado. A mano: `node scripts/metrics/retro-sweep.js --repo <nombre>=<carpeta> --out <dir> --since <YYYY-MM-DD> --report <archivo.json>` |
| La revisión de la semana: qué lee, cuándo corre, por qué propuso (o no) algo · decidir una propuesta · cambiar su tope o apagarla | `scripts/nightly/weekly-review/weekly-review.js` (cabecera) + `prompt.md` (el pedido al agente). **Una vez por semana**, desde el disparador del examen de revisores en la máquina designada (martes y viernes 02:00; corre si pasaron 6 días desde la última completa), un agente lee juntos los merges a main de los siete días anteriores en los repos de `team-repos.json`: asunto, story, commits, archivos, sus `findings.json`, lo que agregaron a las stories y a los pendientes, y su retro (sin ninguna retro de la semana no corre). Los guardados de los nocturnos y las subidas de versión (lo que no pide retro en `retro-sweep.json`) no se leen ni cuentan contra el tope: el informe los cuenta por motivo. Una sola corrida, con tope: hasta 600.000 caracteres de material y **US$5** que corta la propia herramienta; lo que no entra se nombra como no leído. **Regla de patrón: 3 o más merges de 2 o más stories** distintas; lo que vuelve se valida (merges que existen entre los leídos, una de tres formas: regla de revisor, prueba o línea de guía) y lo que no cumple queda descartado en el informe. **Nunca aplica nada**: las propuestas van al final de `guides/guide-update-proposals.md` del repo de mantenimiento como «⏳ PENDIENTE» y el informe a `.dashboard/weekly-review/latest.json`; el resumen de la mañana siguiente dice cuántas hay y el patrón más repetido. Se decide en la lista: una persona la aprueba (y la pasa a una story o la aplica), o la descarta con el motivo. Tope y encendido: `team-repos.json → weekly_review { enabled, budget_usd, max_chars }`; apagado de la máquina: `TYCON_NO_WEEKLY_REVIEW=1`. A mano, sin escribir en main: `node scripts/nightly/weekly-review/weekly-review.js --out <clon de mantenimiento> --team-repos <team-repos.json> --no-push` |
| Ver las corridas del pipeline una por una (tiempo por paso, controles, agentes, vueltas, tokens) | `node scripts/nightly/dashboard/dashboard.js --view runs` (con permiso sobre el buzón de Azure, las de todas las máquinas; la ruta de la página la imprime) |
| **Agregar un estado de story al vocabulario**, o entender por qué una story aparece como «desconocida» en el tablero · por qué `cancelled` no cuenta como entregada · qué pasa si el diccionario queda ilegible | `scripts/metrics/states.json` (el diccionario, con el motivo de cada decisión adentro) + `story-format.md` §1 |
| Apareció "el examen de los revisores NO ESTÁ CORRIENDO" al arrancar · cambiar qué máquina lo corre o cada cuánto · entender por qué el aviso calla unos números que sí existen | `scripts/controls-bench/periodic-exam.js` (arranque: `--dry-run`) |
| Saber si una guía cambia lo que hace el agente · una guía sale marcada «revisar» en `scripts/controls-bench/ultimo-guias.json` · sumar un caso de guía | `scripts/controls-bench/guide-runner.js` (cabecera; casos en `scripts/controls-bench/cases/guides/`). Corre después de un examen completo, con su mismo apagado. «revisar» = con y sin la guía el agente hizo lo mismo: se mira la guía o el caso, pero la guía no se borra por eso. A mano, una corrida por lado: `node scripts/controls-bench/guide-runner.js --case <nombre>` |
| Un control trata a un clon del arnés como si fuera un producto (o al revés) · querés saber si un repo cuenta como «del arnés» y por qué | `node scripts/lib/harness-repo.js <dir>` (decide el remoto `origin`; la carpeta sólo si no hay remoto) |

## Dónde se escribe, dónde se valida y qué queda en Azure DevOps

**Se escribe en el repo público, en GitHub.** Todo lo que el arnés publica (código, guías, skills, revisores) entra por
un pedido de merge a `main`. La regla de esa rama exige un control: `public-ci`, la CI pública
(`.github/workflows/ci.yml`). El número de versión lo pone el merge: al entrar a `main`, otro workflow
(`.github/workflows/version-tag.yml`) le pone la etiqueta `v<número>`. Por eso el paso `version` de la CI sale rojo si el
pedido **toca** el número o la marca `"numbering": "merge-tag"` de `version.json`.

**Lo privado de quien mantiene va a su repo de mantenimiento.** Ahí viven lo que no se publica (el registro de
incidentes con nombres, los datos del equipo, las listas privadas del freno de publicación) y las stories. Ese repo no
guarda copia de nada que el público trae: lo que repite lo declara su `.tycon/internal-forms.json`. La validación de
sus pedidos es un pipeline de Azure DevOps: la del público, con lo público puesto encima (el YAML vive en ese mismo
repo).

**Lo que queda en Azure DevOps**, en una organización que corre ahí:

- **Los procesos de la noche**: el banco de controles y las suites, la revisión de dependencias, el vigilante, las
  métricas y el tablero, la verificación diaria de lo publicado y, a pedido, la prueba de Windows. Traen el código del arnés
  desde GitHub en cada corrida; ninguno lo guarda.
- **Dónde dejan sus datos**: el banco y las suites, en el repo de mantenimiento; la revisión de dependencias, el
  vigilante, el resumen diario, las métricas y el tablero, en el **repo de operaciones**, que también recibe sus
  pedidos. Cada máquina que mantiene el arnés declara sus dos clones (`paths.maintainers` y `paths.operations`) y los
  avisos de arranque leen de ahí (`guides/piezas-del-arnes.md`).
- **El buzón de corridas**, en el almacenamiento de Azure: cada máquina sube ahí lo que midió.
- **La capa del equipo** y los repos y pipelines de cada producto, si la organización los tiene ahí.

Una organización que vive en GitHub corre los mismos procesos de la noche como GitHub Actions: cómo se instalan lo
explica el README de la carpeta de operaciones para GitHub, dentro de la carpeta de pipelines.

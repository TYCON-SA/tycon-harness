# Mantener el arnés — qué guía leer

Lo que necesita quien mantiene el arnés o corre los procesos de la noche de una organización. No se carga en cada
sesión: se lee a demanda, desde la fila «Mantener el arnés» del índice (`INDEX.md`). Las guías de uso diario (stories,
git, pruebas, frenos) siguen en el índice.

| Trabajando en... | Leer (a demanda) |
|---|---|
| Saber cuánto contexto carga cada sesión y cada revisor, y de qué está hecho | `node scripts/tools/context-budget.js [--measured]` — `--measured` da el piso REAL de los lanzamientos, no el estimado |
| Upgrade de BMAD, debug de incompatibilidad con advisors | `guides/bmad-contract.md` |
| Antes de retirar/relajar una regla, hook o advisor — ver qué incidente lo motivó | `guides/incident-log.md` |
| Cambiar una regla que tiene que estar SIEMPRE cargada en el `CLAUDE.md` de todos (estilo de respuesta, comunicación), o agregar un bloque nuevo | `claude-md-blocks/` — editar el `.md` y commitear; se propaga solo en el próximo `SessionStart` |
| Entender por qué el bloque de Azure DevOps dice lo que dice —antes de podarlo, relajarlo o discutirlo— · el detalle de los seis casos con sus comandos | `guides/ado-cola-y-listados.md` |
| Tocar la regla de estilo de respuesta, el medidor `response-style-meter.js`, o el formato de reporte de un agente · entender por qué el bloque dice lo que dice antes de podarlo | `guides/response-style.md` |
| Te apareció un aviso de versión de engram, o validaste una versión nueva y querés que el equipo la adopte | `engram-version` (el pin, con el procedimiento de bump en su cabecera) |
| Armar o publicar la copia pública · el exportador o `mirror.js` frenó · un `git push` o un `gh` frenado · `verify` da 1 · qué entra y qué no · los reemplazos · sumar una skill ajena · máquina limpia | `guides/publicacion-espejo.md` (§«La publicación»; terceros: `third-party-skills.json`) + cabeceras de `scripts/publishing/{export,mirror}.js` — a mano: `export.js --explain` |
| Un commit no se crea por un nombre real en un archivo que se publica · cómo salir · el termómetro de nombres en rojo · subir o bajar el techo | `guides/publicacion-espejo.md` §«El núcleo sin nombres» + `scripts/publishing/new-names.js` (cabecera) |
| Antes de crear una skill/agent/guide/hook nuevo (chequear si ya existe equivalente — evita tejido cicatrizal) | `guides/skill-scout.md` |
| Medir cuánto del context window consume el harness en cada sesión + qué recortar | `guides/context-budget.md` |
| Auditar drift entre catálogo de reglas y advisors (mensual, o tras cambios estructurales) | `guides/rules-distill.md` |
| Health-check completo del harness (score 0-10 sobre 7 categorías, monthly o pre-demo) | `guides/harness-audit.md` |
| Justificar por qué NO usamos un modelo local (o revisar si conviene ahora) — medición propia + estado de la industria | `guides/decisions/local-model-decision-2026-08.md` |
| Entender por qué un run del pipeline salió caro/lento, o verificar que las optimizaciones de costo siguen cableadas | `guides/decisions/pipeline-cost-audit-2026-06-11.md` |
| Llevar el harness a Codex (u otra herramienta): arquitectura de fuente única, etapas, riesgos | `guides/codex-migration.md` |
| Antes de portar/tocar una pieza concreta (un hook, un advisor, un paso del pipeline, un MCP): qué cambia entre Claude Code y Codex y qué caso de prueba la cubre | `guides/codex-divergence-inventory.md` |
| Sospecha de que un hook del arnés está apagado sin rastro (rc del shell, sellos diarios) · agregar un kill-switch nuevo | `guides/decisions/interruptores-fuera-de-tycon-2026-08-25.md` |
| Tocar un hook del arnés (verificar que sigue verde antes del commit) · agregar un hook/advisor nuevo (entra CON sus casos) · el aviso "controls-bench EN ROJO" apareció al arranque | `guides/controls-bench.md` |
| Saber cuánto consumió una corrida del pipeline, o leer el hilo de una que ya pasó · una corrida dice «no medido» o «borrada» · por qué el hilo no viaja por git | `scripts/metrics/tokens-digest.js` (cabecera) — a mano: `--run <volcado>` \| `--pending` \| `--all` |
| Saber cuánto **costó la revisión** de una corrida (cuántos revisores, cuánto tardaron, cuánto consumieron) · por qué una corrida dice «estimado» y otra un número · renovar el supuesto del estimado | `scripts/metrics/reviewers-cost.js` (cabecera) + `scripts/metrics/reviewers-cost-assumption.json` — a mano: `--run <volcado>` \| `--all` |
| Decidir si una regla del catálogo se retira · una regla aparece como «candidata a retiro», «rota» o «sin probar» y querés saber por qué · cambiar el criterio de poda | `scripts/nightly/dashboard/prune.js` (cabecera) + `scripts/nightly/dashboard/sources.json` → `prune` — a mano: `node scripts/nightly/dashboard/prune.js` · el catálogo contado: `node scripts/lib/rules-catalog.js` · colisiones: `--collisions` |
| La pregunta 4 del tablero dice «reportaron N de M máquinas» y falta una · declarar una máquina esperada · un control o escape sale como «otro» · el reductor se niega (exit 2) | `scripts/nightly/dashboard/reducer.js` (cabecera) + `sources.json` (misma carpeta) → `reducer` — a mano: `node scripts/nightly/dashboard/reducer.js --json` · alias de esta máquina: `--alias` · lo que subió: `upload-runs.log` y `~/.claude/.tycon-pipeline/registros-buzon/cobertura.json` |
| Ver las corridas del pipeline una por una (tiempo por paso, controles, agentes, vueltas, tokens) | `node scripts/nightly/dashboard/dashboard.js --view runs` (con permiso sobre el buzón de Azure, las de todas las máquinas; la ruta de la página la imprime) |
| **Agregar un estado de story al vocabulario**, o entender por qué una story aparece como «desconocida» en el tablero · por qué `cancelled` no cuenta como entregada · qué pasa si el diccionario queda ilegible | `scripts/metrics/states.json` (el diccionario, con el motivo de cada decisión adentro) + `story-format.md` §1 |
| Apareció "el examen de los revisores NO ESTÁ CORRIENDO" al arrancar · cambiar qué máquina lo corre o cada cuánto · entender por qué el aviso calla unos números que sí existen | `scripts/controls-bench/periodic-exam.js` (arranque: `--dry-run`) |
| Un control trata a un clon del arnés como si fuera un producto (o al revés) · querés saber si un repo cuenta como «del arnés» y por qué | `node scripts/lib/harness-repo.js <dir>` (decide el remoto `origin`; la carpeta sólo si no hay remoto) |

# adapters/ — lo que cada herramienta consume (plan codex-migration.md §3)

**El canónico se escribe UNA vez** (guías, reglas con ID, skills, scripts de hooks, los 28
advisors en `agent-skills/agents/*.md`). Este directorio contiene solo lo que hay que
**traducir o fragmentar** por herramienta.

## Por qué NO hay `adapters/claude/`

Claude Code consume el canónico **tal cual** (symlink/registración directa, sin copia): los
advisors los lee de `~/.claude/agent-skills/agents/`, los hooks los registra
`install-tycon-hooks.sh` apuntando a los scripts reales de `scripts/hooks/`. Crear una copia
acá sería el drift que la migración existe para eliminar. Si algún día Claude necesita un
fragmento propio que no pueda vivir en el canónico, recién ahí nace `claude/`.

## `codex/agents/*.toml` — GENERADOS, no editar

Salida de `build/generate.js` (la única pieza de traducción del harness — principio 2).
Cada `.toml` es un config-overlay de Codex que se despliega como
`$CODEX_HOME/<name>.config.toml` y se invoca `codex exec -p <name>` (verificado
empíricamente, Codex CLI 0.149.0, con `--strict-config`).

- `MANIFEST.json` — qué advisors están migrados. Un advisor entra al manifest **con sus
  casos en el banco** (`scripts/controls-bench/cases/advisors/`) — regla dura B2.
- ¿Está al día? → `node build/check.js` (pre-commit / corrida diaria del instalador).
- Regenerar → `node build/generate.js` · desplegar → `node build/generate.js --deploy`.

## `codex/hooks.json` — fragmento de hooks del lado Codex

Los scripts de hooks son los REALES de `scripts/hooks/` (no se traducen: los 5 eventos y el
bloqueo por exit 2 funcionan igual en Codex — inventario §A.1/§A.3, verificado B1/C). Lo único
Codex-específico es el archivo de registración. `${TCG}` lo sustituye el instalador al
desplegar (Etapa F; hasta entonces, deploy manual). Gotcha operativo: Codex exige **trust por
hash** del hook (`/hooks` en sesión interactiva) y lo re-untrustea con cada cambio del script.

# adapters/ — lo que se traduce para Codex

**No edites nada de esta carpeta a mano.** Todo sale de `node build/generate.js`, a partir de los revisores de
`agents/*.md`. Para cambiar un revisor, editá su `.md` y regenerá.

| Qué | Para qué |
|---|---|
| `codex/agents/*.toml` | Cada revisor como perfil de Codex: se corre con `codex exec -p <nombre>`. |
| `codex/agents-native/*.toml` | Los mismos revisores como subagentes que una sesión de Codex lanza sola. |
| `codex/agents/MANIFEST.json` | Qué revisores ya están traducidos. Un revisor entra sólo con sus casos de prueba en `scripts/controls-bench/cases/advisors/`. |
| `codex/hooks.json` | Qué controles automáticos registra Codex. Los controles son los mismos de `scripts/hooks/`: no se traducen. |

## Comandos

- ¿Está al día? `node build/check.js`. Lo corre también el control antes de cada commit.
- Regenerar: `node build/generate.js`. Instalar en tu máquina: `node build/generate.js --deploy`.

## Un paso a mano en Codex

Codex pide aprobar cada control la primera vez, y otra vez cada vez que su guion cambia. Se aprueban en una sesión de
`codex`, con `/hooks`. Sin esa aprobación los controles no corren, y no dan error.

## Por qué no hay `adapters/claude/`

Claude Code usa los originales sin traducir: los revisores de `agents/` y los controles de `scripts/hooks/`.

El diseño completo está en [`guides/codex-migration.md`](../guides/codex-migration.md); el de los subagentes nativos, en
[`guides/decisions/codex-etapa-g-diseno.md`](../guides/decisions/codex-etapa-g-diseno.md).

---
description: Revisar y accionar las propuestas de instincts de antes (review/list/show/approve/reject/status); las del equipo se deciden en la pestaña Aprendizajes del sitio
argument-hint: "[review | show <hash> | approve <hash> | reject <hash> --reason \"...\" | status]"
allowed-tools: Bash(node:*), Bash(engram:*), Bash(ls:*), Bash(wc:*), Read
---

Gestioná los instincts del sistema `instinct-mining`. Subcomando + args en: `$ARGUMENTS`

**Las propuestas del equipo ya no salen de esta máquina**: las arma cada noche el proceso de la organización, con lo que
suben las máquinas y con el modelo que elige la organización, y se aprueban o se rechazan en la **pestaña Aprendizajes
del sitio**. Este comando queda para las propuestas de antes (las de `pending/` y `promoted/`). Si piden correr el
observador o «proponer ahora», decí eso: no hay corrida por máquina.

**Repo** (override con `$TYCON_GUIDES_DIR`): `~/.claude/tycon-harness`
**Script**: `<repo>/scripts/instincts/instinct-promote.js`
**Dónde viven las propuestas**: en `<repo>/inbox/instincts/` si ese árbol trae su buzón (el clon de quien mantiene el arnés); si no lo trae (un arnés instalado), en tu carpeta de usuario, dentro del estado del arnés. El script lee en todos los lugares y nunca crea una carpeta por leer: no armes rutas a mano, usá `status` para ver dónde está cada cosa.
**Carpetas de cada lugar**: `pending`, `promoted`, `archived`, `drafts` — y `descartados/`, local: lo que la revisión del observer descartó por repetir algo

Dispatch según el PRIMER token de `$ARGUMENTS` (si está vacío → `review`):

| Token | Qué corro |
|---|---|
| `review` \| `list` (vacío = `review`) | `node <repo>/scripts/instincts/instinct-promote.js list` — mostrá la lista. Si hay pending, ofrecé revisarlos uno por uno (mostrar `show`, recomendar approve/reject). |
| `show <hash>` | `node <repo>/scripts/instincts/instinct-promote.js show <hash>` |
| `approve <hash>` | `node <repo>/scripts/instincts/instinct-promote.js approve <hash>` → el script imprime un bloque `mem_save(...)`. **Traducilo y EJECUTALO con la CLI de engram**: `engram save "<title=trigger>" "<msg=action + Domain/Evidence/Confidence/Reasoning>" --type decision --project <project|TYCON-Global> --scope <scope>`. Si el YAML tenía `tycon_artifact_suggestion`, avisá que se generó un draft y mostrá la ruta que imprime el script en «Archivo:» (queda en `drafts/` del mismo lugar donde estaba la propuesta; si está dentro del repo se commitea a mano, si está en la carpeta de usuario no va por git). |
| `reject <hash> --reason "..."` | `node <repo>/scripts/instincts/instinct-promote.js reject <hash> --reason "..."`. Si falta `--reason`, pedíselo al usuario antes de correr. |
| `status` | `node <repo>/scripts/instincts/instinct-promote.js status` — una línea por lugar con cuántos hay en `pending`, `promoted`, `archived`, `drafts` y `descartados`, y cuál es el lugar donde se escribe (marcado con `*`). Un «?» en vez de un número es una carpeta que existe y no se pudo leer; un renglón que empieza con «!» dice un lugar que quedó sin mirar y por qué. Mostrala tal cual, con esos renglones. |

**Reglas duras**
- NUNCA `approve`/`reject` sin que el usuario lo haya pedido explícito en `$ARGUMENTS`. `approve` emite memoria a engram (acción persistente) y `reject` mueve archivos.
- Confirmá el `<hash>` antes de aprobar/rechazar (mostralo con `show` si hay duda).
- `approve` y `reject` mueven el archivo dentro del lugar donde estaba; nunca lo pasan de un lugar a otro.
- `approve` NO toca catálogo/skills/hooks/guides — solo engram + (si aplica) un draft en `drafts/`. Los cambios team-wide los commiteás vos a mano.
- Si un instinct es `scope: project` con `tycon_artifact_suggestion: null`, es memoria personal — NO es candidato a advisor. No lo trates como tal.

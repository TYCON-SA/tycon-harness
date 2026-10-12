# CodeGraph MCP — índice de código para los agentes

Setup de **CodeGraph** ([@colbymchenry/codegraph](https://www.npmjs.com/package/@colbymchenry/codegraph))
como MCP server en Claude Code. CodeGraph indexa el codebase con tree-sitter y arma un
**grafo semántico** (símbolos, call graph, dependencias) en una SQLite local. Los agentes
consultan ese grafo en vez de escanear archivos con `grep` — menos tokens, menos tool calls.

100% local, MIT. Soporta C#, TypeScript, JavaScript, Python, Go, Rust, Java y ~12 lenguajes más.

> Setup **opcional** — cada dev decide si lo activa. No es parte del flujo TYCON obligatorio.

---

## Instalación — una sola vez por máquina

**macOS / Linux:**

```bash
bash ~/.claude/tycon-harness/scripts/setup/install-codegraph.sh /ruta/al/repo
```

**Windows (PowerShell):**

```powershell
pwsh ~\.claude\tycon-harness\scripts\setup\install-codegraph.ps1 C:\ruta\al\repo
```

El script:

1. Verifica Node ≥ 18 y el CLI `claude`.
2. Instala el CLI `codegraph` global.
3. **Autodetecta** si el target es un repo suelto o un contenedor con subproyectos
   (forzá con `--repo` / `--container`, o `-Repo` / `-Container` en Windows).
4. Indexa cada repo y lo registra como MCP server (`claude mcp add`, scope local).
5. Agrega `.codegraph/` al `.gitignore`.
6. **Instala un hook `SessionStart`** → de acá en adelante, cualquier OTRO repo que abras
   se auto-configura solo (ver "Modo automático").

Después: **reiniciá la sesión (Claude Code; bajo Codex el server se re-traduce solo en el próximo arranque)**, aprobá el/los server(s) `codegraph*`, verificá con `/mcp`.

---

## Modo automático (el hook `SessionStart`)

Tras esa corrida única, el script dejó instalado `codegraph-session-hook.sh` (`.ps1` en
Windows) como hook `SessionStart` en tu `~/.claude/settings.json`. En cada sesión nueva:

- Si el directorio es un proyecto y **todavía no está seteado** → lo indexa, lo registra
  como MCP server y agrega `.codegraph/` al `.gitignore`. Corre en background (`async`),
  no bloquea el arranque.
- Si ya está seteado → sale al instante (marca `.codegraph/.tycon-setup-done`).

O sea: **corrés el instalador una vez y nunca más tocás nada** — todo repo futuro queda
cubierto solo. El MCP server recién registrado se activa en la **sesión siguiente** a la
primera vez que abrís ese repo (es inherente a cómo Claude Code carga MCP servers).

**Qué NO cubre el hook:** contenedores con subproyectos (un dir que no es proyecto él
mismo pero tiene repos adentro). Para esos, corré el instalador con `--container` una vez.

**Optar por NO usar el hook:** instalá con `--no-auto` (`-NoAuto` en Windows) — modo
manual, configura solo el repo indicado y hay que re-correr el script para cada otro repo.

---

## La regla de uso — ya viaja con el arnés

Para que los agentes usen CodeGraph *por defecto* (sin que pidas "con codegraph"), el
`README.md` de este repo incluye una **regla siempre activa** (sección "Regla siempre
activa — CodeGraph"). Como tu `~/.claude/CLAUDE.md` importa ese README, la regla está en
contexto en todas tus sesiones, y es **self-gating**: aplica cuando el repo tiene `.codegraph/` en
su raíz o la sesión tiene tools de CodeGraph (incluidas las `codegraph-<subcarpeta>` del modo
contenedor del instalador). No hay que hacer nada.

Ojo: `codegraph install` agrega además su propia sección al `~/.claude/CLAUDE.md` (entre
`<!-- CODEGRAPH_START -->` y `<!-- CODEGRAPH_END -->`), que duplica las instrucciones que el
servidor MCP ya manda; si reaparece después de reinstalar, se puede borrar.

Si querés que la regla viaje *con un repo puntual* (p.ej. para alguien fuera del setup
TYCON), pegá este bloque en el `CLAUDE.md` del repo y commiteálo:

```markdown
## Búsqueda de código con CodeGraph

Las preguntas sobre la estructura del código —dónde se define algo, quién lo llama, qué rompe
un cambio— se contestan con las tools de CodeGraph: devuelven el grafo completo, que una
búsqueda de texto no ve.

| Necesito… | Tool |
|---|---|
| Encontrar un símbolo por nombre | `codegraph_search` |
| Contexto completo de una tarea (entry points + código) | `codegraph_context` |
| Quién llama a X / a qué llama X | `codegraph_callers` / `codegraph_callees` |
| Qué se rompe si cambio X | `codegraph_impact` |
| Detalle de un símbolo (con código) | `codegraph_node` |
| Estructura de archivos del proyecto | `codegraph_files` |
| Exploración profunda de un tema | `codegraph_explore` |

`grep` / `Grep` / `Glob` quedan solo para texto que NO es código (markdown, specs, logs,
`.json`/`.yaml`/`.sql`), strings literales, o nombres de archivo por patrón. Para leer un
archivo puntual ya identificado, `Read` directo está bien. Si una tool `mcp__codegraph*`
falla (server caído), recién ahí caer a `grep`.
```

---

## Qué se commitea y qué no

| Pieza | Dónde vive | ¿Se commitea? |
|---|---|---|
| CLI `codegraph` | npm global | No — per máquina |
| Índice `.codegraph/` | Carpeta del repo (SQLite) | **No** — gitignored, regenerable |
| Registro MCP server | `~/.claude.json` scope `local` | No — per máquina |
| Hook `SessionStart` | `~/.claude/settings.json` | No — per máquina |
| Entrada `.codegraph/` en `.gitignore` | Repo | **Sí** |

Nada de la config MCP es portable (rutas absolutas resueltas por máquina) — por eso cada
dev corre el instalador localmente.

---

## Mantenimiento del índice

El índice se auto-sincroniza con file watchers mientras hay una sesión activa. Si quedó
viejo (pull grande offline, etc.):

```bash
codegraph sync     # incremental — solo lo que cambió
codegraph index    # rebuild completo
codegraph status   # estadísticas del índice
```

---

## Troubleshooting

**`/mcp` no muestra `codegraph` / aparece `failed`:**
- Reiniciá Claude Code — la config MCP se lee al iniciar sesión.
- Primera vez en un repo: el hook lo configura en background; el server se activa en la
  sesión **siguiente**. Reiniciá una vez más.
- `command not found`: el server se registra con la ruta absoluta del binario; si moviste
  o reinstalaste Node, volvé a correr el instalador.

**El agente sigue usando `grep` en vez de las tools `codegraph`:**
- ¿Tu `~/.claude/CLAUDE.md` importa el `README.md` del arnés? (paso 2 del
  setup TYCON). Sin ese import, la regla siempre-activa no se carga.
- Reiniciá la sesión.

**El hook no configuró un repo nuevo:**
- ¿Es un contenedor con subproyectos? El hook no los maneja — corré `install-codegraph.sh
  --container`.
- ¿El CLI `codegraph` sigue en PATH? El hook lo necesita; si falta, re-corré el instalador.

**Quiero sacar un repo del índice:** `codegraph uninit` (borra `.codegraph/`) +
`claude mcp remove codegraph` desde ese directorio.

---

## Notas

- Versión testeada del paquete: **0.7.9** (pre-1.0, autor individual). El instalador usa
  `@latest`; para pinear, editá `CODEGRAPH_VERSION` arriba del script.
- El paquete no tiene `postinstall` script — no ejecuta código al instalarse.
- El hook `SessionStart` corre en TODO repo que abras (no solo TYCON). Es liviano: en
  repos ya seteados o que no son proyectos, sale al instante.

> **Multi-modelo**: el registro del lado Claude es el CANÓNICO; el deployer de Codex lo traduce solo si el binario `codegraph` está en el PATH de la máquina. No registrar dos veces.


## Gotcha — nunca el HOME (2026-08-24)

El hook decide "esto es un proyecto" por señales (`.git`, `package.json`, `*.sln`, …). Una sesión
abierta sin carpeta arranca en `$HOME`, y si ahí hay un `package.json` suelto la señal da positivo:
el hook indexa el home completo y registra un MCP con `--path $HOME` (medido: 2 h de CPU, 3.8 GB de
índice). Desde 2026-08-24 el hook sale al instante si el cwd
es `$HOME` o `/`, antes de mirar nada más. Si te pasó antes del fix: `claude mcp remove codegraph`
parado en `~`, y borrar `~/.codegraph/codegraph.db*` (el índice; `config.json`/`daemons/` son estado
global de codegraph, dejarlos).

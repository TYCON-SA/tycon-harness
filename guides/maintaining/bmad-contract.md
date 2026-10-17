# Contrato entre Advisors TYCON y skills BMAD

Esta guía documenta **qué inputs/outputs asumen los advisors TYCON** de cada skill BMAD que invocan. Sirve para detectar **breaking changes** cuando BMAD sube de versión.

**Versión BMAD actual piñada**: `6.3.0` — es la del **fork del equipo** (`~/SourceCode/BMAD`, su `package.json`).

**Lo que distribuye agent-skills es otra cosa**: cada carpeta `bmad-*` que el pipeline usa está fijada,
una por una, por commit del repo de BMAD y por hash de árbol de git en el manifiesto de terceros del arnés,
`scripts/publishing/third-party-skills.json` (entradas `third_party` con `from: bmad-code-org-bmad-method@…`), y
`tycon-create-story` figura como derivada (tiene cambios del equipo). El manifiesto es la única fuente: esta guía no
repite qué foto de BMAD es; se lee ahí, y `node scripts/publishing/third-party-coverage.js` verifica que el árbol de
cada carpeta sea el declarado.

---

## Por qué existe este documento

Los advisors TYCON son wrappers que corren **antes/después** de skills BMAD. No modifican BMAD, pero **dependen de su output**. Si BMAD v6.4 cambia:

- El formato del Dev Agent Record
- La estructura de archivos que genera
- Los nombres/signatures de skills
- El comportamiento de `approach: [EXTRACT]` vs `[ADAPT]` vs `[CREATE]`

Los advisors se rompen silencioso. Este documento es el mapa de **qué estamos asumiendo** para poder chequearlo rápido ante un upgrade.

---

## Workflow de upgrade de BMAD

Cuando salga BMAD v6.4 (o cualquier nueva versión):

1. **NO hacer `npm install` directo** en `~/SourceCode/BMAD`. Crear branch de upgrade.
2. Leer changelog de upstream (`bmad-code-org/BMAD-METHOD`).
3. Revisar este documento sección por sección. Por cada item: ¿el cambio de BMAD rompe esta asunción?
4. Si hay breaking changes → arreglar los advisors afectados ANTES de pushear el upgrade al repo BMAD fork.
5. Correr una story de prueba end-to-end con el pipeline para detectar problemas no documentados acá.
6. Si todo OK → mergear upgrade + actualizar este documento con la nueva versión piñada + notas de cambios.
7. Mover lo que distribuye agent-skills es un cambio aparte y revisado: por cada carpeta, el `commit`, el `path` y el
   `tree` nuevos de su entrada en `scripts/publishing/third-party-skills.json` (el árbol se mide con
   `git rev-parse <commit>:<path>` en un clon del origen). El paso del instalador reemplaza sólo lo que escribió él y
   nadie tocó; nada se actualiza solo.

---

## Contratos por skill BMAD

### `tycon-create-story`

**Usado por**: no directamente por el pipeline (el pipeline asume que la story ya existe).

**Output que asume `tycon-story-validator`**:
- Archivo `.md` con frontmatter YAML que incluye:
  - `epic`, `story`, `title`, `status`, `sprint`, `priority`, `approach`, `depends_on`
- Body con secciones: `## Story`, `## Acceptance Criteria` (con H3 para subgrupos), `### Tests` (tabla), `## Tasks / Subtasks`, `## Dev Notes`, `## Dev Agent Record`.
- Formato **Mary+GOLD** según `story-format.md`.

**Fragilidad**: si `tycon-create-story` cambia el formato (ej: renombra `approach` a `mode`), el validator queda desalineado.

---

### `bmad-dev-story`

**Usado por**: Step 2 y Step 4 del pipeline, para stories con `approach: [EXTRACT]` o `[ADAPT]`.

**Inputs esperados**:
- Path al `.md` del story.
- Puede operar en "plan mode" (Step 2) o "execute mode" (Step 4). Hoy esto se pasa vía prompt explícito. Si BMAD v6.4 introduce un flag formal tipo `--mode=plan`, hay que actualizar Step 2 para usarlo.

**Outputs que asume el pipeline**:
- Modificaciones directas a archivos en el repo (file system changes).
- Actualización del **Dev Agent Record** del story con:
  - `Agent Model Used`
  - `Debug Log References` (build results, test results)
  - `Completion Notes List`
  - `File List` (archivos creados/modificados)
  - `Change Log` (fecha + autor)

**Fragilidad**: si BMAD v6.4 cambia nombres de secciones del Dev Agent Record o el formato del File List (ej: pasa de bullet list a tabla), los advisors que leen ese record se rompen.

---

### `bmad-agent-dev` (persona Amelia)

**Usado por**: Step 2 y Step 4 del pipeline, para stories con `approach: [CREATE]`.

**Inputs esperados**:
- Path al story + contexto de plan/execute mode.

**Outputs**: idénticos a `bmad-dev-story` (Dev Agent Record completo + archivos).

**Particularidad de Amelia**: es ultra-sucinta. Reporta en file paths y AC IDs. El pipeline espera esta brevedad — si Amelia se vuelve verbose en v6.4, no rompe pero genera más noise en el consolidated report.

---

### `bmad-agent-quick-flow-solo-dev` (persona Barry)

**Usado por**: Step 2 y Step 4 para stories sin `approach` definido o marcadas como `quick-flow`.

**Inputs esperados**: path al story o a una tarea informal.

**Outputs**: modificaciones al filesystem + Dev Agent Record **abreviado** (Barry puede no completar todas las secciones del record canónico).

**Fragilidad**: si Barry produce un File List inconsistente, los advisors post-impl pueden auditar archivos incorrectos. Mitigación: el pipeline pasa explícitamente la lista de archivos modificados (via `git diff --name-only`) a los advisors, NO confía en lo que Barry reporta.

---

### `bmad-code-review`

**Usado por**: opcional, puede correrse en Step 5 en paralelo con los advisors TYCON.

**Inputs esperados**: diff del repo (detectado automáticamente).

**Outputs**: reporte de review con findings clasificados por severity.

**Fragilidad**: el pipeline consolida outputs en Step 6. Si `bmad-code-review` cambia su formato de output (ej: pasa de markdown a JSON), el consolidator del Step 6 necesita updates.

---

### `bmad-party-mode`

**Usado por**: no en el pipeline principal. Usado para discusiones de diseño arquitectónico.

**Outputs esperados**: transcripts de subagentes multi-persona.

**Fragilidad**: baja — no es dependencia del workflow de implementación.

---

### `bmad-advanced-elicitation`

**Usado por**: no en el pipeline. Usado para refinamiento de specs.

**Outputs esperados**: prompts estructurados con técnicas de elicitación (pre-mortem, red team, etc.).

**Fragilidad**: baja.

---

## Estructura de directorios que asume el pipeline

El pipeline asume que el BMAD installer genera:

```
~/_bmad/
├── core/
│   └── config.yaml          # user_name, communication_language, document_output_language
└── _config/
    ├── manifest.yaml        # version: 6.3.0
    └── skill-manifest.csv   # listado de skills disponibles

~/.claude/agent-skills/
└── skills/
    ├── bmad-*/              # skills BMAD: las que distribuye el equipo las fija el manifiesto de terceros;
    │                        # las que agrega un installer de BMAD más nuevo quedan sin versionar y el paso no las toca
    ├── gds-*/               # skills Game Dev Studio (v6.3.0+)
    ├── wds-*/               # skills Web Dev Studio (v6.3.0+)
    └── tycon-pipeline/      # skill custom del team, no tocado por installer
```

**Fragilidad**: si BMAD v6.4 reorganiza estos paths (ej: mueve skills a otro directorio), el pipeline no encuentra los skills y falla al invocar.

---

## Convenciones de naming que asumimos

### Skills de agente

| Patrón | Ejemplo | Rol |
|---|---|---|
| `bmad-agent-*` | `bmad-agent-dev` (Amelia) | Persona con identidad y communication style |
| `bmad-agent-quick-flow-*` | `bmad-agent-quick-flow-solo-dev` (Barry) | Quick flow |
| `bmad-*` (sin `agent`) | `bmad-dev-story` | Workflow skill |

Si BMAD v6.4 unifica o renombra estas familias, el Step 2 del pipeline (que elige skill según `approach`) necesita actualización.

### Nombres de personas

- **Amelia** → `bmad-agent-dev`
- **Barry** → `bmad-agent-quick-flow-solo-dev`
- **Winston** → `bmad-agent-architect`
- **Mary** → `bmad-agent-analyst`
- **Bob** → `bmad-agent-sm`
- **John** → `bmad-agent-pm`
- **Sally** → `bmad-agent-ux-designer`
- **Paige** → `bmad-agent-tech-writer`
- **Quinn** → `bmad-agent-qa`

El pipeline menciona Amelia y Barry por nombre en los steps. Si BMAD renombra personas, actualizar los steps.

---

## Formato del Dev Agent Record

El pipeline no lo modifica pero varios advisors lo leen para correlacionar warnings con cambios. Formato actual (v6.3.0):

```markdown
## Dev Agent Record

### Agent Model Used
Claude Opus 4.7 (1M context)

### Debug Log References
- Build: `dotnet build` — 0 errores
- Tests: `dotnet test --filter "XYZ"` — N/N PASS
- Full suite: `dotnet test` — M/M PASS

### Completion Notes List
- Implementación usó pattern X por razón Y
- Edge case Z manejado con approach W

### File List
- `src/path/file1.cs` (NEW)
- `src/path/file2.cs` (MODIFIED — added method)
- `tests/path/file1Tests.cs` (NEW — 9 tests)

### Change Log
- 2026-04-18: Story implementada. Tests 9/9 PASS.
```

**Los advisors parsean este formato**. Si cambia en v6.4, hay que actualizar los parsers.

---

## Señales tempranas de breaking change

Después de un upgrade de BMAD, si ves algo de esto durante el uso del pipeline, es señal de drift:

- **Advisor reporta "archivo referenciado no existe"** sobre archivos que BMAD dice haber creado → File List inconsistente.
- **Build-gate del Step 4 no encuentra comando de build** → el detector de framework puede haberse desalineado si BMAD cambió cómo inicializa proyectos.
- **El Step 7 no pausa aunque hay warnings visibles** → el parser del consolidated report falla por cambio de formato en advisor.
- **Step 2 falla al elegir skill** → el mapeo `approach` → skill BMAD quedó obsoleto.

Cualquiera de estas señales = abrir este documento, revisar el contrato, updatear lo que rompa.

---

## Cuándo actualizar este documento

- Al pinear una nueva versión de BMAD (obligatorio).
- Al descubrir un contrato no documentado que un advisor asume (agregarlo).
- Al retirar un advisor (remover su sección si era la única que dependía del contrato).

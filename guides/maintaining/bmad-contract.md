# Contrato entre Advisors TYCON y skills BMAD

Esta guía documenta **qué inputs/outputs asumen los advisors TYCON** de cada skill BMAD que invocan. Sirve para detectar **breaking changes** cuando BMAD sube de versión.

**Versión BMAD actual piñada**: `6.3.0` — es la del **fork del equipo** (`~/SourceCode/BMAD`, su `package.json`).

**El pipeline ya no planifica ni implementa con BMAD**: esos dos pasos los hace el orquestador. De BMAD le quedan
`bmad-code-review`, a pedido, y `bmad-agent-analyst`, que sugiere un aviso. Las demás skills siguen instaladas para quien
las use a mano.

**Lo que distribuye agent-skills es otra cosa**: cada carpeta `bmad-*` está fijada,
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

### `bmad-dev-story`, `bmad-agent-dev` y `bmad-agent-quick-flow-solo-dev`

**Usadas por**: nadie en el pipeline. «Armar el plan» e «Implementar» traen sus reglas en `step-03-plan.md` y
`step-05-implement.md`, y un cambio de estas skills no los afecta. Siguen instaladas para usarlas a mano.

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

Lo escribe el orquestador en «Implementar», y varios advisors lo leen para correlacionar warnings con cambios. Formato actual:

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

Cualquiera de estas señales = abrir este documento, revisar el contrato, updatear lo que rompa.

---

## Qué falta medir: los planes sin BMAD

Dejar de pasar los planes por BMAD puede bajar su calidad, y la revisión automática sólo corre sobre el plan de una
corrida abierta. Por eso se mide en las **tres primeras corridas reales** con el plan escrito por el orquestador: el primer
veredicto de la revisión de cada una.

La base son los 149 resultados guardados en una máquina del equipo el 18/11: 22 rechazados (15 %), 126 aprobados y
1 sin veredicto. Con **2 o más rechazos de 3**, el caso vuelve al dueño con los hallazgos. Tres planes son una muestra
chica: sirven para ver un problema grande, no para afirmar que la calidad es igual.

---

## Cuándo actualizar este documento

- Al pinear una nueva versión de BMAD (obligatorio).
- Al descubrir un contrato no documentado que un advisor asume (agregarlo).
- Al retirar un advisor (remover su sección si era la única que dependía del contrato).

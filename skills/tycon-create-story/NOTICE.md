# NOTICE — bmad-create-story

## English

This skill is a modified copy of `bmad-create-story` from the BMad Method.

- **Origin**: https://github.com/bmad-code-org/BMAD-METHOD
- **Commit**: `1cc433e543cf2bd725cf0128a005d7aa852df76f`
- **Path**: `src/bmm-skills/4-implementation/bmad-create-story`
- **License**: MIT — Copyright (c) 2025 BMad Code, LLC. The original license text is in `LICENSE`, unchanged.
- **Trademark**: BMad™, BMad Method™ and BMad Core™ are trademarks of BMad Code, LLC. Inside the team's internal
  repository the skill keeps its original name, to identify where it comes from. The public copy publishes it as
  `tycon-create-story`, as the BMad trademark policy asks of a modified version. This harness is not affiliated with,
  endorsed by or certified by BMad Code, LLC.

### What the team changed

| File | Status |
|---|---|
| `SKILL.md` | The description adds the requests in Spanish ("creá una historia", "escribí una historia", "creá una story", "armá la historia de…"), so that a request written in Spanish also starts this skill |
| `discover-inputs.md` | Identical to the original |
| `checklist.md` | Adds section 5.5, "TYCON Mary+GOLD format": the story fields and sections the harness reads, checked as critical issues |
| `template.md` | Replaced by the Mary+GOLD story template: a YAML frontmatter the harness reads (epic, story, status, sprint, files…), the guidance comments that point to `story-format.md`, and the Tests table |
| `workflow.md` | A new step 0 runs `scripts/story-without-bmad.js mode` first and, in a repo without a BMAD project, hands over to `first-time.md`; step 5 reads `story-format.md` before writing and fills the Mary+GOLD frontmatter and sections; the closing "next steps" drop the Test Architect ATDD step and the long command names; at the end of step 5 the story gets an estimate, proposed from similar closed stories (`scripts/lib/similar-stories.js`) and confirmed, corrected or skipped by the person, and appended to `.tycon/estimates.jsonl` |
| `first-time.md` | New, written by the team: the first-time mode for a repo without a BMAD project (three plain questions, then the script writes the story) |
| `scripts/story-without-bmad.js` | New, written by the team: decides the mode from the repo and writes the first-time story from the answers |
| `scripts/tests/story-without-bmad.test.js` | New, written by the team: the tests of that script and of the first-time instructions |
| `scripts/story-number.js` | New, written by the team: the number of a new story, read from `main`, the remote branches and the worktrees of the machine, with a doubt instead of a guess |
| `scripts/tests/story-number.test.js` | New, written by the team: the tests of that script and of the step that calls it |

To see every change line by line, compare this folder with the path above at that commit.

## Castellano

Esta skill es una copia modificada de `bmad-create-story`, del BMad Method.

- **Origen**: https://github.com/bmad-code-org/BMAD-METHOD
- **Commit**: `1cc433e543cf2bd725cf0128a005d7aa852df76f`
- **Ruta**: `src/bmm-skills/4-implementation/bmad-create-story`
- **Licencia**: MIT — Copyright (c) 2025 BMad Code, LLC. El texto original está en `LICENSE`, sin cambios.
- **Marca**: BMad™, BMad Method™ y BMad Core™ son marcas de BMad Code, LLC. Adentro, en el repo interno del equipo,
  la skill conserva su nombre original para reconocer de dónde viene. La copia pública la publica como
  `tycon-create-story`, como pide la política de marca de BMad para una versión modificada. Este arnés no está afiliado,
  avalado ni certificado por BMad Code, LLC.

### Qué cambió el equipo

| Archivo | Estado |
|---|---|
| `SKILL.md` | La descripción suma los pedidos en castellano («creá una historia», «escribí una historia», «creá una story», «armá la historia de…»), para que un pedido en castellano también arranque esta skill |
| `discover-inputs.md` | Igual al original |
| `checklist.md` | Suma la sección 5.5, «TYCON Mary+GOLD format»: los campos y secciones de la story que lee el arnés, revisados como problemas críticos |
| `template.md` | Reemplazada por la plantilla de story Mary+GOLD: un frontmatter YAML que lee el arnés (epic, story, status, sprint, archivos…), los comentarios de guía que mandan a `story-format.md`, y la tabla de pruebas |
| `workflow.md` | Un paso 0 nuevo corre primero `scripts/story-without-bmad.js mode` y, en un repo sin proyecto BMAD, pasa a `first-time.md`; el paso 5 lee `story-format.md` antes de escribir y llena el frontmatter y las secciones Mary+GOLD; los «próximos pasos» del cierre sacan el paso ATDD del Test Architect y los nombres largos de los comandos; al final del paso 5 la historia recibe una estimación, propuesta desde historias cerradas parecidas (`scripts/lib/similar-stories.js`) y confirmada, corregida u omitida por la persona, que se agrega a `.tycon/estimates.jsonl` |
| `first-time.md` | Nuevo, escrito por el equipo: el modo primera vez para un repo sin proyecto BMAD (tres preguntas en llano y después el guion escribe la historia) |
| `scripts/story-without-bmad.js` | Nuevo, escrito por el equipo: decide el modo por lo que hay en el repo y escribe la historia de primera vez desde las respuestas |
| `scripts/tests/story-without-bmad.test.js` | Nuevo, escrito por el equipo: las pruebas de ese guion y de las instrucciones de primera vez |
| `scripts/story-number.js` | Nuevo, escrito por el equipo: el número de una historia nueva, leído de `main`, de las ramas remotas y de los worktrees de la máquina, con una duda en vez de una adivinanza |
| `scripts/tests/story-number.test.js` | Nuevo, escrito por el equipo: las pruebas de ese guion y del paso que lo llama |

Para ver cada cambio línea por línea, comparar esta carpeta con la ruta de arriba en ese commit.

# Los tres "Claude" — criterio multi-modelo al escribir material del arnés

Al escribir guías, skills, steps o material del sitio, "Claude" no es una sola cosa — y desde
que el arnés es multi-modelo (corre igual bajo Claude Code y bajo Codex), usar la palabra
equivocada enseña algo falso para la mitad de las herramientas. Tres clases:

1. **La herramienta canónica** — dónde se registra un MCP, dónde se pega el onboarding, de
   quién son las primitivas: se escribe **"Claude Code"**. Es correcto INCLUSO para activar
   Codex, porque el lado Codex se configura desde ahí (el deployer traduce). Generalizar esta
   clase **mete** errores: donde el canónico ES Claude Code, cambiar el nombre deja una
   instrucción falsa.
2. **El actor de runtime Y el modelo en general** — quién detecta el pipeline, implementa la
   story, corre advisors; y también el sujeto de la tesis ("el genio con amnesia" es CUALQUIER
   modelo, no una marca): se escribe **"el agente"** o **"el modelo"**. Ojo: esta clase no se
   caza solo por verbos de acción ("Claude detecta") — también por cópula ("Claude es un…").
   Ejemplo: un título que diga "Claude es un genio con amnesia".
3. **Las referencias a docs y primitivas de Claude Code** — se quedan como están: son suyas.

**Material viejo**: las guías del arnés (`guides/` + README + story-format) y el sitio (las
TRES copias: `index.html`, `index-slides.html`, `guion.md` — el contenido vive por triplicado y
se publica entero) ya recibieron la pasada retroactiva completa el 2026-08-23.
La fase 2 (skills y steps TYCON de `agent-skills`: pipeline, horas, skill-scout,
merge-to-main) aterrizó el mismo día — 26 correcciones, revisada adversarialmente. Quedan
FUERA a propósito: los packs vendorizados (bmad-*, skill-creator, docx, doc-coauthoring,
impeccable, canvas-design, algorithmic-art — editarlos crea drift con upstream) y las skills
con canónico en el repo de su producto (`bizuit-sdd` → el repo de documentación de procesos, `bizuit-bpmn` → el paquete del
MCP): esas se corrigen al tocarlas, en su canónico, con este criterio. La cosmética de clase 1 sigue descartada: generalizar donde el canónico ES Claude
Code mete errores, no los quita.

**Registros históricos** (el registro de incidentes, los registros de la migración a Codex, casos
fechados en cualquier guía) conservan el nombre del actor real de ese día: «2026-05-20: Claude
declaró `done` sin correr los E2E» es un hecho, no una generalización — reescribirlo a «el
agente» falsearía la memoria institucional. No son clase 2.

**Parientes que responden la misma pregunta** ("¿cómo nombro lo tool-específico para que el
texto sobreviva bajo Codex?") — conocerlos evita que driften por separado:
- [claude-md-blocks/names/](../../claude-md-blocks/names) — los nombres EXACTOS de tools viven
  SOLO en el bloque de nombres, con variante por herramienta.
- `build/equivalences.json → text_substitutions` — la sustitución mecánica Claude→descripción
  funcional que el generador aplica a la prosa de los advisors.

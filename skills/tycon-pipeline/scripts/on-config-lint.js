#!/usr/bin/env node
/**
 * on-config-lint.js — handler PostToolUse (Edit|Write) del dispatcher: revisa
 * `.tycon/advisors.yaml` apenas alguien lo toca.
 *
 * POR QUÉ ACÁ Y NO EN EL COMMIT: la config del repo es una superficie de control **que no
 * dispara a nadie**. Un commit que sólo la toca se clasifica como "sólo documentación" y el set de
 * revisores automáticos queda vacío — o sea que la única superficie capaz de apagar frenos era
 * también la única sin revisor. Este handler cierra ese hueco donde cuesta menos: en el momento de
 * la edición, sin modelo, sin red y sin tokens (~50ms de lectura de texto).
 *
 * AVISA, nunca bloquea. Un lint de config que frena commits se apaga en una semana y se lleva
 * puestos los casos donde sí importaba. Off: TYCON_CONFIG_LINT=0.
 */

'use strict';

const path = require('path');

function esConfigTycon(p) {
  const norm = String(p || '').replace(/\\/g, '/');
  return /(^|\/)\.tycon\/advisors\.ya?ml$/.test(norm);
}

function handle(event) {
  if (process.env.TYCON_CONFIG_LINT === '0') return null;
  const filePath = event && event.tool_input && event.tool_input.file_path;
  if (!esConfigTycon(filePath)) return null;

  let r;
  let raiz;
  try {
    const cl = require('./lib/config-lint.js');
    const cs = require('./lib/config-source.js');
    const ec = require('./lib/evidence-config.js');
    raiz = ec.discoverRepoRoot(path.dirname(String(filePath))) || path.dirname(path.dirname(String(filePath)));
    cs.limpiarCache();   // el archivo se acaba de escribir: la lectura anterior quedó vieja
    const ambas = cs.leerAmbas(raiz);
    r = cl.lintConfig({
      repoRoot: raiz,
      txtCarpeta: ambas.carpeta,
      txtCommiteado: ambas.hayHistoria ? (ambas.commiteado || '') : null,
    });
  } catch (_e) {
    return null;   // fail-open: un lint que rompe una edición es peor que un lint ausente
  }
  if (!r || r.ok || !r.hallazgos.length) return null;

  return {
    reminder:
      `⚠ tycon-config-lint — tocaste \`.tycon/advisors.yaml\` y hay ${r.hallazgos.length} cosa(s) que ` +
      'se leen como "está configurado" cuando no lo está:\n' +
      r.hallazgos.map((h) => `  · ${h.mensaje}`).join('\n') +
      '\n\nNo bloquea nada. Detalle completo: ' +
      `\`node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js lint-config --repo ${raiz}\`` +
      ' · apagar: TYCON_CONFIG_LINT=0',
  };
}

module.exports = { handle, esConfigTycon };

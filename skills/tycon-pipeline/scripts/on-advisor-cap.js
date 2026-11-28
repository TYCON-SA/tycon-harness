#!/usr/bin/env node
'use strict';
/**
 * on-advisor-cap.js — PreToolUse (Task | Agent; en Codex collaborationspawn_agent): el tope de vueltas de revisores
 * también vale para un revisor lanzado a mano.
 *
 * Responsabilidad: al tope de vueltas de una corrida, negar el lanzamiento de un revisor del set que no es de la vuelta
 * abierta (o que ya se lanzó en ella): lanzarlo con la herramienta de agentes sacaba una vuelta más sin pasar por el
 * guion, sin foto y sin la firma del dueño. Sale 2 con el cartel del tope; en todo lo demás, 0.
 *
 * Es un freno: va sólo en el perfil completo. El que anota los lanzamientos (on-advisor-run.js, en los dos perfiles) no
 * anota el que este gancho niega, así que sin el freno ese revisor corre pero no cuenta como revisado. La regla vive en
 * on-advisor-run.js (`frenoDelTope`), una sola vez para los dos. Un fallo propio deja pasar: el gancho no rompe un
 * lanzamiento por un error suyo.
 */
const fs = require('fs');
const { frenoDelTope, advisorDelEvento } = require('./on-advisor-run.js');

function main() {
  let event;
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    event = stdin ? JSON.parse(stdin) : null;
  } catch { return null; }
  if (!event || (event.hook_event_name && event.hook_event_name !== 'PreToolUse')) return null;
  const advisor = advisorDelEvento(event);
  if (!advisor) return null;
  return frenoDelTope({ sessionId: event.session_id, advisor });
}

module.exports = { main };

if (require.main === module) {
  let negado = null;
  try { negado = main(); } catch { /* fail-safe */ }
  if (negado) {
    process.stderr.write(negado);
    process.exit(2);
  }
  process.exit(0);
}

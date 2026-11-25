'use strict';
// security-alerts.js — las alertas abiertas del análisis de seguridad en la rama principal de un repo de GitHub
// (`security-alerts.list`). El chequeo de antes de encolar mira las dos referencias del pedido (/merge y /head): una alerta
// que el análisis abre recién en main, después de que el pedido entró (una línea que se movió y que ya no reconoce como la
// que estaba cerrada), sólo se ve acá. Lo lee la lectura de fondo del aviso de pedidos (scripts/hooks/stuck-pr-notice.js).

const { no } = require('./gh-api.js');
const CR = require('./change-requests.js');

/**
 * `[{ number, rule, severity, path, line, createdAt }]`, las abiertas de la rama principal. Un repo sin análisis es
 * no_soportado (no hay nada que mirar); una lectura que no se pudo hacer es un «no», nunca una lista vacía.
 */
function alertasDeMain(_args, ctx) {
  const repo = CR.repoDe(ctx);
  if (!repo) return no('rechazado', 'el repo no trae dueño/nombre de GitHub (team-repos.json)');
  const delRepo = CR.analisisDelRepo(ctx, repo);
  if (delRepo.problema) return no('no_medido', delRepo.problema);
  if (!delRepo.hay) return no('no_soportado', 'el repo no tiene análisis de seguridad');
  // sin `ref`, GitHub da las de la rama principal
  const l = CR.todas(ctx, `repos/${repo}/code-scanning/alerts?state=open`);
  if (l.problem) return l.problem;
  const value = l.value.filter((a) => a && a.state === 'open').map((a) => {
    const lugar = (a.most_recent_instance && a.most_recent_instance.location) || {};
    const regla = a.rule || {};
    return {
      number: Number(a.number),
      rule: String(regla.id || ''),
      severity: String(regla.security_severity_level || regla.severity || ''),
      path: String(lugar.path || ''),
      line: Number.isInteger(lugar.start_line) ? lugar.start_line : null,
      createdAt: String(a.created_at || ''),
    };
  });
  return { ok: true, value };
}

module.exports = { 'security-alerts.list': alertasDeMain };

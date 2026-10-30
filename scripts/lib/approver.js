'use strict';
/**
 * approver.js — quién aprueba una firma: el dueño en los repos del arnés, el dev en cualquier otro repo.
 *
 * La capa de mantenimiento se separa por repo, no por máquina: en un repo de producto la firma la da el dev, aunque
 * trabaje en la máquina del dueño. Lo decide el remoto del repo (scripts/lib/harness-repo.js), no la carpeta. Cambia el
 * texto que ve la persona al firmar; la firma se pide igual en los dos casos.
 *
 * `approverOf(dir, opts)` → `{ maintainers, label, terminal }`. Si el repo no se puede juzgar, devuelve el del dev: es
 * el caso general, y en un repo del arnés el dueño también es quien firma.
 */
const APPROVERS = Object.freeze({
  maintainers: Object.freeze({ maintainers: true, label: 'Firma del dueño', terminal: 'la terminal del dueño' }),
  dev: Object.freeze({ maintainers: false, label: 'Lo aprobás vos', terminal: 'tu terminal' }),
});

function approverOf(dir, { judge, ...opts } = {}) {
  try {
    const juzgar = judge || require('./harness-repo.js').juzgarRuta;
    return juzgar(dir || process.cwd(), opts).arnes ? APPROVERS.maintainers : APPROVERS.dev;
  } catch (_) { return APPROVERS.dev; }
}

module.exports = { APPROVERS, approverOf };

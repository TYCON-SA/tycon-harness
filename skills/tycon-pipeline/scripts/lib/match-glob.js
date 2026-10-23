'use strict';

// match-glob.js — la comparación de una ruta contra un glob que usan los revisores (su superficie) y la lista de
// código deprecado del repo. Una sola función para los dos: el mismo glob alcanza lo mismo en todos lados.

// Glob-to-regex simple matcher (no deps). Soporta:
//   **/  → cualquier dir prefix (0+ dirs)
//   **   → cualquier path (con o sin /)
//   *    → cualquier filename char excepto /
//   {a,b} → alternancia
// Match anchored al final + opcional dir prefix al inicio (para que `**/*.cs` matchee `Services/X.cs`).
function matchGlob(filePath, pattern) {
  // Normalizar barras (Windows defensive).
  const f = String(filePath).replace(/\\/g, '/');
  const p = String(pattern).replace(/\\/g, '/');
  // Escapar metachars regex excepto los nuestros.
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // ** o **/
        if (p[i + 2] === '/') {
          re += '(?:.*/)?'; // **/  → optional dir prefix
          i += 2;
        } else {
          re += '.*'; // ** → cualquier path
          i += 1;
        }
      } else {
        re += '[^/]*'; // * → no slash
      }
    } else if (c === '{') {
      const end = p.indexOf('}', i);
      if (end > i) {
        const alts = p.slice(i + 1, end).split(',').map((a) => a.replace(/([.+?^${}()|[\]\\])/g, '\\$1'));
        re += `(?:${alts.join('|')})`;
        i = end;
      } else {
        re += '\\{';
      }
    } else if ('.+?^$()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  // Anchor: full path match (no permitir prefijo random), pero permitir que el archivo
  // viva en cualquier subdir si el pattern empieza con **/.
  const fullRe = new RegExp(`^${re}$`);
  if (fullRe.test(f)) return true;
  // Fallback: match contra basename si el pattern no tiene `/` (ej `*.cs` matchea `foo/bar.cs`)
  if (!p.includes('/')) {
    const base = f.split('/').pop();
    return fullRe.test(base);
  }
  return false;
}

module.exports = { matchGlob };

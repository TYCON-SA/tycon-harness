#!/usr/bin/env bash
# prod-guard-heredoc-readings.test.sh — un `<<` que puede ser texto no le esconde al freno de producción lo que corre.
#
# Caso que lo motiva (S247e): el freno tomaba todo `<<` por heredoc. Con el `<<` adentro de una comilla
# (`echo "$(echo " <<EOF` y en otra línea `")"`), lo que seguía hasta el `EOF` quedaba como cuerpo, y un borrado del índice
# de producción pasaba sin frenar; bash lo corría. Una lectura que sabe de comillas lo ve, pero si se equivoca al leer
# una comilla, deja como comandos un cuerpo que era texto, y una comilla suelta de ese cuerpo esconde lo que sigue
# (revisión de Fable, dos vueltas). Por eso el freno juzga las dos lecturas y frena si una frena.
#
# Lo que prueba:
#   T1 HeredocReadings_TextLtLt_Blocks     — cada forma de la revisión, con el borrado detrás, sale 2
#   T2 HeredocReadings_CommonForms_Pass    — las formas de siempre (el mensaje del commit con heredoc, una nota a un
#                                            archivo, `<<` en una cuenta o en un texto) siguen saliendo 0
#   T3 HeredocReadings_SecondReading_NoPassRecord — un comando que pasa con las dos lecturas anota un solo «pasó»
#
# 🔴 HOME de laboratorio siempre, y los nombres protegidos se arman al correr: el freno vivo frena un comando que los
#    lleva enteros. Con /opt/tycon presente las costuras no existen y la suite no mide; en una máquina con el freno se
#    corre con /opt/tycon escondido (como prod-guard-shell-forms.test.sh):
#      sandbox-exec -f <perfil que niega leer /opt/tycon> bash scripts/tests/prod-guard-heredoc-readings.test.sh
# stable-data: los `git commit` de esta suite son texto que se le pasa al freno; ninguno corre git ni crea un commit.
set -uo pipefail
AQUI="${TYCON_HEREDOC_READINGS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
if [ -d /opt/tycon ]; then
  echo "⏭ heredoc-readings: NO MEDIDO — esta máquina tiene el freno instalado (/opt/tycon): sin costuras de prueba, esta suite corre en el nocturno."
  exit 0
fi
node - "$AQUI" <<'JS'
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawnSync } = require('child_process');
const AQUI = process.argv[2];
const HOOK = path.join(AQUI, 'scripts/hooks/prod-access-guard.js');
let fallos = 0; let pasaron = 0;
const ok = (m) => { console.log(`✅ heredoc-readings: ${m}`); pasaron++; };
const no = (m) => { console.log(`❌ heredoc-readings: ${m}`); fallos++; };

const NI = 'production' + '-index.json';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'heredoc-readings-'));
const CASA = path.join(TMP, 'casa'); const REPOS = path.join(TMP, 'repos');
const PIPE = path.join(CASA, '.claude', '.tycon-pipeline');
fs.mkdirSync(path.join(CASA, '.claude', 'shell-snapshots'), { recursive: true });
fs.mkdirSync(path.join(PIPE, 'timing-history'), { recursive: true });
fs.mkdirSync(REPOS, { recursive: true });
fs.writeFileSync(path.join(PIPE, NI), '{}');
fs.writeFileSync(path.join(CASA, '.claude', 'shell-snapshots', `snapshot-zsh-${Date.now()}-aaaaaa.sh`),
  '# Snapshot file\n# Functions\n# Aliases\nexport PATH=/usr/bin\n');

function corre(cmd) {
  const payload = JSON.stringify({ tool_name: 'Bash', hook_event_name: 'PreToolUse', cwd: '/tmp', tool_input: { command: cmd } });
  const r = spawnSync(process.execPath, [HOOK], {
    input: payload, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, HOME: CASA, TYCON_REPOS_ROOT: REPOS, TYCON_PROD_SESSION_SINCE: '0' },
  });
  return { rc: r.status, motivo: ((r.stderr || '').match(/Motivo: (.*)/) || [])[1] || '' };
}

const BORRA = `rm -f ~/.claude/.tycon-pipeline/${NI}`;
const q = "'";
// las formas de la revisión de Fable (notas fable-S247e-A17): en todas, bash corre el borrado
const FRENAN = {
  'comilla con <<': `echo "$(echo " <<EOF\n")"\n${BORRA}\nEOF`,
  'comilla de varias líneas': `echo it${q}s\n<<EOF\n${q}a\n${BORRA}\nEOF`,
  'pid y <<B en el cuerpo': `echo $$${q}a\\${q} ; cat <<A\necho ${q} <<B\nA\n${BORRA}\nB`,
  'sustitución y <<B en el cuerpo': `echo "$(echo "it${q}s")"; cat <<A\necho ${q} <<B\nA\n${BORRA}\nB`,
  'comilla invertida y <<B': `echo \`#it${q}s\`; cat <<A\necho ${q} <<B\nA\n${BORRA}\nB`,
  'cuerpo con comilla suelta': `echo "$(echo "it${q}s")"; cat <<A\necho don${q}t\nA\n${BORRA}`,
  'pid y comilla suelta': `echo $$${q}a\\${q}; cat <<A\necho don${q}t\nA\n${BORRA}`,
  'commit y nota': `git commit -m "$(cat <<${q}EOF${q}\nmensaje\nEOF\n)" && cat > n.md <<${q}FIN${q}\necho don${q}t\nFIN\n${BORRA}`,
  'variable y nota': `MSG="$(cat <<${q}EOF${q}\ncuerpo\nEOF\n)"\ncat > n.md <<${q}FIN${q}\necho don${q}t\nFIN\n${BORRA}`,
  'comentario con <<': `# ver cat <<EOF abajo\ncat > n.md <<${q}FIN${q}\necho don${q}t\nFIN\n${BORRA}`,
  'texto con <<': `echo "usa cat <<EOF para el cuerpo"; cat > n.md <<${q}FIN${q}\nprintf "x\nFIN\n${BORRA}`,
  // en una cuenta, `<<` es un corrimiento (segunda vuelta de Fable): las dos lecturas lo tomaban por heredoc
  'cuenta de for': `for (( i = 0; i < 1 <<EOF ; i++ )); do :; done\n${BORRA}\nEOF`,
  'cuenta de time': `time (( x = 1 <<EOF ))\n${BORRA}\nEOF`,
  'cuenta vieja $[ ]': `echo $[ 1 <<EOF ]\n${BORRA}\nEOF`,
  'cuenta como cuerpo de función': `f() (( 1 <<EOF ))\n${BORRA}\nEOF`,
};
const PASAN = {
  'commit con heredoc': `git commit -m "$(cat <<${q}EOF${q}\nmensaje del commit\nEOF\n)"`,
  'commit y nota que nombra el índice': `git commit -m "$(cat <<${q}EOF${q}\nmensaje\nEOF\n)" && cat > nota.md <<${q}FIN${q}\nhoy: ${BORRA}\nFIN`,
  'texto con << y nota': `echo "a << b"; cat >> nota.md <<${q}FIN${q}\nhice git merge de la rama\nFIN`,
  'comentario con << y nota': `# la nota va con cat <<FIN\ncat >> nota.md <<${q}FIN${q}\nun texto\nFIN`,
  'cuenta con <<': `python3 -c "print(1 << 3)" && echo ok`,
};

const malos = Object.entries(FRENAN).map(([k, c]) => [k, corre(c)]).filter(([, r]) => r.rc !== 2);
if (!malos.length) ok(`T1 HeredocReadings_TextLtLt_Blocks (${Object.keys(FRENAN).length} formas)`);
else no(`T1 HeredocReadings_TextLtLt_Blocks: ${malos.map(([k, r]) => `«${k}»=${r.rc}`).join(' · ')}`);

const malos2 = Object.entries(PASAN).map(([k, c]) => [k, corre(c)]).filter(([, r]) => r.rc !== 0);
if (!malos2.length) ok(`T2 HeredocReadings_CommonForms_Pass (${Object.keys(PASAN).length} formas)`);
else no(`T2 HeredocReadings_CommonForms_Pass: ${malos2.map(([k, r]) => `«${k}»=${r.rc} ${r.motivo}`).join(' · ')}`);

// T3: un comando con las dos lecturas distintas que pasa anota lo mismo que uno de una sola lectura
const lineas = () => { try { return fs.readFileSync(path.join(PIPE, 'production.log'), 'utf8').split('\n').filter(Boolean).length; } catch (_) { return 0; } };
const antes = lineas();
const r3 = corre(`echo "x <<EOF"\necho hola\nEOF`);
const despues = lineas();
if (r3.rc === 0 && despues - antes <= 1) ok('T3 HeredocReadings_SecondReading_NoPassRecord');
else no(`T3 HeredocReadings_SecondReading_NoPassRecord: rc=${r3.rc}, ${despues - antes} línea(s) nuevas en el registro ${r3.motivo}`);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`heredoc-readings: ${pasaron} bien · ${fallos} mal`);
process.exit(fallos ? 1 : 0);
JS

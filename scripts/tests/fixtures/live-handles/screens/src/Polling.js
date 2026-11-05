// Una pantalla que consulta en un bucle: sin `stopOnUnmount`, el bucle sigue después de desmontarla (el caso real).
const React = require('react');

function Polling({ stopOnUnmount = false }) {
  React.useEffect(() => {
    let alive = true;
    let id;
    const tick = () => {
      if (!alive && stopOnUnmount) return;
      id = setTimeout(tick, 1000);
    };
    id = setTimeout(tick, 1000);
    return () => {
      alive = false;
      if (stopOnUnmount) clearTimeout(id);
    };
  }, []);
  return React.createElement('div', null, 'polling');
}

module.exports = { Polling };

// Una consulta al montar: con `abort`, la cancela al desmontar.
const React = require('react');

function Loader({ abort = false }) {
  React.useEffect(() => {
    const controller = new AbortController();
    fetch('https://api.example.test/items?token=secret', { signal: controller.signal }).catch(() => {});
    return () => {
      if (abort) controller.abort();
    };
  }, []);
  return React.createElement('div', null, 'loader');
}

module.exports = { Loader };

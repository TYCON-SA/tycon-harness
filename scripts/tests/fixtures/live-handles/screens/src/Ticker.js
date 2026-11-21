// Un intervalo que se limpia al desmontar sólo con `clear`.
const React = require('react');

function Ticker({ clear = false }) {
  React.useEffect(() => {
    const id = setInterval(() => {}, 500);
    return () => {
      if (clear) clearInterval(id);
    };
  }, []);
  return React.createElement('div', null, 'ticker');
}

module.exports = { Ticker };

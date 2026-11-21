const React = require('react');
const { render } = require('@testing-library/react');
const { Ticker } = require('../src/Ticker');

test('leaves the interval alive', () => {
  render(React.createElement(Ticker));
});

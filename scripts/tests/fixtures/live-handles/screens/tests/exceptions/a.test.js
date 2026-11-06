const leave = () => {
  setInterval(() => {}, 1000);
};

test('current', leave);
test('expired', leave);
test('without reason', leave);
test('without expires', leave);

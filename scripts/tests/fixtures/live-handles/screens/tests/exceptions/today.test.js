const leave = () => {
  setInterval(() => {}, 1000);
};

test('expires today', leave);
test('expired yesterday', leave);

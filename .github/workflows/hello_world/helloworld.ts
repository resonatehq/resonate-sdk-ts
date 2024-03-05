const resonateModule = import("@resonatehq/sdk");

resonateModule.then(({ Resonate }) => {
  const resonate = new Resonate();
  console.log("Hello World!", resonate);
});

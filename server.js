import app from "./src/catalog/server.js";

const PORT = 3000;
const HOST = "0.0.0.0";

const server = app.listen(PORT, HOST, () => {
  console.log(`ST Production House Unified server running at http://${HOST}:${PORT}`);
});

export default server;

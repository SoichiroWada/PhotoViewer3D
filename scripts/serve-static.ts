import { createStaticServer } from "../src/local-backend/staticServer";

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535.");
  const server = await createStaticServer("out");
  server.once("error", error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => console.log(`Static frontend: http://127.0.0.1:${port}`));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => server.close(error => { if (error) process.exitCode = 1; }));
  }
}
void main().catch(error => { console.error(`Static preview failed: ${error.message}. Run npm run build first.`); process.exitCode = 1; });

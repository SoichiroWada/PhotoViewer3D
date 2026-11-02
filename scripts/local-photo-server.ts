import { loadEnvConfig } from "@next/env";
import { createLocalPhotoServer, DEFAULT_PHOTO_ORIGINS } from "../src/local-backend/photoServer";

loadEnvConfig(process.cwd(), true);
const port = Number(process.env.PHOTO_API_PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PHOTO_API_PORT must be an integer from 1 to 65535.");
const allowedOrigins = process.env.PHOTO_API_ALLOWED_ORIGINS?.split(",").map(value => value.trim()).filter(Boolean) ?? DEFAULT_PHOTO_ORIGINS;
const server = createLocalPhotoServer(allowedOrigins);
server.once("error", error => { console.error("Local photo backend failed:", error.message); process.exitCode = 1; });
server.listen(port, "0.0.0.0", () => console.log(`Local photo backend listening on 0.0.0.0:${port} (all network interfaces); API: /photos. Use the server's LAN address from other devices.`));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(error => { if (error) process.exitCode = 1; }));
}

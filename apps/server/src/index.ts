import { applyPendingRestore } from "./lib/restore.ts";

if (process.env.CETUS_MODE === "worker") {
  await import("./worker.ts");
} else {
  await applyPendingRestore();
  const [{ createApp }, { config }] = await Promise.all([
    import("./http/app.ts"),
    import("./config.ts"),
  ]);
  const app = await createApp();
  app.listen({ port: config.port, hostname: config.host });

  console.log(`
  Cetus ${config.version}
  ----------------------------------------
  API      http://${config.host}:${config.port}/api/health
  Stacks   ${config.stacksDir}
  Data     ${config.dataDir}
  Mode     ${config.isProduction ? "production" : "development"}
  ----------------------------------------
`);
}

import { defineSpsPlugin, runSpsWorker } from "@sonparkserver/plugin-sdk/worker";
import { createBuilderPlatform } from "./platform.ts";

runSpsWorker(defineSpsPlugin({
  platform: createBuilderPlatform(),
  health() { return { status: "ok", message: "Builder workspace storage is ready; AI integration is not configured." }; },
  shutdown() { return null; },
}));

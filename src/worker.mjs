import { defineSpsPlugin, runSpsWorker } from "@sonparkserver/plugin-sdk/worker";
import { createBuilderPlatform } from "./platform.ts";

runSpsWorker(defineSpsPlugin({
  platform: createBuilderPlatform(),
  health() { return { status: "ok", message: "Builder storage and explicit Lead dispatch are available; provider execution requires current Host authority." }; },
  shutdown() { return null; },
}));

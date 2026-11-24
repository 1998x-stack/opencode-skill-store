import { Plugin } from "@opencode/plugin"
import { loadConfig } from "./config.js"
import { SkillStoreRPC } from "./contracts.js"
import { InstallManager } from "./installer/manager.js"
import { StoreClient } from "./store/client.js"

export default Plugin.define({
  id: "1998x.skill-store",
  async setup(ctx) {
    const config = loadConfig(ctx.options, ctx.location)
    const store = new StoreClient(config)
    const manager = new InstallManager(ctx, store, config)

    await manager.initialize()
    const registration = await ctx.rpc.register(SkillStoreRPC, manager.handlers())
    manager.setEmitter((name, data) => registration.events.emit(name, data as never))

    return async () => {
      await registration.dispose()
      await manager.close()
    }
  },
})

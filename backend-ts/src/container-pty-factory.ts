import type { SpawnPtyOptions, PtyLike } from './harness/terminal/remote-terminal.js';
import type { ContainerRegistry } from './harness/container/container-registry.js';
import type { RuntimeChannelServer } from './harness/container/runtime-channel-server.js';
import type { DockerToolRouter } from './harness/container/docker-tool-router.js';
import { PtyChannelHub } from './harness/container/pty-bridge.js';
import { harnessLog } from './harness/log.js';

export interface ContainerPtyFactoryDeps {
  dockerRouter: DockerToolRouter;
  containerRegistry: ContainerRegistry;
  channelServer: RuntimeChannelServer;
  ptyChannelHubs: Map<number, PtyChannelHub>;
  ptyHubGeneration: Map<number, number>;
  nodePtyFactory: (options: SpawnPtyOptions) => Promise<PtyLike> | PtyLike;
}

export function createContainerPtyFactory(deps: ContainerPtyFactoryDeps): (options: SpawnPtyOptions) => Promise<PtyLike> {
  const { dockerRouter, containerRegistry, channelServer, ptyChannelHubs, ptyHubGeneration, nodePtyFactory } = deps;

  return async (options: SpawnPtyOptions): Promise<PtyLike> => {
    const userId = options.userId;
    if (userId != null && await dockerRouter.enabledFor(userId)) {
      // cwd 即会话工作区：通道会话（飞书/钉钉）越出每用户根，未挂载时先重建容器
      const entry = await containerRegistry.ensureRunning(userId, options.cwd);
      const connection = channelServer.getConnection(userId);
      if (!connection) throw new Error(`容器终端通道未就绪: userId=${userId}`);
      let hub = ptyChannelHubs.get(userId);
      if (!hub || ptyHubGeneration.get(userId) !== entry.startedAtMs) {
        hub?.dispose();
        hub = new PtyChannelHub(connection);
        ptyChannelHubs.set(userId, hub);
        ptyHubGeneration.set(userId, entry.startedAtMs);
      } else {
        hub.bindConnection(connection);
      }
      const bridge = await hub.open(userId, options);
      harnessLog('info', `[container] terminal pty opened in container: user=${userId}, pid=${bridge.pid}`);
      return bridge;
    }
    return nodePtyFactory(options);
  };
}

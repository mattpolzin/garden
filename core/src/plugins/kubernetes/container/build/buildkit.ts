/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import AsyncLock from "async-lock"
import chalk from "chalk"
import split2 = require("split2")
import { isEmpty } from "lodash"
import { buildSyncVolumeName, dockerAuthSecretKey } from "../../constants"
import { KubeApi } from "../../api"
import { KubernetesDeployment } from "../../types"
import { LogEntry } from "../../../../logger/log-entry"
import { waitForResources, compareDeployedResources } from "../../status/status"
import { KubernetesProvider, KubernetesPluginContext, ClusterBuildkitCacheConfig } from "../../config"
import { PluginContext } from "../../../../plugin-context"
import {
  BuildStatusHandler,
  skopeoBuildStatus,
  BuildHandler,
  syncToBuildSync,
  getSocatContainer,
  getUtilContainer,
  utilRsyncPort,
  ensureBuilderSecret,
  builderToleration,
} from "./common"
import { getNamespaceStatus } from "../../namespace"
import { LogLevel } from "../../../../logger/logger"
import { renderOutputStream, sleep } from "../../../../util/util"
import { ContainerModule } from "../../../container/config"
import { getDockerBuildArgs } from "../../../container/build"
import { getRunningDeploymentPod, millicpuToString, megabytesToString, usingInClusterRegistry } from "../../util"
import { PodRunner } from "../../run"
import { prepareSecrets } from "../../secrets"
import { ContainerModuleOutputs } from "../../../container/container"

export const buildkitImageName = "gardendev/buildkit:v0.9.3-1"
export const buildkitDeploymentName = "garden-buildkit"
const buildkitContainerName = "buildkitd"

const deployLock = new AsyncLock()

export const getBuildkitBuildStatus: BuildStatusHandler = async (params) => {
  const { ctx, module, log } = params
  const k8sCtx = ctx as KubernetesPluginContext
  const provider = k8sCtx.provider

  const api = await KubeApi.factory(log, ctx, provider)
  const namespace = (await getNamespaceStatus({ log, ctx, provider })).namespaceName

  const { authSecret } = await ensureBuildkit({
    ctx,
    provider,
    log,
    api,
    namespace,
  })

  return skopeoBuildStatus({
    namespace,
    deploymentName: buildkitDeploymentName,
    containerName: getUtilContainer(authSecret.metadata.name).name,
    log,
    api,
    ctx,
    provider,
    module,
  })
}

export const buildkitBuildHandler: BuildHandler = async (params) => {
  const { ctx, module, log } = params
  const provider = <KubernetesProvider>ctx.provider
  const api = await KubeApi.factory(log, ctx, provider)
  const namespace = (await getNamespaceStatus({ log, ctx, provider })).namespaceName

  await ensureBuildkit({
    ctx,
    provider,
    log,
    api,
    namespace,
  })

  const localId = module.outputs["local-image-id"]
  const dockerfile = module.spec.dockerfile || "Dockerfile"

  const { contextPath } = await syncToBuildSync({
    ...params,
    ctx: ctx as KubernetesPluginContext,
    api,
    namespace,
    deploymentName: buildkitDeploymentName,
    rsyncPort: utilRsyncPort,
  })

  log.setState(`Building image ${localId}...`)

  let buildLog = ""

  // Stream verbose logs to a status line
  const outputStream = split2()
  const statusLine = log.placeholder({ level: LogLevel.verbose })

  outputStream.on("error", () => {})
  outputStream.on("data", (line: Buffer) => {
    ctx.events.emit("log", { timestamp: new Date().getTime(), data: line })
    statusLine.setState(renderOutputStream(line.toString()))
  })

  const command = [
    "buildctl",
    "build",
    "--frontend=dockerfile.v0",
    "--local",
    "context=" + contextPath,
    "--local",
    "dockerfile=" + contextPath,
    "--opt",
    "filename=" + dockerfile,
    ...getBuildkitImageFlags(
      provider.config.clusterBuildkit!.cache,
      module.outputs,
      provider.config.deploymentRegistry!.insecure
    ),
    ...getBuildkitModuleFlags(module),
  ]

  // Execute the build
  const buildTimeout = module.spec.build.timeout

  const pod = await getRunningDeploymentPod({ api, deploymentName: buildkitDeploymentName, namespace })

  const runner = new PodRunner({
    api,
    ctx,
    provider,
    namespace,
    pod,
  })

  const buildRes = await runner.exec({
    log,
    command,
    timeoutSec: buildTimeout,
    containerName: buildkitContainerName,
    stdout: outputStream,
    stderr: outputStream,
    buffer: true,
  })

  buildLog = buildRes.log

  log.silly(buildLog)

  return {
    buildLog,
    fetched: false,
    fresh: true,
    version: module.version.versionString,
  }
}

export async function ensureBuildkit({
  ctx,
  provider,
  log,
  api,
  namespace,
}: {
  ctx: PluginContext
  provider: KubernetesProvider
  log: LogEntry
  api: KubeApi
  namespace: string
}) {
  return deployLock.acquire(namespace, async () => {
    const deployLog = log.placeholder()

    // Make sure auth secret is in place
    const { authSecret, updated: secretUpdated } = await ensureBuilderSecret({
      provider,
      log,
      api,
      namespace,
    })

    const imagePullSecrets = await prepareSecrets({ api, namespace, secrets: provider.config.imagePullSecrets, log })

    // Check status of the buildkit deployment
    const manifest = getBuildkitDeployment(provider, authSecret.metadata.name, imagePullSecrets)
    const status = await compareDeployedResources(ctx as KubernetesPluginContext, api, namespace, [manifest], deployLog)

    if (status.state === "ready") {
      // Need to wait a little to ensure the secret is updated in the deployment
      if (secretUpdated) {
        await sleep(1000)
      }
      return { authSecret, updated: false }
    }

    // Deploy the buildkit daemon
    deployLog.setState(
      chalk.gray(`-> Deploying ${buildkitDeploymentName} daemon in ${namespace} namespace (was ${status.state})`)
    )

    await api.upsert({ kind: "Deployment", namespace, log: deployLog, obj: manifest })

    await waitForResources({
      namespace,
      ctx,
      provider,
      serviceName: "garden-buildkit",
      resources: [manifest],
      log: deployLog,
      timeoutSec: 600,
    })

    deployLog.setState({ append: true, msg: "Done!" })

    return { authSecret, updated: true }
  })
}

export function getBuildkitModuleFlags(module: ContainerModule) {
  const args: string[] = []

  for (const arg of getDockerBuildArgs(module)) {
    args.push("--opt", "build-arg:" + arg)
  }

  if (module.spec.build.targetImage) {
    args.push("--opt", "target=" + module.spec.build.targetImage)
  }

  args.push(...(module.spec.extraFlags || []))

  return args
}

export function getBuildkitImageFlags(
  cacheConfig: ClusterBuildkitCacheConfig[],
  moduleOutputs: ContainerModuleOutputs,
  deploymentRegistryInsecure: boolean
) {
  const args: string[] = []

  const inlineCaches = cacheConfig.filter(
    (config) => getSupportedCacheMode(config, getCacheImageName(moduleOutputs, config)) === "inline"
  )
  const imageNames = [moduleOutputs["deployment-image-id"]]

  if (inlineCaches.length > 0) {
    args.push("--export-cache", "type=inline")

    for (const cache of inlineCaches) {
      const cacheImageName = getCacheImageName(moduleOutputs, cache)
      imageNames.push(`${cacheImageName}:${cache.tag}`)
    }
  }

  let deploymentRegistryExtraSpec = ""
  if (deploymentRegistryInsecure) {
    deploymentRegistryExtraSpec = ",registry.insecure=true"
  }

  args.push("--output", `type=image,"name=${imageNames.join(",")}",push=true${deploymentRegistryExtraSpec}`)

  for (const cache of cacheConfig) {
    const cacheImageName = getCacheImageName(moduleOutputs, cache)

    let registryExtraSpec = ""
    if (cache.registry === undefined) {
      registryExtraSpec = deploymentRegistryExtraSpec
    } else if (cache.registry?.insecure === true) {
      registryExtraSpec = ",registry.insecure=true"
    }

    // subtle: it is important that --import-cache arguments are in the same order as the cacheConfigs
    // buildkit will go through them one by one, and use the first that has any cache hit for all following
    // layers, so it will actually never use multiple caches at once
    args.push("--import-cache", `type=registry,ref=${cacheImageName}:${cache.tag}${registryExtraSpec}`)

    if (cache.export === false) {
      continue
    }

    const cacheMode = getSupportedCacheMode(cache, cacheImageName)
    // we handle inline caches above
    if (cacheMode === "inline") {
      continue
    }

    args.push(
      "--export-cache",
      `type=registry,ref=${cacheImageName}:${cache.tag},mode=${cacheMode}${registryExtraSpec}`
    )
  }

  return args
}

function getCacheImageName(moduleOutputs: ContainerModuleOutputs, cacheConfig: ClusterBuildkitCacheConfig): string {
  if (cacheConfig.registry === undefined) {
    return moduleOutputs["deployment-image-name"]
  }

  const { hostname, port, namespace } = cacheConfig.registry
  const portPart = port ? `:${port}` : ""
  return `${hostname}${portPart}/${namespace}/${moduleOutputs["local-image-name"]}`
}

export const getSupportedCacheMode = (
  cache: ClusterBuildkitCacheConfig,
  deploymentImageName: string
): ClusterBuildkitCacheConfig["mode"] => {
  if (cache.mode !== "auto") {
    return cache.mode
  }

  // Detect AWS ECR
  if (deploymentImageName.includes(".dkr.ecr.")) {
    return "inline"
  }

  // Detect gcr.io
  if (deploymentImageName.includes("gcr.io")) {
    return "inline"
  }

  // Default to true for all others
  return "max"
}

export function getBuildkitDeployment(
  provider: KubernetesProvider,
  authSecretName: string,
  imagePullSecrets: { name: string }[]
) {
  const deployment: KubernetesDeployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      labels: {
        app: buildkitDeploymentName,
      },
      name: buildkitDeploymentName,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: buildkitDeploymentName,
        },
      },
      template: {
        metadata: {
          labels: {
            app: buildkitDeploymentName,
          },
        },
        spec: {
          containers: [
            {
              name: buildkitContainerName,
              image: buildkitImageName,
              args: ["--addr", "unix:///run/buildkit/buildkitd.sock"],
              readinessProbe: {
                exec: {
                  command: ["buildctl", "debug", "workers"],
                },
                initialDelaySeconds: 3,
                periodSeconds: 5,
              },
              livenessProbe: {
                exec: {
                  command: ["buildctl", "debug", "workers"],
                },
                initialDelaySeconds: 5,
                periodSeconds: 30,
              },
              securityContext: {
                privileged: true,
              },
              volumeMounts: [
                {
                  name: authSecretName,
                  mountPath: "/.docker",
                  readOnly: true,
                },
                {
                  name: buildSyncVolumeName,
                  mountPath: "/garden-build",
                },
              ],
              env: [
                {
                  name: "DOCKER_CONFIG",
                  value: "/.docker",
                },
              ],
            },
            // Attach a util container for the rsync server and to use skopeo
            getUtilContainer(authSecretName),
          ],
          imagePullSecrets,
          volumes: [
            {
              name: authSecretName,
              secret: {
                secretName: authSecretName,
                items: [
                  {
                    key: dockerAuthSecretKey,
                    path: "config.json",
                  },
                ],
              },
            },
            {
              name: buildSyncVolumeName,
              emptyDir: {},
            },
          ],
          tolerations: [builderToleration],
        },
      },
    },
  }

  const buildkitContainer = deployment.spec!.template.spec!.containers[0]

  // Optionally run buildkit in rootless mode
  if (!!provider.config.clusterBuildkit?.rootless) {
    deployment.spec!.template.metadata!.annotations = {
      "container.apparmor.security.beta.kubernetes.io/buildkitd": "unconfined",
      "container.seccomp.security.alpha.kubernetes.io/buildkitd": "unconfined",
    }
    buildkitContainer.image += "-rootless"
    buildkitContainer.args = [
      "--addr",
      "unix:///run/user/1000/buildkit/buildkitd.sock",
      "--oci-worker-no-process-sandbox",
    ]
    buildkitContainer.securityContext = {
      runAsUser: 1000,
      runAsGroup: 1000,
    }
  }

  buildkitContainer.resources = {
    limits: {
      cpu: millicpuToString(provider.config.resources.builder.limits.cpu),
      memory: megabytesToString(provider.config.resources.builder.limits.memory),
      ...(provider.config.resources.builder.limits.ephemeralStorage
        ? { "ephemeral-storage": megabytesToString(provider.config.resources.builder.limits.ephemeralStorage) }
        : {}),
    },
    requests: {
      cpu: millicpuToString(provider.config.resources.builder.requests.cpu),
      memory: megabytesToString(provider.config.resources.builder.requests.memory),
      ...(provider.config.resources.builder.requests.ephemeralStorage
        ? { "ephemeral-storage": megabytesToString(provider.config.resources.builder.requests.ephemeralStorage) }
        : {}),
    },
  }

  if (usingInClusterRegistry(provider)) {
    // We need a proxy sidecar to be able to reach the in-cluster registry from the Pod
    deployment.spec!.template.spec!.containers.push(getSocatContainer(provider))
  }

  // Set the configured nodeSelector, if any
  if (!isEmpty(provider.config.clusterBuildkit?.nodeSelector)) {
    deployment.spec!.template.spec!.nodeSelector = provider.config.clusterBuildkit?.nodeSelector
  }

  return deployment
}

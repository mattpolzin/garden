/*
 * Copyright (C) 2018-2024 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import type { V1PodSpec } from "@kubernetes/client-node"
import {
  skopeoDaemonContainerName,
  dockerAuthSecretKey,
  defaultNixImageName,
  getK8sUtilImageName,
} from "../../constants.js"
import { KubeApi } from "../../api.js"
import type { Log } from "../../../../logger/log-entry.js"
import type { KubernetesProvider, KubernetesPluginContext } from "../../config.js"
import { BuildError, ConfigurationError } from "../../../../exceptions.js"
import { PodRunner } from "../../run.js"
import { ensureNamespace, getNamespaceStatus, getSystemNamespace } from "../../namespace.js"
import { prepareSecrets } from "../../secrets.js"
import { dedent } from "../../../../util/string.js"
import type { RunResult } from "../../../../plugin/base.js"
import type { PluginContext } from "../../../../plugin-context.js"
import type { KubernetesPod } from "../../types.js"
import type { BuildStatusHandler, BuildHandler } from "./common.js"
import {
  skopeoBuildStatus,
  utilRsyncPort,
  syncToBuildSync,
  ensureBuilderSecret,
  commonSyncArgs,
  builderToleration,
  ensureUtilDeployment,
  utilDeploymentName,
  inClusterBuilderServiceAccount,
  ensureServiceAccount,
} from "./common.js"
import { differenceBy, isEmpty } from "lodash-es"
import { k8sGetContainerBuildActionOutputs } from "../handlers.js"
import { stringifyResources } from "../util.js"
import { makePodName } from "../../util.js"
import type { ContainerBuildAction } from "../../../container/config.js"
import { styles } from "../../../../logger/styles.js"
import { commandListToShellScript } from "../../../../util/escape.js"

export const DEFAULT_NIX_FLAGS = []

const sharedVolumeName = "comms"
const sharedMountPath = "/.garden"
const contextPath = sharedMountPath + "/context"

export const getNixBuildStatus: BuildStatusHandler = async (params) => {
  const { ctx, action, log } = params
  const k8sCtx = ctx as KubernetesPluginContext
  const provider = k8sCtx.provider

  const api = await KubeApi.factory(log, ctx, provider)
  const namespace = (await getNamespaceStatus({ log, ctx: k8sCtx, provider })).namespaceName

  await ensureUtilDeployment({
    ctx,
    provider,
    log,
    api,
    namespace,
  })

  return skopeoBuildStatus({
    namespace,
    deploymentName: utilDeploymentName,
    containerName: skopeoDaemonContainerName,
    log,
    api,
    ctx,
    provider,
    action,
  })
}

function providerIsOpenShiftLocal(provider: KubernetesProvider) {
  return provider.config.deploymentRegistry?.hostname === "default-route-openshift-image-registry.apps-crc.testing"
}


export const nixBuild: BuildHandler = async (params) => {
  const { ctx, action, log } = params
  const provider = <KubernetesProvider>ctx.provider
  const api = await KubeApi.factory(log, ctx, provider)
  const k8sCtx = ctx as KubernetesPluginContext

  const projectNamespace = (await getNamespaceStatus({ log, ctx: k8sCtx, provider })).namespaceName

  const spec = action.getSpec()

  if (spec.secrets) {
    throw new ConfigurationError({
      message: dedent`
        The Nix builder does not support secret build arguments.
        Garden Cloud Builder and the Kubernetes BuildKit in-cluster builder both support secrets.
      `,
    })
  }

  const outputs = k8sGetContainerBuildActionOutputs({ provider, action })

  const localId = outputs.localImageId
  const deploymentImageId = outputs.deploymentImageId
  const nixfile = spec.nixfile

  if (!nixfile) {
    throw new ConfigurationError({
      message: dedent`
        The Nix builder requires the \`spec.nixfile\` configuration to point to a Nix file
        that produces a derivation that builds a Docker image.
      `,
    })
  }

  const platforms = action.getSpec().platforms
  if (platforms && platforms.length > 1) {
    throw new ConfigurationError({
      message: dedent`Failed building ${styles.bold(action.name)}.
          The Nix builder does not currently support multi-platform builds.
        `,
    })
  }

  let { authSecret } = await ensureUtilDeployment({
    ctx,
    provider,
    log,
    api,
    namespace: projectNamespace,
  })

  await syncToBuildSync({
    ...params,
    ctx: ctx as KubernetesPluginContext,
    api,
    namespace: projectNamespace,
    deploymentName: utilDeploymentName,
  })

  log.info(`Building image ${localId}...`)

  // Use the project namespace by default
  let nixNamespace = provider.config.nix?.namespace || projectNamespace

  if (!nixNamespace) {
    nixNamespace = await getSystemNamespace(k8sCtx, provider, log)
  }

  await ensureNamespace(api, k8sCtx, { name: nixNamespace }, log)

  if (nixNamespace !== projectNamespace) {
    // Make sure the Kaniko Pod namespace has the auth secret ready
    const secretRes = await ensureBuilderSecret({
      provider,
      log: log.createLog(),
      api,
      namespace: nixNamespace,
    })

    authSecret = secretRes.authSecret

    // Make sure the Kaniko Pod namespace has the garden-in-cluster-builder service account
    await ensureServiceAccount({
      ctx,
      log,
      api,
      namespace: nixNamespace,
    })
  }

  // Execute the build
  const args = [
    ...getNixFlags(spec.extraFlags, provider.config.nix?.extraFlags),
    contextPath + "/" + nixfile
  ]

  const buildRes = await runNix({
    ctx,
    provider,
    log,
    nixNamespace,
    utilNamespace: projectNamespace,
    authSecretName: authSecret.metadata.name,
    action,
    args,
    deploymentImageId,
  })

  const buildLog = buildRes.log

  if (nixBuildFailed(buildRes)) {
    throw new BuildError({
      message: `Failed building ${styles.bold(action.name)}:\n\n${buildLog}`,
    })
  }

  log.silly(() => buildLog)

  return {
    state: "ready",
    outputs,
    detail: {
      buildLog,
      fetched: false,
      fresh: true,
      outputs,
      runtime: {
        actual: {
          kind: "remote",
          type: "plugin",
          pluginName: ctx.provider.name,
        },
      },
    },
  }
}

export const getNixFlags = (flags?: string[], topLevelFlags?: string[]): string[] => {
  if (!flags && !topLevelFlags) {
    return DEFAULT_NIX_FLAGS
  }
  const flagToKey = (flag: string) => {
    const found = flag.match(/--([a-zA-Z-]*)/)
    if (found === null) {
      throw new ConfigurationError({
        message: `Invalid format for a nix flag. Expected it to match /--([a-zA-Z-]*)/, actually got: ${flag}`,
      })
    }
    return found[0]
  }
  const defaultsToKeep = differenceBy(DEFAULT_NIX_FLAGS, flags || topLevelFlags || [], flagToKey)
  const topLevelToKeep = differenceBy(topLevelFlags || [], flags || [], flagToKey)
  return [...(flags || []), ...topLevelToKeep, ...defaultsToKeep]
}

export function nixBuildFailed(buildRes: RunResult) {
  return (
    !buildRes.success &&
    !(
      buildRes.log.includes("error pushing image: ") &&
      buildRes.log.includes("cannot be overwritten because the repository is immutable.")
    )
  )
}

interface RunNixParams {
  ctx: PluginContext
  provider: KubernetesProvider
  nixNamespace: string
  utilNamespace: string
  authSecretName: string
  log: Log
  action: ContainerBuildAction
  args: string[],
  deploymentImageId: string
}

export function getNixBuilderPodManifest({
  provider,
  nixNamespace,
  authSecretName,
  syncArgs,
  imagePullSecrets,
  sourceUrl,
  podName,
  nixCommand,
  skopeoPushCommand,
}: {
  provider: KubernetesProvider
  nixNamespace: string
  authSecretName: string
  syncArgs: string[]
  imagePullSecrets: {
    name: string
  }[]
  sourceUrl: string
  podName: string
  nixCommand: string[]
  skopeoPushCommand: string[]
}) {
  const nixImage = provider.config.nix?.image || defaultNixImageName
  const nixTolerations = [...(provider.config.nix?.tolerations || []), builderToleration]

  const spec: V1PodSpec = {
    shareProcessNamespace: true,
    volumes: [
      // Mount the docker auth secret, so Kaniko can pull from private registries.
      {
        name: authSecretName,
        secret: {
          secretName: authSecretName,
          items: [{ key: dockerAuthSecretKey, path: "config.json" }],
        },
      },
      // Mount a volume to communicate between the containers in the Pod.
      {
        name: sharedVolumeName,
        emptyDir: {},
      },
    ],
    imagePullSecrets,
    // Start by rsyncing the build context from the util deployment
    initContainers: [
      {
        name: "init",
        image: getK8sUtilImageName(),
        command: [
          "/bin/sh",
          "-c",
          dedent`
            echo "Copying from $SYNC_SOURCE_URL to $SYNC_CONTEXT_PATH"
            mkdir -p "$SYNC_CONTEXT_PATH"
            n=0
            until [ "$n" -ge 30 ]
            do
              rsync ${commandListToShellScript({ command: syncArgs })} && break
              n=$((n+1))
              sleep 1
            done
            echo "Done!"
          `,
        ],
        imagePullPolicy: "IfNotPresent",
        env: [
          {
            name: "SYNC_SOURCE_URL",
            value: sourceUrl,
          },
          {
            name: "SYNC_CONTEXT_PATH",
            value: contextPath,
          },
        ],
        volumeMounts: [
          {
            name: sharedVolumeName,
            mountPath: sharedMountPath,
          },
        ],
      },
    ],
    containers: [
      {
        name: "nix",
        image: nixImage,
        command: [
          "/bin/sh",
          "-c",
          dedent`
            set -x
            ${commandListToShellScript({ command: nixCommand })};
            export exitcode=$?;
            if [ $exitcode = 0 ]; then
              ${commandListToShellScript({ command: skopeoPushCommand })};
              export exitcode=$?;
            fi
            ${commandListToShellScript({ command: ["touch", `${sharedMountPath}/done`] })};
            exit $exitcode;
          `,
        ],
        volumeMounts: [
          {
            name: authSecretName,
            mountPath: "/kaniko/.docker",
            readOnly: true,
          },
          {
            name: sharedVolumeName,
            mountPath: sharedMountPath,
          },
        ],
        resources: stringifyResources(provider.config.resources.builder),
      },
    ],
    tolerations: nixTolerations,
    serviceAccountName: inClusterBuilderServiceAccount,
  }

  const pod: KubernetesPod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      namespace: nixNamespace,
      annotations: provider.config.nix?.annotations,
    },
    spec,
  }

  return pod
}

function nixShellCmd(packages: string[], cmd: string[]): string[] {
  const packageArgs = packages.flatMap((packageName) => ["-p", packageName])
  return [
    "nix-shell",
    ...packageArgs,
    "--run",
    cmd.join(" ")
  ]
}

async function runNix({
  ctx,
  provider,
  nixNamespace,
  utilNamespace,
  authSecretName,
  log,
  action,
  args,
  deploymentImageId,
}: RunNixParams): Promise<RunResult> {
  const api = await KubeApi.factory(log, ctx, provider)

  const podName = makePodName("nix", action.name)

  const skopeoCopyArgs: string[] = [
    "--dest-authfile=/kaniko/.docker/config.json",
    "--insecure-policy"
  ]

  const isOpenShiftLocal = providerIsOpenShiftLocal(provider)

  // The registry in OpenShift Local requires TLS and comes with a self-signed certificate
  if (isOpenShiftLocal || provider.config.deploymentRegistry?.insecure === true) {
    skopeoCopyArgs.push("--dest-tls-verify=false")
  }

  const nixCommand = ["nix-build", ...args]
  const skopeoPushCommand = nixShellCmd(["skopeo"], [
    "skopeo",
    "copy",
    ...skopeoCopyArgs,
    "docker-archive://result",
    `docker://${deploymentImageId}`
  ])

  const utilHostname = `${utilDeploymentName}.${utilNamespace}.svc.cluster.local`
  const sourceUrl = `rsync://${utilHostname}:${utilRsyncPort}/volume/${ctx.workingCopyId}/${action.name}/`
  const imagePullSecrets = await prepareSecrets({
    api,
    namespace: nixNamespace,
    secrets: provider.config.imagePullSecrets,
    log,
  })

  const syncArgs = [...commonSyncArgs, sourceUrl, contextPath]

  const pod = getNixBuilderPodManifest({
    provider,
    podName,
    sourceUrl,
    syncArgs,
    imagePullSecrets,
    nixCommand,
    nixNamespace,
    authSecretName,
    skopeoPushCommand,
  })

  // Set the configured nodeSelector, if any
  if (!isEmpty(provider.config.nix?.nodeSelector)) {
    pod.spec.nodeSelector = provider.config.nix?.nodeSelector
  }

  const runner = new PodRunner({
    ctx,
    logEventContext: {
      origin: "nix",
      level: "verbose",
    },
    api,
    pod,
    provider,
    namespace: nixNamespace,
  })

  const timeoutSec = action.getConfig("timeout")

  const result = await runner.runAndWait({
    log,
    remove: true,
    events: ctx.events,
    timeoutSec,
    tty: false,
  })

  return result
}

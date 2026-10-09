import { useAtomValue } from "@effect/atom-react";
import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import {
  connectPairingUrl as connectPairingUrlAtom,
  updateBearerConnection,
} from "../../connection/onboarding";
import { appAtomRegistry } from "../../state/atom-registry";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { relayManagedEnvironmentIds } from "./environmentSections";

export interface RelayEnvironmentView {
  readonly environment: RelayClientEnvironmentRecord;
  readonly availability: "checking" | "online" | "offline" | "error";
  readonly status: RelayEnvironmentStatusResponse | null;
  readonly error: string | null;
  readonly traceId: string | null;
}

export function useConnectionController() {
  const connectedEnvironments = useWorkspaceEnvironments();
  const discovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const connectPairingUrlMutation = useAtomCommand(connectPairingUrlAtom, {
    reportFailure: false,
  });
  const updateBearer = useAtomCommand(updateBearerConnection, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const registerEnvironment = useAtomCommand(environmentCatalog.register, "environment register");
  const removeEnvironmentMutation = useAtomCommand(environmentCatalog.remove, "environment remove");
  const retryEnvironmentMutation = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const setEnvironmentEnabledMutation = useAtomCommand(
    environmentCatalog.setEnabled,
    "environment toggle",
  );
  const refreshRelayEnvironments = useAtomCommand(
    relayEnvironmentDiscovery.refresh,
    "relay environment refresh",
  );

  const registeredIds = useMemo(
    () => relayManagedEnvironmentIds(connectedEnvironments),
    [connectedEnvironments],
  );
  const relayEnvironments = useMemo<ReadonlyArray<RelayEnvironmentView>>(
    () =>
      [...discovery.environments.values()].map((entry) => ({
        environment: entry.environment,
        availability: entry.availability,
        status: Option.getOrNull(entry.status),
        error: Option.getOrNull(entry.error)?.message ?? null,
        traceId: Option.getOrNull(entry.error)?.traceId ?? null,
      })),
    [discovery.environments],
  );
  const availableRelayEnvironments = useMemo(
    () => relayEnvironments.filter((entry) => !registeredIds.has(entry.environment.environmentId)),
    [registeredIds, relayEnvironments],
  );

  const connectPairingUrl = useCallback(
    (pairingUrl: string, expectedEnvironmentId?: EnvironmentId) =>
      connectPairingUrlMutation({
        pairingUrl,
        ...(expectedEnvironmentId === undefined ? {} : { expectedEnvironmentId }),
      }),
    [connectPairingUrlMutation],
  );
  const connectRelayEnvironment = useCallback(
    (environment: RelayClientEnvironmentRecord) =>
      registerEnvironment(
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({
            environmentId: environment.environmentId,
            label: environment.label,
          }),
        }),
      ),
    [registerEnvironment],
  );
  const removeEnvironment = useCallback(
    (environmentId: EnvironmentId) => removeEnvironmentMutation(environmentId),
    [removeEnvironmentMutation],
  );
  const retryEnvironment = useCallback(
    (environmentId: EnvironmentId) => retryEnvironmentMutation(environmentId),
    [retryEnvironmentMutation],
  );
  const setEnvironmentEnabled = useCallback(
    (environmentId: EnvironmentId, enabled: boolean) =>
      setEnvironmentEnabledMutation({ environmentId, enabled }),
    [setEnvironmentEnabledMutation],
  );
  const updateEnvironment = useCallback(
    async (
      environmentId: EnvironmentId,
      updates: { readonly label: string; readonly displayUrl: string },
    ) => {
      // The name every device shows is a server setting, so a new label goes
      // there first, while the connection is up: saving the route below
      // restarts it. A server that cannot keep a name, or one this device
      // cannot reach or configure, only gets the label saved on this device.
      const current = connectedEnvironments.find(
        (environment) => environment.environmentId === environmentId,
      );
      if (
        updates.label !== "" &&
        current?.connectionState === "connected" &&
        updates.label !== current.environmentLabel &&
        appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.environment
          .capabilities.environmentName === true &&
        readEnvironmentScope(environmentId, AuthSettingsWriteScope)
      ) {
        const renamed = await updateSettings({
          environmentId,
          input: { patch: { environmentName: updates.label } },
        });
        if (AsyncResult.isFailure(renamed)) return renamed;
      }
      return updateBearer({
        environmentId,
        label: updates.label,
        httpBaseUrl: updates.displayUrl,
      });
    },
    [connectedEnvironments, updateBearer, updateSettings],
  );

  return {
    connectedEnvironments,
    relayEnvironments,
    availableRelayEnvironments,
    relayDiscovery: {
      isRefreshing: discovery.refreshing,
      isOffline: discovery.offline,
      error: Option.getOrNull(discovery.error)?.message ?? null,
      errorTraceId: Option.getOrNull(discovery.error)?.traceId ?? null,
    },
    connectPairingUrl,
    connectRelayEnvironment,
    removeEnvironment,
    retryEnvironment,
    setEnvironmentEnabled,
    updateEnvironment,
    refreshRelayEnvironments,
  };
}

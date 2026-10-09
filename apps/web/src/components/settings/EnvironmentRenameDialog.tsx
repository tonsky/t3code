import {
  AuthSettingsWriteScope,
  ENVIRONMENT_NAME_MAX_LENGTH,
  type ServerConfig,
} from "@t3tools/contracts";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

/**
 * Why the environment cannot be renamed, in the order the user can do
 * something about it. Null means it can.
 */
export function resolveEnvironmentRenameLock(input: {
  readonly serverConfig: ServerConfig | null;
  readonly settingsAccess: "granted" | "denied";
}): string | null {
  if (input.serverConfig === null) {
    return "Connect to this environment to rename it.";
  }
  if (input.serverConfig.environment.capabilities.environmentName !== true) {
    return "This environment's server is too old to keep a name. Update it to rename it.";
  }
  if (input.settingsAccess !== "granted") {
    return "Your session on this environment cannot change its settings.";
  }
  return null;
}

/**
 * The `environmentName` to store for what the user typed. Empty, or the
 * environment's own default name, clears the rename instead of pinning a copy
 * of the default that would outlive a host name change.
 */
export function resolveEnvironmentNameSetting(input: string, defaultName: string): string {
  const name = input.trim();
  return name === defaultName ? "" : name;
}

/**
 * "Rename environment" dialog for an environment's row menu. The name is a
 * server setting, so it follows the environment to every connected device.
 * Locked environments still open the dialog and show the reason.
 */
export function EnvironmentRenameDialog({
  environment,
  open,
  onOpenChange,
}: {
  readonly environment: EnvironmentPresentation;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <EnvironmentRenameForm environment={environment} onClose={() => onOpenChange(false)} />
      </DialogPopup>
    </Dialog>
  );
}

// Mounted with the popup, so each opening starts from the current name.
function EnvironmentRenameForm({
  environment,
  onClose,
}: {
  readonly environment: EnvironmentPresentation;
  readonly onClose: () => void;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environment.environmentId);
  const settingsAccess = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope)
    ? "granted"
    : "denied";
  const lock = resolveEnvironmentRenameLock({
    serverConfig: environment.serverConfig,
    settingsAccess,
  });
  const defaultName = environment.entry.target.label;
  const [name, setName] = useState(environment.label);

  const save = () => {
    if (lock !== null) return;
    const environmentName = resolveEnvironmentNameSetting(name, defaultName);
    if (environmentName !== (environment.serverConfig?.settings.environmentName ?? "")) {
      updateSettings({ environmentName });
    }
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename environment</DialogTitle>
        <DialogDescription>
          Every device connected to this environment shows the new name.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Environment name</span>
          <Input
            aria-label="Environment name"
            autoFocus
            disabled={lock !== null}
            maxLength={ENVIRONMENT_NAME_MAX_LENGTH}
            placeholder={defaultName}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                save();
              }
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {lock ?? `Leave empty to go back to ${defaultName}.`}
        </p>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={lock !== null} onClick={save}>
          Save
        </Button>
      </DialogFooter>
    </>
  );
}

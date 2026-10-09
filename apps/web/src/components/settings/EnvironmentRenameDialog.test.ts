import type { ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveEnvironmentNameSetting,
  resolveEnvironmentRenameLock,
} from "./EnvironmentRenameDialog";

const config = (environmentName: boolean | undefined) =>
  ({
    environment: { capabilities: environmentName === undefined ? {} : { environmentName } },
  }) as unknown as ServerConfig;

describe("resolveEnvironmentRenameLock", () => {
  it("locks until the environment is connected", () => {
    expect(resolveEnvironmentRenameLock({ serverConfig: null, settingsAccess: "granted" })).toMatch(
      /Connect/,
    );
  });

  it("locks on servers that predate the setting, before looking at permissions", () => {
    expect(
      resolveEnvironmentRenameLock({ serverConfig: config(undefined), settingsAccess: "denied" }),
    ).toMatch(/too old/);
  });

  it("locks when the session cannot change settings", () => {
    expect(
      resolveEnvironmentRenameLock({ serverConfig: config(true), settingsAccess: "denied" }),
    ).toMatch(/cannot change/);
    expect(
      resolveEnvironmentRenameLock({ serverConfig: config(true), settingsAccess: "granted" }),
    ).toBeNull();
  });
});

describe("resolveEnvironmentNameSetting", () => {
  it("stores a trimmed custom name", () => {
    expect(resolveEnvironmentNameSetting("  Studio ", "Box")).toBe("Studio");
  });

  it("clears the rename for an empty name or the environment's own default", () => {
    expect(resolveEnvironmentNameSetting("   ", "Box")).toBe("");
    expect(resolveEnvironmentNameSetting("Box", "Box")).toBe("");
  });
});

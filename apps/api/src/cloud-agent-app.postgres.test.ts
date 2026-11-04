import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as adapters from "@rakazo/adapters";
import { describe, expect, it, vi } from "vitest";
import { findTools, partitionTools } from "../../../packages/adapters/src/builtin-tool-bridge.js";
import { selectBuiltinToolsForRun } from "../../../packages/adapters/src/run-tool-selection.js";
import { createApp } from "./app.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;

describePostgres("API cloud-agent wiring", () => {
  it("preserves the configured provider when creating the API executor", async () => {
    const factory = vi.spyOn(adapters, "createCloudAgentConnection");
    const executor = vi.spyOn(adapters, "createRunExecutor");
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-cloud-agent-test-"));
    let handles: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "scripted",
        wakeupDriver: "memory",
        cloudAgentProvider: "devin",
        cloudAgentSpaceId: "space-fixture",
        devinApiKey: "test-cloud-key",
        devinOrgId: "org-fixture",
        devinMaxAcuLimit: "1",
      });
      expect(factory).toHaveBeenCalledExactlyOnceWith({
        CLOUD_AGENT_PROVIDER: "devin",
        CLOUD_AGENT_SPACE_ID: "space-fixture",
        CURSOR_API_KEY: undefined,
        DEVIN_API_KEY: "test-cloud-key",
        DEVIN_ORG_ID: "org-fixture",
        DEVIN_MAX_ACU_LIMIT: "1",
      });
      const connection = factory.mock.results[0]!.value;
      expect(connection).not.toBeNull();
      expect(executor.mock.calls[0]![0].cloudAgent).toBe(connection);
      expect(executor.mock.calls[0]![0].secrets).toContain("test-cloud-key");
      expect(adapters.cloudAgentsEnabled(connection, "other-space")).toBe(false);
      const { deferred } = partitionTools(
        selectBuiltinToolsForRun({
          graphicalToolsAllowed: false,
          groupId: null,
          trigger: "user",
          semanticMemoryEnabled: false,
          cloudAgentEnabled: adapters.cloudAgentsEnabled(connection, "space-fixture"),
          messagingChannelRun: false,
        }),
      );
      const names = [
        "cloud_agent_launch",
        "cloud_agent_status",
        "cloud_agent_reply",
        "cloud_agent_cancel",
      ];
      expect(findTools(deferred, { names }).tools.map((tool) => tool.name)).toEqual(names);
    } finally {
      await handles?.stop();
      await rm(dataDir, { recursive: true, force: true });
      factory.mockRestore();
      executor.mockRestore();
    }
  });
});

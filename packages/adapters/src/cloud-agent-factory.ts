import { createHash } from "node:crypto";
import type { CloudAgentProvider } from "@rakazo/adapter-kit";
import { EmulatorCloudAgentProvider } from "./cloud-agent-emulator.js";
import { resolveCloudAgentProvider } from "./cloud-agent-provider-env.js";
import { CursorCloudAgentProvider } from "./cursor-cloud-agent.js";
import { DevinCloudAgentProvider } from "./devin-cloud-agent.js";

/** The composition root binds a credential to exactly one authorized Space. */
export interface CloudAgentConnection {
  provider: CloudAgentProvider;
  /** Opaque credential binding. Rotation fails closed for existing agents. */
  key: string;
  /** Only the offline emulator may be available in every Space. */
  spaceId?: string;
}

export function cloudAgentsEnabled(
  connection: CloudAgentConnection | null | undefined,
  spaceId: string,
) {
  return Boolean(
    connection &&
      (connection.spaceId === spaceId ||
        (!connection.spaceId && connection.provider.describe().capabilities.offline)),
  );
}

export function createCloudAgentConnection(
  source: NodeJS.ProcessEnv = process.env,
): CloudAgentConnection | null {
  const kind = resolveCloudAgentProvider(source);
  if (kind === "emulator") {
    return { provider: new EmulatorCloudAgentProvider(), key: "emulator" };
  }
  if (kind === "devin") {
    const apiKey = source.DEVIN_API_KEY!.trim();
    const organizationId = source.DEVIN_ORG_ID!.trim();
    return {
      provider: new DevinCloudAgentProvider({
        apiKey,
        organizationId,
        maxAcuLimit: Number(source.DEVIN_MAX_ACU_LIMIT),
      }),
      key: `devin:${createHash("sha256")
        .update(JSON.stringify([organizationId, apiKey]))
        .digest("hex")}`,
      spaceId: source.CLOUD_AGENT_SPACE_ID!.trim(),
    };
  }
  if (kind !== "cursor") return null;
  const apiKey = source.CURSOR_API_KEY!.trim();
  const spaceId = source.CLOUD_AGENT_SPACE_ID!.trim();
  return {
    provider: new CursorCloudAgentProvider({ apiKey }),
    key: `cursor:${createHash("sha256").update(apiKey).digest("hex")}`,
    spaceId,
  };
}

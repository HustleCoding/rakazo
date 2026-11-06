// @vitest-environment jsdom
import type { Bot, Routine } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/rpc";
import { useRoutineEditor } from "./use-routine-editor";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: (parts: TemplateStringsArray) => parts.join("") }),
}));

const routine: Routine = {
  id: "routine-1",
  botId: "bot-1",
  name: "Daily",
  prompt: "",
  crons: ["0 9 * * *"],
  timezone: "UTC",
  active: true,
  notify: true,
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  emailSenders: null,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  watch: null,
  watchState: null,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
};

let root: Root;
let editor: ReturnType<typeof useRoutineEditor>;
let finishUpdate: (saved: Routine) => void;
const update = vi.fn();
const rotateWebhookSecret = vi.fn();
let activeBot: Bot;

function Harness() {
  editor = useRoutineEditor({
    rpc: { routines: { update }, bots: { rotateWebhookSecret } } as unknown as ReturnType<
      typeof createSpaceRpc
    >,
    active: activeBot,
    activeBotId: { current: activeBot.id },
    timezone: "UTC",
    messageProviders: [],
    setBots: () => {},
    refreshThread: async () => ({}) as never,
    setPanel: () => {},
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  activeBot = { id: "bot-1", webhookConfigured: false } as Bot;
  update.mockImplementation(() => new Promise<Routine>((resolve) => (finishUpdate = resolve)));
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("keeps edits made while a save is in flight", async () => {
  act(() => editor.editRoutine(routine));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, name: "Weekly" }));

  let saving!: Promise<void>;
  act(() => {
    saving = editor.editorProps!.onSave() as unknown as Promise<void>;
  });
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ name: "Weekly" }));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, name: "Monthly" }));

  await act(async () => {
    finishUpdate({ ...routine, name: "Weekly", prompt: "Check in." });
    await saving;
  });

  expect(editor.editingRoutine?.name).toBe("Weekly");
  expect(editor.editorProps!.draft.name).toBe("Monthly");
  expect(editor.editorProps!.draft.prompt).toBe("Check in.");
});

it("sends on/off only when the save changes it", async () => {
  update.mockResolvedValue(routine);
  act(() => editor.editRoutine(routine));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, name: "Renamed" }));
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update.mock.calls[0]![0]).not.toHaveProperty("active");

  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, active: false }));
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update.mock.calls[1]![0]).toMatchObject({ active: false });
});

it("refreshes an automatically paused routine without losing unsaved edits", async () => {
  const armed = { ...routine, crons: ["@once"], nextRunAt: "2026-11-03T21:05:00.000Z" };
  const completed = {
    ...armed,
    active: false,
    nextRunAt: null,
    lastRunAt: "2026-11-03T21:05:00.000Z",
  };
  act(() => editor.editRoutine(armed));
  act(() =>
    editor.editorProps!.onChange({
      ...editor.editorProps!.draft,
      name: "Unsaved name",
      prompt: "Unsaved instruction",
    }),
  );
  act(() => editor.editorProps!.onRefresh(completed));

  expect(editor.editingRoutine).toEqual(completed);
  expect(editor.editorProps!.draft).toMatchObject({
    active: false,
    name: "Unsaved name",
    prompt: "Unsaved instruction",
  });
  update.mockResolvedValue(completed);
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update.mock.calls[0]![0]).not.toHaveProperty("active");
});

it("preserves an unsaved Active change when server state refreshes", async () => {
  const paused = { ...routine, active: false };
  act(() => editor.editRoutine(paused));
  act(() => editor.editorProps!.onChange({ ...editor.editorProps!.draft, active: true }));
  act(() => editor.editorProps!.onRefresh({ ...paused, lastRunAt: "2026-11-03T21:05:00.000Z" }));
  expect(editor.editorProps!.draft.active).toBe(true);

  update.mockResolvedValue({ ...paused, active: true });
  await act(async () => {
    await editor.editorProps!.onSave();
  });
  expect(update.mock.calls[0]![0]).toMatchObject({ active: true });
});

it("ignores refreshes for another routine or bot and while saving", async () => {
  act(() => editor.editRoutine(routine));
  act(() => editor.editorProps!.onRefresh({ ...routine, id: "routine-2", active: false }));
  act(() => editor.editorProps!.onRefresh({ ...routine, botId: "bot-2", active: false }));
  expect(editor.editingRoutine).toEqual(routine);

  let saving!: Promise<void>;
  act(() => {
    saving = editor.editorProps!.onSave() as unknown as Promise<void>;
  });
  act(() => editor.editorProps!.onRefresh({ ...routine, active: false }));
  expect(editor.editorProps!.draft.active).toBe(true);
  await act(async () => {
    finishUpdate(routine);
    await saving;
  });
  act(() => editor.editorProps!.onRefresh({ ...routine, active: false }));
  expect(editor.editorProps!.draft.active).toBe(false);
});

it("shows a revealed webhook secret only for the bot it belongs to", async () => {
  let finishRotate!: (result: { secret: string }) => void;
  rotateWebhookSecret.mockImplementation(() => new Promise((resolve) => (finishRotate = resolve)));
  let ensuring!: Promise<void>;
  act(() => {
    ensuring = editor.editorProps!.onEnsureWebhook() as Promise<void>;
  });

  activeBot = { id: "bot-2", webhookConfigured: false } as Bot;
  act(() => root.render(<Harness />));
  await act(async () => {
    finishRotate({ secret: "secret-1" });
    await ensuring;
  });
  expect(editor.editorProps!.webhook.secret).toBeNull();
  expect(editor.editorProps!.webhook.configured).toBe(false);

  activeBot = { id: "bot-1", webhookConfigured: true } as Bot;
  act(() => root.render(<Harness />));
  expect(editor.editorProps!.webhook.secret).toBe("secret-1");
});

it("keeps each bot's revealed secret when rotations overlap", async () => {
  const finishers: ((result: { secret: string }) => void)[] = [];
  rotateWebhookSecret.mockImplementation(() => new Promise((resolve) => finishers.push(resolve)));
  let first!: Promise<void>;
  act(() => {
    first = editor.editorProps!.onEnsureWebhook() as Promise<void>;
  });
  activeBot = { id: "bot-2", webhookConfigured: false } as Bot;
  act(() => root.render(<Harness />));
  let second!: Promise<void>;
  act(() => {
    second = editor.editorProps!.onEnsureWebhook() as Promise<void>;
  });
  await act(async () => {
    finishers[0]!({ secret: "secret-1" });
    finishers[1]!({ secret: "secret-2" });
    await Promise.all([first, second]);
  });
  expect(editor.editorProps!.webhook.secret).toBe("secret-2");

  activeBot = { id: "bot-1", webhookConfigured: true } as Bot;
  act(() => root.render(<Harness />));
  expect(editor.editorProps!.webhook.secret).toBe("secret-1");
});

import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCompletionModel } from "./completion";
import {
  createPendingTrainingExample,
  resolveTrainingDataFolder,
  resolveTrainingDataRecord,
  writeTrainingDataRecord,
} from "./training-data";

const temporaryFolders: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryFolders.splice(0).map((folder) =>
      rm(folder, { recursive: true, force: true }),
    ),
  );
});

function example(folderPath: string) {
  return createPendingTrainingExample({
    folderPath,
    model: getCompletionModel("anthropic/claude-opus-4.6"),
    snapshot: {
      title: "Ideas",
      path: "Notes/Ideas.md",
      document: "The cat",
      cursor: 7,
    },
    request: {
      url: "https://openrouter.ai/api/v1/chat/completions",
      body: {
        model: "anthropic/claude-opus-4.6",
        max_tokens: 64,
        temperature: 1,
        top_p: 0.9,
        stream: false,
        messages: [
          { role: "assistant", content: "The cat" },
        ],
      },
    },
    raw: " sat down.",
    sanitized: " sat down.",
    displayed: " sat down.",
    replaceFrom: 7,
    generatedAt: new Date("2026-07-24T12:34:56.789Z"),
    exampleId: "example-id",
  });
}

describe("training data paths", () => {
  it("supports absolute, home-relative, and vault-relative folders", () => {
    expect(
      resolveTrainingDataFolder(
        "/tmp/onward-data",
        "/vault",
        "/home/louis",
      ),
    ).toBe("/tmp/onward-data");
    expect(
      resolveTrainingDataFolder(
        "~/training/onward",
        "/vault",
        "/home/louis",
      ),
    ).toBe("/home/louis/training/onward");
    expect(
      resolveTrainingDataFolder(
        "Training/Onward",
        "/vault",
        "/home/louis",
      ),
    ).toBe("/vault/Training/Onward");
    expect(resolveTrainingDataFolder("  ", "/vault")).toBeNull();
  });
});

describe("training data records", () => {
  it("keeps the exact request and attaches one terminal outcome", () => {
    const record = resolveTrainingDataRecord(
      example("/tmp/onward"),
      "accepted",
      new Date("2026-07-24T12:35:00.000Z"),
    );

    expect(record).toMatchObject({
      schemaVersion: 1,
      outcome: "accepted",
      generatedAt: "2026-07-24T12:34:56.789Z",
      resolvedAt: "2026-07-24T12:35:00.000Z",
      model: {
        id: "anthropic/claude-opus-4.6",
      },
      completion: {
        raw: " sat down.",
        displayed: " sat down.",
      },
    });
    expect(record.request.body.messages).toEqual([
      { role: "assistant", content: "The cat" },
    ]);
    expect(JSON.stringify(record)).not.toContain("Authorization");
  });

  it("writes one standalone JSON file", async () => {
    const folder = await mkdtemp(
      join(tmpdir(), "onward-training-test-"),
    );
    temporaryFolders.push(folder);

    const filePath = await writeTrainingDataRecord(
      example(folder),
      "hard_rejected",
    );
    const saved = JSON.parse(
      await readFile(filePath, "utf8"),
    ) as { outcome: string; exampleId: string };

    expect(saved).toEqual(
      expect.objectContaining({
        outcome: "hard_rejected",
        exampleId: "example-id",
      }),
    );
  });
});

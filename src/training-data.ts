import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  isAbsolute,
  join,
  normalize,
  resolve,
} from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CompletionModel,
  CompletionRequest,
  CompletionSnapshot,
} from "./completion";

export type TrainingOutcome =
  | "accepted"
  | "soft_rejected"
  | "hard_rejected";

export interface PendingTrainingExample {
  folderPath: string;
  exampleId: string;
  generatedAt: string;
  model: {
    id: string;
    label: string;
    backend: string;
    apiModel: string;
    prefillMode: string | null;
  };
  source: {
    title: string;
    path: string | null;
    cursor: number;
  };
  request: CompletionRequest;
  completion: {
    raw: string;
    sanitized: string;
    displayed: string;
    replaceFrom: number;
  };
}

export interface TrainingDataRecord {
  schemaVersion: 1;
  exampleId: string;
  generatedAt: string;
  resolvedAt: string;
  outcome: TrainingOutcome;
  model: PendingTrainingExample["model"];
  source: PendingTrainingExample["source"];
  request: CompletionRequest;
  completion: PendingTrainingExample["completion"];
}

export function resolveTrainingDataFolder(
  configuredPath: string,
  vaultBasePath: string,
  homePath = homedir(),
): string | null {
  const trimmed = configuredPath.trim();
  if (!trimmed) return null;
  if (trimmed === "~") return normalize(homePath);
  if (trimmed.startsWith("~/")) {
    return normalize(join(homePath, trimmed.slice(2)));
  }
  return isAbsolute(trimmed)
    ? normalize(trimmed)
    : resolve(vaultBasePath, trimmed);
}

export function createPendingTrainingExample(options: {
  folderPath: string;
  model: CompletionModel;
  snapshot: CompletionSnapshot;
  request: CompletionRequest;
  raw: string;
  sanitized: string;
  displayed: string;
  replaceFrom: number;
  generatedAt?: Date;
  exampleId?: string;
}): PendingTrainingExample {
  return {
    folderPath: options.folderPath,
    exampleId: options.exampleId ?? randomUUID(),
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    model: {
      id: options.model.id,
      label: options.model.label,
      backend: options.model.backend,
      apiModel: options.model.apiModel,
      prefillMode: options.model.prefillMode ?? null,
    },
    source: {
      title: options.snapshot.title,
      path: options.snapshot.path ?? null,
      cursor: options.snapshot.cursor,
    },
    request: options.request,
    completion: {
      raw: options.raw,
      sanitized: options.sanitized,
      displayed: options.displayed,
      replaceFrom: options.replaceFrom,
    },
  };
}

export function resolveTrainingDataRecord(
  pending: PendingTrainingExample,
  outcome: TrainingOutcome,
  resolvedAt = new Date(),
): TrainingDataRecord {
  return {
    schemaVersion: 1,
    exampleId: pending.exampleId,
    generatedAt: pending.generatedAt,
    resolvedAt: resolvedAt.toISOString(),
    outcome,
    model: pending.model,
    source: pending.source,
    request: pending.request,
    completion: pending.completion,
  };
}

export function trainingDataFilename(
  record: TrainingDataRecord,
): string {
  const timestamp = record.generatedAt.replace(/[:.]/gu, "-");
  return `${timestamp}_${record.exampleId}.json`;
}

export async function writeTrainingDataRecord(
  pending: PendingTrainingExample,
  outcome: TrainingOutcome,
): Promise<string> {
  const record = resolveTrainingDataRecord(pending, outcome);
  const filename = trainingDataFilename(record);
  await mkdir(pending.folderPath, { recursive: true });
  const filePath = join(pending.folderPath, filename);
  await writeFile(
    filePath,
    `${JSON.stringify(record, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  return filePath;
}

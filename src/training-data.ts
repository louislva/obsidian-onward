import type {
  CompletionModel,
  CompletionRequest,
  CompletionSnapshot,
} from "./completion";

interface NodeTrainingModules {
  mkdir: typeof import("node:fs/promises").mkdir;
  writeFile: typeof import("node:fs/promises").writeFile;
  homedir: typeof import("node:os").homedir;
  isAbsolute: typeof import("node:path").isAbsolute;
  join: typeof import("node:path").join;
  normalize: typeof import("node:path").normalize;
  resolve: typeof import("node:path").resolve;
}

let nodeTrainingModules: NodeTrainingModules | null = null;

function getNodeTrainingModules(): NodeTrainingModules {
  if (nodeTrainingModules) return nodeTrainingModules;
  const fileSystem =
    require("node:fs/promises") as typeof import("node:fs/promises");
  const operatingSystem =
    require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  nodeTrainingModules = {
    mkdir: fileSystem.mkdir,
    writeFile: fileSystem.writeFile,
    homedir: operatingSystem.homedir,
    isAbsolute: path.isAbsolute,
    join: path.join,
    normalize: path.normalize,
    resolve: path.resolve,
  };
  return nodeTrainingModules;
}

function createExampleId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

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
  homePath?: string,
): string | null {
  const {
    homedir,
    isAbsolute,
    join,
    normalize,
    resolve,
  } = getNodeTrainingModules();
  const trimmed = configuredPath.trim();
  if (!trimmed) return null;
  const resolvedHomePath = homePath ?? homedir();
  if (trimmed === "~") return normalize(resolvedHomePath);
  if (trimmed.startsWith("~/")) {
    return normalize(join(resolvedHomePath, trimmed.slice(2)));
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
    exampleId: options.exampleId ?? createExampleId(),
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
  const { join, mkdir, writeFile } = getNodeTrainingModules();
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

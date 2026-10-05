import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FuelCastValidation } from "@workspace/api-zod";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDirectory, "../../../");
const artifactDirectory = path.resolve(
  process.env.FUELCAST_ARTIFACT_DIR ?? path.join(repositoryRoot, ".local/fuelcast"),
);
const pipelinePath = path.resolve(
  process.env.FUELCAST_PIPELINE_PATH ?? path.join(repositoryRoot, "scripts/fuelcast_model.py"),
);
const modelPath = path.join(artifactDirectory, "fuelcast_model.joblib");
const reportPath = path.join(artifactDirectory, "validation.json");
let artifactDownload: Promise<void> | undefined;

async function fileExists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

async function downloadPrivateArtifact(fileName: string): Promise<void> {
  const storageUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.FUELCAST_STORAGE_BUCKET ?? "fuelcast-private";
  if (!storageUrl || !serviceKey) {
    throw new Error("Private FuelCast storage is not configured on this server.");
  }

  const response = await fetch(
    `${storageUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeURIComponent(fileName)}`,
    {
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Private FuelCast artifact download failed (${response.status}).`);
  }

  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > 20 * 1024 * 1024) {
    throw new Error("Private FuelCast artifact exceeds the 20 MB limit.");
  }
  const artifact = Buffer.from(await response.arrayBuffer());
  if (artifact.length > 20 * 1024 * 1024) {
    throw new Error("Private FuelCast artifact exceeds the 20 MB limit.");
  }
  if (fileName === "fuelcast_model.joblib") {
    const expectedHash = process.env.FUELCAST_MODEL_SHA256?.toLowerCase();
    if (!expectedHash) {
      throw new Error("Set FUELCAST_MODEL_SHA256 to verify the private hosted model artifact.");
    }
    const actualHash = createHash("sha256").update(artifact).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error("The private FuelCast model checksum does not match.");
    }
  }

  await mkdir(artifactDirectory, { recursive: true });
  const destination = path.join(artifactDirectory, fileName);
  const temporaryPath = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, artifact, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, destination);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function ensureLocalArtifacts(): Promise<void> {
  const [modelAvailable, reportAvailable] = await Promise.all([
    fileExists(modelPath),
    fileExists(reportPath),
  ]);
  if (modelAvailable && reportAvailable) return;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return;

  artifactDownload ??= (async () => {
    if (!modelAvailable) await downloadPrivateArtifact("fuelcast_model.joblib");
    if (!reportAvailable) await downloadPrivateArtifact("validation.json");
  })();
  try {
    await artifactDownload;
  } catch (error) {
    artifactDownload = undefined;
    throw error;
  }
}

export type FuelCastPredictionRow = {
  Consumer_Total_ShaftPower: number;
  Ship_SpeedOverGround: number;
  Weather_WindSpeed10M: number;
  Weather_WaveHeight: number;
  Weather_OceanCurrentVelocity: number;
};

export async function getFuelCastValidation(): Promise<FuelCastValidation> {
  await ensureLocalArtifacts();
  const [report, modelAvailable] = await Promise.all([
    readFile(reportPath, "utf8").then((value) => JSON.parse(value) as Record<string, any>),
    access(modelPath).then(() => true, () => false),
  ]);
  const timeBlocks = Object.entries(
    report.validation.timeBlocks as Record<string, Record<string, number | string | null>>,
  ).map(([vessel, block]) => ({
    vessel,
    sourceOrderStart: Number(block.sourceOrderStart),
    sourceOrderEnd: Number(block.sourceOrderEnd),
    observations: Number(block.observations),
    maeKgPerSecond: Number(block.maeKgPerSecond),
    rmseKgPerSecond: Number(block.rmseKgPerSecond),
    r2: Number(block.r2),
    mapePercent: block.mapePercent == null ? null : Number(block.mapePercent),
    mapeUnavailableReason:
      block.mapeUnavailableReason == null ? null : String(block.mapeUnavailableReason),
  }));
  return {
    available: true,
    modelAvailable,
    dataset: report.dataset,
    target: report.target,
    targetUnit: report.targetUnit,
    observationsLoaded: report.observationsLoaded,
    observationsUsable: report.observationsUsable,
    vesselCount: report.vesselCount,
    vessels: report.vessels,
    features: report.features,
    model: report.model,
    trainingObservations: report.validation.trainingObservations,
    testObservations: report.validation.testObservations,
    timeBlockMetrics: report.validation.metrics,
    timeBlocks,
    unseenVesselMetrics: report.leaveOneVesselOut.metrics,
    unseenVesselFolds: report.leaveOneVesselOut.folds,
    physicsBaselineStatus: report.physicsBaseline.status,
    physicsBaselineReason: report.physicsBaseline.reason,
    limitations: report.dataLimitations,
  };
}

export async function predictFuelCastBatch(
  rows: FuelCastPredictionRow[],
): Promise<number[]> {
  await ensureLocalArtifacts();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.PYTHON_EXECUTABLE ?? "python3",
      [pipelinePath, "predict", "--stdin-json"],
      {
        env: {
          ...process.env,
          FUELCAST_ARTIFACT_DIR: artifactDirectory,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `FuelCast prediction process exited with code ${code}.`));
        return;
      }
      try {
        const response = JSON.parse(stdout) as { fuelRateKgPerSecond: number[] };
        if (
          response.fuelRateKgPerSecond.length !== rows.length ||
          response.fuelRateKgPerSecond.some((value) => !Number.isFinite(value) || value < 0)
        ) {
          throw new Error("FuelCast returned invalid fuel-rate predictions.");
        }
        resolve(response.fuelRateKgPerSecond);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Could not parse FuelCast predictions."));
      }
    });
    child.stdin.end(JSON.stringify({ rows }));
  });
}

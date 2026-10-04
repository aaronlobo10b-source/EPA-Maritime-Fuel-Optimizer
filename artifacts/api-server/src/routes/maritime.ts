import {
  CreateVesselBody,
  CreateVesselResponse,
  DeleteVesselParams,
  DeleteVesselResponse,
  GetMaritimeCatalogResponse,
  ListVesselsResponse,
  OptimizeVoyageBody,
  OptimizeVoyageResponse,
  UpdateVesselBody,
  UpdateVesselParams,
  UpdateVesselResponse,
} from "@workspace/api-zod";
import { db, maritimeVesselsTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { getMaritimeCatalog, optimizeVoyage } from "../lib/maritime-engine";

const router: IRouter = Router();

function serializedVessel<T extends { createdAt: Date; updatedAt: Date }>(
  vessel: T,
) {
  return {
    ...vessel,
    createdAt: vessel.createdAt.toISOString(),
    updatedAt: vessel.updatedAt.toISOString(),
  };
}

function validateVesselRules(
  vessel: ReturnType<typeof CreateVesselBody.parse>,
): string | null {
  if (vessel.cargoCapacityTonnes > vessel.deadweightTonnes) {
    return "Cargo capacity cannot exceed deadweight tonnage.";
  }
  if (vessel.designServiceSpeedKnots > vessel.maxSpeedKnots) {
    return "Design service speed cannot exceed maximum speed.";
  }
  if (new Set(vessel.fuelCompatibility).size !== vessel.fuelCompatibility.length) {
    return "Fuel compatibility entries must be unique.";
  }
  const allowedFuelIds = new Set(
    getMaritimeCatalog().fuels.map((fuel) => fuel.fuelId),
  );
  if (vessel.fuelCompatibility.some((fuelId) => !allowedFuelIds.has(fuelId))) {
    return "Fuel compatibility contains an unsupported fuel identifier.";
  }
  for (const point of vessel.sfocCurve) {
    if (point.loadFraction <= 0 || point.loadFraction > 1) {
      return "SFOC load fractions must be greater than zero and no more than one.";
    }
  }
  const sortedCurve = [...vessel.sfocCurve].sort(
    (a, b) => a.loadFraction - b.loadFraction,
  );
  for (let index = 1; index < sortedCurve.length; index += 1) {
    if (sortedCurve[index]!.loadFraction === sortedCurve[index - 1]!.loadFraction) {
      return "SFOC curve load fractions must be unique.";
    }
  }
  for (const fuelId of vessel.fuelCompatibility) {
    if (!(fuelId in vessel.fuelTankVolumesM3)) {
      return `Add an onboard tank volume for compatible fuel ${fuelId}.`;
    }
    if (vessel.fuelTankVolumesM3[fuelId] <= 0) {
      return `Onboard tank volume for compatible fuel ${fuelId} must be greater than zero.`;
    }
    if (!(fuelId in vessel.alternativeFuelWeightPenaltyTonnes)) {
      return `Enter the alternative-fuel weight penalty for ${fuelId}; use zero only when the sourced penalty is zero.`;
    }
  }
  return null;
}

router.get("/maritime/catalog", (_req, res): void => {
  res.json(GetMaritimeCatalogResponse.parse(getMaritimeCatalog()));
});

router.get("/maritime/vessels", async (_req, res): Promise<void> => {
  const vessels = await db
    .select()
    .from(maritimeVesselsTable)
    .orderBy(asc(maritimeVesselsTable.name));
  res.json(ListVesselsResponse.parse(vessels.map(serializedVessel)));
});

router.post("/maritime/vessels", async (req, res): Promise<void> => {
  const parsed = CreateVesselBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const ruleError = validateVesselRules(parsed.data);
  if (ruleError) {
    res.status(400).json({ error: ruleError });
    return;
  }
  const [vessel] = await db
    .insert(maritimeVesselsTable)
    .values(parsed.data)
    .returning();
  res.status(201).json(CreateVesselResponse.parse(serializedVessel(vessel!)));
});

router.put("/maritime/vessels/:vesselId", async (req, res): Promise<void> => {
  const params = UpdateVesselParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateVesselBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const ruleError = validateVesselRules(parsed.data);
  if (ruleError) {
    res.status(400).json({ error: ruleError });
    return;
  }
  const [vessel] = await db
    .update(maritimeVesselsTable)
    .set(parsed.data)
    .where(eq(maritimeVesselsTable.id, params.data.vesselId))
    .returning();
  if (!vessel) {
    res.status(404).json({ error: "Vessel profile not found." });
    return;
  }
  res.json(UpdateVesselResponse.parse(serializedVessel(vessel)));
});

router.delete("/maritime/vessels/:vesselId", async (req, res): Promise<void> => {
  const params = DeleteVesselParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [vessel] = await db
    .delete(maritimeVesselsTable)
    .where(eq(maritimeVesselsTable.id, params.data.vesselId))
    .returning({ id: maritimeVesselsTable.id });
  if (!vessel) {
    res.status(404).json({ error: "Vessel profile not found." });
    return;
  }
  res.json(DeleteVesselResponse.parse({ deleted: true }));
});

router.post("/maritime/optimize", async (req, res): Promise<void> => {
  const parsed = OptimizeVoyageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [vessel] = await db
    .select()
    .from(maritimeVesselsTable)
    .where(eq(maritimeVesselsTable.id, parsed.data.vesselId));
  if (!vessel) {
    res.status(404).json({ error: "Selected vessel profile was not found." });
    return;
  }
  try {
    const result = optimizeVoyage(vessel, parsed.data);
    res.json(OptimizeVoyageResponse.parse(result));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not optimize this scenario.";
    res.status(400).json({ error: message });
  }
});

export default router;
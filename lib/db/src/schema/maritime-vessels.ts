import {
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

type SfocPoint = {
  loadFraction: number;
  gramsPerKwh: number;
};

export const maritimeVesselsTable = pgTable("maritime_vessels", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  vesselClass: text("vessel_class").notNull(),
  deadweightTonnes: real("deadweight_tonnes").notNull(),
  lightshipTonnes: real("lightship_tonnes").notNull(),
  cargoCapacityTonnes: real("cargo_capacity_tonnes").notNull(),
  designServiceSpeedKnots: real("design_service_speed_knots").notNull(),
  maxSpeedKnots: real("max_speed_knots").notNull(),
  maxEnginePowerKw: real("max_engine_power_kw").notNull(),
  engineEfficiency: real("engine_efficiency").notNull(),
  sfocCurve: jsonb("sfoc_curve").$type<SfocPoint[]>().notNull(),
  blockCoefficient: real("block_coefficient").notNull(),
  lengthOverallM: real("length_overall_m").notNull(),
  beamM: real("beam_m").notNull(),
  designDraftM: real("design_draft_m").notNull(),
  fuelCompatibility: text("fuel_compatibility").array().notNull(),
  fuelTankVolumesM3: jsonb("fuel_tank_volumes_m3")
    .$type<Record<string, number>>()
    .notNull(),
  alternativeFuelWeightPenaltyTonnes: jsonb(
    "alternative_fuel_weight_penalty_tonnes",
  )
    .$type<Record<string, number>>()
    .notNull(),
  windageAreaM2: real("windage_area_m2").notNull(),
  windDragCoefficient: real("wind_drag_coefficient").notNull(),
  sourceName: text("source_name").notNull(),
  sourceUrl: text("source_url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertMaritimeVesselSchema = createInsertSchema(
  maritimeVesselsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertMaritimeVessel = z.infer<typeof insertMaritimeVesselSchema>;
export type MaritimeVessel = typeof maritimeVesselsTable.$inferSelect;
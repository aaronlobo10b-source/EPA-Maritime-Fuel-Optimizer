import {
  GetFuelCastValidationResponse,
  GetMaritimeCatalogResponse,
} from "@workspace/api-zod";
import { Router, type IRouter } from "express";
import { getMaritimeCatalog } from "../lib/maritime-engine";
import { getFuelCastValidation } from "../lib/fuelcast";

const router: IRouter = Router();

router.get("/maritime/catalog", (_req, res): void => {
  res.json(GetMaritimeCatalogResponse.parse(getMaritimeCatalog()));
});

router.get("/maritime/fuelcast/validation", async (_req, res): Promise<void> => {
  try {
    const status = await getFuelCastValidation();
    res.json(GetFuelCastValidationResponse.parse(status));
  } catch {
    res.status(503).json({
      error:
        "FuelCast validation is unavailable. Place the licensed data in the local data folder and run the documented training command.",
    });
  }
});

export default router;
import { Router, type IRouter } from "express";
import healthRouter from "./health";
import maritimeRouter from "./maritime";

const router: IRouter = Router();

router.use(healthRouter);
router.use(maritimeRouter);

export default router;

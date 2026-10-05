import { Router, type IRouter, type RequestHandler } from "express";
import healthRouter from "./health";
import maritimeLocalRouter from "./maritime-local";

const router: IRouter = Router();

router.use(healthRouter);
router.use(maritimeLocalRouter);

if (process.env.DATABASE_URL) {
	const { default: maritimeRouter } = await import("./maritime");
	router.use(maritimeRouter);
} else {
	const databaseUnavailable: RequestHandler = (_req, res) => {
		res.status(503).json({
			error: "Set DATABASE_URL to enable vessel profiles and voyage optimization.",
		});
	};
	router.use("/maritime/vessels", databaseUnavailable);
	router.use("/maritime/optimize", databaseUnavailable);
}

export default router;

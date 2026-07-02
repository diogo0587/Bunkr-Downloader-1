import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import bunkrRouter from "./bunkr.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(bunkrRouter);

export default router;

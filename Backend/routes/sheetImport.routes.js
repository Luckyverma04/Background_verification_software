"use strict";
const router = require("express").Router();
const c = require("../controllers/sheetImport.controller");

router.get("/status", c.status);
router.post("/sync", c.sync);
router.get("/items", c.items);
router.post("/confirm", c.confirm);
router.post("/unconfirm", c.unconfirm);
router.post("/queue/start", c.startQueue);
router.post("/queue/retry", c.retry);
router.post("/queue/cancel", c.cancel);

module.exports = router;

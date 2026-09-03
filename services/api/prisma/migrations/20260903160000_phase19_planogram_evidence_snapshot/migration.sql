-- Phase 19 hardening: persist the EXACT sanitized planogram section a
-- pretrained run was scored against. Reports display this stored
-- snapshot for historical runs — publishing a new planogram version can
-- never silently rewrite old candidates or match status.
ALTER TABLE "PretrainedVisionRun" ADD COLUMN "planogramEvidence" JSONB;

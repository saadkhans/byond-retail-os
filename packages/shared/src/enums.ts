/**
 * The workspace's domain vocabularies.
 *
 * Every value below is a wire value the platform API emits and the admin
 * web reads. Before this package they existed twice: once as a Prisma
 * enum (or a hand-written union) inside `services/api`, and again as a
 * hand-copied string union inside `apps/admin-web/src/api.ts`. Drift
 * between the two was invisible until a page silently stopped matching a
 * status.
 *
 * Each vocabulary is declared ONCE, as a frozen value list plus the union
 * derived from it, so consumers get both the type and something they can
 * iterate (filter dropdowns, exhaustiveness tests). Where the Prisma enum
 * carries a different name the comment says which one.
 *
 * `services/api/src/common/shared-contract.ts` asserts, at compile time,
 * that each vocabulary here still matches the Prisma enum it mirrors — so
 * a migration that adds or renames a member fails `tsc` instead of
 * reaching the UI.
 */

/* ------------------------------------------------------------------ */
/* Checkout, orders and payments */
/* ------------------------------------------------------------------ */

export const CHECKOUT_SESSION_STATUS_VALUES = [
  'OPEN',
  'ACTIVE',
  'PENDING_REVIEW',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type CheckoutSessionStatus = (typeof CHECKOUT_SESSION_STATUS_VALUES)[number];

export const ORDER_STATUS_VALUES = [
  'DRAFT',
  'CONFIRMED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUS_VALUES)[number];

export const ORDER_PAYMENT_STATUS_VALUES = [
  'UNPAID',
  'AUTHORIZED',
  'PAID',
  'PAYMENT_FAILED',
  'VOIDED',
  'REFUND_PENDING',
  'REFUNDED',
] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUS_VALUES)[number];

export const PAYMENT_PROVIDER_VALUES = [
  'SIMULATED',
  'MANUAL',
] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDER_VALUES)[number];

export const PAYMENT_STATUS_VALUES = [
  'CREATED',
  'REQUIRES_AUTHORIZATION',
  'AUTHORIZED',
  'CAPTURE_PENDING',
  'CAPTURED',
  'FAILED',
  'CANCELLED',
  'VOIDED',
  'EXPIRED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUS_VALUES)[number];

export const PAYMENT_CAPTURE_STATUS_VALUES = [
  'PENDING',
  'SUCCEEDED',
  'FAILED',
] as const;
export type PaymentCaptureStatus = (typeof PAYMENT_CAPTURE_STATUS_VALUES)[number];

export const PAYMENT_EVENT_STATUS_VALUES = [
  'RECEIVED',
  'PROCESSED',
  'IGNORED',
  'FAILED',
] as const;
export type PaymentEventStatus = (typeof PAYMENT_EVENT_STATUS_VALUES)[number];

export const PAYMENT_EVENT_TYPE_VALUES = [
  'AUTHORIZATION_SUCCEEDED',
  'AUTHORIZATION_FAILED',
  'CAPTURE_SUCCEEDED',
  'CAPTURE_FAILED',
  'PAYMENT_CANCELLED',
  'PAYMENT_VOIDED',
  'PAYMENT_EXPIRED',
  'UNKNOWN',
] as const;
export type PaymentEventType = (typeof PAYMENT_EVENT_TYPE_VALUES)[number];

export const RECONCILIATION_STATUS_VALUES = [
  'PENDING',
  'MATCHED',
  'MISMATCH',
  'RECONCILED',
  'FAILED',
] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUS_VALUES)[number];

/* ------------------------------------------------------------------ */
/* Vision events and inference */
/* ------------------------------------------------------------------ */

export const VISION_EVENT_TYPE_VALUES = [
  'PRODUCT_PICKUP',
  'PRODUCT_RETURN',
  'PRODUCT_TRANSFER',
  'CART_INSERTION',
  'EXIT_RECONCILIATION',
] as const;
export type VisionEventType = (typeof VISION_EVENT_TYPE_VALUES)[number];

export const VISION_EVENT_STATUS_VALUES = [
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'OVERRIDDEN',
] as const;
export type VisionEventStatus = (typeof VISION_EVENT_STATUS_VALUES)[number];

export const INFERENCE_JOB_TYPE_VALUES = [
  'TRACKING_EVENT',
  'SHELF_AUDIT',
  'PRODUCT_RECOGNITION',
  'OCR_REVIEW',
  'VLM_REVIEW',
  'EXIT_RECONCILIATION',
] as const;
export type InferenceJobType = (typeof INFERENCE_JOB_TYPE_VALUES)[number];

/**
 * PENDING_LINK is the non-claimable creation state for work that must
 * commit a downstream link before it may be delivered. The admin client
 * used to omit it, so a job parked in that state fell outside its own
 * status union; the contract assertion in services/api now pins it.
 */
export const INFERENCE_JOB_STATUS_VALUES = [
  'PENDING_LINK',
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export type InferenceJobStatus = (typeof INFERENCE_JOB_STATUS_VALUES)[number];

/* ------------------------------------------------------------------ */
/* Video assets and clip artefacts */
/* ------------------------------------------------------------------ */

export const VIDEO_ASSET_STATUS_VALUES = [
  'PENDING_MEDIA',
  'QUARANTINED',
  'UPLOADED',
  'VALIDATED',
  'REJECTED',
  'PROCESSING',
  'READY',
  'FAILED',
] as const;
export type VideoAssetStatus = (typeof VIDEO_ASSET_STATUS_VALUES)[number];

export const VIDEO_ARTIFACT_TYPE_VALUES = [
  'FRAME',
  'CROP',
] as const;
export type VideoArtifactType = (typeof VIDEO_ARTIFACT_TYPE_VALUES)[number];

export const VIDEO_CROP_REASON_VALUES = [
  'PRODUCT_PICKUP',
  'PRODUCT_RETURN',
  'SHELF_AUDIT',
  'CART_INSERTION',
  'OCR_REVIEW',
  'VLM_REVIEW',
] as const;
export type VideoCropReason = (typeof VIDEO_CROP_REASON_VALUES)[number];

/* ------------------------------------------------------------------ */
/* Customer journeys */
/* ------------------------------------------------------------------ */

/** Mirrors the Prisma `CustomerJourneyEventType` enum. */
export const JOURNEY_EVENT_TYPE_VALUES = [
  'ENTRY',
  'EXIT',
  'SHELF_INTERACTION',
  'PRODUCT_PICKUP',
  'PRODUCT_RETURN',
  'REVIEW_REQUIRED',
] as const;
export type JourneyEventType = (typeof JOURNEY_EVENT_TYPE_VALUES)[number];

/**
 * The final SHADOW decision of an exited journey: a recorded conclusion
 * only, which never triggers a checkout, order or payment write.
 * Mirrors the Prisma `CustomerJourneyDecision` enum.
 */
export const JOURNEY_DECISION_VALUES = [
  'READY_TO_SETTLE_SHADOW',
  'NEEDS_EVENT_REVIEW',
  'NEEDS_JOURNEY_REVIEW',
  'FAILED',
] as const;
export type JourneyDecision = (typeof JOURNEY_DECISION_VALUES)[number];

/** Mirrors the Prisma `JourneyEventReviewDecision` enum. */
export const JOURNEY_REVIEW_DECISION_VALUES = [
  'APPROVE',
  'REJECT',
  'CORRECT',
] as const;
export type JourneyReviewDecision = (typeof JOURNEY_REVIEW_DECISION_VALUES)[number];

/* ------------------------------------------------------------------ */
/* Cameras, replay runs and live sessions */
/* ------------------------------------------------------------------ */

export const CAMERA_SOURCE_TYPE_VALUES = [
  'FILE_REPLAY',
  'RTSP_PLACEHOLDER',
  'LOCAL_WEBCAM_PLACEHOLDER',
  'RTSP_SHADOW',
] as const;
export type CameraSourceType = (typeof CAMERA_SOURCE_TYPE_VALUES)[number];

export const CAMERA_SOURCE_STATUS_VALUES = [
  'ACTIVE',
  'DISABLED',
  'ERROR',
] as const;
export type CameraSourceStatus = (typeof CAMERA_SOURCE_STATUS_VALUES)[number];

/** Mirrors the Prisma `CameraPilotRunStatus` enum. */
export const PILOT_RUN_STATUS_VALUES = [
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
] as const;
export type PilotRunStatus = (typeof PILOT_RUN_STATUS_VALUES)[number];

/** Mirrors the Prisma `LiveCameraSessionStatus` enum. */
export const LIVE_SESSION_STATUS_VALUES = [
  'STARTING',
  'RUNNING',
  'STOPPING',
  'STOPPED',
  'ERROR',
] as const;
export type LiveSessionStatus = (typeof LIVE_SESSION_STATUS_VALUES)[number];

/* ------------------------------------------------------------------ */
/* Camera calibration */
/* ------------------------------------------------------------------ */

export const CAMERA_CALIBRATION_PROFILE_STATUS_VALUES = [
  'DRAFT',
  'ACTIVE',
  'ARCHIVED',
] as const;
export type CameraCalibrationProfileStatus = (typeof CAMERA_CALIBRATION_PROFILE_STATUS_VALUES)[number];

export const CAMERA_CALIBRATION_ORIENTATION_VALUES = [
  'LANDSCAPE',
  'PORTRAIT',
  'UNKNOWN',
] as const;
export type CameraCalibrationOrientation = (typeof CAMERA_CALIBRATION_ORIENTATION_VALUES)[number];

export const CAMERA_CALIBRATION_MOUNT_VALUES = [
  'OVERHEAD',
  'FRONT_SHELF',
  'ANGLED_SHELF',
  'UNKNOWN',
] as const;
export type CameraCalibrationMount = (typeof CAMERA_CALIBRATION_MOUNT_VALUES)[number];

export const CAMERA_CALIBRATION_ZONE_TYPE_VALUES = [
  'SHELF_ZONE',
  'INTERACTION_ZONE',
  'IGNORE_ZONE',
  'ENTRY_EXIT_ZONE',
] as const;
export type CameraCalibrationZoneType = (typeof CAMERA_CALIBRATION_ZONE_TYPE_VALUES)[number];

/** No Prisma enum: computed readiness grade. */
export const CALIBRATION_READINESS_LEVEL_VALUES = [
  'READY',
  'WARNING',
  'NOT_READY',
  'NOT_APPLICABLE',
] as const;
export type CalibrationReadinessLevel = (typeof CALIBRATION_READINESS_LEVEL_VALUES)[number];

/* ------------------------------------------------------------------ */
/* Pilot evaluation and ground truth */
/* ------------------------------------------------------------------ */

export const GROUND_TRUTH_EVENT_KIND_VALUES = [
  'PICKUP',
  'RETURN',
  'NONE',
] as const;
export type GroundTruthEventKind = (typeof GROUND_TRUTH_EVENT_KIND_VALUES)[number];

/** Mirrors the Prisma `PilotEvaluationRunStatus` enum. */
export const PILOT_EVALUATION_STATUS_VALUES = [
  'OPEN',
  'COMPLETED',
  'CANCELLED',
] as const;
export type PilotEvaluationStatus = (typeof PILOT_EVALUATION_STATUS_VALUES)[number];

/** Mirrors the Prisma `PilotObservationVerdict` enum. */
export const PILOT_VERDICT_VALUES = [
  'CORRECT',
  'INCORRECT',
  'UNCERTAIN',
  'FALSE_TOUCH',
  'WRONG_SKU',
  'WRONG_ACTION',
  'MISSED_EVENT',
] as const;
export type PilotVerdict = (typeof PILOT_VERDICT_VALUES)[number];

export const PILOT_EXPECTED_ACTION_VALUES = [
  'PICKUP',
  'RETURN',
  'NO_OP',
  'UNKNOWN',
] as const;
export type PilotExpectedAction = (typeof PILOT_EXPECTED_ACTION_VALUES)[number];

/* ------------------------------------------------------------------ */
/* CV test protocols */
/* ------------------------------------------------------------------ */

export const CV_TEST_SCENARIO_VALUES = [
  'PICKUP_SINGLE',
  'RETURN_SINGLE',
  'FALSE_TOUCH',
  'TWO_SIMILAR_PICK_ONE',
  'TWO_VISIBLE_PICK_ONE',
  'VLM_UNAVAILABLE',
  'VLM_INVALID_SKU',
] as const;
export type CvTestScenario = (typeof CV_TEST_SCENARIO_VALUES)[number];

export const CV_TEST_PROTOCOL_STATUS_VALUES = [
  'DRAFT',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
] as const;
export type CvTestProtocolStatus = (typeof CV_TEST_PROTOCOL_STATUS_VALUES)[number];

export const CV_TEST_SCENARIO_TYPE_VALUES = [
  'SINGLE_PICKUP',
  'SINGLE_RETURN',
  'FALSE_TOUCH_NO_PRODUCT_MOVED',
  'MISSED_PICKUP',
  'MISSED_RETURN',
  'TWO_PRODUCTS_VISIBLE_ONE_PICKED',
  'SIMILAR_SKU_CONFUSION',
  'MULTI_QUANTITY_PICKUP',
  'HAND_OCCLUSION',
  'FAST_PICKUP',
  'SLOW_PICKUP',
  'LOW_LIGHT',
  'BAD_ANGLE',
  'EMPTY_SHELF',
  'UNKNOWN_PRODUCT',
] as const;
export type CvTestScenarioType = (typeof CV_TEST_SCENARIO_TYPE_VALUES)[number];

export const CV_TEST_SCENARIO_RESULT_VALUES = [
  'PASS',
  'FAIL',
  'INCONCLUSIVE',
] as const;
export type CvTestScenarioResult = (typeof CV_TEST_SCENARIO_RESULT_VALUES)[number];

/* ------------------------------------------------------------------ */
/* CV dataset improvement */
/* ------------------------------------------------------------------ */

/** Mirrors the Prisma `CvDatasetImprovementRunStatus` enum. */
export const CV_DATASET_RUN_STATUS_VALUES = [
  'DRAFT',
  'READY',
  'EXPORTED',
  'ARCHIVED',
] as const;
export type CvDatasetRunStatus = (typeof CV_DATASET_RUN_STATUS_VALUES)[number];

export const CV_DATASET_PURPOSE_VALUES = [
  'SKU_CLASSIFICATION',
  'ACTION_RECOGNITION',
  'FALSE_TOUCH_FILTERING',
  'MISSED_EVENT_RECOVERY',
  'CALIBRATION_VALIDATION',
  'MIXED',
] as const;
export type CvDatasetPurpose = (typeof CV_DATASET_PURPOSE_VALUES)[number];

export const CV_DATASET_CANDIDATE_SOURCE_TYPE_VALUES = [
  'LIVE_REVIEW',
  'MISSED_EVENT',
  'PROTOCOL_SCENARIO',
  'DATASET_EXPORT_ITEM',
] as const;
export type CvDatasetCandidateSourceType = (typeof CV_DATASET_CANDIDATE_SOURCE_TYPE_VALUES)[number];

export const CV_DATASET_SPLIT_VALUES = [
  'TRAIN',
  'VALIDATION',
  'TEST',
  'HOLDOUT',
] as const;
export type CvDatasetSplit = (typeof CV_DATASET_SPLIT_VALUES)[number];

export const CV_DATASET_ELIGIBILITY_VALUES = [
  'ELIGIBLE',
  'EXCLUDED',
] as const;
export type CvDatasetEligibility = (typeof CV_DATASET_ELIGIBILITY_VALUES)[number];

/** No Prisma enum: computed readiness grade. */
export const CV_DATASET_READINESS_VALUES = [
  'READY',
  'WARNING',
  'NOT_READY',
] as const;
export type CvDatasetReadiness = (typeof CV_DATASET_READINESS_VALUES)[number];

/* ------------------------------------------------------------------ */
/* One-SKU bootstrap */
/* ------------------------------------------------------------------ */

/** No Prisma enum: crop quality warning codes. */
export const ONE_SKU_CROP_WARNING_VALUES = [
  'PRODUCT_TOO_SMALL',
  'HIGH_OCCLUSION',
  'LOW_SHARPNESS',
  'CROP_MISALIGNED',
  'NO_CLEAR_PRODUCT_FRAME',
  'UNKNOWN_GEOMETRY',
] as const;
export type OneSkuCropWarning = (typeof ONE_SKU_CROP_WARNING_VALUES)[number];

/**
 * The compile-time bridge between the Prisma schema and `@byond/shared`.
 *
 * `@byond/shared` declares the domain vocabularies ONCE so the admin web
 * stops hand-copying them. That only helps if the copies cannot drift, so
 * every vocabulary that mirrors a Prisma enum is pinned here: each entry
 * below is a type-level assertion that the union and the enum still have
 * exactly the same members, in either direction. Add a member to a Prisma
 * enum without adding it to `@byond/shared` (or vice versa) and
 * `pnpm run typecheck` fails with the offending name, instead of a page
 * silently failing to match a status it has never heard of.
 *
 * Imports are type-only by design: `@byond/shared` is a source-only
 * workspace package, so nothing here may survive into `dist` as a
 * runtime `require` of a TypeScript file.
 */
import type * as Prisma from '@prisma/client';
import type * as Shared from '@byond/shared';

/**
 * `true` only when A and B are the same union, `false` otherwise.
 * Checking each side separately is what makes a MISSING member fail
 * rather than a merely-assignable subset passing.
 *
 * The mismatch branch must be `false` and never `never`: `never` is
 * assignable to every type, so a `never` verdict would satisfy the
 * `extends true` guard below and the whole file would pass vacuously.
 */
type SameUnion<A extends string, B extends string> = [Exclude<A, B>] extends [never]
  ? [Exclude<B, A>] extends [never]
    ? true
    : false
  : false;

/** One pinned vocabulary: `true` while it matches, `false` once it drifts. */
type Pinned<A extends string, B extends string> = SameUnion<A, B>;

export interface SharedVocabularyMatchesPrisma {
  checkoutSessionStatus: Pinned<Shared.CheckoutSessionStatus, Prisma.CheckoutSessionStatus>;
  orderStatus: Pinned<Shared.OrderStatus, Prisma.OrderStatus>;
  orderPaymentStatus: Pinned<Shared.OrderPaymentStatus, Prisma.OrderPaymentStatus>;
  paymentProvider: Pinned<Shared.PaymentProvider, Prisma.PaymentProvider>;
  paymentStatus: Pinned<Shared.PaymentStatus, Prisma.PaymentStatus>;
  paymentCaptureStatus: Pinned<Shared.PaymentCaptureStatus, Prisma.PaymentCaptureStatus>;
  paymentEventStatus: Pinned<Shared.PaymentEventStatus, Prisma.PaymentEventStatus>;
  paymentEventType: Pinned<Shared.PaymentEventType, Prisma.PaymentEventType>;
  reconciliationStatus: Pinned<Shared.ReconciliationStatus, Prisma.ReconciliationStatus>;
  visionEventType: Pinned<Shared.VisionEventType, Prisma.VisionEventType>;
  visionEventStatus: Pinned<Shared.VisionEventStatus, Prisma.VisionEventStatus>;
  inferenceJobType: Pinned<Shared.InferenceJobType, Prisma.InferenceJobType>;
  inferenceJobStatus: Pinned<Shared.InferenceJobStatus, Prisma.InferenceJobStatus>;
  videoAssetStatus: Pinned<Shared.VideoAssetStatus, Prisma.VideoAssetStatus>;
  videoArtifactType: Pinned<Shared.VideoArtifactType, Prisma.VideoArtifactType>;
  videoCropReason: Pinned<Shared.VideoCropReason, Prisma.VideoCropReason>;
  groundTruthEventKind: Pinned<Shared.GroundTruthEventKind, Prisma.GroundTruthEventKind>;
  cvTestScenario: Pinned<Shared.CvTestScenario, Prisma.CvTestScenario>;
  cameraSourceType: Pinned<Shared.CameraSourceType, Prisma.CameraSourceType>;
  cameraSourceStatus: Pinned<Shared.CameraSourceStatus, Prisma.CameraSourceStatus>;
  pilotExpectedAction: Pinned<Shared.PilotExpectedAction, Prisma.PilotExpectedAction>;
  cvTestProtocolStatus: Pinned<Shared.CvTestProtocolStatus, Prisma.CvTestProtocolStatus>;
  cvTestScenarioResult: Pinned<Shared.CvTestScenarioResult, Prisma.CvTestScenarioResult>;
  cvTestScenarioType: Pinned<Shared.CvTestScenarioType, Prisma.CvTestScenarioType>;
  cameraCalibrationProfileStatus: Pinned<Shared.CameraCalibrationProfileStatus, Prisma.CameraCalibrationProfileStatus>;
  cameraCalibrationOrientation: Pinned<Shared.CameraCalibrationOrientation, Prisma.CameraCalibrationOrientation>;
  cameraCalibrationMount: Pinned<Shared.CameraCalibrationMount, Prisma.CameraCalibrationMount>;
  cameraCalibrationZoneType: Pinned<Shared.CameraCalibrationZoneType, Prisma.CameraCalibrationZoneType>;
  cvDatasetPurpose: Pinned<Shared.CvDatasetPurpose, Prisma.CvDatasetPurpose>;
  cvDatasetCandidateSourceType: Pinned<Shared.CvDatasetCandidateSourceType, Prisma.CvDatasetCandidateSourceType>;
  cvDatasetSplit: Pinned<Shared.CvDatasetSplit, Prisma.CvDatasetSplit>;
  cvDatasetEligibility: Pinned<Shared.CvDatasetEligibility, Prisma.CvDatasetEligibility>;
  /** `CustomerJourneyEventType` in the schema. */
  journeyEventType: Pinned<Shared.JourneyEventType, Prisma.CustomerJourneyEventType>;
  /** `CustomerJourneyDecision` in the schema. */
  journeyDecision: Pinned<Shared.JourneyDecision, Prisma.CustomerJourneyDecision>;
  /** `JourneyEventReviewDecision` in the schema. */
  journeyReviewDecision: Pinned<Shared.JourneyReviewDecision, Prisma.JourneyEventReviewDecision>;
  /** `CameraPilotRunStatus` in the schema. */
  pilotRunStatus: Pinned<Shared.PilotRunStatus, Prisma.CameraPilotRunStatus>;
  /** `LiveCameraSessionStatus` in the schema. */
  liveSessionStatus: Pinned<Shared.LiveSessionStatus, Prisma.LiveCameraSessionStatus>;
  /** `PilotEvaluationRunStatus` in the schema. */
  pilotEvaluationStatus: Pinned<Shared.PilotEvaluationStatus, Prisma.PilotEvaluationRunStatus>;
  /** `PilotObservationVerdict` in the schema. */
  pilotVerdict: Pinned<Shared.PilotVerdict, Prisma.PilotObservationVerdict>;
  /** `CvDatasetImprovementRunStatus` in the schema. */
  cvDatasetRunStatus: Pinned<Shared.CvDatasetRunStatus, Prisma.CvDatasetImprovementRunStatus>;
}

/**
 * The keys of the pin table whose verdict is no longer `true` — the
 * vocabularies that have drifted apart.
 */
type DriftedVocabularies = {
  [K in keyof SharedVocabularyMatchesPrisma]: SharedVocabularyMatchesPrisma[K] extends true
    ? never
    : K;
}[keyof SharedVocabularyMatchesPrisma];

/**
 * The assertion itself. Declaring a pin is inert on its own — a property
 * typed `false` is still a legal property — so the table above only bites
 * when something rejects a non-empty drift set. This alias is that
 * something: `tsc` reports `Type '"orderStatus"' does not satisfy the
 * constraint 'never'`, naming the vocabulary that drifted.
 */
type NoDrift<TDrifted extends never> = TDrifted;

/** Resolves to `never` while every vocabulary matches; fails to compile otherwise. */
export type SharedVocabularyDrift = NoDrift<DriftedVocabularies>;

/**
 * Vocabularies with no Prisma enum behind them — they are computed grades
 * and classified code lists the services derive, so there is nothing to
 * pin them to. Listed so the next reader knows the omission is deliberate:
 * `CalibrationReadinessLevel`, `CvDatasetReadiness`, `OneSkuCropWarning`.
 */
export type UnpinnedSharedVocabularies =
  | Shared.CalibrationReadinessLevel
  | Shared.CvDatasetReadiness
  | Shared.OneSkuCropWarning;

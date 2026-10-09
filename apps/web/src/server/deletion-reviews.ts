import { createHash } from "node:crypto";
import type { JsonValue } from "@agents-in-the-cloud/core";
import type { WorkspaceDeletionReview } from "@agents-in-the-cloud/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";

const blockedReviewsSchema = Type.Array(Type.Object({ review: Type.Integer({ minimum: 0 }), details: Type.Unsafe<JsonValue>({}) }));

/**
 * Each module reviews what deleting a workspace would lose. Deletion goes ahead without asking only when
 * none of them finds anything; otherwise the user sees every module's evidence at once.
 */
export function combineDeletionReviews(reviews: WorkspaceDeletionReview[]): WorkspaceDeletionReview {
  return {
    async inspect(workspaceId) {
      const assessments = await Promise.all(reviews.map((review) => review.inspect(workspaceId)));
      const blocked = assessments.flatMap((assessment, review) => assessment.status === "blocked" ? [{ review, fingerprint: assessment.fingerprint, details: assessment.details }] : []);
      if (!blocked.length) return { status: "clear" };
      return {
        status: "blocked",
        fingerprint: createHash("sha256").update(JSON.stringify(blocked.map(({ review, fingerprint }) => [review, fingerprint]))).digest("hex"),
        details: blocked.map(({ review, details }) => ({ review, details })),
      };
    },
    renderEvidence(workspaceId, details) {
      if (!Value.Check(blockedReviewsSchema, details)) throw new Error("Deletion review evidence is invalid");
      return details.map(({ review, details: evidence }) => reviews[review]!.renderEvidence(workspaceId, evidence)).join("");
    },
  };
}

export type MatrixRtcMode = "compatibility" | "matrix_2_0";

type MatrixRtcModeMembershipLike = {
  getAbsoluteExpiry(): number | undefined;
};

export function resolveMatrixRtcMode(membership: MatrixRtcModeMembershipLike): MatrixRtcMode {
  // matrix-js-sdk exposes an absolute expiry only for legacy m.call.member
  // state memberships. New m.rtc.member sticky memberships do not expire in
  // the event payload and require the hashed Matrix 2.0 identity contract.
  return membership.getAbsoluteExpiry() === undefined ? "matrix_2_0" : "compatibility";
}

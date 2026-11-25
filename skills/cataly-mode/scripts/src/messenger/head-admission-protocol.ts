export const HEAD_ADMISSION_PROTOCOL = "cataly-head-admission-v1";
export type HeadAdmissionProtocol = typeof HEAD_ADMISSION_PROTOCOL;

export const isHeadAdmissionProtocol = (value: unknown): value is HeadAdmissionProtocol =>
  value === HEAD_ADMISSION_PROTOCOL;

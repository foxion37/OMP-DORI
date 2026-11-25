/** Remote-command wire types; the native host (`native/src/headless/remote.rs`) serves them. */
export type HeadlessRemoteInput = {
  readonly id: string;
  readonly text: string;
  readonly delivery?: "prompt" | "steer";
};
export type HeadlessRemoteReceipt = {
  readonly id: string;
  readonly status: "pending" | "admitted" | "refused";
  readonly replyAttributed: false;
  readonly receipt?: { readonly id: string; readonly kind: "native-submission" };
  readonly reason?: string;
};
export type HeadlessRemoteInterrupt = {
  readonly status: "interrupted" | "refused";
  readonly foreground: boolean;
  readonly background: "unverified";
  readonly reason?: string;
};
export type HeadlessRemoteModel = {
  readonly status: "changed" | "refused";
  readonly model?: string;
  readonly reason?: string;
};
export type HeadlessRemoteClose = {
  readonly status: "closed" | "refused" | "close-unconfirmed";
  readonly reason?: string;
};
export type HeadlessRemoteRequest = { readonly expectedSessionId: string } & (
  | { readonly op: "remote-send"; readonly input: HeadlessRemoteInput }
  | { readonly op: "remote-receipt"; readonly id: string }
  | { readonly op: "remote-interrupt" }
  | { readonly op: "remote-model"; readonly model: string }
  | { readonly op: "remote-close"; readonly force: boolean }
);

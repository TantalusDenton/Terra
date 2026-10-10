import type { ProposalDraft } from "./proposals";

export type Stage = { token: string } & (
  | { kind: "proposal"; draft: ProposalDraft }
  | { kind: "ballot"; id: string; choice: "0" | "1" | "2" }
);
const key = "terra-agent-stage:";
export function getStage(scope = "terra"): Stage | null {
  try {
    return JSON.parse(sessionStorage.getItem(key + scope) ?? "null");
  } catch {
    return null;
  }
}
export function acknowledgeStage(token: string, scope = "terra") {
  if (getStage(scope)?.token === token) sessionStorage.removeItem(key + scope);
  window.dispatchEvent(
    new CustomEvent("terra-stage-visible", { detail: token }),
  );
}
export async function stageForReview(
  stage:
    | Omit<Extract<Stage, { kind: "proposal" }>, "token">
    | Omit<Extract<Stage, { kind: "ballot" }>, "token">,
  navigate: (url: string) => void,
  scope = "terra",
  basePath = "",
) {
  const token = crypto.randomUUID();
  sessionStorage.setItem(key + scope, JSON.stringify({ ...stage, token }));
  const visible = new Promise<void>((resolve, reject) => {
    const listener = (event: Event) => {
      if ((event as CustomEvent).detail !== token) return;
      clearTimeout(timer);
      window.removeEventListener("terra-stage-visible", listener);
      resolve();
    };
    const timer = setTimeout(() => {
      window.removeEventListener("terra-stage-visible", listener);
      if (getStage(scope)?.token === token) sessionStorage.removeItem(key + scope);
      reject(
        new Error(
          "The review page did not open. Please open it manually and try again.",
        ),
      );
    }, 10000);
    window.addEventListener("terra-stage-visible", listener);
  });
  navigate(
    basePath + (stage.kind === "proposal" ? "/proposals/new" : `/proposals/${stage.id}`),
  );
  window.dispatchEvent(new Event("terra-stage"));
  await visible;
  return { status: "prepared_not_signed", requiresWalletSignature: true };
}

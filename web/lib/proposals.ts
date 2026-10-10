import { getAddress, isAddress, parseEther, zeroAddress, type Hex } from "viem";
import type { Action } from "./terra";

export type ActionDraft = { target: string; value: string; data: string };
export type ProposalDraft = {
  title: string;
  summary: string;
  body: string;
  duration: string;
  unit: "hours" | "days";
  actions: ActionDraft[];
};
export const emptyDraft = (): ProposalDraft => ({
  title: "",
  summary: "",
  body: "",
  duration: "72",
  unit: "hours",
  actions: [],
});
export function policyBytes(
  draft: Pick<ProposalDraft, "title" | "summary" | "body">,
) {
  return new TextEncoder().encode(draft.title + draft.summary + draft.body)
    .length;
}
export function validateDraft(draft: ProposalDraft) {
  if (!draft || typeof draft !== "object")
    throw new Error("Provide a proposal draft.");
  if (
    typeof draft.title !== "string" ||
    typeof draft.body !== "string" ||
    typeof draft.summary !== "string" ||
    !draft.title.trim() ||
    !draft.body.trim()
  )
    throw new Error("Give your policy a title and full text.");
  if (policyBytes(draft) > 16384)
    throw new Error(
      "The title, summary, and policy text together must fit within 16 KiB.",
    );
  if (draft.unit !== "hours" && draft.unit !== "days")
    throw new Error("Duration unit must be hours or days.");
  if (
    typeof draft.duration !== "string" ||
    !/^\d+(\.\d+)?$/.test(draft.duration)
  )
    throw new Error("Enter a positive duration.");
  const seconds =
    Number(draft.duration) * (draft.unit === "days" ? 86400 : 3600);
  if (!Number.isSafeInteger(seconds) || seconds < 3600 || seconds > 2592000)
    throw new Error(
      "Choose a duration from one hour to 30 days, in whole seconds.",
    );
  if (!Array.isArray(draft.actions) || draft.actions.length > 8)
    throw new Error("A proposal may contain up to eight actions.");
  const actions: Action[] = draft.actions.map((a, index) => {
    if (
      !a ||
      typeof a.target !== "string" ||
      typeof a.value !== "string" ||
      typeof a.data !== "string"
    )
      throw new Error(
        `Action ${index + 1} needs target, value, and calldata strings.`,
      );
    if (!isAddress(a.target) || getAddress(a.target) === zeroAddress)
      throw new Error(
        `Action ${index + 1} needs a valid, nonzero target address.`,
      );
    if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(a.value))
      throw new Error(
        `Action ${index + 1} needs a nonnegative ETH amount with up to 18 decimals.`,
      );
    if (!/^0x(?:[a-fA-F0-9]{2})*$/.test(a.data))
      throw new Error(
        `Action ${index + 1} calldata must be complete hexadecimal bytes beginning with 0x.`,
      );
    const value = parseEther(a.value);
    if (value >= 2n ** 256n)
      throw new Error(`Action ${index + 1} amount exceeds the contract limit.`);
    return { target: getAddress(a.target), value, data: a.data as Hex };
  });
  return {
    title: draft.title,
    summary: draft.summary,
    body: draft.body,
    duration: BigInt(seconds),
    actions,
  };
}

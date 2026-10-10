"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Trash2, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTerra } from "@/app/providers";
import { WalletControl } from "./terra-shell";
import {
  userError,
} from "@/lib/terra";
import {
  emptyDraft,
  policyBytes,
  validateDraft,
  type ProposalDraft,
} from "@/lib/proposals";
import { getStage, acknowledgeStage } from "@/lib/agent-staging";

export default function ProposalForm() {
  const { account, citizen, busy, transact, chain, governorAddress, governorAbi, publicClient, isDeployed, community, href, home, memberWord, proposalWord } = useTerra();
  const draftKey = "terra-proposal-draft:" + community.chainId + ":" + governorAddress;
  const scope = community.chainId + ":" + governorAddress;
  const router = useRouter();
  const [draft, setDraft] = useState<ProposalDraft>(emptyDraft);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState(false);
  const [stageToken, setStageToken] = useState<string | null>(null);
  /* eslint-disable react-hooks/set-state-in-effect -- Hydrate tab-local draft preferences after SSR; never hydrate blockchain records from storage. */
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(draftKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (
          typeof parsed.title === "string" &&
          typeof parsed.summary === "string" &&
          typeof parsed.body === "string" &&
          typeof parsed.duration === "string" &&
          ["hours", "days"].includes(parsed.unit) &&
          Array.isArray(parsed.actions) &&
          parsed.actions.length <= 8 &&
          parsed.actions.every(
            (a: unknown) =>
              !!a &&
              typeof a === "object" &&
              ["target", "value", "data"].every(
                (key) =>
                  typeof (a as Record<string, unknown>)[key] === "string",
              ),
          )
        )
          setDraft(parsed);
      }
    } catch {}
    setLoaded(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (loaded)
      try {
        sessionStorage.setItem(draftKey, JSON.stringify(draft));
      } catch {}
  }, [draft, loaded]);
  useEffect(() => {
    function receive() {
      const stage = getStage(scope);
      if (stage?.kind !== "proposal") return;
      try {
        validateDraft(stage.draft);
        setDraft(stage.draft);
        setReview(false);
        setError("");
        setStageToken(stage.token);
      } catch {
        setError(
          "The agent draft is invalid. Your existing draft has not been changed.",
        );
      }
    }
    receive();
    window.addEventListener("terra-stage", receive);
    return () => window.removeEventListener("terra-stage", receive);
  }, []);
  useEffect(() => {
    if (stageToken) acknowledgeStage(stageToken, scope);
  }, [stageToken]);
  const change = (key: keyof ProposalDraft, value: unknown) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setReview(false);
    setError("");
  };
  const updateAction = (
    index: number,
    key: "target" | "value" | "data",
    value: string,
  ) => {
    setDraft((d) => ({
      ...d,
      actions: d.actions.map((a, i) =>
        i === index ? { ...a, [key]: value } : a,
      ),
    }));
    setReview(false);
  };
  async function publish() {
    setError("");
    try {
      const valid = validateDraft(draft);
      const result = await transact(
        "Proposal published",
        governorAddress!,
        governorAbi,
        "propose",
        [valid.title, valid.summary, valid.body, valid.duration, valid.actions],
      );
      const { decodeEventLog } = await import("viem");
      const receipt = await publicClient.getTransactionReceipt({
        hash: result.hash,
      });
      let proposalId: bigint | undefined;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== governorAddress.toLowerCase()) continue;
        try {
          const event = decodeEventLog({
            abi: governorAbi,
            data: log.data,
            topics: log.topics,
          });
          if (event.eventName === "ProposalCreated")
            proposalId = (event.args as unknown as { proposalId: bigint })
              .proposalId;
        } catch {}
      }
      setDraft(emptyDraft());
      try {
        sessionStorage.removeItem(draftKey);
      } catch {}
      router.push(proposalId ? href("/proposals/" + proposalId) : home);
    } catch (e) {
      setError(userError(e));
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR PROPOSAL</p>
          <h1>Put an idea to a vote.</h1>
          <p className="lede">Any subject. One clear {proposalWord}. Equal voices.</p>
        </div>
      </div>
      <div className="assembly-layout">
        <section className="panel">
          <form
            className="panel-body proposal-form"
            onSubmit={(e) => {
              e.preventDefault();
              setError("");
              try {
                validateDraft(draft);
                setReview(true);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <label className="field-label" htmlFor="proposal-title">
              Policy title
            </label>
            <Input
              id="proposal-title"
              required
              value={draft.title}
              onChange={(e) => change("title", e.target.value)}
              placeholder="What should Terra decide?"
            />
            <label className="field-label" htmlFor="proposal-summary">
              Short summary
            </label>
            <Textarea
              id="proposal-summary"
              rows={2}
              value={draft.summary}
              onChange={(e) => change("summary", e.target.value)}
              placeholder="The decision, in a few sentences."
            />
            <label className="field-label" htmlFor="proposal-body">
              Full {proposalWord} text
            </label>
            <Textarea
              id="proposal-body"
              required
              rows={10}
              value={draft.body}
              onChange={(e) => change("body", e.target.value)}
              placeholder="State the policy, its purpose, and its intended effects."
            />
            <p className="small-note">
              {policyBytes(draft).toLocaleString()} / 16,384 bytes. The
              published text becomes permanent.
            </p>
            <label className="field-label" htmlFor="proposal-duration">
              How long should voting stay open?
            </label>
            <div className="duration-fields">
              <Input
                id="proposal-duration"
                type="number"
                min="0"
                step="any"
                required
                value={draft.duration}
                onChange={(e) => change("duration", e.target.value)}
              />
              <Select
                value={draft.unit}
                onValueChange={(v) => change("unit", v)}
              >
                <SelectTrigger aria-label="Duration unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hours">Hours</SelectItem>
                  <SelectItem value="days">Days</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="small-note">
              Choose one hour to 30 days. Voting starts when your proposal is
              published.
            </p>
            <div className="section-divider">
              <div>
                <h2>Executable actions</h2>
                <p className="small-note">
                  Optional. Leave empty to enact a policy record.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={draft.actions.length >= 8}
                onClick={() =>
                  change("actions", [
                    ...draft.actions,
                    { target: "", value: "0", data: "0x" },
                  ])
                }
              >
                <Plus size={16} /> Add action
              </Button>
            </div>
            {draft.actions.map((a, index) => (
              <div className="action-editor" key={index}>
                <div className="action-heading">
                  <strong>Action {index + 1}</strong>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={`Remove action ${index + 1}`}
                    onClick={() =>
                      change(
                        "actions",
                        draft.actions.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
                <label className="field-label" htmlFor={`target-${index}`}>
                  Target contract or wallet
                </label>
                <Input
                  id={`target-${index}`}
                  required
                  value={a.target}
                  onChange={(e) =>
                    updateAction(index, "target", e.target.value)
                  }
                  placeholder="0x…"
                />
                <label className="field-label" htmlFor={`value-${index}`}>
                  Test ETH from the treasury
                </label>
                <Input
                  id={`value-${index}`}
                  required
                  value={a.value}
                  onChange={(e) => updateAction(index, "value", e.target.value)}
                  inputMode="decimal"
                />
                <label className="field-label" htmlFor={`data-${index}`}>
                  Calldata
                </label>
                <Textarea
                  id={`data-${index}`}
                  rows={3}
                  required
                  value={a.data}
                  onChange={(e) => updateAction(index, "data", e.target.value)}
                  className="code-field"
                />
                <p className="small-note">
                  Use 0x for a simple ETH transfer. All actions execute as one
                  batch.
                </p>
              </div>
            ))}
            {draft.actions.length > 0 && (
              <div className="notice warning">
                <p>
                  Passed actions can spend treasury funds and call external
                  contracts immediately after voting ends. Review every address,
                  value, and byte before publishing.
                </p>
              </div>
            )}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            {!review ? (
              <Button type="submit" className="primary-button">
                <FileText size={16} /> Review proposal
              </Button>
            ) : (
              <section className="review-box">
                <h2>Ready for the public record?</h2>
                <h3>{draft.title}</h3>
                <p className="policy-text">{draft.summary}</p>
                <p className="policy-text">{draft.body}</p>
                <p>
                  Duration: {draft.duration} {draft.unit}.{" "}
                  {draft.actions.length} actions.
                </p>
                {draft.actions.length > 0 && (
                  <pre>{JSON.stringify(draft.actions, null, 2)}</pre>
                )}
                <p className="small-note">
                  No quorum. Yes must exceed No. The text and actions cannot be
                  edited after publication.
                </p>
                {!account.address ? (
                  <WalletControl />
                ) : !citizen.data?.id ? (
                  <Button asChild variant="outline">
                    <Link href={href("/citizenship")}>Become a {memberWord} first</Link>
                  </Button>
                ) : (
                  <Button
                    type="button"
                    disabled={
                      busy || !isDeployed || account.chainId !== chain.id
                    }
                    onClick={() => void publish()}
                  >
                    Publish with wallet
                  </Button>
                )}
              </section>
            )}
          </form>
        </section>
        <aside className="panel side-note">
          <h2>A fair hearing</h2>
          <p>
            Only {memberWord}s can propose. Everyone in the electorate gets one
            ballot.
          </p>
          <hr />
          <h3>The electorate is fixed</h3>
          <p>
            Citizens admitted after publication can vote on future proposals.
          </p>
          <hr />
          <h3>No minimum turnout</h3>
          <p>
            One Yes vote can pass a proposal if there are no No votes. Ties and
            zero-vote proposals fail.
          </p>
          <hr />
          <h3>Draft stays here</h3>
          <p>
            Your temporary draft is saved only in this browser tab. Publication
            writes it to the blockchain.
          </p>
        </aside>
      </div>
    </>
  );
}

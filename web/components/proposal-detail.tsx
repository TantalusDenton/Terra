"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatEther } from "viem";
import {
  Copy,
  Clock3,
  ExternalLink,
  Landmark,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useProposal, useTerra } from "@/app/providers";
import { WalletControl } from "./terra-shell";
import {
  formatDate,
  policyState,
  shortAddress,
  userError,
} from "@/lib/terra";
import { getStage, acknowledgeStage } from "@/lib/agent-staging";
import { verifyProposalOnchain } from "@/lib/community";

export default function ProposalDetail({ id }: { id: string }) {
  const { assembly, account, citizen, now, busy, transact, chain, explorer, governorAddress, governorAbi, isDeployed, publicClient, community, href, home, memberWord, proposalWord } = useTerra();
  const record = useProposal(id);
  const [choice, setChoice] = useState("1");
  const [error, setError] = useState("");
  const [stageToken, setStageToken] = useState<string | null>(null);
  const proposal = record.data;
  const ballot = useQuery({
    queryKey: ["ballot", community.chainId, governorAddress, id, account.address],
    enabled: isDeployed && !!account.address && !!proposal,
    refetchInterval: 15000,
    retry: 1,
    queryFn: async () =>
      Number(
        await publicClient.readContract({
          address: governorAddress!,
          abi: governorAbi,
          functionName: "ballots",
          args: [BigInt(id), account.address!],
        }),
      ),
  });
  useEffect(() => {
    function receive() {
      const stage = getStage(community.chainId + ":" + governorAddress);
      if (
        stage?.kind !== "ballot" ||
        stage.id !== id ||
        !["0", "1", "2"].includes(stage.choice) ||
        !proposal
      )
        return;
      setChoice(stage.choice);
      setStageToken(stage.token);
      setError("");
    }
    receive();
    window.addEventListener("terra-stage", receive);
    return () => window.removeEventListener("terra-stage", receive);
  }, [id, proposal]);
  useEffect(() => {
    if (stageToken) acknowledgeStage(stageToken, community.chainId + ":" + governorAddress);
  }, [stageToken]);
  if (!proposal)
    return (
      <section className="panel empty-state">
        <Landmark size={42} />
        <h1>
          {record.isLoading
            ? "Reading this " + proposalWord + "…"
            : !isDeployed
              ? "Voting opens after deployment."
              : record.isError
                ? "The ledger is unavailable."
                : proposalWord[0].toUpperCase() + proposalWord.slice(1) + " not found."}
        </h1>
        <p>
          {!isDeployed
            ? "This voting page becomes available after " + community.name + "’s deployment is independently verified."
            : "Return to the Assembly to view the public record."}
        </p>
        <Button asChild variant="outline">
          <Link href={home}>View assembly</Link>
        </Button>
      </section>
    );
  const state = policyState(proposal, now);
  const total = proposal.yes + proposal.no + proposal.abstain;
  const yesPercent = total ? Number((proposal.yes * 10000n) / total) / 100 : 0;
  const eligible = !!citizen.data?.id && citizen.data.id <= proposal.electorate;
  const hasBallot = (ballot.data ?? 0) > 0;
  const choiceNames = ["No", "Yes", "Abstain"];
  async function cast() {
    setError("");
    try {
      await verifyProposalOnchain(community, proposal!);
      await transact("Ballot recorded", governorAddress!, governorAbi, "vote", [
        BigInt(id),
        Number(choice),
      ]);
      await ballot.refetch();
    } catch (e) {
      setError(userError(e));
    }
  }
  async function execute() {
    setError("");
    try {
      await verifyProposalOnchain(community, proposal!);
      await transact(
        proposalWord[0].toUpperCase() + proposalWord.slice(1) + " enacted",
        governorAddress!,
        governorAbi,
        "execute",
        [BigInt(id), proposal!.actions],
      );
    } catch (e) {
      setError(userError(e));
    }
  }
  const txLink = explorer("tx", proposal.transactionHash);
  return (
    <>
      <Link href={home} className="back-link">
        Assembly / {proposalWord} {id.padStart(3, "0")}
      </Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{proposalWord.toUpperCase()} {id.padStart(3, "0")}</p>
          <h1 className="policy-title">{proposal.title}</h1>
          <p className="lede">
            Proposed by {shortAddress(proposal.proposer)} ·{" "}
            {formatDate(proposal.startsAt)}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() =>
            void navigator.clipboard
              .writeText(window.location.href)
              .then(() => toast.success("Voting link copied"))
              .catch(() =>
                toast.error("Copy the voting page URL from your browser."),
              )
          }
        >
          <Copy size={16} /> Copy voting link
        </Button>
      </div>
      <div className="assembly-layout">
        <div className="space-y-6">
          <section className="panel">
            <div className="panel-heading">
              <h2>The {proposalWord}</h2>
              <span className={`status status-${state.toLowerCase()}`}>
                {state}
              </span>
            </div>
            <article className="panel-body">
              {proposal.summary && (
                <p className="policy-summary">{proposal.summary}</p>
              )}
              <p className="policy-text">{proposal.body}</p>
            </article>
            <div className="panel-footer">
              <Clock3 size={15} /> Voting{" "}
              {state === "Active" ? "closes" : "closed"}{" "}
              {formatDate(proposal.endsAt)}
            </div>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>
                {proposal.actions.length
                  ? "Exact execution payload"
                  : "Policy enactment"}
              </h2>
              <span className="pill">Immutable</span>
            </div>
            <div className="panel-body">
              {proposal.actions.length ? (
                <>
                  <p>
                    These calls run as one transaction from {community.name}’s treasury if
                    the policy passes. Any failing call rolls back the entire
                    batch.
                  </p>
                  {proposal.actions.map((action, index) => (
                    <div className="payload-card" key={index}>
                      <strong>Action {index + 1}</strong>
                      <dl>
                        <dt>Target</dt>
                        <dd>
                          <code>{action.target}</code>
                        </dd>
                        <dt>Test ETH</dt>
                        <dd>{formatEther(action.value)}</dd>
                        <dt>Calldata</dt>
                        <dd>
                          <code className="raw-data">{action.data}</code>
                        </dd>
                      </dl>
                    </div>
                  ))}
                </>
              ) : (
                <p>
                  This proposal enacts a permanent policy record. It has no
                  external calls or treasury transfers.
                </p>
              )}
              <details className="hash-details">
                <summary>Verify hashes and publication</summary>
                <dl>
                  <dt>Policy hash</dt>
                  <dd>
                    <code>{proposal.policyHash}</code>
                  </dd>
                  <dt>Actions hash</dt>
                  <dd>
                    <code>{proposal.actionsHash}</code>
                  </dd>
                  <dt>Publication transaction</dt>
                  <dd>
                    {txLink ? (
                      <a
                        className="text-link"
                        href={txLink}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        View on explorer <ExternalLink size={13} />
                      </a>
                    ) : (
                      <code>{proposal.transactionHash}</code>
                    )}
                  </dd>
                  <dt>Eligible {memberWord}s</dt>
                  <dd>Member IDs 1–{proposal.electorate.toString()}</dd>
                </dl>
              </details>
            </div>
          </section>
        </div>
        <aside className="panel ballot-panel">
          <div className="panel-heading">
            <h2>The vote</h2>
            <span className="pill">1 {memberWord} / 1 vote</span>
          </div>
          <div className="panel-body">
            <div className="vote-total">
              {total.toString()} <span>ballots</span>
            </div>
            <div className="tally-track">
              <span style={{ width: `${yesPercent}%` }} />
            </div>
            <dl className="vote-counts">
              <div>
                <dt>Yes</dt>
                <dd>{proposal.yes.toString()}</dd>
              </div>
              <div>
                <dt>No</dt>
                <dd>{proposal.no.toString()}</dd>
              </div>
              <div>
                <dt>Abstain</dt>
                <dd>{proposal.abstain.toString()}</dd>
              </div>
            </dl>
            <p className="small-note">
              No turnout requirement. Yes must exceed No.
            </p>
            <hr />
            {state === "Active" ? (
              <>
                {hasBallot ? (
                  <div className="voted">
                    <CheckCircle2 size={22} />
                    <strong>
                      Your ballot: {choiceNames[ballot.data! - 1]}
                    </strong>
                    <p>Recorded publicly. Your vote cannot be changed.</p>
                  </div>
                ) : (
                  <>
                    {!account.address ? (
                      <WalletControl />
                    ) : !citizen.data?.id ? (
                      <Button asChild>
                        <Link href={href("/citizenship")}>Become a {memberWord}</Link>
                      </Button>
                    ) : !eligible ? (
                      <p>
                        Your citizenship began after this electorate was fixed.
                        You can vote on later proposals.
                      </p>
                    ) : (
                      <>
                        <h3>Your ballot</h3>
                        <RadioGroup
                          value={choice}
                          onValueChange={setChoice}
                          className="ballot-options"
                          aria-label="Your vote"
                        >
                          {[
                            ["1", "Yes", "Support this policy"],
                            ["0", "No", "Reject this policy"],
                            ["2", "Abstain", "Record participation"],
                          ].map(([value, label, description]) => (
                            <label
                              className="ballot-choice"
                              key={value}
                              htmlFor={`choice-${value}`}
                            >
                              <RadioGroupItem
                                id={`choice-${value}`}
                                value={value}
                              />
                              <span>
                                <strong>{label}</strong>
                                <small>{description}</small>
                              </span>
                            </label>
                          ))}
                        </RadioGroup>
                        <p className="small-note">
                          Your wallet and choice will be public.
                        </p>
                        <Button
                          className="primary-button"
                          disabled={
                            busy ||
                            account.chainId !== chain.id ||
                            ballot.isLoading ||
                            ballot.isError
                          }
                          onClick={() => void cast()}
                        >
                          Cast {choiceNames[Number(choice)]} ballot
                        </Button>
                        {ballot.isError && (
                          <p role="alert" className="form-error">
                            Your existing ballot could not be verified. Try
                            refreshing.
                          </p>
                        )}
                      </>
                    )}
                  </>
                )}
              </>
            ) : state === "Passed" ? (
              <>
                <h3>Passed. Ready to enact.</h3>
                <p className="small-note">
                  Any wallet can execute this exact payload. There is no
                  additional delay.
                </p>
                {account.address ? (
                  <Button
                    className="primary-button"
                    disabled={busy || account.chainId !== chain.id}
                    onClick={() => void execute()}
                  >
                    Execute passed policy
                  </Button>
                ) : (
                  <WalletControl />
                )}
              </>
            ) : (
              <div className="voted">
                <strong>
                  {state === "Enacted"
                    ? "Part of the permanent record."
                    : "This policy did not pass."}
                </strong>
                <p>
                  {state === "Enacted"
                    ? "The original payload has been executed once."
                    : "Ties, zero votes, and No majorities cannot execute."}
                </p>
              </div>
            )}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

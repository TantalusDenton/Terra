"use client";

import { useEffect, useState } from "react";
import { isAddress } from "viem";
import { useSignMessage } from "wagmi";
import { Fingerprint, CheckCircle2, Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { WalletControl } from "@/components/terra-shell";
import { useTerra } from "@/app/providers";
import {
  CONTRIBUTION,
  formatDate,
  userError,
  type Citizen,
} from "@/lib/terra";

export default function Citizenship() {
  const { account, citizen, transact, busy, chain, explorer, isDeployed, registryAddress, registryAbi, publicClient, memberFunction, community, memberWord } = useTerra();
  const { signMessageAsync } = useSignMessage();
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [lookup, setLookup] = useState("");
  const [lookupResult, setLookupResult] = useState<Citizen | null>(null);
  const [lookupError, setLookupError] = useState("");
  const [proof, setProof] = useState<{
    address: string;
    chainId: number;
    message: string;
    signature: string;
    expiresAt: number;
  } | null>(null);
  useEffect(() => {
    if (!proof) return;
    const timer = setTimeout(
      () => setProof(null),
      Math.max(0, proof.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [proof]);
  const member = citizen.data?.id ? citizen.data : null;
  async function join() {
    setError("");
    try {
      await transact(
        community.kind === "terra" ? "Citizenship granted" : "Stockholder membership granted",
        registryAddress!,
        registryAbi,
        "join",
        [],
        CONTRIBUTION,
      );
    } catch (e) {
      setError(userError(e));
    }
  }
  async function verify() {
    setLookupError("");
    setLookupResult(null);
    if (!isAddress(lookup)) {
      setLookupError("Enter a complete Ethereum wallet address.");
      return;
    }
    if (!isDeployed) {
      setLookupError("Verification opens once the contracts are deployed.");
      return;
    }
    setChecking(true);
    try {
      const [id, joinedAt, joinedBlock] = (await publicClient.readContract({
        address: registryAddress!,
        abi: registryAbi,
        functionName: memberFunction,
        args: [lookup],
      })) as [bigint, bigint, bigint];
      setLookupResult({ id, joinedAt, joinedBlock });
    } catch (e) {
      setLookupError(userError(e));
    } finally {
      setChecking(false);
    }
  }
  async function verifyControl() {
    if (!account.address || !member) return;
    setError("");
    setProof(null);
    setChecking(true);
    const address = account.address;
    const nonce = crypto.randomUUID();
    const expiresAt = Date.now() + 300000;
    const message = `${community.name} ${memberWord} proof\nChain: ${chain.id}\nRegistry: ${registryAddress}\nWallet: ${address}\nMember: ${member.id}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}\nThis signature authorizes no transaction.`;
    try {
      const signature = await signMessageAsync({ message });
      const valid = await publicClient.verifyMessage({
        address,
        message,
        signature,
      });
      if (!valid) throw new Error("Invalid signature");
      setProof({ address, chainId: chain.id, message, signature, expiresAt });
    } catch (e) {
      setError(userError(e));
    } finally {
      setChecking(false);
    }
  }
  const registryLink = registryAddress
    ? explorer("address", registryAddress)
    : null;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{memberWord.toUpperCase()} MEMBERSHIP</p>
          <h1>Your place in {community.name}.</h1>
          <p className="lede">
            A permanent membership. The same rights for every {memberWord}.
          </p>
        </div>
      </div>
      <div className="assembly-layout">
        <div className="space-y-6">
          <section
            className={`panel passport ${member ? "passport-active" : ""}`}
          >
            <div className="panel-heading">
              <h2>
                {member ? "Your " + memberWord + " passport" : "Join " + community.name}
              </h2>
              <Fingerprint size={26} />
            </div>
            <div className="panel-body">
              {member ? (
                <>
                  <span className="eyebrow">PERMANENT {memberWord.toUpperCase()}</span>
                  <div className="passport-number">
                    {community.name.toUpperCase()} / {member.id.toString().padStart(6, "0")}
                  </div>
                  <code className="address-block">{account.address}</code>
                  <dl className="detail-grid">
                    <div>
                      <dt>Issued</dt>
                      <dd>{formatDate(member.joinedAt)}</dd>
                    </div>
                    <div>
                      <dt>Issuance block</dt>
                      <dd>{member.joinedBlock.toString()}</dd>
                    </div>
                    <div>
                      <dt>Voting power</dt>
                      <dd>One per {community.kind === "terra" ? "policy" : "resolution"}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>Permanent</dd>
                    </div>
                  </dl>
                  <Button
                    variant="outline"
                    disabled={checking || account.chainId !== chain.id}
                    onClick={() => void verifyControl()}
                  >
                    <CheckCircle2 size={16} /> Verify wallet control
                  </Button>
                  {proof &&
                    proof.address === account.address &&
                    proof.chainId === chain.id && (
                      <div className="proof-box">
                        <strong>Wallet control verified</strong>
                        <p className="small-note">
                          This signed proof expires in five minutes. Membership
                          remains permanent.
                        </p>
                        <pre>{JSON.stringify(proof, null, 2)}</pre>
                        <Button
                          variant="outline"
                          onClick={() =>
                            void navigator.clipboard
                              .writeText(JSON.stringify(proof, null, 2))
                              .catch(() =>
                                setError(
                                  "Clipboard access is unavailable. Select and copy the displayed proof instead.",
                                ),
                              )
                          }
                        >
                          <Copy size={15} /> Copy proof
                        </Button>
                      </div>
                    )}
                </>
              ) : (
                <>
                  <h2>One contribution. Lifelong standing.</h2>
                  <p>
                    Contribute 0.001 test ETH to {community.name}’s treasury. Your
                    wallet receives one permanent passport and equal rights to
                    publish proposals and vote.
                  </p>
                  <dl className="detail-grid">
                    <div>
                      <dt>Contribution</dt>
                      <dd>0.001 test ETH</dd>
                    </div>
                    <div>
                      <dt>Voting power</dt>
                      <dd>One per {community.kind === "terra" ? "policy" : "resolution"}</dd>
                    </div>
                    <div>
                      <dt>Refund or exit</dt>
                      <dd>None</dd>
                    </div>
                    <div>
                      <dt>Identity labels</dt>
                      <dd>None</dd>
                    </div>
                  </dl>
                  <label className="checkbox-row">
                    <Checkbox
                      checked={agreed}
                      onCheckedChange={(v) => setAgreed(v === true)}
                    />
                    <span>
                      I understand that membership is permanent, my payment
                      goes to the treasury, and neither can be refunded.
                    </span>
                  </label>
                  {!account.address ? (
                    <WalletControl />
                  ) : (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          className="primary-button"
                          disabled={
                            !agreed ||
                            busy ||
                            !isDeployed ||
                            citizen.isLoading ||
                            citizen.isError ||
                            account.chainId !== chain.id
                          }
                        >
                          Become a {memberWord}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Establish permanent membership?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            Your wallet will contribute 0.001 test ETH to the
                            treasury. The passport cannot be transferred,
                            revoked, or surrendered. Your wallet will also pay
                            the transaction fee.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Keep reviewing</AlertDialogCancel>
                          <AlertDialogAction onClick={() => void join()}>
                            Confirm in wallet
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                  {citizen.isError && (
                    <p role="alert" className="form-error">
                      Membership could not be read. Check your blockchain
                      connection before continuing.
                    </p>
                  )}
                </>
              )}
              {error && (
                <p role="alert" className="form-error">
                  {error}
                </p>
              )}
            </div>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>Verify a {memberWord}</h2>
            </div>
            <form
              className="panel-body"
              onSubmit={(e) => {
                e.preventDefault();
                void verify();
              }}
            >
              <label htmlFor="citizen-address" className="field-label">
                Wallet address
              </label>
              <div className="inline-form">
                <Input
                  id="citizen-address"
                  value={lookup}
                  onChange={(e) => {
                    setLookup(e.target.value);
                    setLookupResult(null);
                  }}
                  placeholder="0x…"
                  autoComplete="off"
                />
                <Button disabled={checking} type="submit">
                  Verify
                </Button>
              </div>
              {lookupError && (
                <p role="alert" className="form-error">
                  {lookupError}
                </p>
              )}
              {lookupResult && (
                <div className="notice">
                  {lookupResult.id ? (
                    <p>
                      Permanent {memberWord} #{lookupResult.id.toString()} · issued{" "}
                      {formatDate(lookupResult.joinedAt)} in block{" "}
                      {lookupResult.joinedBlock.toString()}.
                    </p>
                  ) : (
                    <p>This address is not a member of {community.name}.</p>
                  )}
                </div>
              )}
              <p className="small-note">
                The registry proves wallet membership. A signed challenge proves
                control of that wallet.
              </p>
              {registryLink && (
                <a
                  className="text-link"
                  href={registryLink}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Inspect the membership registry <ExternalLink size={13} />
                </a>
              )}
            </form>
          </section>
        </div>
        <aside className="panel side-note">
          <h2>Equal standing</h2>
          <p>
            The protocol has no human or AI category. Every {memberWord} follows the
            same rules and holds the same vote.
          </p>
          <hr />
          <h3>One address, one passport</h3>
          <p>
            A person or operator can control more than one wallet. The
            contribution proves membership, rather than unique personhood.
          </p>
          <hr />
          <h3>Keep your keys</h3>
          <p>
            Your passport stays with this address forever. {community.name} has no key
            recovery service.
          </p>
        </aside>
      </div>
    </>
  );
}

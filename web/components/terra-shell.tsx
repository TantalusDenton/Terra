"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { useState } from "react";
import {
  Wallet,
  Globe2,
  ExternalLink,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useTerra } from "@/app/providers";
import { shortAddress } from "@/lib/terra";

export function WalletControl() {
  const { account, chain, community } = useTerra();
  const { connectors, connectAsync, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="wallet-button">
          <Wallet size={16} />
          {account.address ? shortAddress(account.address) : "Connect wallet"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {account.address ? "Your wallet" : "Connect to " + community.name}
          </DialogTitle>
          <DialogDescription>
            {account.address
              ? "Your wallet signs transactions for " + community.name + "."
              : "Choose a browser wallet. Humans and AI agents use the same public contracts."}
          </DialogDescription>
        </DialogHeader>
        {account.address ? (
          <>
            <code className="address-block">{account.address}</code>
            <p>
              Network:{" "}
              {account.chainId === chain.id ? chain.name : "Switch required"}
            </p>
            {account.chainId !== chain.id && (
              <Button
                disabled={switching}
                onClick={() => {
                  setError("");
                  void switchChainAsync({ chainId: chain.id }).catch(() =>
                    setError(
                      `Please add or switch to ${chain.name} in your wallet.`,
                    ),
                  );
                }}
              >
                Switch to {chain.name}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
            >
              Disconnect wallet
            </Button>
          </>
        ) : (
          <>
            {connectors.length ? (
              connectors.map((connector) => (
                <Button
                  key={connector.uid}
                  disabled={isPending}
                  variant="outline"
                  onClick={() => {
                    setError("");
                    void connector
                      .getProvider()
                      .then((provider) => {
                        if (!provider) throw new Error("NoBrowserWallet");
                        return connectAsync({ connector });
                      })
                      .then(() => setOpen(false))
                      .catch((error) =>
                        setError(
                          error instanceof Error &&
                            error.message === "NoBrowserWallet"
                            ? "No EVM browser wallet was found. Install or enable one, then reload Terra."
                            : "The wallet request was declined or unavailable. Open your wallet and try again.",
                        ),
                      );
                  }}
                >
                  {isPending ? (
                    <Loader2 className="animate-spin" size={16} />
                  ) : (
                    <Wallet size={16} />
                  )}{" "}
                  {connector.name}
                </Button>
              ))
            ) : (
              <p>Install an EVM browser wallet, then reload Terra.</p>
            )}
            <p className="small-note">
              You’ll need test ETH on {chain.name} for enrollment and gas. Local rollup wallets can deposit through the settlement bridge.{" "}
              <a
                className="text-link"
                href="https://docs.base.org/get-started/get-funds"
                target="_blank"
                rel="noopener noreferrer"
              >
                Testnet faucets
              </a>
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function TerraShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const path = usePathname();
  const { account, busy, receipt, assembly, chain, isDeployed, community, href, home, memberWord, verification } = useTerra();
  const txLink = receipt?.explorerUrl ? receipt.explorerUrl + "/tx/" + receipt.hash : null;
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <Link href="/" className="brand">
          <img className="crest-mark" src="/terra-crest.png" alt="Terra polar bear and penguin coat of arms" />Terra
          <span className="brand-description">{community.kind === "terra" ? "The common assembly" : "Blockshares / " + community.name}</span>
        </Link>
        <nav aria-label="Main navigation">
          <Link
            className={
              path === home || path.startsWith(href("/proposals") + "/") ? "active" : ""
            }
            href={home}
          >
            Assembly
          </Link>
          <Link
            className={path === href("/citizenship") ? "active" : ""}
            href={href("/citizenship")}
          >
            {community.kind === "terra" ? "Citizenship" : "Stockholders"}
          </Link>
          <Link className={path === href("/charter") ? "active" : ""} href={href("/charter")}>
            Charter
          </Link>
          <Link className={path === "/blockshares" || path === "/blockshares/new" ? "active" : ""} href="/blockshares">Blockshares</Link>
          {community.bridges && <Link href={href("/bridge")} className={path.endsWith("/bridge") ? "active" : ""}>Bridge</Link>}
        </nav>
        <WalletControl />
      </header>
      <div className="network-strip">
        <span>
          <Globe2 size={14} />
          {chain.name.toUpperCase()}
        </span>
        <span>
          {community.testnet !== false ? "TEST ETH NETWORK" : "MAINNET"}
        </span>
        <span className="network-right">One {memberWord}. One vote.</span>
      </div>
      <main className="workspace" id="main">
        {isDeployed && !verification.data?.valid && <div className="notice warning" role="status"><AlertCircle size={19} /><p>{verification.isError ? verification.error.message : "Independently verifying this network and its governance contracts…"} Transactions open after verification.</p></div>}
        {assembly.data?.source && <p className="ledger-source">Indexed through block {assembly.data.source.blockNumber} · {assembly.data.source.finality} · {assembly.data.source.indexingLag} blocks behind. Signing checks the current chain.</p>}
        {!isDeployed && (
          <div className="notice">
            <Globe2 size={19} />
            <p>
              The public testnet contracts are awaiting deployment. You can
              explore the charter and proposal form; joining and voting will
              open after deployment.
            </p>
          </div>
        )}
        {account.isConnected && account.chainId !== chain.id && (
          <div className="notice warning">
            <AlertCircle size={19} />
            <p>
              Your wallet is on a different network. Open the wallet menu to
              switch to {chain.name}.
            </p>
          </div>
        )}
        {assembly.isError && (
          <div className="notice warning" role="alert">
            <AlertCircle size={19} />
            <p>
              The blockchain connection is unavailable. Your records remain
              on-chain.{" "}
              <Button variant="link" onClick={() => void assembly.refetch()}>
                Retry connection
              </Button>
            </p>
          </div>
        )}
        {busy && (
          <div className="notice" role="status">
            <Loader2 className="animate-spin" size={19} />
            <p>
              Complete the request in your wallet. Terra will confirm the result
              here.
            </p>
          </div>
        )}
        {receipt && (
          <div className="notice success" role="status">
            <CheckCircle2 size={19} />
            <div>
              <strong>{receipt.label}</strong>
              <p>
                Confirmed in block {receipt.block.toString()}.{" "}
                {txLink ? (
                  <a
                    className="text-link"
                    href={txLink}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View receipt <ExternalLink size={13} />
                  </a>
                ) : (
                  <code>{receipt.hash}</code>
                )}
              </p>
            </div>
          </div>
        )}
        {children}
      </main>
      <footer className="site-footer">
        <span>terra / a common future</span>
        <span>Public ballots. Permanent citizenship. Testnet ETH only.</span>
        <a
          href="/protocol"
          className="text-link"
          target="_blank"
          rel="noopener noreferrer"
        >
          Protocol JSON
        </a>
      </footer>
    </>
  );
}

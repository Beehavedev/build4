import { Link } from "wouter";
import { SEO } from "@/components/seo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Terminal, ArrowLeft, Rocket, Construction,
  Bell, Wallet,
} from "lucide-react";

export default function AgentBuilder() {
  return (
    <>
      <SEO title="Build | BUILD4" description="AI Agent Builder — Coming Soon" path="/build" />
      <div className="min-h-screen bg-background" data-testid="page-agent-builder">
        <header className="border-b sticky top-0 z-40 bg-background/95 backdrop-blur">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="flex items-center justify-between h-14">
              <div className="flex items-center gap-3">
                <Link href="/">
                  <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-back">
                    <ArrowLeft className="w-4 h-4" />
                  </Button>
                </Link>
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-primary" />
                  <span className="font-mono font-bold text-sm tracking-wider">BUILD<span className="text-primary">4</span></span>
                  <span className="text-muted-foreground font-mono text-xs hidden md:inline ml-1">/ Build</span>
                </div>
              </div>
            </div>
          </div>
        </header>

        <main className="max-w-2xl mx-auto px-4 sm:px-6 py-24 text-center space-y-8">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-primary/10 mx-auto">
            <Construction className="w-10 h-10 text-primary" />
          </div>

          <div className="space-y-3">
            <h1 className="font-mono text-3xl sm:text-4xl font-bold tracking-tight" data-testid="coming-soon-heading">
              Coming <span className="text-primary">Soon</span>
            </h1>
            <p className="font-mono text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
              The AI Agent Builder is being rebuilt from the ground up. Deploy autonomous agents powered by Llama 3.3 70B with real on-chain wallets and skills.
            </p>
          </div>

          <Card className="p-6 bg-muted/30 border-muted max-w-sm mx-auto space-y-4">
            <div className="flex items-center justify-center gap-2">
              <Rocket className="w-4 h-4 text-primary" />
              <span className="font-mono text-xs font-semibold">What's Coming</span>
            </div>
            <ul className="font-mono text-[11px] text-muted-foreground space-y-2 text-left">
              <li className="flex items-start gap-2"><span className="text-primary mt-0.5">&#9656;</span> Strategy templates for instant deployment</li>
              <li className="flex items-start gap-2"><span className="text-primary mt-0.5">&#9656;</span> Visual agent configuration</li>
              <li className="flex items-start gap-2"><span className="text-primary mt-0.5">&#9656;</span> Live preview with real AI inference</li>
              <li className="flex items-start gap-2"><span className="text-primary mt-0.5">&#9656;</span> One-click deploy to Base, BNB Chain, XLayer</li>
            </ul>
          </Card>

          <div className="flex items-center justify-center gap-3 pt-4">
            <Link href="/agent-store">
              <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5" data-testid="button-agent-store">
                <Bell className="w-3.5 h-3.5" /> Browse Agents
              </Button>
            </Link>
            <Link href="/autonomous-economy">
              <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5" data-testid="button-economy">
                <Wallet className="w-3.5 h-3.5" /> Economy Dashboard
              </Button>
            </Link>
          </div>
        </main>
      </div>
    </>
  );
}

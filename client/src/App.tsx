import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/lib/i18n";
import { WalletProvider } from "@/hooks/use-wallet";
import Home from "@/pages/home";
import AutonomousEconomy from "@/pages/autonomous-economy";
import Manifesto from "@/pages/manifesto";
import Architecture from "@/pages/architecture";
import WhyBuild4 from "@/pages/why-build4";
import Revenue from "@/pages/revenue";
import Marketplace from "@/pages/marketplace";
import Outreach from "@/pages/outreach";
import Analytics from "@/pages/analytics";
import Services from "@/pages/services";
import Privacy from "@/pages/privacy";
import TwitterAgent from "@/pages/twitter-agent";
import SupportAgent from "@/pages/support-agent";
import Chain from "@/pages/chain";
import Standards from "@/pages/standards";
import TaskTerminal from "@/pages/task-terminal";
import TokenLauncher from "@/pages/token-launcher";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/autonomous-economy" component={AutonomousEconomy} />
      <Route path="/manifesto" component={Manifesto} />
      <Route path="/architecture" component={Architecture} />
      <Route path="/why-build4" component={WhyBuild4} />
      <Route path="/revenue" component={Revenue} />
      <Route path="/marketplace" component={Marketplace} />
      <Route path="/outreach" component={Outreach} />
      <Route path="/analytics" component={Analytics} />
      <Route path="/services" component={Services} />
      <Route path="/privacy" component={Privacy} />
      <Route path="/twitter-agent" component={TwitterAgent} />
      <Route path="/support-agent" component={SupportAgent} />
      <Route path="/chain" component={Chain} />
      <Route path="/standards" component={Standards} />
      <Route path="/tasks" component={TaskTerminal} />
      <Route path="/token-launcher" component={TokenLauncher} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <I18nProvider>
          <WalletProvider>
            <Toaster />
            <Router />
          </WalletProvider>
        </I18nProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

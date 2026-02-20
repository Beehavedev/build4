import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home from "@/pages/home";
import AutonomousEconomy from "@/pages/autonomous-economy";
import Manifesto from "@/pages/manifesto";
import Architecture from "@/pages/architecture";
import WhyBuild4 from "@/pages/why-build4";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/autonomous-economy" component={AutonomousEconomy} />
      <Route path="/manifesto" component={Manifesto} />
      <Route path="/architecture" component={Architecture} />
      <Route path="/why-build4" component={WhyBuild4} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

import { Link } from "wouter";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background text-foreground">
      <div className="text-center space-y-6 glass-panel p-12 rounded-3xl max-w-md w-full border border-white/10">
        <div className="flex justify-center">
          <div className="p-4 bg-destructive/10 rounded-full border border-destructive/20">
            <AlertCircle className="w-12 h-12 text-destructive" />
          </div>
        </div>
        <div className="space-y-2">
          <h1 className="text-3xl font-display font-bold text-white">404</h1>
          <p className="text-muted-foreground font-mono text-sm">System route not found</p>
        </div>
        <Link href="/" className="inline-block mt-4">
          <Button variant="outline" className="w-full border-white/20 hover:bg-white/10">
            Return to Terminal
          </Button>
        </Link>
      </div>
    </div>
  );
}

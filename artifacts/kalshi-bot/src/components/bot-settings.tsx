import { useEffect, useState } from "react";
import { useGetBotConfig, useUpdateBotConfig, getGetBotConfigQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Settings2, Save } from "lucide-react";

export function BotSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: config, isLoading } = useGetBotConfig();
  const updateConfig = useUpdateBotConfig();

  const [formData, setFormData] = useState({
    maxEntryPriceCents: "59",
    minNetProfitCents: "5",
    maxNetProfitCents: "25",
    minMinutesRemaining: "10",
    feeRateDisplay: "7",
    pollIntervalSecs: "20",
  });

  useEffect(() => {
    if (config) {
      setFormData({
        maxEntryPriceCents: config.maxEntryPriceCents?.toString() ?? "59",
        minNetProfitCents: config.minNetProfitCents?.toString() ?? "5",
        maxNetProfitCents: config.maxNetProfitCents?.toString() ?? "25",
        minMinutesRemaining: config.minMinutesRemaining?.toString() ?? "10",
        feeRateDisplay: config.feeRate ? (Math.round(config.feeRate * 10000) / 100).toString() : "7",
        pollIntervalSecs: config.pollIntervalSecs?.toString() ?? "20",
      });
    }
  }, [config]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSave = () => {
    updateConfig.mutate(
      {
        data: {
          maxEntryPriceCents: parseInt(formData.maxEntryPriceCents, 10),
          minNetProfitCents: parseInt(formData.minNetProfitCents, 10),
          maxNetProfitCents: parseInt(formData.maxNetProfitCents, 10),
          minMinutesRemaining: parseInt(formData.minMinutesRemaining, 10),
          feeRate: parseFloat(formData.feeRateDisplay) / 100,
          pollIntervalSecs: parseInt(formData.pollIntervalSecs, 10),
        },
      },
      {
        onSuccess: () => {
          toast({
            title: "Settings Saved",
            description: "Bot configuration updated successfully.",
          });
          queryClient.invalidateQueries({ queryKey: getGetBotConfigQueryKey() });
        },
        onError: (err) => {
          toast({
            title: "Error",
            description: "Failed to update configuration.",
            variant: "destructive",
          });
        },
      }
    );
  };

  if (isLoading) {
    return (
      <Card className="animate-pulse">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-muted-foreground">
            <Settings2 className="w-5 h-5" />
            Loading Settings...
          </CardTitle>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Settings2 className="w-5 h-5 text-primary" />
            Bot Configuration
          </CardTitle>
          <Button 
            size="sm" 
            onClick={handleSave} 
            disabled={updateConfig.isPending}
            className="flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            {updateConfig.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <div className="space-y-2">
            <Label htmlFor="maxEntryPriceCents">Max Entry Price (¢)</Label>
            <Input
              id="maxEntryPriceCents"
              name="maxEntryPriceCents"
              type="number"
              value={formData.maxEntryPriceCents}
              onChange={handleChange}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">Only enter a trade if ask ≤ this.</p>
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="minNetProfitCents">Min Profit Target (¢)</Label>
            <Input
              id="minNetProfitCents"
              name="minNetProfitCents"
              type="number"
              value={formData.minNetProfitCents}
              onChange={handleChange}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">Exit when net profit ≥ this.</p>
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="maxNetProfitCents">Max Profit Target (¢)</Label>
            <Input
              id="maxNetProfitCents"
              name="maxNetProfitCents"
              type="number"
              value={formData.maxNetProfitCents}
              onChange={handleChange}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">Upper bound for profit target.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="minMinutesRemaining">Min Minutes Remaining</Label>
            <Input
              id="minMinutesRemaining"
              name="minMinutesRemaining"
              type="number"
              value={formData.minMinutesRemaining}
              onChange={handleChange}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">Skip market if ≤ this many minutes left.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="feeRateDisplay">Kalshi Fee Rate (%)</Label>
            <Input
              id="feeRateDisplay"
              name="feeRateDisplay"
              type="number"
              step="0.01"
              value={formData.feeRateDisplay}
              onChange={handleChange}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">Contract fee rate (e.g. 7 for 0.07).</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pollIntervalSecs">Scan Interval (sec)</Label>
            <Input
              id="pollIntervalSecs"
              name="pollIntervalSecs"
              type="number"
              value={formData.pollIntervalSecs}
              onChange={handleChange}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">How often to scan markets.</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

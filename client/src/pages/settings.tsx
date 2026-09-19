import { FormEvent, useEffect, useRef, useState } from "react";
import { ExternalLink, Eye, EyeOff, KeyRound, Loader2, Plug, Save, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { apiErrorCode, apiErrorText } from "@shared/api-error-message";

interface ModelOption {
  id: string;
  label: string;
  description: string;
}

interface ImageModelOption extends ModelOption {
  tierParam: string;
  tiers: string[];
  defaultTier: string;
}

interface SettingsStatus {
  youtube: boolean;
  claude: { installed: boolean; signedIn: boolean; authMethod?: string; version?: string };
  higgsfield: { connected: boolean | null };
  models: {
    text: string;
    textEffort: string;
    image: string;
    imageQuality: string;
    textOptions: ModelOption[];
    effortOptions: ModelOption[];
    imageOptions: ImageModelOption[];
  };
}

interface KeyFieldProps {
  id: string;
  label: string;
  description: string;
  configured: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
  providerUrl: string;
  providerLabel: string;
}

const COMMUNITIES = [
  {
    id: "free",
    title: "AI Marketing Hub",
    tier: "Free community",
    url: "https://www.skool.com/ai-marketing-hub",
    colors: ["#F1B43C", "#3D8FD1", "#D64A43"],
  },
  {
    id: "pro",
    title: "AI Marketing Hub Pro",
    tier: "Pro community",
    url: "https://www.skool.com/ai-marketing-hub-pro",
    colors: ["#D64A43", "#E2A33A", "#4D9B65"],
  },
] as const;

const HIGGSFIELD_CONNECT_COMMAND = "claude mcp add --transport http higgsfield https://mcp.higgsfield.ai/mcp";

function CommunityMark({
  colors,
}: {
  colors: readonly [string, string, string];
}) {
  const heights = ["h-3", "h-5", "h-4"] as const;

  return (
    <span
      aria-hidden="true"
      className="flex h-10 w-10 shrink-0 items-end justify-center gap-1 rounded-lg border border-border bg-background px-2 pb-2"
    >
      {colors.map((color, index) => (
        <span
          className={`w-1 rounded-full ${heights[index]}`}
          key={color}
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  );
}

function KeyField({
  id,
  label,
  description,
  configured,
  inputRef,
  providerUrl,
  providerLabel,
}: KeyFieldProps) {
  const [showKey, setShowKey] = useState(false);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Label htmlFor={id} className="text-base">{label}</Label>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <Badge
          variant="outline"
          className={configured
            ? "border-green-500/40 bg-green-500/10 text-green-500"
            : "text-muted-foreground"}
        >
          {configured ? "Configured" : "Not configured"}
        </Badge>
      </div>

      <div className="relative">
        <Input
          ref={inputRef}
          id={id}
          name={id}
          type={showKey ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          placeholder={configured ? "Enter a replacement key" : "Paste API key"}
          className="pr-11 font-mono"
          data-testid={`input-${id}`}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-0 top-0"
          onClick={() => setShowKey((visible) => !visible)}
          aria-label={showKey ? `Hide ${label}` : `Show ${label}`}
        >
          {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
      </div>

      <a
        href={providerUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        {providerLabel}
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

function StatusBadge({ state, label }: { state: "ok" | "warn" | "unknown"; label: string }) {
  const className = state === "ok"
    ? "border-green-500/40 bg-green-500/10 text-green-500"
    : state === "warn"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
      : "text-muted-foreground";
  return <Badge variant="outline" className={className}>{label}</Badge>;
}

function OptionSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: ModelOption[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} data-testid={`select-${id}`}>
          <SelectValue placeholder="Choose an option" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {options.find((option) => option.id === value)?.description}
      </p>
    </div>
  );
}

export default function SettingsPage() {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [claudeTextModel, setClaudeTextModel] = useState("");
  const [claudeTextEffort, setClaudeTextEffort] = useState("");
  const [higgsfieldImageModel, setHiggsfieldImageModel] = useState("");
  const [higgsfieldImageQuality, setHiggsfieldImageQuality] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const youtubeKeyRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const applyStatus = (next: SettingsStatus) => {
    setStatus(next);
    setClaudeTextModel(next.models.text);
    setClaudeTextEffort(next.models.textEffort);
    setHiggsfieldImageModel(next.models.image);
    setHiggsfieldImageQuality(next.models.imageQuality);
  };

  useEffect(() => {
    const loadStatus = async () => {
      try {
        const response = await fetch("/api/settings/status", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load settings.");
        applyStatus(data as SettingsStatus);
      } catch (error: any) {
        setLoadError(error?.message || "Unable to load settings.");
      } finally {
        setIsLoading(false);
      }
    };

    loadStatus();
  }, []);

  const selectedImageModel = status?.models.imageOptions.find((model) => model.id === higgsfieldImageModel);

  const handleImageModelChange = (modelId: string) => {
    setHiggsfieldImageModel(modelId);
    const model = status?.models.imageOptions.find((option) => option.id === modelId);
    if (model && !model.tiers.includes(higgsfieldImageQuality)) {
      setHiggsfieldImageQuality(model.defaultTier);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!status) return;
    const youtubeApiKey = youtubeKeyRef.current?.value.trim() || "";
    const modelsChanged = claudeTextModel !== status.models.text
      || claudeTextEffort !== status.models.textEffort
      || higgsfieldImageModel !== status.models.image
      || higgsfieldImageQuality !== status.models.imageQuality;

    if (!youtubeApiKey && !modelsChanged) {
      toast({
        title: "No changes to save",
        description: "Enter a replacement key or choose a different option.",
      });
      return;
    }

    setIsSaving(true);
    try {
      const response = await apiRequest("PUT", "/api/settings/api-keys", {
        ...(youtubeApiKey ? { youtubeApiKey } : {}),
        claudeTextModel,
        claudeTextEffort,
        higgsfieldImageModel,
        higgsfieldImageQuality,
      }) as { success: boolean; status: SettingsStatus };

      applyStatus(response.status);
      if (youtubeKeyRef.current) youtubeKeyRef.current.value = "";
      toast({
        title: "Settings saved",
        description: "The local server is using the updated settings.",
      });
    } catch (error: unknown) {
      toast({
        title: "Could not save settings",
        description: apiErrorText(error, "Check the values and try again."),
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestError(null);
    try {
      const result = await apiRequest("POST", "/api/settings/test-higgsfield", {}) as { connected: boolean; credits: number };
      setCredits(result.credits);
      setStatus((current) => (current ? { ...current, higgsfield: { connected: true } } : current));
    } catch (error: unknown) {
      setCredits(null);
      setTestError(apiErrorText(error, "Could not reach Higgsfield."));
      if (apiErrorCode(error) === "HIGGSFIELD_NOT_CONNECTED") {
        setStatus((current) => (current ? { ...current, higgsfield: { connected: false } } : current));
      }
    } finally {
      setIsTesting(false);
    }
  };

  const claude = status?.claude;
  const higgsfieldConnected = status?.higgsfield.connected ?? null;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6 md:p-8">
      <div>
        <div className="flex items-center gap-2 text-primary">
          <KeyRound className="h-5 w-5" />
          <span className="text-sm font-medium">Local connections</span>
        </div>
        <h1 className="mt-2 text-3xl font-bold">Settings</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Connect YouTube research data, and check the Claude and Higgsfield connections used for AI generation.
        </p>
      </div>

      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>Stored locally</AlertTitle>
        <AlertDescription>
          The YouTube key and your choices are written to the server's ignored <code>.env</code> file
          with owner-only permissions. Saved keys are never returned to the browser and the input field
          is cleared after saving. Claude and Higgsfield use your local Claude Code sign-in, so no keys
          for them are stored here. Settings changes are accepted only from this machine.
        </AlertDescription>
      </Alert>

      {loadError && (
        <Alert variant="destructive">
          <AlertTitle>Settings unavailable</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Connections</CardTitle>
          <CardDescription>
            Leave the YouTube key blank to keep its current value.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading || !status ? (
            <div className="flex min-h-48 items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Loading connection status
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <KeyField
                id="youtube-api-key"
                label="YouTube Data API"
                description="Required for video search and research data."
                configured={status.youtube}
                inputRef={youtubeKeyRef}
                providerUrl="https://console.cloud.google.com/apis/credentials"
                providerLabel="Open Google Cloud credentials"
              />

              <div className="space-y-3 rounded-lg border border-border bg-background/50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-base font-medium">Claude: research and writing</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Insights, ideas, scripts, and thumbnail suggestions run through your Claude Code sign-in.
                    </p>
                  </div>
                  <StatusBadge
                    state={claude?.installed && claude.signedIn ? "ok" : "warn"}
                    label={!claude?.installed ? "Not installed" : claude.signedIn ? "Signed in" : "Not signed in"}
                  />
                </div>
                {claude && !claude.installed && (
                  <p className="text-sm text-muted-foreground">
                    Install Claude Code, or set <code>CLAUDE_BIN</code> in <code>.env</code> to the executable path.
                  </p>
                )}
                {claude?.installed && !claude.signedIn && (
                  <p className="text-sm text-muted-foreground">
                    Run <code>claude</code> in a terminal and sign in with <code>/login</code>.
                  </p>
                )}
                {claude?.installed && claude.signedIn && (
                  <p className="text-xs text-muted-foreground">
                    Claude Code {claude.version}{claude.authMethod ? ` · ${claude.authMethod}` : ""}
                  </p>
                )}
                <div className="grid gap-4 border-t border-border pt-4 md:grid-cols-2">
                  <OptionSelect
                    id="claude-text-model"
                    label="Model"
                    value={claudeTextModel}
                    options={status.models.textOptions}
                    onChange={setClaudeTextModel}
                  />
                  <OptionSelect
                    id="claude-text-effort"
                    label="Effort"
                    value={claudeTextEffort}
                    options={status.models.effortOptions}
                    onChange={setClaudeTextEffort}
                  />
                </div>
              </div>

              <div className="space-y-3 rounded-lg border border-border bg-background/50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-base font-medium">Higgsfield: thumbnail images</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Images are generated through Higgsfield's MCP server, driven by Claude Code. Each thumbnail spends Higgsfield credits.
                    </p>
                  </div>
                  <StatusBadge
                    state={higgsfieldConnected === true ? "ok" : higgsfieldConnected === false ? "warn" : "unknown"}
                    label={higgsfieldConnected === true ? "Connected" : higgsfieldConnected === false ? "Not connected" : "Not checked"}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleTestConnection}
                    disabled={isTesting}
                    data-testid="button-test-higgsfield"
                  >
                    {isTesting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plug className="mr-2 h-4 w-4" />}
                    Test connection
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Runs a read-only balance check. It spends no credits.
                  </span>
                  {credits !== null && (
                    <span className="text-sm text-green-500" data-testid="text-higgsfield-credits">
                      {credits} credits available
                    </span>
                  )}
                </div>
                {testError && <p className="text-sm text-destructive">{testError}</p>}
                {higgsfieldConnected !== true && (
                  <p className="text-xs text-muted-foreground">
                    Connect it once with <code>{HIGGSFIELD_CONNECT_COMMAND}</code>, then run <code>/mcp</code> inside <code>claude</code> to sign in.
                  </p>
                )}
                <div className="grid gap-4 border-t border-border pt-4 md:grid-cols-2">
                  <OptionSelect
                    id="higgsfield-image-model"
                    label="Image model"
                    value={higgsfieldImageModel}
                    options={status.models.imageOptions}
                    onChange={handleImageModelChange}
                  />
                  <OptionSelect
                    id="higgsfield-image-quality"
                    label={selectedImageModel?.tierParam === "resolution" ? "Resolution" : "Quality"}
                    value={higgsfieldImageQuality}
                    options={(selectedImageModel?.tiers ?? []).map((tier) => ({ id: tier, label: tier, description: "" }))}
                    onChange={setHiggsfieldImageQuality}
                  />
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <Button type="submit" disabled={isSaving || Boolean(loadError)} data-testid="button-save-api-settings">
                  {isSaving ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="mr-2 h-4 w-4" />
                  )}
                  Save and apply
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <Card aria-labelledby="community-heading">
        <CardHeader>
          <CardTitle id="community-heading" className="text-lg">
            Join the community
          </CardTitle>
          <CardDescription>
            Connect with AI marketers, share what you learn, and get support.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {COMMUNITIES.map((community) => (
            <a
              key={community.url}
              href={community.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Join ${community.title}, ${community.tier}`}
              className="group flex min-w-0 items-center gap-3 rounded-lg border border-border bg-background/50 p-3 transition-colors hover:border-primary/40 hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid={`link-community-${community.id}`}
            >
              <CommunityMark colors={community.colors} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {community.title}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {community.tier}
                </span>
              </span>
              <ExternalLink
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
              />
            </a>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

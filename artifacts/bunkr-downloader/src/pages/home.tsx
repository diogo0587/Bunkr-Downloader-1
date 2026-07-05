import { useState } from "react";
import { useResolveUrl } from "@workspace/api-client-react";
import type { BunkrFile, ResolveResult } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import {
  Download,
  FolderArchive,
  Image as ImageIcon,
  Video,
  File as FileIcon,
  Loader2,
  Terminal,
  ChevronRight,
  AlertTriangle,
  Search,
  ArrowLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "Unknown size";
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function FileTypeIcon({ type }: { type: string }) {
  if (type.includes("image")) return <ImageIcon className="w-5 h-5 opacity-70" />;
  if (type.includes("video")) return <Video className="w-5 h-5 opacity-70" />;
  return <FileIcon className="w-5 h-5 opacity-70" />;
}

interface SearchItem {
  title: string;
  url: string;
  thumbnailUrl: string | null;
  source: string;
}

export default function Home() {
  const { toast } = useToast();
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [isZipping, setIsZipping] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"broad" | "strict">("broad");
  const [searchResults, setSearchResults] = useState<SearchItem[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);

  const resolveMutation = useResolveUrl();

  const handleResolve = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setResult(null);
    setSearchResults(null);

    resolveMutation.mutate(
      { data: { url: url.trim() } },
      {
        onSuccess: (data) => setResult(data),
        onError: (err) => {
          toast({
            title: "Failed to resolve",
            description:
              err.data?.error ||
              err.message ||
              "Could not fetch files from the provided URL.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim() || searchQuery.trim().length < 2) {
      toast({ title: "Search too short", description: "Type at least 2 characters." });
      return;
    }
    setSearchLoading(true);
    setSearchResults(null);
    setResult(null);

    try {
      const resp = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery.trim(), mode: searchMode, page: 1 }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Search failed" }));
        toast({ title: "Search failed", description: err.error, variant: "destructive" });
        return;
      }
      const data = await resp.json();
      setSearchResults(data.results ?? []);
    } catch (err) {
      toast({
        title: "Search error",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSearchLoading(false);
    }
  };

  const handleSelectSearchResult = (item: SearchItem) => {
    setUrl(item.url);
    setSearchResults(null);
    setSearchQuery("");
    // Auto-resolve
    resolveMutation.mutate(
      { data: { url: item.url } },
      {
        onSuccess: (data) => setResult(data),
        onError: (err) => {
          toast({
            title: "Failed to resolve album",
            description: err.data?.error || err.message || "Could not resolve.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleDownloadSingle = (file: BunkrFile) => {
    const downloadUrl = `/api/download?url=${encodeURIComponent(file.url)}&filename=${encodeURIComponent(file.name)}`;
    window.open(downloadUrl, "_blank");
  };

  const handleDownloadZip = async () => {
    if (!result || !result.files.length || isZipping) return;
    setIsZipping(true);

    try {
      const resp = await fetch("/api/zip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: result.files.map((f) => ({ url: f.url, name: f.name })),
          archiveName: result.albumName ?? "bunkr_download",
        }),
      });

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({ error: "Failed to create ZIP" }));
        toast({
          title: "Failed to create ZIP",
          description: errBody.error ?? "Unknown error",
          variant: "destructive",
        });
        return;
      }

      const blob = await resp.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `${result.albumName ?? "bunkr_download"}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);

      toast({ title: "Download started", description: "Your ZIP file is ready." });
    } catch (err) {
      toast({
        title: "Failed to create ZIP",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsZipping(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background font-sans selection:bg-primary/30">
      <header className="sticky top-0 z-10 border-b border-border/50 bg-background/80 backdrop-blur-sm px-4 py-4 md:px-8">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3 text-primary">
            <Terminal className="w-6 h-6" />
            <span className="font-mono font-bold tracking-tight text-lg">BUNKR_DL</span>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-5xl mx-auto px-4 py-8 md:px-8 md:py-12 flex flex-col gap-8">
        <section className="flex flex-col gap-4 max-w-3xl">
          <h1 className="text-3xl md:text-5xl font-bold tracking-tight text-foreground">
            Fast, dense media retrieval.
          </h1>
          <p className="text-muted-foreground text-lg max-w-xl">
            Paste a Bunkr album URL or search the archive to find and download media.
          </p>

          {/* URL Resolve Form */}
          <form onSubmit={handleResolve} className="mt-2 flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <ChevronRight className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://bunkr.site/a/..."
                className="pl-10 h-14 font-mono text-base bg-secondary/30 border-secondary-border focus-visible:ring-primary/50"
                data-testid="input-url"
              />
            </div>
            <Button
              type="submit"
              disabled={resolveMutation.isPending || !url.trim()}
              className="h-14 px-8 font-mono font-bold text-sm tracking-widest uppercase transition-all duration-300"
              data-testid="button-resolve"
            >
              {resolveMutation.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : "Resolve"}
            </Button>
          </form>

          {/* Search Form */}
          <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search balalbums.st (online only)..."
                className="pl-10 h-12 font-mono text-base bg-secondary/30 border-secondary-border focus-visible:ring-primary/50"
              />
            </div>
            <div className="flex gap-2">
              <select
                value={searchMode}
                onChange={(e) => setSearchMode(e.target.value as "broad" | "strict")}
                className="h-12 px-3 rounded-md bg-secondary/30 border border-secondary-border text-sm font-mono"
              >
                <option value="broad">Broad</option>
                <option value="strict">Strict</option>
              </select>
              <Button
                type="submit"
                disabled={searchLoading || !searchQuery.trim()}
                className="h-12 px-6 font-mono font-bold text-sm tracking-widest uppercase"
              >
                {searchLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Search"}
              </Button>
            </div>
          </form>
        </section>

        {resolveMutation.isError && (
          <div className="p-4 border border-destructive/50 bg-destructive/10 text-destructive-foreground rounded-md flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-destructive" />
            <div>
              <p className="font-bold font-mono text-sm uppercase">Resolution Failed</p>
              <p className="text-sm opacity-90">
                {resolveMutation.error?.data?.error || resolveMutation.error?.message || "Unknown error occurred"}
              </p>
            </div>
          </div>
        )}

        {/* Search Results */}
        {searchResults !== null && (
          <section className="flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => setSearchResults(null)} className="shrink-0">
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <h2 className="text-xl font-bold font-mono text-foreground">
                Search Results ({searchResults.length})
              </h2>
            </div>
            {searchResults.length === 0 ? (
              <p className="text-muted-foreground font-mono">No albums found for &ldquo;{searchQuery}&rdquo;.</p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {searchResults.map((item, i) => (
                  <button
                    key={`${item.url}-${i}`}
                    onClick={() => handleSelectSearchResult(item)}
                    className="group text-left flex flex-col gap-2 p-3 rounded-xl border border-border/40 bg-card hover:bg-secondary/20 hover:border-primary/30 transition-all"
                  >
                    <div className="aspect-video bg-secondary/50 rounded-lg overflow-hidden relative">
                      {item.thumbnailUrl ? (
                        <img
                          src={item.thumbnailUrl}
                          alt={item.title}
                          className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <FileIcon className="w-8 h-8 text-muted-foreground/50" />
                        </div>
                      )}
                    </div>
                    <p className="font-mono text-xs text-foreground/80 line-clamp-2 leading-snug">{item.title}</p>
                    <Badge variant="secondary" className="w-fit text-[10px] font-mono">
                      {item.source}
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Album/File Result */}
        {result && (
          <section className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 py-4 border-b border-border/50">
              <div>
                <h2 className="text-2xl font-bold font-mono break-all text-primary/90">
                  {result.albumName || "Unnamed Album"}
                </h2>
                <p className="text-muted-foreground mt-1">
                  Found <strong className="text-foreground">{result.files.length}</strong> items
                </p>
              </div>

              {result.files.length > 1 && (
                <Button
                  onClick={handleDownloadZip}
                  disabled={isZipping}
                  className="w-full md:w-auto h-12 font-mono uppercase text-xs tracking-wider shrink-0"
                  data-testid="button-download-all"
                >
                  {isZipping ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Creating ZIP…
                    </>
                  ) : (
                    <>
                      <FolderArchive className="w-4 h-4 mr-2" />
                      Zip All Files
                    </>
                  )}
                </Button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {result.files.map((file: BunkrFile, i: number) => (
                <div
                  key={`${file.url}-${i}`}
                  className="group relative flex items-start gap-4 p-3 rounded-lg border border-border/40 bg-card hover:bg-secondary/20 hover:border-primary/30 transition-all"
                  style={{ animationDelay: `${i * 30}ms` }}
                >
                  <div className="w-16 h-16 shrink-0 bg-secondary/50 rounded flex items-center justify-center overflow-hidden border border-border/50">
                    {file.thumbnailUrl ? (
                      <img
                        src={file.thumbnailUrl}
                        alt="thumbnail"
                        className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
                        loading="lazy"
                      />
                    ) : (
                      <FileTypeIcon type={file.type} />
                    )}
                  </div>

                  <div className="flex-1 min-w-0 flex flex-col justify-between h-full py-0.5">
                    <div>
                      <h3 className="font-mono text-sm truncate font-medium text-foreground/90 group-hover:text-primary transition-colors">
                        {file.name}
                      </h3>
                      <div className="flex items-center gap-2 mt-1.5">
                        <Badge
                          variant="secondary"
                          className="px-1.5 py-0 text-[10px] font-mono rounded bg-secondary/60 text-secondary-foreground border-border/50"
                        >
                          {file.type.split("/")[0]}
                        </Badge>
                        <span className="text-xs text-muted-foreground font-mono">
                          {formatSize(file.size)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <Button
                    size="icon"
                    variant="ghost"
                    className="shrink-0 h-8 w-8 self-center text-muted-foreground hover:text-primary hover:bg-primary/10"
                    onClick={() => handleDownloadSingle(file)}
                    title="Download file"
                    data-testid={`button-download-${i}`}
                  >
                    <Download className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

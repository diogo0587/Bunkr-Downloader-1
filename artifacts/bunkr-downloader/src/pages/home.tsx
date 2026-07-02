import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import {
  useResolveUrl,
  useCreateJob,
  useGetJob,
  getGetJobQueryKey
} from "@workspace/api-client-react";
import type { BunkrFile, ResolveResult } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Download,
  FolderArchive,
  Image as ImageIcon,
  Video,
  File as FileIcon,
  Loader2,
  Terminal,
  ExternalLink,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  X
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
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

export default function Home() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [sseProgress, setSseProgress] = useState<{ processed: number; total: number; status: string } | null>(null);

  const resolveMutation = useResolveUrl();
  const createJobMutation = useCreateJob();

  // Polling fallback
  const { data: jobData } = useGetJob(jobId || "", {
    query: {
      enabled: !!jobId && (!sseProgress || sseProgress.status !== "done"),
      queryKey: getGetJobQueryKey(jobId || "")
    }
  });

  // SSE setup
  useEffect(() => {
    if (!jobId) return;

    const eventSource = new EventSource(`/api/jobs/${jobId}/events`);

    eventSource.addEventListener("progress", (e) => {
      try {
        const data = JSON.parse(e.data);
        setSseProgress({
          processed: data.processedFiles,
          total: data.totalFiles,
          status: data.status
        });

        if (data.status === "done") {
          eventSource.close();
          toast({
            title: "Archive Ready",
            description: "Your ZIP file is ready for download.",
            variant: "default",
          });
          window.open(`/api/jobs/${jobId}/download`, "_blank");
        } else if (data.status === "error") {
          eventSource.close();
          toast({
            title: "Job Error",
            description: "An error occurred while creating the archive.",
            variant: "destructive",
          });
        }
      } catch (err) {
        console.error("Failed to parse SSE data", err);
      }
    });

    eventSource.onerror = () => {
      console.error("SSE connection error");
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [jobId, toast]);

  const handleResolve = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;

    setResult(null);
    setJobId(null);
    setSseProgress(null);

    resolveMutation.mutate(
      { data: { url: url.trim() } },
      {
        onSuccess: (data) => {
          setResult(data);
        },
        onError: (err) => {
          toast({
            title: "Failed to resolve",
            description: err.data?.error || err.message || "Could not fetch files from the provided URL.",
            variant: "destructive",
          });
        }
      }
    );
  };

  const handleDownloadSingle = (file: BunkrFile) => {
    const downloadUrl = `/api/download?url=${encodeURIComponent(file.url)}&filename=${encodeURIComponent(file.name)}`;
    window.open(downloadUrl, "_blank");
  };

  const handleDownloadAll = () => {
    if (!result || !result.files.length) return;

    createJobMutation.mutate(
      {
        data: {
          files: result.files,
          archiveName: result.albumName || "bunkr_download"
        }
      },
      {
        onSuccess: (job) => {
          setJobId(job.id);
          setSseProgress({
            processed: job.processedFiles,
            total: job.totalFiles,
            status: job.status
          });
        },
        onError: (err) => {
          toast({
            title: "Failed to create job",
            description: err.data?.error || err.message || "An error occurred.",
            variant: "destructive",
          });
        }
      }
    );
  };

  const activeJobStatus = sseProgress?.status || jobData?.status;
  const activeProcessed = sseProgress?.processed ?? jobData?.processedFiles ?? 0;
  const activeTotal = sseProgress?.total ?? jobData?.totalFiles ?? 0;
  const isJobActive = jobId && activeJobStatus !== "error";
  const progressPercent = activeTotal > 0 ? (activeProcessed / activeTotal) * 100 : 0;

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
            Paste a Bunkr album or file URL to extract direct links and bulk download contents.
          </p>

          <form onSubmit={handleResolve} className="mt-4 flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <ChevronRight className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://bunkrr.su/a/..."
                className="pl-10 h-14 font-mono text-base bg-secondary/30 border-secondary-border focus-visible:ring-primary/50"
                autoFocus
                data-testid="input-url"
              />
            </div>
            <Button
              type="submit"
              disabled={resolveMutation.isPending || !url.trim()}
              className="h-14 px-8 font-mono font-bold text-sm tracking-widest uppercase transition-all duration-300"
              data-testid="button-resolve"
            >
              {resolveMutation.isPending ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                "Resolve"
              )}
            </Button>
          </form>
        </section>

        {resolveMutation.isError && (
          <div className="p-4 border border-destructive/50 bg-destructive/10 text-destructive-foreground rounded-md flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-destructive" />
            <div>
              <p className="font-bold font-mono text-sm uppercase">Resolution Failed</p>
              <p className="text-sm opacity-90">{resolveMutation.error?.data?.error || resolveMutation.error?.message || "Unknown error occurred"}</p>
            </div>
          </div>
        )}

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
                <div className="flex flex-col items-end gap-2 w-full md:w-auto shrink-0">
                  {isJobActive ? (
                    <div className="w-full md:w-64 p-3 bg-secondary/50 rounded-md border border-border">
                      <div className="flex justify-between items-center mb-2 font-mono text-xs">
                        <span className="uppercase text-muted-foreground flex items-center gap-1">
                          {activeJobStatus === "processing" ? <RefreshCw className="w-3 h-3 animate-spin" /> : null}
                          {activeJobStatus === "done" ? "Complete" : "Zipping..."}
                        </span>
                        <span className="text-primary font-bold">
                          {activeProcessed} / {activeTotal}
                        </span>
                      </div>
                      <Progress value={progressPercent} className="h-1" />
                      {activeJobStatus === "done" && (
                        <Button 
                          size="sm" 
                          className="w-full mt-3 font-mono text-xs uppercase"
                          onClick={() => window.open(`/api/jobs/${jobId}/download`, "_blank")}
                        >
                          <Download className="w-3 h-3 mr-2" /> Download ZIP
                        </Button>
                      )}
                    </div>
                  ) : (
                    <Button
                      onClick={handleDownloadAll}
                      disabled={createJobMutation.isPending}
                      className="w-full md:w-auto h-12 font-mono uppercase text-xs tracking-wider"
                      data-testid="button-download-all"
                    >
                      {createJobMutation.isPending ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <FolderArchive className="w-4 h-4 mr-2" />
                      )}
                      Zip All Files
                    </Button>
                  )}
                </div>
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
                        <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-mono rounded bg-secondary/60 text-secondary-foreground border-border/50">
                          {file.type.split('/')[0]}
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

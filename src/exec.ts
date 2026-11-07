import { spawn, type SpawnOptions } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout+stderr interleaved in arrival order. */
  output: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  signal?: AbortSignal;
  /** Cap on captured bytes per stream; the tail is kept. */
  maxBytes?: number;
}

const DEFAULT_MAX = 4 * 1024 * 1024;

/** Run a program without a shell (arguments are never interpreted). */
export function execFile(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return spawnCollect(cmd, args, { shell: false }, opts);
}

/** Run a command line through the platform shell. Used only for configured check commands. */
export function execShell(command: string, opts: ExecOptions): Promise<ExecResult> {
  return spawnCollect(command, [], { shell: true }, opts);
}

function spawnCollect(
  cmd: string,
  args: string[],
  extra: Pick<SpawnOptions, "shell">,
  opts: ExecOptions,
): Promise<ExecResult> {
  const started = Date.now();
  const max = opts.maxBytes ?? DEFAULT_MAX;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // own process group on POSIX so a timeout can kill the whole tree
      detached: process.platform !== "win32",
      ...extra,
    });
    let stdout = "";
    let stderr = "";
    let output = "";
    let timedOut = false;
    const keepTail = (s: string) => (s.length > max ? s.slice(s.length - max) : s);
    child.stdout!.setEncoding("utf8").on("data", (d: string) => {
      stdout = keepTail(stdout + d);
      output = keepTail(output + d);
    });
    child.stderr!.setEncoding("utf8").on("data", (d: string) => {
      stderr = keepTail(stderr + d);
      output = keepTail(output + d);
    });

    const kill = () => killTree(child.pid);
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code, sig) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        code: code ?? (sig ? 128 : 1),
        stdout,
        stderr,
        output,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Last `n` lines of a string, for error reports. */
export function tail(s: string, n = 80): string {
  const lines = s.replace(/\r\n/g, "\n").trimEnd().split("\n");
  return lines.length <= n ? lines.join("\n") : `[... ${lines.length - n} lines omitted ...]\n` + lines.slice(-n).join("\n");
}

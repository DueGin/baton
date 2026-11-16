import { execFile } from "node:child_process";

/** Shell startup banners are permitted before the first env entry. Values may contain '='. */
export function parseShellEnv(output: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [index, entry] of output.split("\0").entries()) {
    const match = (index === 0 ? entry.replace(/^.*\n(?=[A-Za-z_][A-Za-z0-9_]*=)/su, "") : entry).match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/u);
    if (match?.[1] && match[1] !== "__proto__") env[match[1]] = match[2] ?? "";
  }
  return env;
}

export async function loginShellEnv(base: NodeJS.ProcessEnv, platform = process.platform): Promise<NodeJS.ProcessEnv> {
  if (platform !== "darwin") return { ...base };
  const shell = base.SHELL?.startsWith("/") ? base.SHELL : "/bin/zsh";
  return new Promise(resolve => {
    execFile(shell, ["-ilc", "env -0"], { env: base, timeout: 5000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      const captured = error ? {} : parseShellEnv(stdout);
      // Preserve explicit desktop configuration even when shell startup scripts set their own.
      const overrides = Object.fromEntries(Object.entries(base).filter(([key]) => key.startsWith("BATON_") || key === "TMPDIR"));
      resolve({ ...base, ...captured, ...overrides });
    });
  });
}

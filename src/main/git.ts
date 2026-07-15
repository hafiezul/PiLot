import { execFile } from "node:child_process";

type GitOptions = {
  environment?: NodeJS.ProcessEnv;
  literalPathspecs?: boolean;
  maxBuffer?: number;
};

export function runGit(cwd: string, args: string[], options: GitOptions = {}) {
  const environment = options.environment ?? process.env;
  return new Promise<string>((resolve, reject) => {
    execFile("git", [
      "--no-optional-locks",
      ...(options.literalPathspecs ? ["--literal-pathspecs"] : []),
      ...args,
    ], {
      cwd,
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      env: { ...environment, GIT_PAGER: "cat" },
    }, (error, stdout, stderr) => {
      if (!error) resolve(stdout);
      else {
        if (stderr.trim()) error.message = stderr.trim();
        reject(error);
      }
    });
  });
}

import { execSync } from "child_process";
import { readdirSync, renameSync, cpSync } from "fs";
import { join } from "path";

// 1. Run OpenNext build
execSync("node node_modules/@opennextjs/cloudflare/dist/cli/index.js build", {
  stdio: "inherit",
});

// 2. Merge .open-next/assets/* up into .open-next/ so that _worker.js and its
//    relative imports (cloudflare/, middleware/, server-functions/, etc.) all
//    live in the same directory, which is what CF Pages expects.
for (const item of readdirSync(".open-next/assets")) {
  cpSync(join(".open-next/assets", item), join(".open-next", item), {
    recursive: true,
    force: true,
  });
}

// 3. CF Pages requires the worker to be named _worker.js
renameSync(".open-next/worker.js", ".open-next/_worker.js");

console.log("CF Pages build complete — output: .open-next/");

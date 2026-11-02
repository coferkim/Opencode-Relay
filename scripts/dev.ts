import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const processes: ReturnType<typeof Bun.spawn>[] = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of processes) {
    if (child.exitCode !== null) continue;
    if (process.platform === "win32") {
      // uv and Vite may each own a child process; stop only the tree we started.
      Bun.spawnSync(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
        stdout: "ignore", stderr: "ignore",
      });
    } else child.kill();
  }
  process.exitCode = code;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop());

try {
  processes.push(Bun.spawn(
    ["uv", "run", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", "8949"],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  ));
  processes.push(Bun.spawn([process.execPath, "run", "--cwd", "frontend", "dev"], {
    cwd: root, stdout: "inherit", stderr: "inherit",
  }));
  console.log("\nOpenCode Relay: http://127.0.0.1:8948\nAPI / docs:    http://127.0.0.1:8949/docs\n");
  const code = await Promise.race(processes.map((child) => child.exited));
  stop(code);
} catch (error) {
  console.error("启动失败，请先安装 uv、Bun，并运行 uv sync 和 bun install。", error);
  stop(1);
}

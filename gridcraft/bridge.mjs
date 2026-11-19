/**
 * Stdio launcher for the GridCraft MCP bridge.
 *
 * DSH starts this file as the stdio MCP server. It first makes sure GridCraft
 * exposes its JSON-lines control channel on 127.0.0.1:<port> (starting the app
 * with `--control <port>` when nothing is listening), then hands stdin, stdout
 * and stderr to `gridcraft-cli mcp --connect <port>` unchanged, so the MCP
 * JSON-RPC stream is never decoded or re-encoded in between.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';

const PORT = Number(process.env.GRIDCRAFT_CONTROL_PORT ?? 7979);
const APP = process.env.GRIDCRAFT_APP ?? 'C:\\Program Files\\ArtCraft\\GridCraft\\gridcraft.exe';
const CLI = process.env.GRIDCRAFT_CLI ?? 'C:\\Program Files\\ArtCraft\\GridCraft\\gridcraft-cli.exe';
const READY_TIMEOUT_MS = Number(process.env.GRIDCRAFT_READY_TIMEOUT_MS ?? 30_000);
const POLL_MS = 250;

/** @param {number} port @returns {Promise<boolean>} */
function probe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(700);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/** @param {number} port @param {number} timeoutMs */
async function waitForChannel(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return probe(port);
}

function startApp() {
  const child = spawn(APP, ['--control', String(PORT)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.once('error', (error) => {
    process.stderr.write(`gridcraft bridge: cannot start ${APP}: ${error.message}\n`);
    process.exit(1);
  });
  child.unref();
}

async function main() {
  if (!(await probe(PORT))) {
    startApp();
    if (!(await waitForChannel(PORT, READY_TIMEOUT_MS))) {
      process.stderr.write(
        `gridcraft bridge: no control channel on 127.0.0.1:${PORT} after ${READY_TIMEOUT_MS} ms\n`,
      );
      process.exit(1);
    }
  }

  const bridge = spawn(CLI, ['mcp', '--connect', String(PORT)], { stdio: 'inherit' });
  let closing = false;
  const stop = (signal) => {
    if (closing) return;
    closing = true;
    try {
      bridge.kill(signal);
    } catch {
      // The bridge may already be gone.
    }
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('exit', () => stop());
  bridge.on('error', (error) => {
    process.stderr.write(`gridcraft bridge: cannot start ${CLI}: ${error.message}\n`);
    process.exit(1);
  });
  bridge.on('exit', (code) => process.exit(code ?? 1));
}

main().catch((error) => {
  process.stderr.write(`gridcraft bridge: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

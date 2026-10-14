import { runApp } from './app.ts';
import { listMicDevices } from './audio.ts';
import { ConfigError, loadDotEnv, parseCli, USAGE } from './config.ts';

async function main(): Promise<number> {
  loadDotEnv();
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log(USAGE);
    return 0;
  }
  if (cli.listDevices) {
    listMicDevices().forEach((name, i) => console.log(`${i}: ${name}`));
    return 0;
  }

  const stop = new AbortController();
  const force = new AbortController();
  process.on('SIGINT', () => {
    if (!stop.signal.aborted) {
      stop.abort();
      console.log('\nWrapping up and saving… press Ctrl+C again to quit immediately.');
    } else if (!force.signal.aborted) {
      force.abort();
      // Safety net: never take longer than 3 seconds, even if wrap-up hangs
      setTimeout(() => process.exit(130), 3000).unref();
    }
  });

  await runApp({ ...cli, forceSignal: force.signal }, stop.signal);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof ConfigError ? err.message : `Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(err instanceof ConfigError ? 2 : 1);
  },
);

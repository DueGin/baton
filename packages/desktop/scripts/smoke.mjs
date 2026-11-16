import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const temporary = await mkdtemp(join(tmpdir(),'baton-desktop-smoke-'));
const report = join(temporary,'report.json');
const env = {...process.env, BATON_HOME:join(temporary,'home'), BATON_DESKTOP_USER_DATA:join(temporary,'chromium'), BATON_DESKTOP_PORT:'0', BATON_DESKTOP_FAKE:'1', BATON_DESKTOP_SMOKE:'1', BATON_DESKTOP_SMOKE_REPORT:report};
delete env.ELECTRON_RUN_AS_NODE; delete env.BATON_DESKTOP_WEB_URL;
const executable = process.env.BATON_DESKTOP_EXECUTABLE ?? require('electron');
const child = spawn(executable,process.env.BATON_DESKTOP_EXECUTABLE ? [] : [fileURLToPath(new URL('../',import.meta.url))],{env,stdio:'inherit'});
const timeout = setTimeout(()=>{child.kill('SIGTERM');},60_000);
const code = await new Promise((resolve,reject)=>{child.once('error',reject); child.once('exit',resolve);}); clearTimeout(timeout);
if(code !== 0) { try { console.error(await readFile(join(env.BATON_HOME,'desktop-daemon.log'),'utf8')); } catch {} throw new Error(`Smoke exited ${code}; files retained at ${temporary}`); }
const result = JSON.parse(await readFile(report,'utf8'));
if(!result.ok) throw new Error('Smoke report failed');
// Quitting the app must have stopped the owned daemon, not just its window.
try { await fetch(`${result.daemon.url}/api/info`,{signal:AbortSignal.timeout(1000)}); throw new Error('Owned daemon survived desktop quit'); }
catch(error) { if(error instanceof Error && error.message === 'Owned daemon survived desktop quit') throw error; }
console.log(`Desktop smoke passed; daemon stopped gracefully. Report: ${report}`);

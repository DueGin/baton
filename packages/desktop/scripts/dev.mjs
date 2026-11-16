import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url)), desktop = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url), electron = require('electron');
const children = new Set();
const run = (command,args,options={}) => { const child = spawn(command,args,{cwd:root,stdio:'inherit',...options}); children.add(child); child.once('exit',()=>children.delete(child)); return child; };
function wait(child) { return new Promise((resolve,reject) => { child.once('error',reject); child.once('exit',code => code === 0 ? resolve() : reject(new Error(`Build exited ${code}`))); }); }
await wait(run(process.execPath,[require.resolve('typescript/bin/tsc'),'-b','packages/protocol','packages/providers','packages/server','packages/desktop']));
await wait(run(process.execPath,[fileURLToPath(new URL('./icons.mjs',import.meta.url))]));
const watcher = run(process.execPath,[require.resolve('typescript/bin/tsc'),'-b','packages/desktop','--watch','--preserveWatchOutput']);
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
const app = run(electron,[desktop],{env});
app.once('exit',code => { watcher.kill(); process.exitCode = code ?? 1; });
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{for(const child of children) child.kill(signal);});

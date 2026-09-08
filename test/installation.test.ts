import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
test("skill installation uses real files, preserves unrelated state, and refuses silent replacement",async()=>{
  const root=await mkdtemp(join(tmpdir(),"express-skill-test-"));
  try {
    await writeFile(join(root,"AGENTS.md"),"untouched");
    await exec(process.execPath,["scripts/install-skill.mjs","--workspace",root]);
    const skill=join(root,"skills/express-messenger");assert.equal((await lstat(skill)).isSymbolicLink(),false);
    const config=JSON.parse(await readFile(join(skill,"installation.json"),"utf8"));
    assert.ok(config.entry.endsWith("/dist/src/cli.js"));assert.equal(await readFile(join(root,"AGENTS.md"),"utf8"),"untouched");
    await assert.rejects(exec(process.execPath,["scripts/install-skill.mjs","--workspace",root]));
    assert.equal(await readFile(join(root,"AGENTS.md"),"utf8"),"untouched");
  }finally{await rm(root,{recursive:true,force:true});}
});
test("agent CLI uses a real MCP stdio connection and safe JSON response",async()=>{
  const root=await mkdtemp(join(tmpdir(),"express-agent-test-"));
  try {
    const {spawn}=await import("node:child_process");
    const child=spawn(process.execPath,["dist/src/cli.js","agent"],{env:{...process.env,EXPRESS_MCP_ADAPTER:"mock",EXPRESS_MCP_PROFILE_DIR:join(root,"profile")},stdio:["pipe","pipe","pipe"]});
    let out="",err="";child.stdout.on("data",v=>out+=v);child.stderr.on("data",v=>err+=v);
    child.stdin.end(JSON.stringify({operation:"search-people",query:"Synthetic",limit:1}));
    const code=await new Promise(resolve=>child.once("exit",resolve));
    assert.equal(code,0,err);assert.equal(JSON.parse(out).ok,true);assert.equal(err.includes("Synthetic"),false);
  }finally{await rm(root,{recursive:true,force:true});}
});

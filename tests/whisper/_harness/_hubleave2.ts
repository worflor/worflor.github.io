import { VirtualNet, makeNode, connect, epochOf, elderHex, teardown } from "../_helpers/campfire-harness.js";
import { toHex } from "../../../src/scripts/whisper/wasm.js";

type R={fork:boolean;lag:boolean;healed:boolean};
async function run(seed:number):Promise<R>{
  const net=new VirtualNet(seed); net.autoPump=true;
  const host=makeNode(net,"A"); const recs=[host];
  for(const n of ["B","C","D","E"]){const j=makeNode(net,n); await connect(host,j); recs.push(j);}
  try{
    const eh=elderHex(recs[0])!;
    const elder=recs.find(r=>r.node.getPeerIdHex()===eh)!;
    await elder.node.endCampfire("test: hub departs");
    await net.drain();
    const surv=recs.filter(r=>r!==elder);
    const view=()=>surv.map(r=>{const e=epochOf(r); return e?{ep:e.epochId,root:toHex(e.root)}:null;});
    // fork = two seats at the SAME epoch with DIFFERENT roots. that is unrecoverable.
    const isFork=(v:any[])=>{const m=new Map<number,string>();
      for(const s of v){ if(!s) continue; const p=m.get(s.ep); if(p&&p!==s.root) return true; m.set(s.ep,s.root); } return false;};
    const isLag=(v:any[])=>new Set(v.map(s=>s?.ep??-1)).size>1;
    const v0=view(); const fork=isFork(v0), lag=isLag(v0);
    // give the catch-up its trigger: someone speaks.
    for(const r of surv) await r.node.broadcastText("ping "+r.name);
    await net.drain();
    const v1=view();
    return {fork, lag, healed: !isFork(v1) && !isLag(v1)};
  } finally { await teardown(recs); }
}

let forks=0,lags=0,healed=0,clean=0;
for(let s=1;s<=25;s++){ const r=await run(2000+s);
  if(r.fork)forks++; else if(r.lag)lags++; else clean++;
  if((r.fork||r.lag)&&r.healed)healed++; }
console.log(`over 25 hub departures (concurrent delivery):`);
console.log(`  converged immediately : ${clean}`);
console.log(`  lagging seat (recoverable) : ${lags}`);
console.log(`  TRUE FORK (same epoch, different roots) : ${forks}`);
console.log(`  of the ${lags+forks} imperfect runs, healed after traffic : ${healed}`);

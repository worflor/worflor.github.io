import { VirtualNet, makeNode, connect, epochOf, elderHex, teardown } from "../_helpers/campfire-harness.js";
import { toHex } from "../../../src/scripts/whisper/wasm.js";

async function run(seed:number){
  const net=new VirtualNet(seed); net.autoPump=true;
  const host=makeNode(net,"A"); const recs=[host];
  for(const n of ["B","C","D","E"]){const j=makeNode(net,n); await connect(host,j); recs.push(j);}
  try{
    const eh=elderHex(recs[0])!;
    const elder=recs.find(r=>r.node.getPeerIdHex()===eh)!;
    await elder.node.endCampfire("hub departs");
    await net.drain();
    const surv=recs.filter(r=>r!==elder);
    const v=surv.map(r=>{const e=epochOf(r); return e?{ep:e.epochId,root:toHex(e.root)}:null;});
    const m=new Map<number,string>(); let fork=false;
    for(const x of v){ if(!x)continue; const p=m.get(x.ep); if(p&&p!==x.root)fork=true; m.set(x.ep,x.root); }
    const lag=new Set(v.map(x=>x?.ep??-1)).size>1;
    return {fork,lag};
  } finally { await teardown(recs); }
}
let fork=0,lag=0,clean=0;
for(let s=1;s<=30;s++){ const r=await run(3000+s); if(r.fork)fork++; else if(r.lag)lag++; else clean++; }
console.log(`clean ${clean}/30 | lag ${lag} | TRUE FORK ${fork}`);

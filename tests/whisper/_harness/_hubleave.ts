import { VirtualNet, makeNode, connect, epochOf, elderHex, teardown } from "../_helpers/campfire-harness.js";
import { toHex } from "../../../src/scripts/whisper/wasm.js";

async function run(seed:number, autoPump:boolean):Promise<string>{
  const net=new VirtualNet(seed); net.autoPump=autoPump;
  const host=makeNode(net,"A"); const recs=[host];
  for(const n of ["B","C","D","E"]){const j=makeNode(net,n); await connect(host,j); recs.push(j);}
  try{
    const eh=elderHex(recs[0])!;
    const elder=recs.find(r=>r.node.getPeerIdHex()===eh)!;
    const before=epochOf(recs[0])!.epochId;
    // the hub case: the ELDER (also genesis host in this build) departs
    await elder.node.endCampfire("test: hub departs");
    await net.drain();
    const survivors=recs.filter(r=>r!==elder);
    const eps=survivors.map(r=>epochOf(r)?.epochId ?? -1);
    const roots=new Set(survivors.map(r=>{const e=epochOf(r); return e?toHex(e.root):"none";}));
    const converged=eps.every(e=>e===before+1) && roots.size===1;
    return converged?"OK":`SPLIT eps=${eps.join(",")} roots=${roots.size}`;
  } finally { await teardown(recs); }
}

for(const pump of [false,true]){
  let ok=0; const bad:string[]=[];
  for(let s=1;s<=20;s++){ const r=await run(1000+s,pump); if(r==="OK")ok++; else bad.push(r); }
  console.log(`autoPump=${String(pump).padEnd(5)} converged ${ok}/20`, bad.length?`| e.g. ${bad[0]}`:"");
}

import { expect, it } from "vitest";
import { redlineOffThread } from "../src/jobs/export-worker.ts";

it("renders an export while the API event loop can continue servicing work",async()=>{
  const content="Confidentiality provision.\n".repeat(4000);
  let timerRan=false;
  const timer=setTimeout(()=>{timerRan=true;},10);
  try {
    const bytes=await redlineOffThread({title:"Thread fixture",from:{version:1,content},to:{version:2,content:`${content}Updated.`,createdAt:new Date().toISOString()}});
    expect(bytes.subarray(0,2).toString()).toBe("PK");
    expect(timerRan).toBe(true);
  } finally {clearTimeout(timer);}
},30_000);

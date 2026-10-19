import { describe, expect, it } from "vitest";
import { applyChanges } from "../../../packages/core/src/browser.ts";
import { projectText } from "../src/lib/projected-text.ts";

describe("bounded proposed text windows",()=>{
  it("matches full reconstruction for Unicode, inserts, removals and window boundaries",()=>{
    const original="First 😀 paragraph.\nSecond café paragraph.\nEnd.";
    const result=applyChanges(original,[{operation:"replace",target:{quote:{exact:"First"}},replacement:"New first"},{operation:"replace",target:{quote:{exact:"café"}},replacement:"tea"},{operation:"replace",target:{quote:{exact:"End."}},replacement:""}]);
    expect(result.ok).toBe(true);if(!result.ok)return;
    const projected=projectText(original,result.value.applied);expect(projected.length).toBe(result.value.content.length);
    for(let start=-5;start<projected.length;start++)for(let end=start;end<=projected.length;end++)expect(projected.slice(start,end)).toBe(result.value.content.slice(start,end));
  });
  it("returns the base for overlapping or out-of-range spans",()=>{
    const change={index:0,start:0,end:2,before:"ab",after:"x",newStart:0,newEnd:1};
    expect(projectText("abc",[change,{...change,index:1}])).toBe("abc");
    expect(projectText("abc",[{...change,end:100}])).toBe("abc");
  });
});

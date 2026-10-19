import { useRef, useState, type ReactNode } from "react";

interface Props { href:string; className:string; title:string; children:ReactNode; compact?:boolean; "aria-label"?:string }
type State={kind:"idle"}|{kind:"running";jobId:string;statusUrl:string;progress:number}|{kind:"error";message:string};

export function ExportButton({href,className,title,children,compact=false,"aria-label":ariaLabel}:Props) {
  const [state,setState]=useState<State>({kind:"idle"});
  const abort=useRef<AbortController|null>(null);
  const cancel=async()=>{
    abort.current?.abort();
    if(state.kind==="running") await fetch(`/api/jobs/${state.jobId}/cancel`,{method:"POST"}).catch(()=>undefined);
    setState({kind:"idle"});
  };
  const download=(url:string)=>{
    const a=document.createElement("a");
    a.href=url.startsWith("/")?`/api${url}`:url;
    a.download="clause-redline.docx";
    a.rel="noreferrer";
    document.body.append(a);a.click();a.remove();
  };
  const start=async()=>{
    if(state.kind==="running") return;
    const controller=new AbortController();abort.current=controller;
    setState({kind:"running",jobId:"",statusUrl:"",progress:0});
    try {
      const response=await fetch(href,{signal:controller.signal});
      if(response.status!==202) {
        if(!response.ok) throw new Error("The Word export could not be created.");
        const url=URL.createObjectURL(await response.blob());download(url);setTimeout(()=>URL.revokeObjectURL(url),60_000);setState({kind:"idle"});return;
      }
      const accepted=await response.json() as {jobId:string;statusUrl:string};
      setState({kind:"running",jobId:accepted.jobId,statusUrl:accepted.statusUrl,progress:0});
      for(;;) {
        await new Promise<void>((resolve,reject)=>{
          const timer=setTimeout(resolve,1000);
          controller.signal.addEventListener("abort",()=>{clearTimeout(timer);reject(new DOMException("Aborted","AbortError"));},{once:true});
        });
        const statusResponse=await fetch(`/api${accepted.statusUrl}`,{signal:controller.signal});
        if(!statusResponse.ok) throw new Error("Could not check export progress.");
        const job=await statusResponse.json() as {status:string;progress:number;downloadUrl?:string;errorCode?:string};
        if(job.status==="succeeded"&&job.downloadUrl) { download(job.downloadUrl);setState({kind:"idle"});return; }
        if(job.status==="failed"||job.status==="cancelled") throw new Error(job.status==="cancelled"?"The export was cancelled.":"The Word export failed. Try again.");
        setState({kind:"running",jobId:accepted.jobId,statusUrl:accepted.statusUrl,progress:job.progress});
      }
    } catch(error) {
      if(controller.signal.aborted) return;
      setState({kind:"error",message:error instanceof Error?error.message:"The export failed."});
    }
  };

  return <span className="inline-flex flex-col items-start gap-1">
    <button type="button" onClick={()=>void start()} className={className} title={title} aria-label={ariaLabel} disabled={state.kind==="running"}>
      {state.kind==="running" ? compact ? `Exporting ${state.progress}%` : `Exporting ${state.progress}%` : children}
    </button>
    {state.kind==="running"&&state.jobId&&<button type="button" onClick={()=>void cancel()} className="text-xs text-muted underline underline-offset-2">Cancel export</button>}
    {state.kind==="error"&&<span role="status" className="text-xs text-fail">{state.message}</span>}
  </span>;
}

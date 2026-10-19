import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { redlineDocx } from "../docx.ts";

const input=z.object({title:z.string(),from:z.object({version:z.number(),content:z.string()}),to:z.object({version:z.number(),content:z.string(),createdAt:z.string()})}).parse(workerData);
const result=new Uint8Array(await redlineDocx(input));
parentPort?.postMessage(result,[result.buffer]);

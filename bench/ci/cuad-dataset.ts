import { readFileSync } from "node:fs";
import { join } from "node:path";

export type CuadSplit = "train" | "test";
export interface CuadItem {
  id: string;
  documentId: string;
  title: string;
  text: string;
  category: string;
  requirement: string;
  hasClause: boolean;
  spans: [number, number][];
}
interface CuadJson { data: { title: string; paragraphs: { context: string; qas: { id: string; question: string; is_impossible: boolean; answers: { text: string; answer_start: number }[] }[] }[] }[] }

const dataFile = (split: CuadSplit) => join(import.meta.dirname, "data", "cuad", `${split}.json`);

export function loadCuadSplit(split: CuadSplit): CuadItem[] {
  const data = JSON.parse(readFileSync(dataFile(split), "utf8")) as CuadJson;
  const items: CuadItem[] = [];
  for (const document of data.data) {
    for (const paragraph of document.paragraphs) {
      for (const qa of paragraph.qas) {
        const category = qa.question.match(/"([^"]+)"/)?.[1] ?? qa.question.replace(/^Does the agreement contain (?:a|any) /i, "").replace(/\?$/, "").trim();
        const spans = qa.answers.flatMap((a): [number, number][] => {
          const start = a.answer_start;
          const end = start + a.text.length;
          return paragraph.context.slice(start, end) === a.text ? [[start, end]] : [];
        });
        items.push({ id: qa.id, documentId: document.title, title: document.title, text: paragraph.context, category, requirement: `This agreement contains a clause about ${category}.`, hasClause: !qa.is_impossible, spans });
      }
    }
  }
  return items;
}

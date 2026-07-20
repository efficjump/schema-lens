import type { Metadata } from "next";
import { SchemaLensWorkspace } from "./components/SchemaLensWorkspace";

export const metadata: Metadata = {
  title: "Schema Lens — 소스에서 찾는 데이터 관계",
  description:
    "로컬 소스와 SQL을 분석해 DB ERD, 소스 관계도, IDE형 코드 탐색과 근거 기반 자연어 질의를 제공하는 개발 도구",
};

export default function Home() {
  return <SchemaLensWorkspace />;
}

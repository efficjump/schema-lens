import type { Metadata } from "next";
import { SchemaLensWorkspace } from "./components/SchemaLensWorkspace";
import { I18nProvider } from "./i18n";

export const metadata: Metadata = {
  title: "Schema Lens — Source-Grounded Data Relationships",
  description:
    "Analyze local source and SQL to explore DB ERDs, source relationships, code evidence, and grounded natural-language answers.",
};

export default function Home() {
  return (
    <I18nProvider>
      <SchemaLensWorkspace />
    </I18nProvider>
  );
}
